// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The diner is told their order is ready, and the wall screen can be read (#96).
 *
 * TWO FINDINGS, one file, because they are the two halves of order tracking:
 *
 * 1. The product confirmed an order and then said **nothing else, ever**. A
 *    click-and-collect customer had no way to know when to walk over except by
 *    watching the tracking page.
 *
 * 2. `/display/[storeId]` is a tablet bolted to a wall in the dining room, and
 *    its only query was wrapped with `kitchen:read` — so the screen a customer is
 *    meant to read could only be opened by somebody logged in as staff. The audit
 *    called it "the unusable unauthenticated display screen".
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
  role: "client_admin" | "kitchen",
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
  over: { type?: "pickup" | "delivery" | "dine_in"; email?: string; status?: string } = {}
) {
  seq += 1
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `ORD-2026-${String(seq).padStart(4, "0")}`,
      customerInfo: {
        name: "Camille",
        ...(over.email === "" ? {} : { email: over.email ?? "camille@example.fr" }),
      },
      type: over.type ?? ("pickup" as const),
      status: (over.status ?? "preparing") as never,
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
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const markReady = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, { id, status: "ready" })

/** Whether the claim marker landed — the honest proxy for "a notice was sent". */
const claimed = async (t: ReturnType<typeof convexTest>, id: Id<"orders">) => {
  const order = await t.run((ctx) => ctx.db.get(id))
  return typeof order?.readyEmailAt === "number"
}

// ============================================================================
// The notice
// ============================================================================

