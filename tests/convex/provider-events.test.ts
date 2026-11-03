// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What the provider tells us after the checkout is over.
 *
 * THE BUG: the Stripe webhook understood one event, `checkout.session.completed`,
 * and answered 200 to the rest. Two of the discarded four are money.
 *
 *  - A guest who pays and closes the tab never reaches the confirmation page.
 *    If the checkout delivery is lost as well, the charge sits in Stripe behind
 *    an order at `paymentStatus: "pending"`: money taken, kitchen blind, and
 *    nothing that would ever notice. `payment_intent.succeeded` is the second
 *    chance, and the reconciliation sweep is the third — the one that works even
 *    when Stripe never delivered anything at all.
 *  - A refund issued from the Stripe dashboard moved real money and left our
 *    `refundedAmount` untouched. The admin accepts `partially_refunded` as a
 *    refundable state, so a stale balance is an operator being offered money
 *    that is no longer there. `planRefund` refuses the overshoot server-side, so
 *    nothing is lost twice — what the operator gets is an error about a balance
 *    no screen ever showed them.
 *
 * `stripeWebhook` is an `httpAction` calling a `"use node"` verifier that
 * imports the Stripe SDK, so neither loads under `edge-runtime`.
 * `stripe-event-coverage.test.ts` asserts against the source that the route
 * reaches these mutations; this file runs the mutations for real, against the
 * real schema, in memory.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { planRefund } from "@be-yours/convex-functions/refundPolicy"
import { paymentStatusAfterSettlement } from "@be-yours/convex-functions/paymentSettlement"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
/** 48 € in cents. */
const CHARGE = 4_800
const INTENT = "pi_3ProviderEventCharge"
const SESSION = "cs_test_ProviderEventCheckout"
const MINUTE = 60_000
const HOUR = 60 * MINUTE

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
 * `payment-dedup.test.ts`.
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
      name: "Chez Camille",
      slug: "chez-camille",
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
  overrides: {
    createdAt?: number
    total?: number
    stripeCheckoutSessionId?: string
  } = {}
) {
  const createdAt = overrides.createdAt ?? NOW
  const total = overrides.total ?? CHARGE
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
      ...(overrides.stripeCheckoutSessionId
        ? { stripeCheckoutSessionId: overrides.stripeCheckoutSessionId }
        : {}),
      createdAt,
      updatedAt: createdAt,
    })
  )
}

