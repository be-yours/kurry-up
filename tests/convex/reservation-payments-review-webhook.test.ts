// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Stripe webhook, for what the review of the reservation payments (phase 5) changed.
 *
 * The real route runs end to end — the delivery's dedup claim, the branch, the mutation —
 * with the `"use node"` signature verifier replaced by a stub that answers what a verified
 * delivery would have carried (the technique of `stripe-webhook-refusal.test.ts`).
 *
 *  - a dispute is NOT a refund: it flags the charge, writes no refund row and mails nobody;
 *  - a refund Stripe left pending and then failed is released and handed to the host;
 *  - a refund it then confirmed becomes a refund, and the guest is told, once.
 */

import { convexTest } from 'convex-test'
import { v } from 'convex/values'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import { internalAction } from '../../convex/_generated/server'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'
import { dateIn, guest, openSlots, seedWorld, type Harness } from './reservation-fixtures'
import {
  bookingByToken,
  noticeKinds,
  openAttempt,
  paidFact,
  payBooking,
  paymentRows,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

/** What the stub verifier should answer for the next delivery. */
let verified: Record<string, unknown> = {}

const modules = {
  ...import.meta.glob('../../convex/**/*.ts'),
  '../../convex/stripeWebhookVerify.ts': async () => ({
    verify: internalAction({
      args: { body: v.string(), signature: v.string() },
      handler: async (): Promise<Record<string, unknown>> => verified,
    }),
  }),
}

const harnesses: Harness[] = []

function newHarness(): Harness {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(stubPaymentWorld)

afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.state.kind === 'pending' || job.state.kind === 'inProgress') {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
  unstubPaymentWorld()
})

let delivery = 0

/** Deliver one verified event to the real route. */
async function deliver(t: Harness, event: Record<string, unknown>): Promise<Response> {
  verified = { eventId: `evt_${++delivery}`, ...event }
  return await t.fetch('/webhooks/stripe', {
    method: 'POST',
    body: '{}',
    headers: { 'stripe-signature': 't=1,v1=stub' },
  })
}

async function paidDeposit(t: Harness) {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, { autoConfirm: true, looseTables: 4 })
  await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
    storeId: world.storeId,
    enabled: true,
    rules: [{ id: 'r1', kind: 'deposit', deposit: { mode: 'per_cover', cents: 1000 } }] as never,
    freeCancellationHours: 48,
    holdMinutes: 15,
  })
  const slot = (await openSlots(t, world.storeId, 2))[0]!
  const created = await t.mutation(api.reservations.create, {
    storeId: world.storeId,
    date: dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize: 2,
    guest,
    consentNoticeVersion: 'v1',
    paymentConsent: true,
  })
  const charge = await payBooking(t, created.manageToken)
  return { world, token: created.manageToken, charge }
}

const get = (t: Harness, id: Id<'reservationPayments'>) =>
  t.run((ctx): Promise<Doc<'reservationPayments'> | null> => ctx.db.get(id))

describe('a dispute arriving at the webhook', () => {
  test('flags the charge, writes no refund row, and mails nobody', async () => {
    const t = newHarness()
    const { charge, world, token } = await paidDeposit(t)
    const before = await noticeKinds(t)

    const response = await deliver(t, {
      eventType: 'charge.dispute.created',
      paymentIntent: charge.externalId,
      chargeId: 'ch_1',
      currency: 'EUR',
      amountDisputed: charge.amount,
      disputeReason: 'fraudulent',
    })
    expect(response.status).toBe(200)

    expect((await get(t, charge._id))!.attentionCode).toBe('dispute')
    expect((await paymentRows(t)).filter((row) => row.kind === 'refund')).toHaveLength(0)
    expect(await noticeKinds(t)).toEqual(before)
    const booking = (await bookingByToken(t, token))!
    const entries = await world.manager.query(api.reservationPayments.listForBookings, {
      storeId: world.storeId,
      ids: [booking._id],
    })
    expect(entries[0]!.state).toBe('disputed')
  })

  test('reaching us before the charge was settled still flags it, through the intent’s own metadata', async () => {
    // Stripe orders no two events: against its test mode the dispute card opens a dispute the
    // instant the payment is made, and `charge.dispute.created` arrived before the event that
    // settles the charge. No row held the intent id yet, so the dispute found nothing, was
    // answered 200 and was lost.
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 4 })
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: true,
      rules: [{ id: 'r1', kind: 'deposit', deposit: { mode: 'per_cover', cents: 1000 } }] as never,
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    const slot = (await openSlots(t, world.storeId, 2))[0]!
    const created = await t.mutation(api.reservations.create, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest,
      consentNoticeVersion: 'v1',
      paymentConsent: true,
    })
    const attempt = await openAttempt(t, created.manageToken, {})
    const rowId = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
    expect((await get(t, rowId))!.externalId).toBeUndefined()

    const response = await deliver(t, {
      eventType: 'charge.dispute.created',
      paymentIntent: 'pi_not_yet_known',
      reservationPaymentId: String(rowId),
      chargeId: 'ch_early',
      currency: 'EUR',
      amountDisputed: 2000,
      disputeReason: 'fraudulent',
    })
    expect(response.status).toBe(200)
    expect((await get(t, rowId))!.attentionCode).toBe('dispute')
    expect((await paymentRows(t)).filter((row) => row.kind === 'refund')).toHaveLength(0)

    // The settlement that follows keeps the flag: the host still reads « Litige ouvert ».
    await t.mutation(internal.reservationPayments.settlePayment, {
      paymentId: rowId,
      fact: paidFact((await get(t, rowId))!) as never,
    })
    const settled = (await get(t, rowId))!
    expect(settled.status).toBe('succeeded')
    expect(settled.attentionCode).toBe('dispute')
  })

  test('on a charge that is not a booking’s still goes to the order path, untouched', async () => {
    const t = newHarness()
    await paidDeposit(t)
    const response = await deliver(t, {
      eventType: 'charge.dispute.created',
      paymentIntent: 'pi_an_order',
      chargeId: 'ch_2',
      currency: 'EUR',
      amountDisputed: 500,
      disputeReason: 'general',
    })
    expect(response.status).toBe(200)
    expect(await paymentRows(t)).toHaveLength(1)
  })
})

