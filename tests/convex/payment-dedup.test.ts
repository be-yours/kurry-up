// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * One provider charge is one payment row.
 *
 * THE BUG: two writers settle the same Stripe charge from two different events
 * — the return page (`stripe.verifyCheckoutSession`) and the webhook
 * (`stripeWebhook.handleWebhook`). Each read `order.paymentStatus !== "paid"`
 * and then wrote, in separate transactions, so the loser of that race still
 * inserted. `by_externalId` existed on the payments table and a repository-wide
 * search found exactly one reference to it: its own definition.
 *
 * Every call site wrapped the insert in `try {} catch {}` under the comment
 * "Payment record may already exist". That comment was false — `db.insert` has
 * no duplicate to throw on — and the four `catch` blocks caught nothing.
 *
 * The consequence was not cosmetic: `planRefund` validates each row against its
 * OWN amount, so one 48 € charge recorded twice offered 96 € of refundable
 * balance. That is money out of the restaurant's account.
 *
 * These run the real Convex functions against the real schema, in memory.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { planRefund } from "@be-yours/convex-functions/refundPolicy"
import {
  assertSettlesOrder,
  deliberateSettlementRefusal,
  paymentStatusAfterSettlement,
} from "@be-yours/convex-functions/paymentSettlement"
import {
  abandonedCheckoutSession,
  markCashPaid,
} from "@be-yours/convex-functions/orders"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
/** 48 € in cents — the charge whose duplicate offered 96 € back. */
const CHARGE = 4_800
const INTENT = "pi_3PfakeChargeIntent"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Catalogue and store mutations queue menu syncs through `ctx.scheduler`. A
 * test finishes in milliseconds and leaves them pending; whatever fires them
 * next writes against a closed transaction, and because nothing awaits it that
 * arrives as an unhandled rejection — the run then reports every test green and
 * still exits 1, blaming whichever file happened to be running. Same block as
 * `authorization.test.ts`.
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
      name: "Chez Probe",
      slug: "chez-probe",
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

async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  orderNumber: string,
  total = CHARGE
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber,
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: total,
      taxAmount: 0,
      total,
      paymentStatus: "pending" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

function settlement(storeId: Id<"stores">, orderId: Id<"orders">, externalId = INTENT) {
  return {
    storeId,
    orderId,
    amount: CHARGE,
    currency: "EUR",
    provider: "stripe" as const,
    externalId,
  }
}

async function paymentsFor(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
  return t.run((ctx) =>
    ctx.db
      .query("payments")
      .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
      .collect()
  )
}

describe("settling one charge twice", () => {
  test("writes one row, and says so", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-001")

    // The webhook, then the return page — or the other way round; the point is
    // that these are two different events about one charge.
    const first = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )
    const second = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.paymentId).toBe(first.paymentId)
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("leaves 48 € refundable, not 96 €", async () => {
    // The money question, stated as money. Before the fix this summed to 9600.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-002")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))

    const rows = await paymentsFor(t, orderId)
    const refundable = rows.reduce(
      (sum, row) =>
        sum +
        planRefund({
          payment: {
            provider: row.provider,
            status: row.status,
            amount: row.amount,
            refundedAmount: row.refundedAmount,
            externalId: row.externalId,
          },
          amount: row.amount,
        }).amount,
      0
    )

    expect(refundable).toBe(CHARGE)
  })
})

describe("what a settlement refuses", () => {
  test("refuses one charge settling a second order", async () => {
    // The replay: the same provider reference presented against a different
    // order. `by_externalId` is deliberately SINGLE-field — one provider charge
    // is one row, whatever order claims it. A compound (orderId, externalId)
    // index would read this as a miss and insert.
    const t = newHarness()
    const storeId = await seedStore(t)
    const paidOrder = await seedOrder(t, storeId, "A-003")
    const otherOrder = await seedOrder(t, storeId, "A-004")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, paidOrder))

    await expect(
      t.mutation(internal.payments.internalSettle, settlement(storeId, otherOrder))
    ).rejects.toThrow(/règle déjà la commande/)

    expect(await paymentsFor(t, otherOrder)).toHaveLength(0)
  })

  test("refuses a settlement with no provider reference", async () => {
    // `externalId` is optional on the table because cash has none, and
    // `q.eq("externalId", undefined)` would match every cash payment ever
    // taken. A settlement without a reference can be neither deduplicated nor
    // refunded through the provider, so it is refused rather than stored.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-005")

    for (const empty of ["", "   "]) {
      await expect(
        t.mutation(internal.payments.internalSettle, settlement(storeId, orderId, empty))
      ).rejects.toThrow(/référence de transaction/)
    }

    expect(await paymentsFor(t, orderId)).toHaveLength(0)
  })

  test("refuses a non-positive amount", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-006")

    await expect(
      t.mutation(internal.payments.internalSettle, {
        ...settlement(storeId, orderId),
        amount: 0,
      })
    ).rejects.toThrow(/positive/)
  })
})