function settlement(
  storeId: Id<"stores">,
  orderId: Id<"orders">,
  externalId = INTENT,
  amount = CHARGE
) {
  return {
    storeId,
    orderId,
    amount,
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

/** What `planRefund` says is still refundable on a row, in cents. */
async function refundableBalance(
  t: ReturnType<typeof convexTest>,
  paymentId: Id<"payments">
): Promise<number> {
  const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
  const remaining = row.amount - (row.refundedAmount ?? 0)
  if (remaining <= 0) return 0
  return planRefund({
    payment: {
      provider: row.provider,
      status: row.status,
      amount: row.amount,
      refundedAmount: row.refundedAmount,
      externalId: row.externalId,
    },
    amount: remaining,
  }).amount
}

describe("payment_intent.succeeded — the redundant confirmation", () => {
  test("the return page already won: still exactly one payment row", async () => {
    // The whole point of routing this through `settlePayment` rather than
    // writing directly. Two different events describe one charge, and the
    // second must find the row and write nothing.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "P-001")

    const first = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    const outcome = await t.mutation(internal.payments.internalSettleFromCharge, {
      provider: "stripe" as const,
      externalId: INTENT,
    })

    expect(outcome.status).toBe("settled")
    expect(outcome.created).toBe(false)
    expect(outcome.paymentId).toBe(first.paymentId)
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("closes an order the settlement left behind", async () => {
    // The rescue. The payment row exists — the money moved — and the order was
    // never advanced past `pending`, so the kitchen has a paid order it cannot
    // see. This event is what notices.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "P-002")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("pending")

    await t.mutation(internal.payments.internalSettleFromCharge, {
      provider: "stripe" as const,
      externalId: INTENT,
    })

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("paid")
  })

  test("does not resurrect a cancelled order as paid", async () => {
    // Same rule as every other settlement path: an order paid and then
    // cancelled sits at `refund_pending`, and "refund_pending" !== "paid" is
    // exactly how the older code erased the marker.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "P-003")

    await t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
    await t.run((ctx) =>
      ctx.db.patch(orderId, {
        status: "cancelled" as const,
        paymentStatus: "refund_pending" as const,
        updatedAt: NOW + 1,
      })
    )

    await t.mutation(internal.payments.internalSettleFromCharge, {
      provider: "stripe" as const,
      externalId: INTENT,
    })

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("refund_pending")
  })

  test("a charge we hold no row for is reported, not thrown on", async () => {
    // It may be a stranded checkout — the reconciliation sweep owns that, since
    // recovering it needs the session id this event does not carry — or it may
    // simply not be ours. Throwing would earn three days of Stripe retries for
    // something no retry can fix.
    const t = newHarness()
    await seedStore(t)

    const outcome = await t.mutation(internal.payments.internalSettleFromCharge, {
      provider: "stripe" as const,
      externalId: "pi_neverSeenHere",
    })

    expect(outcome.status).toBe("unknown_charge")
  })

  test("refuses a reference belonging to another provider", async () => {
    // `by_externalId` spans every provider, so a SumUp reference that happens
    // to equal a Stripe intent id must not be settled by a Stripe event.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "P-004")

    await t.mutation(internal.payments.internalSettle, {
      ...settlement(storeId, orderId),
      provider: "sumup" as const,
    })

    const outcome = await t.mutation(internal.payments.internalSettleFromCharge, {
      provider: "stripe" as const,
      externalId: INTENT,
    })

    expect(outcome.status).toBe("provider_mismatch")
  })
})

describe("charge.refunded — a refund issued outside our UI", () => {
  async function settledPayment(t: ReturnType<typeof convexTest>, orderNumber: string) {
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, orderNumber)
    const { paymentId } = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )
    return { storeId, orderId, paymentId: paymentId as Id<"payments"> }
  }

  test("a partial refund leaves exactly the remainder refundable", async () => {
    // THE MONEY QUESTION. 18 € went back from the Stripe dashboard. Before this
    // handler existed the balance still read 48 €, and the admin — which now
    // treats `partially_refunded` as refundable — offered all of it.
    const t = newHarness()
    const { paymentId } = await settledPayment(t, "R-001")

    const outcome = await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: 1_800,
      reason: "Remboursement effectué depuis le tableau de bord Stripe",
      externalRefundId: "ch_dashboardRefund",
    })

    expect(outcome.status).toBe("recorded")
    expect(outcome.refundedAmount).toBe(1_800)
    expect(await refundableBalance(t, paymentId)).toBe(CHARGE - 1_800)

    const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
    expect(row.status).toBe("partially_refunded")
    // One cent past the remainder is refused, which is the balance being real.
    expect(() =>
      planRefund({
        payment: {
          provider: row.provider,
          status: row.status,
          amount: row.amount,
          refundedAmount: row.refundedAmount,
          externalId: row.externalId,
        },
        amount: CHARGE - 1_800 + 1,
      })
    ).toThrow(/solde restant/)
  })

  test("a full refund leaves nothing refundable, and says so on the order", async () => {
    const t = newHarness()
    const { orderId, paymentId } = await settledPayment(t, "R-002")

    await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: CHARGE,
      reason: "Remboursement effectué depuis le tableau de bord Stripe",
    })

    expect(await refundableBalance(t, paymentId)).toBe(0)
    expect((await t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("refunded")
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("refunded")
  })

  test("a replayed delivery reports the same total and writes nothing", async () => {
    // Stripe's `amount_refunded` is CUMULATIVE for the charge, which is what
    // makes recording it as a total — rather than adding a delta — safe to
    // receive twice.
    const t = newHarness()
    const { paymentId } = await settledPayment(t, "R-003")

    const args = {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: 1_800,
      externalRefundId: "ch_dashboardRefund",
    }

    await t.mutation(internal.payments.internalRecordProviderRefund, args)
    const replay = await t.mutation(internal.payments.internalRecordProviderRefund, args)

    expect(replay.status).toBe("already_recorded")
    expect(replay.refundedAmount).toBe(1_800)

    const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
    expect(row.refundedAmount).toBe(1_800)
    // And the history did not grow a phantom second refund.
    expect(row.refunds ?? []).toHaveLength(1)
  })

  test("a second dashboard refund raises the total to the new cumulative figure", async () => {
    const t = newHarness()
    const { paymentId } = await settledPayment(t, "R-004")

    await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: 1_800,
    })
    await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: 3_000,
    })

    const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
    expect(row.refundedAmount).toBe(3_000)
    expect(await refundableBalance(t, paymentId)).toBe(CHARGE - 3_000)
    // Two entries summing to the balance, not one overwriting the other.
    expect((row.refunds ?? []).map((r) => r.amount)).toEqual([1_800, 1_200])
  })

  test("never lowers a balance a refund in flight has already committed", async () => {
    // `reserveRefund` commits the amount BEFORE calling the provider, which is
    // what stops two concurrent refunds both leaving. An event minted before
    // that reservation reports a smaller total; writing it back would hand the
    // reserved amount out to be spent a second time.
    const t = newHarness()
    const { paymentId } = await settledPayment(t, "R-005")

    await t.mutation(internal.payments.internalReserveRefund, {
      id: paymentId,
      amount: 3_000,
      refundMethod: "api" as const,
    })

    const outcome = await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: 1_800,
    })

    expect(outcome.status).toBe("already_recorded")
    expect((await t.run((ctx) => ctx.db.get(paymentId)))?.refundedAmount).toBe(3_000)
  })

  test("clamps a reported total larger than the charge", async () => {
    const t = newHarness()
    const { paymentId } = await settledPayment(t, "R-006")

    await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: CHARGE * 10,
    })

    const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
    expect(row.refundedAmount).toBe(CHARGE)
    expect(row.status).toBe("refunded")
  })

  test("a charge we hold no row for is reported, not thrown on", async () => {
    const t = newHarness()
    await seedStore(t)

    const outcome = await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: "pi_notOurCharge",
      refundedTotalMinor: 1_000,
    })

    expect(outcome.status).toBe("unknown_charge")
  })
})

