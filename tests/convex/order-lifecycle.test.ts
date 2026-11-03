// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What happens to an order after — and instead of — the first click.
 *
 * A second click on "Payer" bought a second dinner: the button re-enables in
 * `finally` while the redirect to the provider is in flight, and the cart
 * survives a Back navigation. Cash was offered, accepted, and never recorded,
 * so the order stayed unpaid for ever. Cancelling one left its ticket live on
 * the kitchen display and "en préparation" on the customer's tracking page. And
 * the two settings that say what an establishment will take an order for — a
 * minimum, a radius — were written by the dashboard and read by nobody.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

/** Place de la Bastille, and an address 6 km away at the Arc de Triomphe. */
const BASTILLE = { latitude: 48.8532, longitude: 2.3692 }
const ETOILE = { latitude: 48.8738, longitude: 2.295 }

type Role = "super_admin" | "client_admin" | "manager" | "kitchen" | "customer"

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Product, menu and store mutations queue work through `ctx.scheduler.runAfter`
 * — `scheduleMenuSync` puts the Uber Eats and Deliveroo syncs at a 5s delay on
 * every catalogue write. A test finishes in milliseconds and leaves them
 * pending; whatever fires them next writes against a transaction that closed,
 * and because nothing awaits it that arrives as an unhandled rejection. The run
 * then reports every test green and still exits 1, blaming whichever file
 * happened to be running rather than the one that queued the work.
 *
 * Cancel rather than run. `syncAllStores` is an `internalAction`, and running
 * one here is the disease, not the cure: convex-test patches its
 * `_scheduled_functions` row on completion, an action has no transaction to
 * patch it in, and the failure comes straight back. Finishing the queue with
 * `finishAllScheduledFunctions` was tried first and made it worse — ten
 * rejections in a run where leaving the jobs alone produced two.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        // Only what is still outstanding: cancelling a job that already
        // finished is not a no-op. Same guard as `cancelScheduled` in
        // campaign-send.test.ts, which reached this from the other direction.
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})


async function seedStore(
  t: ReturnType<typeof convexTest>,
  address: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
        ...address,
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  extra: Record<string, unknown> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
      ...extra,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
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

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  price = 1_200
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
      storeId,
      categoryId,
      name: "Margherita",
      slug: "margherita",
      price,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual",
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
  overrides: Record<string, unknown> = {},
  price = 1_200
) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: 1,
        unitPrice: price,
        selectedOptions: [],
        subtotal: price,
      },
    ],
    type: "pickup" as const,
    ...overrides,
  }
}


/**
 * Confirm the payment, which is what now puts the slip on the pass.
 *
 * The kitchen ticket used to be written inside checkout, before any provider
 * redirect — so an abandoned payment left the kitchen cooking (#136). These
 * tests are about what happens to a ticket, so they have to get one the way
 * the product now does.
 */
async function payOrder(
  t: ReturnType<typeof convexTest>,
  orderId: Id<"orders">
) {
  await t.run((ctx) =>
    ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
      id: orderId,
      paymentStatus: "paid" as const,
    })
  )
}

