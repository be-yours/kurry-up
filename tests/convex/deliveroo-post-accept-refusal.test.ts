// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A Deliveroo order accepted by the kitchen cannot be silently un-accepted
 * (#627).
 *
 * WHAT SHIPPED. `ticket-card.tsx` rendered the same seven-reason refusal menu
 * for a ticket in `in_progress` as for one in `pending`, and
 * `kitchenTickets.ts:566` gated the transmission on `!wasAccepted`: the `else`
 * wrote a `console.log`. So on the post-accept path the reason was dropped,
 * Deliveroo was never called, **the diner's app still showed the order
 * coming**, and the toast read « Commande annulée ».
 *
 * WHY A REFUSAL RATHER THAN A CALL. Deliveroo's Order API offers
 * `PATCH /v1/orders/{id}` with `status: "rejected"`, which is a PRE-ACCEPT
 * rejection; there is no endpoint an integration can call to withdraw an order
 * the restaurant has already accepted. The issue asks for the call "and when it
 * cannot be called, refuse the action with a message instead of a success
 * toast". It cannot be called.
 *
 * The refusal happens BEFORE anything local changes, which is the part that
 * matters: our state and Deliveroo's stay in agreement instead of diverging
 * silently.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
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

/**
 * Drain the scheduler, the way `kitchen-auto-print.test.ts` does.
 *
 * `cancelTicket` schedules work from the order-cancellation path, and a job
 * still running when the file ends surfaces as "Write outside of transaction",
 * blaming whichever suite happens to be executing rather than this one.
 * `finishInProgressScheduledFunctions` first, so nothing is cancelled mid-run.
 */
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

async function seed(t: ReturnType<typeof convexTest>) {
  const storeId = await t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:cook",
      role: "client_admin" as const,
      storeIds: [storeId as Id<"stores">],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return { storeId, asCook: t.withIdentity({ subject: "user:cook" }) }
}

async function seedTicket(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  source: "deliveroo" | "uber_eats" | "website",
  status: "pending" | "in_progress",
) {
  return t.run(async (ctx) => {
    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber: "D-1",
      customerInfo: { name: "Camille" },
      type: "delivery" as const,
      status: "confirmed" as const,
      items: [],
      subtotal: 2000,
      taxAmount: 200,
      total: 2200,
      paymentStatus: "paid" as const,
      source,
      externalOrderId: "deliveroo-external-1",
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    const ticketId = await ctx.db.insert("kitchenTickets", {
      storeId,
      orderId,
      orderNumber: "D-1",
      orderType: "delivery" as const,
      items: [],
      priority: "normal" as const,
      source,
      status,
      trackingToken: `tok-${source}-${status}`,
      printStatus: "not_required" as const,
      printAttempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return { ticketId, orderId }
  })
}

describe("a Deliveroo order already accepted", () => {
  test("is refused, with a message naming what the operator must do", async () => {
    const t = newHarness()
    const { storeId, asCook } = await seed(t)
    const { ticketId } = await seedTicket(t, storeId as Id<"stores">, "deliveroo", "in_progress")

    await expect(
      asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId, reason: "out_of_stock" })
    ).rejects.toThrow(/Deliveroo/)
  })

  test("leaves the ticket and the order exactly as they were", async () => {
    // The half that made this dangerous: everything local was cancelled before
    // the platform step was even reached, so our state and Deliveroo's diverged
    // and only the diner could tell.
    const t = newHarness()
    const { storeId, asCook } = await seed(t)
    const { ticketId, orderId } = await seedTicket(
      t,
      storeId as Id<"stores">,
      "deliveroo",
      "in_progress",
    )

    await expect(
      asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId })
    ).rejects.toThrow()

    const ticket = await t.run((ctx) => ctx.db.get(ticketId))
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(ticket?.status).toBe("in_progress")
    expect(order?.status).toBe("confirmed")
  })
})

describe("what is still allowed", () => {
  test("a Deliveroo order NOT yet accepted is refused normally", async () => {
    // Anti-vacuity, and the case the platform genuinely supports:
    // `PATCH /v1/orders/{id}` with `status: "rejected"` is a pre-accept
    // rejection, and the KDS still offers the seven reasons for it.
    const t = newHarness()
    const { storeId, asCook } = await seed(t)
    const { ticketId } = await seedTicket(t, storeId as Id<"stores">, "deliveroo", "pending")

    await asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId, reason: "store_busy" })

    const ticket = await t.run((ctx) => ctx.db.get(ticketId))
    expect(ticket?.status).toBe("cancelled")
  })

  test("an accepted Uber Eats order is still cancellable — Uber has the endpoint", async () => {
    // Anti-vacuity the other way: the refusal must be Deliveroo-specific.
    // `uberEats.cancelOrder` exists and is called on the post-accept path.
    const t = newHarness()
    const { storeId, asCook } = await seed(t)
    const { ticketId } = await seedTicket(t, storeId as Id<"stores">, "uber_eats", "in_progress")

    await asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId })

    const ticket = await t.run((ctx) => ctx.db.get(ticketId))
    expect(ticket?.status).toBe("cancelled")
  })

  test("an accepted website order is still cancellable", async () => {
    const t = newHarness()
    const { storeId, asCook } = await seed(t)
    const { ticketId } = await seedTicket(t, storeId as Id<"stores">, "website", "in_progress")

    await asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId })

    const ticket = await t.run((ctx) => ctx.db.get(ticketId))
    expect(ticket?.status).toBe("cancelled")
  })
})