describe("charge.dispute.created — money Stripe takes back", () => {
  test("stops the disputed amount being offered as refundable", async () => {
    // A chargeback is not a refund, but it empties the same pocket. Recorded
    // through the same mutation with the disputed amount, so an operator cannot
    // then refund money Stripe has already pulled back.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "D-001")
    const { paymentId } = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )

    await t.mutation(internal.payments.internalRecordProviderRefund, {
      provider: "stripe" as const,
      externalId: INTENT,
      refundedTotalMinor: CHARGE,
      reason: "Litige / rétrofacturation (fraudulent)",
      externalRefundId: "ch_disputed",
    })

    expect(await refundableBalance(t, paymentId as Id<"payments">)).toBe(0)
    const row = (await t.run((ctx) => ctx.db.get(paymentId as Id<"payments">)))!
    expect(row.refundReason).toContain("Litige")
  })
})

describe("one delivery, handled once", () => {
  test("a replayed event id is already_processed", async () => {
    // Stripe retries until it gets a 2xx and repeats deliveries even after one.
    // This is the guard that stops ONE delivery running the handler twice —
    // separate from the payment-intent deduplication, which stops two DIFFERENT
    // events writing two rows.
    const t = newHarness()
    const args = {
      provider: "stripe",
      eventId: "evt_replayedDelivery",
      eventType: "charge.refunded",
    }

    expect(await t.mutation(internal.paymentEvents.beginEvent, args)).toBe("fresh")
    await t.mutation(internal.paymentEvents.markProcessed, {
      provider: "stripe",
      eventId: args.eventId,
    })
    expect(await t.mutation(internal.paymentEvents.beginEvent, args)).toBe("already_processed")
  })

  test("a delivery that never finished is let through again", async () => {
    // A handler that threw returns 500 and leaves the row unprocessed on
    // purpose, so Stripe's retry finishes the job rather than being swallowed.
    const t = newHarness()
    const args = {
      provider: "stripe",
      eventId: "evt_diedHalfway",
      eventType: "payment_intent.succeeded",
    }

    expect(await t.mutation(internal.paymentEvents.beginEvent, args)).toBe("fresh")
    expect(await t.mutation(internal.paymentEvents.beginEvent, args)).toBe("in_flight")
  })
})

