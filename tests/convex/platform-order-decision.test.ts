// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A Deliveroo order gets an answer, and every status change leaves a trail
 * (#103, #104).
 *
 * TWO FINDINGS, one file, because the second is what makes the first auditable.
 *
 * 1. `storeIntegrations.orderMode` offers `auto_accept`, `auto_reject` and
 *    `manual`, and the webhook honours the first two. Under `manual` it logged
 *    the mode and did nothing, so the order sat in the product with **no control
 *    anywhere** that could accept or refuse it. A restaurant that chose manual
 *    had no way to run a service.
 *
 * 2. An order's status releases the kitchen, flags money as owed back and cancels
 *    tickets — and nothing recorded who changed it. `systemAuditLog` carried the
 *    RGPD runs and nothing else.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: "client_admin" | "kitchen" | "waiter",
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

let seq = 0

async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: { source?: string; externalOrderId?: string; status?: string } = {}
) {
  seq += 1
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `ORD-2026-${String(seq).padStart(4, "0")}`,
      customerInfo: { name: "Camille", email: "camille@example.fr" },
      type: "delivery" as const,
      status: (over.status ?? "pending") as never,
      items: [
        {
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
        },
      ],
      subtotal: 1_200,
      taxAmount: 120,
      total: 1_320,
      paymentStatus: "paid" as const,
      source: (over.source ?? "deliveroo") as never,
      ...(over.externalOrderId === ""
        ? {}
        : { externalOrderId: over.externalOrderId ?? "deliveroo-order-7" }),
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const auditLines = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("systemAuditLog").collect())

// ============================================================================
// The trail
// ============================================================================

describe("every status change", () => {
  test("leaves a line naming the order and both statuses", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.details).toContain("pending → confirmed")
    expect(lines[0]!.details).toContain("ORD-2026-")
  })

  test("names the platform an order came from", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(lines[0]!.details).toContain("source deliveroo")
  })

  test("names the member of staff who did it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asWaiter = await seedUser(t, "server", "waiter", [storeId])
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await asWaiter.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(lines[0]!.performedBy).toBe("server")
  })

  test("says « système » when nobody was signed in", async () => {
    // A platform webhook, a scheduler and a payment confirmation all move orders
    // with no session. Writing "unknown" for the three of them would make the log
    // useless exactly where it is most needed.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(lines[0]!.performedBy).toBe("système")
  })

  test("names no diner", async () => {
    /*
     * `systemAuditLog` is read by the whole team and sits OUTSIDE the erasure
     * set, so a customer's name or address in here would be a copy of their data
     * that `eraseDataSubject` cannot reach. The order number is the link.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(JSON.stringify(lines)).not.toContain("Camille")
    expect(JSON.stringify(lines)).not.toContain("camille@example.fr")
  })

  test("writes nothing when the status was replayed", async () => {
    // A webhook retry and a double-clicked button both land here, and the handler
    // returns before changing anything.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { source: "website", status: "confirmed" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "confirmed" as const,
    })

    expect((await auditLines(t)).filter((l) => l.action === "order_status_change")).toEqual([])
  })

  test("carries the cancellation reason", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "cancelled" as const,
      cancellationReason: "Rupture d'un ingrédient",
    })

    const lines = (await auditLines(t)).filter((l) => l.action === "order_status_change")
    expect(lines[0]!.details).toContain("Rupture d'un ingrédient")
  })
})

// ============================================================================
// The decision
// ============================================================================

describe("the manual Deliveroo decision", () => {
  test("refuses an order that is not from Deliveroo", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId, { source: "website" })

    await expect(
      asOwner.action(api.deliverooOrderDecision.accept, { orderId })
    ).resolves.toEqual({ accepted: false, reason: "not_a_deliveroo_order" })
  })

  test("refuses an order with no platform id", async () => {
    // A Deliveroo order that lost its external id cannot be answered, and
    // guessing one would answer somebody else's.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId, { externalOrderId: "" })

    await expect(
      asOwner.action(api.deliverooOrderDecision.accept, { orderId })
    ).resolves.toEqual({ accepted: false, reason: "not_a_deliveroo_order" })
  })

  test("says so when Deliveroo is not configured, rather than throwing", async () => {
    /*
     * The state of every deployment that has not connected Deliveroo, and the
     * one a restaurant hits if the credentials are removed mid-service. A
     * refusal the screen can explain beats a 500 it cannot.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId)

    await expect(
      asOwner.action(api.deliverooOrderDecision.accept, { orderId })
    ).resolves.toEqual({ accepted: false, reason: "deliveroo_not_configured" })
    await expect(
      asOwner.action(api.deliverooOrderDecision.reject, { orderId })
    ).resolves.toEqual({ rejected: false, reason: "deliveroo_not_configured" })
  })

  test("leaves the order untouched when the platform could not be told", async () => {
    // The platform moves first on purpose: a restaurant must never read
    // « confirmée » on an order Deliveroo still considers pending.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId)

    await asOwner.action(api.deliverooOrderDecision.accept, { orderId })

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.status).toBe("pending")
  })

  test("is refused to a role that cannot advance an order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)
    // No profile at all: an anonymous caller.
    await expect(
      t.action(api.deliverooOrderDecision.accept, { orderId })
    ).rejects.toThrow()
  })

  test("a kitchen account may decide — it is a service decision", async () => {
    // `orders:update_status` is held by kitchen and delivery precisely because
    // advancing an order is their entire job. The refusal here is the missing
    // credential, not the permission.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])
    const orderId = await seedOrder(t, storeId)

    await expect(
      asKitchen.action(api.deliverooOrderDecision.accept, { orderId })
    ).resolves.toEqual({ accepted: false, reason: "deliveroo_not_configured" })
  })
})