describe('a refund Stripe left pending, at the webhook', () => {
  async function pendingRefund(t: Harness) {
    const { charge, world, token } = await paidDeposit(t)
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: charge._id,
      amount: charge.amount,
      actor: 'system',
    })
    const refundId = reserved.refundId as Id<'reservationPayments'>
    await t.mutation(internal.reservationPayments.noteRefundPending, {
      refundId,
      externalRefundId: 're_wh_1',
    })
    return { charge, refundId, world, token }
  }

  test('`refund.failed` releases it and hands it to the host', async () => {
    const t = newHarness()
    const { charge, refundId } = await pendingRefund(t)
    await deliver(t, {
      eventType: 'refund.failed',
      refundId: 're_wh_1',
      refundStatus: 'failed',
      paymentIntent: charge.externalId,
    })
    const refund = (await get(t, refundId))!
    expect(refund.status).toBe('failed')
    expect(refund.attentionCode).toBe('refund_failed')
    expect((await get(t, charge._id))!.refundedAmount).toBe(0)
    expect(await noticeKinds(t)).not.toContain('payment_refunded')
  })

  test('the host asking again answers the failure: the flag goes once the retry is confirmed, and not before', async () => {
    const t = newHarness()
    const { charge, refundId } = await pendingRefund(t)
    await deliver(t, {
      eventType: 'refund.failed',
      refundId: 're_wh_1',
      refundStatus: 'failed',
      paymentIntent: charge.externalId,
    })
    expect((await get(t, refundId))!.attentionCode).toBe('refund_failed')

    // The retry is asked and only reserved: the host is still waiting on the provider.
    const retry = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: charge._id,
      amount: charge.amount,
      actor: 'staff',
    })
    expect((await get(t, refundId))!.attentionCode).toBe('refund_failed')

    // Confirmed, it has returned the money the failed one did not: nothing waits for anybody.
    await t.mutation(internal.reservationPayments.settleRefundFromProvider, {
      refundId: retry.refundId as Id<'reservationPayments'>,
      status: 'confirmed',
    })
    const failed = (await get(t, refundId))!
    expect(failed.status).toBe('failed')
    expect(failed.attentionCode).toBeUndefined()
    expect(failed.attentionAt).toBeUndefined()
  })

  test('a retry smaller than the failure leaves it flagged: the rest is still owed', async () => {
    const t = newHarness()
    const { charge, refundId } = await pendingRefund(t)
    await deliver(t, {
      eventType: 'refund.failed',
      refundId: 're_wh_1',
      refundStatus: 'failed',
      paymentIntent: charge.externalId,
    })
    const part = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: charge._id,
      amount: Math.floor(charge.amount / 2),
      actor: 'staff',
    })
    await t.mutation(internal.reservationPayments.settleRefundFromProvider, {
      refundId: part.refundId as Id<'reservationPayments'>,
      status: 'confirmed',
    })
    expect((await get(t, refundId))!.attentionCode).toBe('refund_failed')
  })

  test('`charge.refund.updated` pending changes nothing, succeeded confirms and mails once', async () => {
    const t = newHarness()
    const { charge, refundId } = await pendingRefund(t)
    await deliver(t, {
      eventType: 'charge.refund.updated',
      refundId: 're_wh_1',
      refundStatus: 'pending',
      paymentIntent: charge.externalId,
    })
    expect((await get(t, refundId))!.status).toBe('reserved')

    await deliver(t, {
      eventType: 'charge.refund.updated',
      refundId: 're_wh_1',
      refundStatus: 'succeeded',
      paymentIntent: charge.externalId,
    })
    expect((await get(t, refundId))!.status).toBe('succeeded')
    // The same event delivered twice is one mail.
    await deliver(t, {
      eventType: 'charge.refund.updated',
      refundId: 're_wh_1',
      refundStatus: 'succeeded',
      paymentIntent: charge.externalId,
    })
    expect((await noticeKinds(t)).filter((kind) => kind === 'payment_refunded')).toHaveLength(1)
  })

  test('`charge.refunded` does not confirm a refund Stripe still calls pending', async () => {
    const t = newHarness()
    const { charge, refundId } = await pendingRefund(t)
    await deliver(t, {
      eventType: 'charge.refunded',
      paymentIntent: charge.externalId,
      chargeId: 'ch_1',
      currency: 'EUR',
      amountRefunded: charge.amount,
      fullyRefunded: true,
    })
    expect((await get(t, refundId))!.status).toBe('reserved')
  })
})