describe("the checkout Stripe never reported", () => {
  test("is found once it is old enough to be stranded", async () => {
    // The reconciliation candidate set. Nothing could produce this before: the
    // session id was handed to the browser and stored nowhere, so a paid order
    // stuck at `pending` could not even be named to Stripe.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-001", {
      createdAt: NOW - 30 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })

    const stranded = await t.query(internal.payments.internalListStrandedCheckouts, {
      now: NOW,
      minAgeMinutes: 10,
      maxAgeHours: 24,
    })

    expect(stranded.map((c) => c.orderId)).toContain(orderId)
    expect(stranded.find((c) => c.orderId === orderId)?.checkoutSessionId).toBe(SESSION)
  })

  test("is left alone while the customer may still be paying", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-002", {
      createdAt: NOW - 2 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })

    const stranded = await t.query(internal.payments.internalListStrandedCheckouts, {
      now: NOW,
      minAgeMinutes: 10,
    })

    expect(stranded.map((c) => c.orderId)).not.toContain(orderId)
  })

  test("is dropped once the session has expired on Stripe's side", async () => {
    // Past 24 h there is nothing left to retrieve, so scanning for it is work
    // that can only ever fail.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-003", {
      createdAt: NOW - 30 * HOUR,
      stripeCheckoutSessionId: SESSION,
    })

    const stranded = await t.query(internal.payments.internalListStrandedCheckouts, {
      now: NOW,
      minAgeMinutes: 10,
      maxAgeHours: 24,
    })

    expect(stranded.map((c) => c.orderId)).not.toContain(orderId)
  })

  test("an order that never went through Stripe checkout is not a candidate", async () => {
    // Cash and platform orders also sit at `paymentStatus: "pending"`. They
    // have no session, so there is nothing to ask about — and rows written
    // before the field existed read the same way, which is why no backfill is
    // needed.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-004", {
      createdAt: NOW - 30 * MINUTE,
    })

    const stranded = await t.query(internal.payments.internalListStrandedCheckouts, {
      now: NOW,
      minAgeMinutes: 10,
    })

    expect(stranded.map((c) => c.orderId)).not.toContain(orderId)
  })

  test("stops being a candidate once it has been settled", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-005", {
      createdAt: NOW - 30 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })

    await reconcileThroughTheActionsPath(t, storeId, orderId)

    const stranded = await t.query(internal.payments.internalListStrandedCheckouts, {
      now: NOW,
      minAgeMinutes: 10,
    })

    expect(stranded.map((c) => c.orderId)).not.toContain(orderId)
  })

  /**
   * The three steps `stripe.reconcilePendingCheckouts` runs once Stripe has
   * confirmed the session was paid.
   *
   * The action itself is `"use node"` and dynamically imports the Stripe SDK,
   * so it does not load under `edge-runtime`.
   * `stripe-event-coverage.test.ts` asserts against the source that it really
   * runs these steps; this proves the steps produce the right state.
   */
  async function reconcileThroughTheActionsPath(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    orderId: Id<"orders">
  ) {
    const order = (await t.run((ctx) => ctx.db.get(orderId)))!
    const next = paymentStatusAfterSettlement({
      status: order.status,
      paymentStatus: order.paymentStatus,
    })
    if (next) {
      await t.mutation(internal.orders.internalUpdatePaymentStatus, {
        id: orderId,
        paymentStatus: next,
      })
    }
    return t.mutation(internal.payments.internalSettle, settlement(storeId, orderId))
  }

  test("the sweep rescues the order, and pays the customer's kitchen ticket", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-006", {
      createdAt: NOW - 30 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })

    await reconcileThroughTheActionsPath(t, storeId, orderId)

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("paid")
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("running the sweep twice writes one payment, not two", async () => {
    // Idempotence is not optional here: this runs every fifteen minutes, and a
    // webhook that arrives late settles the same charge from a different event.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-007", {
      createdAt: NOW - 30 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })

    const first = await reconcileThroughTheActionsPath(t, storeId, orderId)
    const second = await reconcileThroughTheActionsPath(t, storeId, orderId)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })

  test("a sweep landing on a cancelled order records money owed, not a paid order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, "S-008", {
      createdAt: NOW - 30 * MINUTE,
      stripeCheckoutSessionId: SESSION,
    })
    await t.run((ctx) =>
      ctx.db.patch(orderId, { status: "cancelled" as const, updatedAt: NOW })
    )

    await reconcileThroughTheActionsPath(t, storeId, orderId)

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("refund_pending")
    expect(await paymentsFor(t, orderId)).toHaveLength(1)
  })
})