describe("a second click on Payer", () => {
  test("returns the order that already exists", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const args = orderArgs(storeId, productId, { idempotencyKey: "attempt-1" })

    const first = await t.mutation(api.orders.create, args)
    const second = await t.mutation(api.orders.create, args)

    expect(second).toBe(first)

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(1)
  })

  /**
   * #374 — the retry that changes its mind. On a store with cash enabled and
   * no card provider configured, card was the pre-selected tile, so the
   * natural first journey was a failed card submit followed by a cash
   * confirmation on the SAME attempt. The reuse kept "card": release refused
   * an unpaid card order, « Encaisser en espèces » only shows for cash, and
   * the confirmed order could never be settled or cooked.
   */
  test("a retry that switches card to cash re-methods the reused order and settles", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const first = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "card",
        idempotencyKey: "attempt-1",
      })
    )
    const second = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "cash",
        idempotencyKey: "attempt-1",
      })
    )

    // Idempotence holds: one order, no duplicate.
    expect(second).toBe(first)
    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(1)

    // The diner's last confirmed choice is the truth, and the reused order is
    // in the exact state the admin's cash button requires.
    expect(orders[0]?.paymentMethod).toBe("cash")
    expect(orders[0]?.paymentStatus).toBe("pending")

    const asManager = await seedUser(t, "user:switch", "manager", [storeId])
    await asManager.mutation(api.orders.markCashPaid, {
      orderId: second as Id<"orders">,
    })

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
    const settled = await t.run((ctx) => ctx.db.get(second as Id<"orders">))
    expect(settled?.paymentStatus).toBe("paid")
  })

  test("a retry never re-methods an order the kitchen has already been fed", async () => {
    // The reverse direction: a cash order's ticket is on the pass from
    // creation, and a stale duplicated tab retrying the same attempt as card
    // would strand a cooking, unpaid order — method card, release refused,
    // cash button gone. The method the kitchen was fed under stands.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const first = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "cash",
        idempotencyKey: "attempt-1",
      })
    )
    const ticketsBefore = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticketsBefore).toHaveLength(1)

    const second = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "card",
        idempotencyKey: "attempt-1",
      })
    )

    expect(second).toBe(first)
    const order = await t.run((ctx) => ctx.db.get(first as Id<"orders">))
    expect(order?.paymentMethod).toBe("cash")
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
  })

  test("a retry never re-methods an order whose payment has progressed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const first = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "card",
        idempotencyKey: "attempt-1",
      })
    )
    await payOrder(t, first as Id<"orders">)

    const second = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        paymentMethod: "cash",
        idempotencyKey: "attempt-1",
      })
    )

    expect(second).toBe(first)
    const order = await t.run((ctx) => ctx.db.get(first as Id<"orders">))
    // Paid as a card order: the stored method is what actually happened.
    expect(order?.paymentMethod).toBe("card")
  })

  test("does not send a second ticket to the kitchen", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const args = orderArgs(storeId, productId, { idempotencyKey: "attempt-1" })

    const first = await t.mutation(api.orders.create, args)
    const second = await t.mutation(api.orders.create, args)

    // The replay returns the same order, and the payment confirms once.
    expect(second).toBe(first)
    await payOrder(t, first as Id<"orders">)

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
  })

  test("does not burn a second promotion usage", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const promotionId = await t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId,
        name: "Bienvenue",
        triggerMode: "coupon" as const,
        couponCode: "BIENVENUE",
        discountType: "percentage" as const,
        discountValue: 10,
        scope: "order" as const,
        startDate: NOW - 1_000,
        endDate: NOW + 100_000_000_000,
        isActive: true,
        usageCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const args = orderArgs(storeId, productId, {
      idempotencyKey: "attempt-1",
      promotionId,
    })
    await t.mutation(api.orders.create, args)
    await t.mutation(api.orders.create, args)

    const promotion = await t.run((ctx) => ctx.db.get(promotionId))
    expect(promotion?.usageCount).toBe(1)
  })

  test("still lets the customer order twice on purpose", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { idempotencyKey: "attempt-1" })
    )
    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { idempotencyKey: "attempt-2" })
    )

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(2)
  })

  test("keys the replay to one establishment", async () => {
    // Two browsers, two restaurants, the same generated key: not the same order.
    const t = newHarness()
    await seedGlobalSettings(t)
    const a = await seedStore(t)
    const b = await seedStore(t)
    const productA = await seedProduct(t, a)
    const productB = await seedProduct(t, b)

    await t.mutation(
      api.orders.create,
      orderArgs(a, productA, { idempotencyKey: "same-key" })
    )
    await t.mutation(
      api.orders.create,
      orderArgs(b, productB, { idempotencyKey: "same-key" })
    )

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(2)
  })
})

describe("cash taken at the counter", () => {
  test("is recorded as a payment and marks the order paid", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { paymentMethod: "cash" })
    )
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await asManager.mutation(api.orders.markCashPaid, {
      orderId: orderId as Id<"orders">,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.paymentStatus).toBe("paid")

    const payments = await t.run((ctx) => ctx.db.query("payments").collect())
    expect(payments).toHaveLength(1)
    expect(payments[0]?.provider).toBe("cash")
    expect(payments[0]?.status).toBe("succeeded")
    expect(payments[0]?.amount).toBe(order?.total)
  })

  test("does not double-count two members of staff pressing the button", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { paymentMethod: "cash" })
    )
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await asManager.mutation(api.orders.markCashPaid, {
      orderId: orderId as Id<"orders">,
    })
    await asManager.mutation(api.orders.markCashPaid, {
      orderId: orderId as Id<"orders">,
    })

    const payments = await t.run((ctx) => ctx.db.query("payments").collect())
    expect(payments).toHaveLength(1)
  })

  test("is refused to a customer", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { paymentMethod: "cash" })
    )
    const asCustomer = await seedUser(t, "user:c1", "customer", [])

    await expect(
      asCustomer.mutation(api.orders.markCashPaid, {
        orderId: orderId as Id<"orders">,
      })
    ).rejects.toThrow(/Access denied|access/i)
  })
})