describe("marking an order ready", () => {
  test("claims a notice for a collection order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await markReady(t, orderId)

    expect(await claimed(t, orderId)).toBe(true)
  })

  test("claims one for a dine-in order too", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { type: "dine_in" })

    await markReady(t, orderId)

    expect(await claimed(t, orderId)).toBe(true)
  })

  test("claims nothing for a delivery order", async () => {
    // « Prête » on a delivery means the food left the kitchen, not that anything
    // is expected of the diner.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { type: "delivery" })

    await markReady(t, orderId)

    expect(await claimed(t, orderId)).toBe(false)
  })

  test("claims nothing for an order with no address", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { email: "" })

    await markReady(t, orderId)

    expect(await claimed(t, orderId)).toBe(false)
  })

  test("claims nothing on the statuses before and after it", async () => {
    // One email, at the one moment the diner has to act. Four emails an order is
    // a spam complaint waiting to happen.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { status: "confirmed" })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "preparing",
    })
    expect(await claimed(t, orderId)).toBe(false)

    await markReady(t, orderId)
    expect(await claimed(t, orderId)).toBe(true)

    // And `completed` afterwards adds nothing — the claim is already there, which
    // is what stops a second send rather than a second check.
    const before = await t.run((ctx) => ctx.db.get(orderId))
    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "completed",
    })
    const after = await t.run((ctx) => ctx.db.get(orderId))
    expect(after?.readyEmailAt).toBe(before?.readyEmailAt)
  })

  test("claims once even if ready is reached twice", async () => {
    /*
     * The state machine will not walk `ready -> preparing`, so the second
     * arrival is reproduced the way it actually happens: the claim marker is
     * cleared — which is what `releaseReadyNoticeClaim` does when nothing could
     * be sent — and the transition replayed from `preparing`. The claim must be
     * re-made once, and one send scheduled, not two.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await markReady(t, orderId)
    const first = await t.run((ctx) => ctx.db.get(orderId))
    expect(typeof first?.readyEmailAt).toBe("number")

    // Back to preparing, marker intact — this is the "second station finishes"
    // shape, and `planOrderReady` must refuse on the marker alone.
    await t.run((ctx) => ctx.db.patch(orderId, { status: "preparing" }))
    await markReady(t, orderId)

    const second = await t.run((ctx) => ctx.db.get(orderId))
    expect(second?.readyEmailAt).toBe(first?.readyEmailAt)
  })

  test("the payload says what the diner needs and nothing else", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)
    await markReady(t, orderId)

    const payload = await t.run(async (ctx) => {
      const { readyPayload } = await import(
        "@be-yours/convex-functions/orderReady"
      )
      return readyPayload(ctx, orderId)
    })

    expect(payload?.email).toMatchObject({
      customerName: "Camille",
      fulfilment: "pickup",
    })
    expect(payload?.email.store.name).toBe("Chez Luigi")
    // No lines, no totals, no VAT: the confirmation carries those.
    expect(payload?.email).not.toHaveProperty("items")
    expect(payload?.email).not.toHaveProperty("total")
  })
})

// ============================================================================
// The dining-room screen
// ============================================================================

describe("the dining-room screen", () => {
  test("cannot be read with no token", async () => {
    // Absent is off, not open: no existing deployment becomes readable by never
    // generating one.
    const t = newHarness()
    const storeId = await seedStore(t)

    await expect(
      t.query(api.kitchenTickets.getForDisplayByToken, { storeId, token: "anything" })
    ).resolves.toBeNull()
  })

  test("can be read with the establishment's own token, and no session", async () => {
    /*
     * THE FINDING. The guarded twin requires `kitchen:read`, and this page is a
     * tablet on a wall in a public room — so the screen a customer is meant to
     * read could not be opened by the screen itself.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    const { token } = (await asOwner.mutation(
      api.kitchenTickets.rotateDisplayToken,
      { storeId }
    )) as { token: string }

    // No identity at all, which is the whole point.
    const data = await t.query(api.kitchenTickets.getForDisplayByToken, {
      storeId,
      token,
    })
    expect(data).not.toBeNull()
    expect(data.storeBranding.name).toBe("Chez Luigi")
  })

  test("refuses the wrong token", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, { storeId })

    await expect(
      t.query(api.kitchenTickets.getForDisplayByToken, {
        storeId,
        token: "00000000-0000-0000-0000-000000000000",
      })
    ).resolves.toBeNull()
  })

  test("refuses the old token after a rotation", async () => {
    // Rotation is the point: a tablet that leaves the building keeps working
    // until the owner turns the token over.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    const first = (await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, {
      storeId,
    })) as { token: string }
    const second = (await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, {
      storeId,
    })) as { token: string }

    expect(second.token).not.toBe(first.token)
    await expect(
      t.query(api.kitchenTickets.getForDisplayByToken, { storeId, token: first.token })
    ).resolves.toBeNull()
    await expect(
      t.query(api.kitchenTickets.getForDisplayByToken, { storeId, token: second.token })
    ).resolves.not.toBeNull()
  })

  test("shows no order numbers of another establishment", async () => {
    const t = newHarness()
    const mine = await seedStore(t)
    const theirs = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Sushi Bar",
        slug: "sushi-bar",
        address: { street: "2 rue B", city: "Paris", postalCode: "75011", country: "France" },
        hours: [],
        status: "open" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const asOwner = await seedUser(t, "owner", "client_admin", [mine, theirs])
    const { token } = (await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, {
      storeId: mine,
    })) as { token: string }

    await expect(
      t.query(api.kitchenTickets.getForDisplayByToken, { storeId: theirs, token })
    ).resolves.toBeNull()
  })

  test("carries nothing personal", async () => {
    /*
     * What makes the token safe to sit in a URL: the payload is order numbers,
     * statuses, timestamps and the establishment's own name. It is what is
     * already legible to anybody standing in the room, so the token is stopping a
     * stranger polling the endpoint rather than guarding personal data.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const { token } = (await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, {
      storeId,
    })) as { token: string }

    const orderId = await seedOrder(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-2026-9999",
        items: [{ productName: "Margherita", quantity: 1, options: [] }],
        status: "ready" as const,
        priority: "normal" as const,
        source: "website" as const,
        orderType: "pickup" as const,
        printStatus: "printed" as const,
        printAttempts: 1,
        trackingToken: "tok-display-test",
        // `Date.now()`, not `NOW`: `getForDisplay` drops a ready ticket older
        // than the auto-dismiss window, and `NOW` is a 2023 constant — so the
        // screen would be legitimately empty and this test would pass vacuously
        // on the "contains nothing personal" half.
        readyAt: Date.now(),
        customerName: "Camille Dupont",
        customerPhone: "+33612345678",
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const data = await t.query(api.kitchenTickets.getForDisplayByToken, {
      storeId,
      token,
    })
    const serialised = JSON.stringify(data)
    expect(serialised).toContain("ORD-2026-9999")
    expect(serialised).not.toContain("Camille Dupont")
    expect(serialised).not.toContain("+33612345678")
    expect(serialised).not.toContain("Margherita")
  })

  test("the owner is told whether a token exists, never its value", async () => {
    // A token returned by a general read would sit in the browser memory of
    // every admin page every member of staff opens.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    expect(
      await asOwner.query(api.kitchenTickets.displayTokenState, { storeId })
    ).toEqual({ configured: false })

    await asOwner.mutation(api.kitchenTickets.rotateDisplayToken, { storeId })

    const state = await asOwner.query(api.kitchenTickets.displayTokenState, { storeId })
    expect(state).toEqual({ configured: true })
    expect(JSON.stringify(state)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  test("a kitchen account cannot rotate it", async () => {
    // Rotating takes a screen off the air until somebody walks over to the
    // tablet. That is an owner's decision, not a shift decision.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(
      asKitchen.mutation(api.kitchenTickets.rotateDisplayToken, { storeId })
    ).rejects.toThrow()
  })
})