describe("a status update is not a refund", () => {
  async function settledPayment(t: ReturnType<typeof convexTest>, orderNumber: string) {
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, orderNumber)
    const { paymentId } = await t.mutation(
      internal.payments.internalSettle,
      settlement(storeId, orderId)
    )
    return paymentId as Id<"payments">
  }

  test.each(["refunded", "partially_refunded"])(
    "refuses to write %s, because nothing here moves money",
    async (status) => {
      // THE BUG. `payments.updateStatus` accepted these two and did a bare
      // `ctx.db.patch` with no provider call anywhere — exposed publicly as a
      // `storeMutation` under `payments:write`, the permission for TAKING money.
      //
      // The damage is not that the books read wrong. The patched row has
      // `refundedAmount: undefined`, and `planRefund` accepts only `succeeded`
      // and `partially_refunded` — so the next real refund attempt dies on
      // "Un paiement au statut « refunded » ne peut pas être remboursé". The lie
      // is permanent: the customer can no longer be paid back through the
      // product at all. That is the same block issue #128 was raised to remove.
      const t = newHarness()
      const paymentId = await settledPayment(t, `U-${status}`)

      await expect(
        t.mutation(internal.payments.internalUpdateStatus, {
          id: paymentId,
          // Cast: the argument validator no longer admits this literal, which
          // is half the fix. The cast is what lets the test prove the other
          // half — that the handler refuses it too.
          status: status as "failed",
        })
      ).rejects.toThrow()

      const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
      expect(row.status).toBe("succeeded")
      expect(row.refundedAmount).toBeUndefined()
    }
  )

  test("the payment stays refundable for its full amount", async () => {
    // The consequence, stated as money: a refused money-lie leaves 48 € that
    // can still actually be given back.
    const t = newHarness()
    const paymentId = await settledPayment(t, "U-003")

    await expect(
      t.mutation(internal.payments.internalUpdateStatus, {
        id: paymentId,
        status: "refunded" as "failed",
      })
    ).rejects.toThrow()

    expect(await refundableBalance(t, paymentId)).toBe(CHARGE)
  })

  test("still moves a payment through its real states", async () => {
    // Guards the guard: a fix that refused everything would be no fix at all.
    const t = newHarness()
    const paymentId = await settledPayment(t, "U-004")

    await t.mutation(internal.payments.internalUpdateStatus, {
      id: paymentId,
      status: "failed" as const,
    })

    expect((await t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("failed")
  })
})