describe("cancelling an order", () => {
  test("closes the ticket the kitchen is looking at", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = await t.mutation(api.orders.create, orderArgs(storeId, productId))
    await payOrder(t, orderId as Id<"orders">)
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await asManager.mutation(api.orders.updateStatus, {
      id: orderId as Id<"orders">,
      status: "cancelled" as const,
      cancellationReason: "Le client a changé d’avis",
    })

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets[0]?.status).toBe("cancelled")
  })

  test("leaves a ticket the kitchen already finished alone", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = await t.mutation(api.orders.create, orderArgs(storeId, productId))
    await payOrder(t, orderId as Id<"orders">)
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    const ticket = await t.run(async (ctx) => {
      const found = await ctx.db.query("kitchenTickets").first()
      await ctx.db.patch(found!._id, { status: "completed" as const })
      return found!._id
    })

    await asManager.mutation(api.orders.updateStatus, {
      id: orderId as Id<"orders">,
      status: "cancelled" as const,
    })

    const after = await t.run((ctx) => ctx.db.get(ticket))
    expect(after?.status).toBe("completed")
  })

  /**
   * A cancellation does not move money, and must not pretend it did.
   *
   * Cancelling a paid order used to patch the order AND every succeeded payment
   * to "refunded" with no provider call anywhere — the restaurant read
   * "remboursé" and the customer was never paid back. It was also a one-way
   * door: `planRefund` accepts only "succeeded" and "partially_refunded", so
   * the fake refund made `payments.refundPayment` throw `not_settled` for ever
   * after. `orders:update_status` belongs to the kitchen and delivery roles, so
   * a line cook could fire it.
   *
   * These three go through the real path — the mutation, then the refund action
   * — because the bug lived in the seam between them, where a unit test with a
   * hand-rolled ctx cannot see it.
   */
  async function cancelledPaidOrder() {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = (await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { paymentMethod: "cash" })
    )) as Id<"orders">

    const asManager = await seedUser(t, "user:m1", "manager", [storeId])
    const asOwner = await seedUser(t, "user:a1", "client_admin", [storeId])

    await asManager.mutation(api.orders.markCashPaid, { orderId })
    const paymentId = await t.run(async (ctx) => {
      const payment = await ctx.db.query("payments").first()
      return payment!._id
    })

    await asManager.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "cancelled" as const,
      cancellationReason: "plus de stock",
    })

    return { t, orderId, paymentId, asOwner }
  }

  test("leaves the payment rows untouched", async () => {
    const { t, paymentId } = await cancelledPaidOrder()

    const payment = await t.run((ctx) => ctx.db.get(paymentId))
    expect(payment?.status).toBe("succeeded")
    expect(payment?.refundedAmount).toBeUndefined()
    expect(payment?.refundedAt).toBeUndefined()
  })

  test("flags the order refund_pending, not refunded", async () => {
    const { t, orderId } = await cancelledPaidOrder()

    const order = await t.run((ctx) => ctx.db.get(orderId))
    // "refund_pending" says money is OWED back. "refunded" claimed it was sent.
    expect(order?.paymentStatus).toBe("refund_pending")
  })

  test("leaves the real refund still possible afterwards", async () => {
    const { t, orderId, paymentId, asOwner } = await cancelledPaidOrder()

    // Cash routes to a manual refund, so the whole path runs without a
    // provider. Before the fix this threw `not_settled`.
    const result = await asOwner.action(api.payments.refundPayment, {
      id: paymentId,
      amount: 1_200,
      reason: "plus de stock",
    })
    expect(result.isFullRefund).toBe(true)

    const payment = await t.run((ctx) => ctx.db.get(paymentId))
    expect(payment?.status).toBe("refunded")
    expect(payment?.refundMethod).toBe("manual")

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("refunded")
  })

  test("refuses to take cash again while the refund is still owed", async () => {
    const { t, orderId } = await cancelledPaidOrder()
    const storeId = await t.run(async (ctx) => (await ctx.db.get(orderId))!.storeId)
    const asManager = t.withIdentity({ subject: "user:m1" })

    await expect(
      asManager.mutation(api.orders.markCashPaid, { orderId })
    ).rejects.toThrow(/attente de remboursement/)

    const payments = await t.run((ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_storeId", (q) => q.eq("storeId", storeId))
        .collect()
    )
    expect(payments).toHaveLength(1)
  })
})

/**
 * A cancellation only owes a refund where the restaurant took the money.
 *
 * Since the fake refund was removed, cancelling a paid order flags it
 * `refund_pending` and the admin renders an amber "remboursement dû" banner
 * with a refund button. Uber Eats and Deliveroo orders are created `paid` and
 * never get a `payments` row — the customer paid the platform, `payments`
 * has no provider value for one, and Deliveroo refunds its own customer on a
 * rejection. Those cancellations raised the same banner, so the restaurant was
 * asked to send back money it never held and has no way to send.
 *
 * `source` decides, not the absence of a payment row: a card order is marked
 * paid by `internalUpdatePaymentStatus` and settled by
 * `payments.internalSettle` in a SECOND transaction, so in between a real
 * Stripe order looks exactly like a platform one.
 *
 * Through the real seam, because that is where the two disagreed: the
 * auto-reject path cancels via `internalUpdateStatus`, the status webhooks via
 * `updateFromWebhook`.
 */