describe("the row a settlement leaves", () => {
  test("lands succeeded, with no pending state for anyone to observe", async () => {
    // The old path was `internalCreate` (status "pending") followed by
    // `internalUpdateStatus` — two mutations, so two transactions. When the
    // second never landed the row sat at "pending" for good, and a real
    // payment could not be refunded. One mutation means there is no instant at
    // which a caller could read this row as pending.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-007")

    const { paymentId } = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    const row = await t.run((ctx) => ctx.db.get(paymentId))
    expect(row?.status).toBe("succeeded")
    expect(row?.externalId).toBe(INTENT)
    expect(row?.amount).toBe(CHARGE)
    // Inserted in this state, never patched into it.
    expect(row?.createdAt).toBe(row?.updatedAt)
  })

  test("trims the provider reference it stores", async () => {
    // Otherwise " pi_x" and "pi_x" are two charges as far as the index is
    // concerned, and the deduplication silently stops working.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-008")

    await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId, `  ${INTENT}  `)
    )
    const second = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    expect(second.created).toBe(false)
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })
})

describe("a settlement arriving after cancellation", () => {
  /**
   * The sequence the four provider paths run, replayed here.
   *
   * They are all `"use node"` and dynamically import provider SDKs, so none of
   * them loads under `edge-runtime`. `settlement-binding.test.ts` asserts
   * against the source that all four really do run these two steps in this
   * order; this proves the steps produce the right state.
   */
  async function settleThroughTheCallSitePath(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    orderId: Id<"orders">
  ) {
    const order = await t.run((ctx) => ctx.db.get(orderId))
    const next = paymentStatusAfterSettlement({
      status: order!.status,
      paymentStatus: order!.paymentStatus,
    })
    if (next) {
      await t.mutation(internal.orders.internalUpdatePaymentStatus, {
        id: orderId,
        paymentStatus: next,
      })
    }
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
  }

  test("does not resurrect the order as paid, erasing the refund it owes", async () => {
    // THE BUG. Issue #128 leaves a cancelled paid order at "refund_pending" —
    // money owed back, the payment row still `succeeded` and refundable. The
    // settlement paths guarded with `paymentStatus !== "paid"`, and
    // "refund_pending" !== "paid", so a Stripe retry (up to three days of them)
    // or a guest refreshing the success tab wrote "paid" straight back over the
    // marker. The amber "Remboursement à effectuer" banner and the "Rembourser
    // le client" action then disappear from the admin, and nothing anywhere
    // still records that the restaurant owes the money.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-009")

    // 1. The customer pays.
    await settleThroughTheCallSitePath(t, storeId, orderId)
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("paid")

    // 2. The kitchen cancels: money owed back, payment left refundable.
    await t.run(async (ctx) => {
      await ctx.db.patch(orderId, {
        status: "cancelled" as const,
        paymentStatus: "refund_pending" as const,
        updatedAt: NOW + 1,
      })
    })

    // 3. Stripe retries, or the customer refreshes the success tab.
    await settleThroughTheCallSitePath(t, storeId, orderId)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("refund_pending")
    expect(order?.status).toBe("cancelled")

    // And the money is still there to give back: one row, still refundable.
    const rows = await paymentsFor(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("succeeded")
    expect(rows[0].refundedAmount).toBeUndefined()
  })

  test("records the payment and owes it back when the order was cancelled first", async () => {
    // Cancelled while still unpaid, then the payment lands anyway — the
    // customer did pay, for something nobody will deliver. The row must exist
    // or there is nothing to refund against, and the order must say the money
    // is owed rather than claiming to be a paid cancelled order.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-010")

    await t.run((ctx) =>
      ctx.db.patch(orderId, { status: "cancelled" as const, updatedAt: NOW + 1 })
    )

    await settleThroughTheCallSitePath(t, storeId, orderId)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("refund_pending")
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("does not write paid over a refund already made", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-011")

    await settleThroughTheCallSitePath(t, storeId, orderId)
    await t.run((ctx) =>
      ctx.db.patch(orderId, {
        status: "cancelled" as const,
        paymentStatus: "refunded" as const,
        updatedAt: NOW + 1,
      })
    )

    await settleThroughTheCallSitePath(t, storeId, orderId)

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("refunded")
  })
})

// ============================================================================
// One order, collected twice — #378
// ============================================================================

describe("one order collected twice", () => {
  /**
   * The full provider path, guard included.
   *
   * `settleThroughTheCallSitePath` above replays the two steps that decide what
   * an arriving payment does to the ORDER. This one adds the step before them:
   * the binding `assertSettlesOrder` performs, which is where a settlement is
   * refused outright. All four provider paths run these three in this order —
   * `settlement-binding.test.ts` asserts that against their source, since none
   * of them loads under `edge-runtime`.
   */
  async function settleLiveCardSession(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    orderId: Id<"orders">
  ) {
    const order = await t.run((ctx) => ctx.db.get(orderId))

    assertSettlesOrder(
      {
        provider: "stripe",
        reference: orderId,
        amountMinor: order!.total,
        currency: "EUR",
      },
      {
        orderId,
        total: order!.total,
        paymentMethod: order!.paymentMethod,
        paymentStatus: order!.paymentStatus,
      }
    )

    const next = paymentStatusAfterSettlement({
      status: order!.status,
      paymentStatus: order!.paymentStatus,
    })
    if (next) {
      await t.mutation(internal.orders.internalUpdatePaymentStatus, {
        id: orderId,
        paymentStatus: next,
      })
    }
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
  }

  /** Step 2 of the reproduction: #374 re-methods the reused order to cash. */
  async function reMethodToCash(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
    await t.run((ctx) =>
      ctx.db.patch(orderId, { paymentMethod: "cash", updatedAt: NOW + 1 })
    )
  }

  test("refuses the live card session once the counter has taken the cash", async () => {
    // THE BUG, replayed end to end.
    //
    //  1. The diner submits with card: the order is `paymentMethod: "card"`,
    //     `paymentStatus: "pending"`, and the Stripe session id is recorded.
    //     That session stays payable for ~24 h.
    //  2. They press Back and confirm « Espèces » on the same attempt. Since
    //     #374 the reused order is re-methoded to cash — correct, and the point
    //     of that fix.
    //  3. Staff take the notes: a `cash` payment row, order `paid`.
    //  4. The still-live Stripe session is completed from the tab left open.
    //  5. Identity, currency and amount all match — it IS this order at this
    //     total — and `paymentStatusAfterSettlement` answers null for an
    //     already-paid order, so the order looked untouched while a second
    //     `succeeded` row went in beside the cash one. `settlePayment`
    //     deduplicates on `externalId`, and a cash row has none.
    //
    // Verbatim probe output on the unfixed code, from the issue:
    //   PROBE order total: 1200 collected: 2400
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-1")

    await t.run((ctx) =>
      ctx.db.patch(orderId, {
        paymentMethod: "card",
        stripeCheckoutSessionId: "cs_test_378",
        updatedAt: NOW,
      })
    )
    await reMethodToCash(t, orderId)

    // The real thing, not a fixture of it: this is what the « Encaisser en
    // espèces » button runs.
    await t.run((ctx) => markCashPaid.handler(ctx, { orderId }))

    await expect(settleLiveCardSession(t, storeId, orderId)).rejects.toThrow(
      /déjà été réglée/
    )

    // One meal, collected once.
    const rows = await paymentsFor(t, orderId)
    const succeeded = rows.filter((row) => row.status === "succeeded")
    expect(succeeded).toHaveLength(1)
    expect(succeeded[0].provider).toBe("cash")
    expect(succeeded.reduce((sum, row) => sum + row.amount, 0)).toBe(CHARGE)
  })

  test("still settles a card payment that arrives before any cash", async () => {
    // The guard must not be satisfiable by refusing everything. A card order
    // paid by card settles exactly as it always did — and the cash button then
    // refuses to take the money a second time, which is `markCashPaid`'s own
    // guard doing its half.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-2")

    await t.run((ctx) =>
      ctx.db.patch(orderId, { paymentMethod: "card", updatedAt: NOW })
    )

    await settleLiveCardSession(t, storeId, orderId)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("paid")

    const rows = await paymentsFor(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe("stripe")

    // And the counter cannot then take the notes on top of it.
    const cash = await t.run((ctx) => markCashPaid.handler(ctx, { orderId }))
    expect(cash.paymentId).toBeNull()
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("lets a replayed Stripe delivery through without writing a second row", async () => {
    // Stripe redelivers for up to three days, and the return page settles the
    // same charge from a different event. Neither may be refused — a throw is a
    // 500 answered with more retries — and neither may write a second row.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-3")

    await t.run((ctx) =>
      ctx.db.patch(orderId, { paymentMethod: "card", updatedAt: NOW })
    )

    await settleLiveCardSession(t, storeId, orderId)
    await settleLiveCardSession(t, storeId, orderId)

    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("the ledger refuses a second collection even with the guard skipped", async () => {
    // Defence in depth, and the reason it is not redundant: five provider paths
    // remember to ask `assertSettlesOrder`, and the sixth one written next year
    // would not have to. `settlePayment` is the single seam every provider
    // settlement passes through, so the invariant is stated there too — this
    // call bypasses the guard entirely, exactly as a forgetful new path would.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-4")

    await t.run((ctx) =>
      ctx.db.patch(orderId, { paymentMethod: "cash", updatedAt: NOW })
    )
    await t.run((ctx) => markCashPaid.handler(ctx, { orderId }))

    await expect(
      t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    ).rejects.toThrow(/double encaissement/)

    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })
})

// ============================================================================
// The session behind the abandoned checkout — #378, prevention
// ============================================================================

describe("the Stripe session an order has stopped needing", () => {
  test("is handed back for expiry once the order is no longer a card order", async () => {
    // A mutation cannot call Stripe, so `orders.create` asks this and schedules
    // `stripe.expireCheckoutSession` with the answer. Expiring the session is
    // what stops the second charge being TAKEN — the difference between the
    // diner being made whole afterwards and never being charged at all.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-5")

    await t.run((ctx) =>
      ctx.db.patch(orderId, {
        paymentMethod: "card",
        stripeCheckoutSessionId: "cs_test_abandoned",
        updatedAt: NOW,
      })
    )

    // Still a card order: the session is the one it is going to pay with.
    expect(await t.run((ctx) => abandonedCheckoutSession(ctx, orderId))).toBeNull()

    // #374 re-methods it to cash. Now the session is a way to collect the same
    // order twice.
    await t.run((ctx) => ctx.db.patch(orderId, { paymentMethod: "cash" }))
    expect(await t.run((ctx) => abandonedCheckoutSession(ctx, orderId))).toBe(
      "cs_test_abandoned"
    )

    // The id stays ON the order: it is the only pointer
    // `reconcilePendingCheckouts` has, and the one case where the expiry fails
    // is a session Stripe refuses to expire because it has already been paid —
    // exactly when that pointer is what recovers the money.
    expect(
      (await t.run((ctx) => ctx.db.get(orderId)))?.stripeCheckoutSessionId
    ).toBe("cs_test_abandoned")
  })

  test("answers null for an order that never had one", async () => {
    // Cash from the start, PayPal, and every platform order.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-378-6")

    await t.run((ctx) => ctx.db.patch(orderId, { paymentMethod: "cash" }))
    expect(await t.run((ctx) => abandonedCheckoutSession(ctx, orderId))).toBeNull()
  })
})
// ============================================================================
// Two live card sessions on one order — #411
// ============================================================================

/**
 * The vector #378 did not cover.
 *
 * #378 closed cash-then-card: `assertSettlesOrder` refuses a card settlement
 * on an order the counter has already collected, because the ORDER records
 * which method it is on and the two differ. Two card sessions differ in
 * nothing it can see. A diner who opens checkout twice — a stale tab, a
 * back-navigation, a retry — leaves two live Stripe Checkout Sessions against
 * one order; both reference that order, that currency and that total, so the
 * guard passes both, and both are `card`, so the method check does not
 * separate them.
 *
 * Verbatim probe output on the unfixed code:
 *   [PROBE] order total: 120000  collected: 240000
 *   [PROBE] succeeded rows: 2
 *   [PROBE] second session refused: false
 *
 * A 1 200 € order collected 2 400 €, in two `succeeded` rows, each
 * independently refundable, with the order untouched and nothing anywhere
 * saying so.
 */
describe("one order, two live card sessions", () => {
  /** The full provider path for ONE completed session. */
  async function completeCardSession(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    orderId: Id<"orders">,
    paymentIntent: string
  ) {
    const order = await t.run((ctx) => ctx.db.get(orderId))

    assertSettlesOrder(
      {
        provider: "stripe",
        reference: orderId,
        amountMinor: order!.total,
        currency: "EUR",
      },
      {
        orderId,
        total: order!.total,
        paymentMethod: order!.paymentMethod,
        paymentStatus: order!.paymentStatus,
      }
    )

    const next = paymentStatusAfterSettlement({
      status: order!.status,
      paymentStatus: order!.paymentStatus,
    })
    if (next) {
      await t.mutation(internal.orders.internalUpdatePaymentStatus, {
        id: orderId,
        paymentStatus: next,
      })
    }
    await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId, paymentIntent)
    )
  }

  async function cardOrder(t: ReturnType<typeof convexTest>, number: string) {
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, number)
    await t.run((ctx) =>
      ctx.db.patch(orderId, { paymentMethod: "card", updatedAt: NOW })
    )
    return { storeId, orderId }
  }

  test("collects the order once, however many sessions were completed", async () => {
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-1")

    await completeCardSession(t, storeId, orderId, "pi_session_A")
    await expect(
      completeCardSession(t, storeId, orderId, "pi_session_B")
    ).rejects.toThrow(/double encaissement/)

    const succeeded = (await paymentsFor(t, orderId)).filter(
      (row) => row.status === "succeeded"
    )
    expect(succeeded).toHaveLength(1)
    expect(succeeded.reduce((sum, row) => sum + row.amount, 0)).toBe(CHARGE)
  })

  test("refuses the third and the fourth as well", async () => {
    // The rule is about the ORDER, not about "the second one". A diner who
    // reloads a tab four times must not be able to grind past it.
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-2")

    await completeCardSession(t, storeId, orderId, "pi_1")
    for (const intent of ["pi_2", "pi_3", "pi_4"]) {
      await expect(
        completeCardSession(t, storeId, orderId, intent)
      ).rejects.toThrow(/double encaissement/)
    }

    expect(
      (await paymentsFor(t, orderId)).filter((r) => r.status === "succeeded")
    ).toHaveLength(1)
  })

  test("refuses in a form the webhook can tell from a crash", async () => {
    // The other half of #411: the refusal used to reach the webhook as an
    // opaque throw and be answered 500, so Stripe retried a permanent refusal
    // for three days. `deliberateSettlementRefusal` is what the route reads,
    // and it reads `data`, not the class — Convex rebuilds the error across
    // the mutation boundary and the instance does not survive.
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-3")

    await completeCardSession(t, storeId, orderId, "pi_1")

    const refused = await completeCardSession(t, storeId, orderId, "pi_2").then(
      () => null,
      (error: unknown) => error
    )
    expect(refused).not.toBeNull()
    expect(deliberateSettlementRefusal(refused)?.code).toBe(
      "order_already_collected"
    )
  })

  test("still lets the FIRST card session settle", async () => {
    // A rule satisfied by refusing everything would take the diner's money and
    // record nothing.
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-4")

    await completeCardSession(t, storeId, orderId, "pi_only")

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("paid")
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("still lets the SAME session be redelivered, writing nothing", async () => {
    // Stripe redelivers for up to three days, and the return page settles the
    // same charge from a different event. Neither may be refused: a throw is a
    // 500 answered with more retries. This is what the removed
    // `p.provider !== args.provider` clause was mistaken for.
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-5")

    await completeCardSession(t, storeId, orderId, "pi_same")
    await completeCardSession(t, storeId, orderId, "pi_same")

    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("refuses a second collection from ANY provider, not just another one", async () => {
    // The clause that was removed only refused a DIFFERENT provider, so PayPal
    // after Stripe was caught and Stripe after Stripe was not. Both are one
    // order collected twice.
    const t = newHarness()
    const { storeId, orderId } = await cardOrder(t, "A-411-6")

    await completeCardSession(t, storeId, orderId, "pi_card")

    await expect(
      t.mutation(internal.payments.internalSettle, {
        storeId,
        orderId,
        amount: CHARGE,
        currency: "EUR",
        provider: "paypal" as const,
        externalId: "capture_1",
      })
    ).rejects.toThrow(/double encaissement/)

    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })
})

// ============================================================================
// Telling somebody a second charge was taken — #411
// ============================================================================

describe("a refused collection is written down", () => {
  test("names the order, the charge and the reason where an operator reads them", async () => {
    // Refusing the row keeps the LEDGER right. It does not make the diner
    // whole: the provider does not report a charge it did not take, so by the
    // time the refusal fires the money has left their account a second time.
    // Before this, the only trace was a `console.error` in one client's Convex
    // dashboard — which is to say, nobody was told.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-7")

    await t.mutation(internal.payments.internalRecordRefusedCollection, {
      provider: "stripe",
      code: "order_already_collected",
      message: "Cette commande a déjà été encaissée (stripe).",
      externalId: "pi_second",
      eventType: "checkout.session.completed",
      orderId,
      storeId,
    })

    const entries = await t.run((ctx) =>
      ctx.db.query("systemAuditLog").collect()
    )
    const refusal = entries.find(
      (e) => e.action === "payment_collection_refused"
    )
    expect(refusal).toBeDefined()
    expect(refusal?.result).toBe("failure")
    expect(refusal?.targetStoreId).toBe(storeId)
    expect(refusal?.errorMessage).toContain("déjà été encaissée")

    const details = JSON.parse(refusal!.details!)
    expect(details).toMatchObject({
      code: "order_already_collected",
      provider: "stripe",
      orderId,
      externalId: "pi_second",
      eventType: "checkout.session.completed",
    })
  })

  test("records what it can when the delivery named no order", async () => {
    // A `payment_intent.succeeded` carries no `metadata.orderId`. The entry is
    // still worth writing: the payment intent is what a human takes to Stripe.
    const t = newHarness()

    await t.mutation(internal.payments.internalRecordRefusedCollection, {
      provider: "stripe",
      code: "charge_settles_another_order",
      message: "Ce paiement stripe règle déjà la commande orders:9.",
      externalId: "pi_orphan",
    })

    const entries = await t.run((ctx) =>
      ctx.db.query("systemAuditLog").collect()
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].targetStoreId).toBeUndefined()
    expect(JSON.parse(entries[0].details!).externalId).toBe("pi_orphan")
  })
})
// ============================================================================
// The two other writers that reach the payments table — #411
// ============================================================================

/**
 * The invariant is the LEDGER's, or it is nobody's.
 *
 * #411's first fix stated "one order, one collection" inside `settlePayment`
 * and claimed it was "a property of the ledger rather than of five call sites
 * remembering to ask a guard". Two other writers reach the same table and
 * asked nothing: `orders.markCashPaid` inserts a `succeeded` row directly, and
 * `payments.create` + `payments.updateStatus` is a public pair under
 * `payments:write` that writes one in two steps. Either could put a second
 * collection on an order the four provider paths would have refused.
 */
describe("every writer asks the ledger, not only the provider paths", () => {
  test("the cash button refuses an order a card has already collected", async () => {
    // The reachable shape: a settlement writes the payment row and the order
    // status in two transactions, so between them the order reads `pending`
    // with a `succeeded` row against it — and `markCashPaid`'s four status
    // checks all wave the notes through.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-W1")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe(
      "pending"
    )

    await expect(
      t.run((ctx) => markCashPaid.handler(ctx, { orderId }))
    ).rejects.toThrow(/déjà été encaissée/)

    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("the cash button still works on an order nothing has collected", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-W2")

    const { paymentId } = await t.run((ctx) =>
      markCashPaid.handler(ctx, { orderId })
    )
    expect(paymentId).not.toBeNull()
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("a manual status promotion cannot write a second collection", async () => {
    // `payments.create` inserts at `pending` under `payments:write` and
    // `updateStatus` promotes it. Nothing calls the pair today — which is
    // exactly why nothing would have noticed.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-W3")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))

    const secondRow = await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "sumup" as const,
      externalId: "sumup_manual_1",
    })

    await expect(
      t.mutation(internal.payments.internalUpdateStatus, {
        id: secondRow,
        status: "succeeded" as const,
      })
    ).rejects.toThrow(/double encaissement/)

    const succeeded = (await paymentsFor(t, orderId)).filter(
      (row) => row.status === "succeeded"
    )
    expect(succeeded).toHaveLength(1)
  })

  test("a promotion still works on the only row an order has", async () => {
    // The guard must not be satisfiable by refusing everything, and it must
    // not refuse a row promoting ITSELF.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-W4")

    const rowId = await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "sumup" as const,
      externalId: "sumup_manual_2",
    })

    await t.mutation(internal.payments.internalUpdateStatus, {
      id: rowId,
      status: "succeeded" as const,
    })

    const rows = await paymentsFor(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("succeeded")

    // And re-promoting the same row is not a second collection either.
    await t.mutation(internal.payments.internalUpdateStatus, {
      id: rowId,
      status: "succeeded" as const,
    })
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("a failed row is not a collection and does not block one", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-411-W5")

    const rowId = await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "sumup" as const,
      externalId: "sumup_declined",
    })
    await t.mutation(internal.payments.internalUpdateStatus, {
      id: rowId,
      status: "failed" as const,
    })

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    expect(
      (await paymentsFor(t, orderId)).filter((r) => r.status === "succeeded")
    ).toHaveLength(1)
  })
})

// ============================================================================
// A settlement landing on a row that is still a placeholder
// ============================================================================

/**
 * A `pending` row is not a settlement, and treating it as one hid the charge.
 *
 * `settlePayment` recognised "a row for this charge on this order exists" and
 * returned it untouched. `settleByExternalReference` — the handler behind
 * `payment_intent.succeeded` — then marked the ORDER paid off the back of it.
 * The result was an order reading « Payé » over a `pending` payment row, which
 * is the worst of both: `planRefund` accepts only `succeeded` and
 * `partially_refunded`, so the charge could never be given back through the
 * product; and `collectionOnOrder` counts the same two, so the order read as
 * holding no money and a second collection was still allowed on it.
 */
describe("a settlement promotes the placeholder it lands on", () => {
  test("a pending row for the same charge is promoted, not left behind", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S1")

    // What `payments.create` writes: the charge is known, nothing has been
    // heard from the provider yet.
    const rowId = await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: INTENT,
    })

    const settled = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    // The same row, not a second one.
    expect(settled.paymentId).toBe(rowId)
    expect(settled.created).toBe(true)

    const rows = await paymentsFor(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("succeeded")
  })

  test("the promoted row is refundable, which the pending one was not", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S2")

    await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: INTENT,
    })
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))

    const [row] = await paymentsFor(t, orderId)
    // The check that was permanently failing: money taken and no way to give
    // it back through the product.
    expect(() =>
      planRefund({
        payment: {
          provider: row.provider,
          status: row.status,
          amount: row.amount,
          refundedAmount: row.refundedAmount,
          externalId: row.externalId,
        },
        amount: row.amount,
      })
    ).not.toThrow()
  })

  test("the promoted row closes the order to a second collection", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S3")

    await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: INTENT,
    })
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))

    // Cash at the counter on an order a card has now really collected.
    await expect(
      t.run((ctx) => markCashPaid.handler(ctx, { orderId }))
    ).rejects.toThrow(/déjà été encaissée/)
  })

  test("the settlement's provider wins, so the refund goes where the money is", async () => {
    // A placeholder naming the wrong provider is worse than no row: a refund
    // is issued against whatever that field says.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S4")

    await t.mutation(internal.payments.internalCreate, {
      storeId,
      orderId,
      amount: 1,
      currency: "usd",
      provider: "cash" as const,
      externalId: INTENT,
    })
    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))

    const [row] = await paymentsFor(t, orderId)
    expect(row.provider).toBe("stripe")
    expect(row.amount).toBe(CHARGE)
    expect(row.currency).toBe("EUR")
  })

  test("a charge already on the ledger is still recognised and not rewritten", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S5")

    const first = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )
    const second = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    expect(second.paymentId).toBe(first.paymentId)
    expect(second.created).toBe(false)
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("a refunded charge is not resurrected by a replayed event", async () => {
    // The money went back. A provider event arriving afterwards must not put
    // the row back to `succeeded` and make it refundable a second time.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "A-P2-S6")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    const [settled] = await paymentsFor(t, orderId)
    await t.run((ctx) =>
      ctx.db.patch(settled._id, { status: "refunded", refundedAmount: CHARGE })
    )

    const replay = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )
    expect(replay.created).toBe(false)

    const rows = await paymentsFor(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("refunded")
  })
})