describe("cancelling a platform order", () => {
  async function platformOrder(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    platform: "uberEats" | "deliveroo",
    externalOrderId: string
  ) {
    const { orderId } = (await t.mutation(internal.orders.createFromWebhook, {
      storeId,
      externalOrderId,
      platform,
      status: "pending" as const,
      type: "delivery" as const,
      customerName: "Camille",
      items: [{ externalId: "i1", name: "Margherita", quantity: 1, price: 1_200 }],
      subtotal: 1_200,
      total: 1_200,
      createdAt: NOW,
    })) as { orderId: Id<"orders">; created: boolean }
    return orderId
  }

  test("the platform's order really does arrive paid and unbacked", async () => {
    // The premise, asserted rather than assumed. If either half of this ever
    // stops being true the two tests below are measuring nothing.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await platformOrder(t, storeId, "deliveroo", "gb:1")

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("paid")
    expect(order?.source).toBe("deliveroo")

    const payments = await t.run((ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
        .collect()
    )
    expect(payments).toHaveLength(0)
  })

  test("auto-rejecting a Deliveroo order owes nobody a refund", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await platformOrder(t, storeId, "deliveroo", "gb:2")

    // Exactly what `deliverooWebhook`'s auto-reject branch calls.
    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "cancelled" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.status).toBe("cancelled")
    expect(order?.paymentStatus).not.toBe("refund_pending")
  })

  test("cancelling an Uber Eats order owes nobody a refund", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await platformOrder(t, storeId, "uberEats", "ue:1")

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "cancelled" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).not.toBe("refund_pending")
  })

  test("both webhook cancellation routes leave it in the same state", async () => {
    // One platform, one cancellation, two transports. `internalUpdateStatus`
    // used to write `refund_pending` where `updateFromWebhook` left `paid`, so
    // whether a restaurant was billed for a refund depended on which webhook
    // Deliveroo happened to send.
    const t = newHarness()
    const storeId = await seedStore(t)
    const viaStatus = await platformOrder(t, storeId, "deliveroo", "gb:3")
    const viaWebhook = await platformOrder(t, storeId, "deliveroo", "gb:4")

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: viaStatus,
      status: "cancelled" as const,
    })
    await t.mutation(internal.orders.updateFromWebhook, {
      externalOrderId: "gb:4",
      platform: "deliveroo" as const,
      status: "cancelled" as const,
      updatedAt: NOW,
    })

    const a = await t.run((ctx) => ctx.db.get(viaStatus))
    const b = await t.run((ctx) => ctx.db.get(viaWebhook))
    expect(a?.status).toBe("cancelled")
    expect(b?.status).toBe("cancelled")
    expect(a?.paymentStatus).toBe("paid")
    expect(b?.paymentStatus).toBe(a?.paymentStatus)
  })

  test("a direct order the restaurant WAS paid for still owes its refund", async () => {
    // The regression guard. Narrowing the flag to direct orders must not lose
    // it on the orders it was introduced for.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)
    const orderId = (await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { paymentMethod: "cash" })
    )) as Id<"orders">
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await asManager.mutation(api.orders.markCashPaid, { orderId })
    await asManager.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "cancelled" as const,
      cancellationReason: "plus de stock",
    })

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.source).toBe("website")
    expect(order?.paymentStatus).toBe("refund_pending")
  })
})

describe("what the establishment will take an order for", () => {
  test("refuses a basket below the minimum", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 1_500 })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, 330)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, {}, 330))
    ).rejects.toThrow(/15,00 €/)
  })

  test("accepts one that reaches it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 1_500 })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, 1_500)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, {}, 1_500))
    ).resolves.toBeTruthy()
  })

  test("refuses a delivery beyond the radius", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { delivery: { radius: 3 } })
    const storeId = await seedStore(t, BASTILLE)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, {
          type: "delivery" as const,
          deliveryAddress: {
            street: "1 place Charles de Gaulle",
            city: "Paris",
            postalCode: "75008",
            country: "France",
            ...ETOILE,
          },
        })
      )
    ).rejects.toThrow(/zone de livraison/)
  })

  test("accepts one inside it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { delivery: { radius: 10 } })
    const storeId = await seedStore(t, BASTILLE)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, {
          type: "delivery" as const,
          deliveryAddress: {
            street: "1 place Charles de Gaulle",
            city: "Paris",
            postalCode: "75008",
            country: "France",
            ...ETOILE,
          },
        })
      )
    ).resolves.toBeTruthy()
  })

  test("leaves a pickup order alone, however far the customer lives", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { delivery: { radius: 1 } })
    const storeId = await seedStore(t, BASTILLE)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).resolves.toBeTruthy()
  })
})
