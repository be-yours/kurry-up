// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Regression tests for the independent review of the reservation payments (phase 5).
 *
 * Each block names the finding it closes. They were written before the fix and failed
 * for the reason the reviewer gave; the paths are the ones a guest, a host or a provider
 * can actually reach, never a helper called in isolation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import {
  createHarnessFactory,
  dateIn,
  eventRows,
  guest,
  openSlots,
  refusalCode,
  refusalMessage,
  rowById,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'
import {
  bookingByToken,
  dispatches,
  eraseFully,
  noticeKinds,
  openAttempt,
  paidFact,
  payBooking,
  paymentRows,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const HOUR = 60 * 60_000

beforeEach(stubPaymentWorld)
afterEach(unstubPaymentWorld)

type Rule = Record<string, unknown>
const DEPOSIT_RULE: Rule = {
  id: 'r1',
  kind: 'deposit',
  deposit: { mode: 'per_cover', cents: 1000 },
}
const FROM_FOUR: Rule = { ...DEPOSIT_RULE, minPartySize: 4 }

async function paymentWorld(t: Harness, rules: Rule[], freeCancellationHours = 48): Promise<World> {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    autoConfirm: true,
    looseTables: 4,
    cancellationDeadlineHours: 2,
  })
  await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
    storeId: world.storeId,
    enabled: true,
    rules: rules as never,
    freeCancellationHours,
    holdMinutes: 15,
  })
  return world
}

/** A booking the guest made, agreeing to the terms when there are any. */
async function book(
  t: Harness,
  world: World,
  partySize: number,
  extra: { email?: string; day?: number } = {},
) {
  const slot = (await openSlots(t, world.storeId, partySize, { date: dateIn(extra.day ?? 10) }))[0]!
  const created = await t.mutation(api.reservations.create, {
    storeId: world.storeId,
    date: dateIn(extra.day ?? 10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize,
    guest: { ...guest, email: extra.email ?? guest.email },
    consentNoticeVersion: 'v1',
    paymentConsent: true,
  })
  const row = (await bookingByToken(t, created.manageToken))!
  return { created, id: row._id, token: created.manageToken, slot }
}

async function onlyBooking(t: Harness): Promise<Doc<'reservations'>> {
  const rows = await t.run((ctx) => ctx.db.query('reservations').collect())
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/* ------------------------------------------------------------------ */
/* 1. The cut-off binds a change as well as a cancellation             */
/* ------------------------------------------------------------------ */

describe('finding 1: a paid booking past its cut-off cannot be moved by the guest', () => {
  test('moving it two weeks out to cancel it afterwards is refused', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    await payBooking(t, token)
    // The booking is now 30 hours away, inside the 48 hour cut-off.
    const start = Date.now() + 30 * HOUR
    await t.run((ctx) => ctx.db.patch(id, { startsAt: start, endsAt: start + 90 * 60_000 }))
    expect(await refusalCode(t.mutation(api.reservations.cancelByToken, { token }))).toBe(
      'cancellation_closed',
    )

    const later = (await openSlots(t, world.storeId, 2, { date: dateIn(12) }))[0]!
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token,
          date: dateIn(12),
          serviceId: later.serviceId as Id<'reservationServices'>,
          startsAt: later.startsAt,
          partySize: 2,
        }),
      ),
    ).toBe('change_closed')
    // Nothing moved, and the cancellation is still closed: no refund can be provoked.
    expect((await rowById(t, id))!.startsAt).toBe(start)
    expect(await refusalCode(t.mutation(api.reservations.cancelByToken, { token }))).toBe(
      'cancellation_closed',
    )
    expect((await dispatches(t)).filter((d) => d.type === 'refund')).toHaveLength(0)
  })

  test('even a note-only change is closed once the cut-off passed', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    await payBooking(t, token)
    const start = Date.now() + 30 * HOUR
    await t.run((ctx) => ctx.db.patch(id, { startsAt: start, endsAt: start + 90 * 60_000 }))
    const row = (await rowById(t, id))!
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token,
          date: dateIn(10),
          serviceId: row.serviceId,
          startsAt: row.startsAt,
          partySize: 2,
          note: 'Une chaise haute, merci',
        }),
      ),
    ).toBe('change_closed')
  })

  test('the manage page stops offering the change when the guest could not use it', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    await payBooking(t, token)
    const open = await t.query(api.reservations.getByToken, { token })
    expect(open?.canModify).toBe(true)
    const start = Date.now() + 30 * HOUR
    await t.run((ctx) => ctx.db.patch(id, { startsAt: start, endsAt: start + 90 * 60_000 }))
    const closed = await t.query(api.reservations.getByToken, { token })
    expect(closed?.canModify).toBe(false)
    expect(closed?.canCancel).toBe(false)
  })

  test('before the cut-off the guest still moves a paid booking, as before', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    await payBooking(t, token)
    const later = (await openSlots(t, world.storeId, 2, { date: dateIn(12) }))[0]!
    const result = await t.mutation(api.reservations.modifyByToken, {
      token,
      date: dateIn(12),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      partySize: 2,
    })
    expect(result.changed).toBe(true)
    expect((await rowById(t, id))!.startsAt).toBe(later.startsAt)
  })
})

/* ------------------------------------------------------------------ */
/* 2. A booking that owes nothing cannot grow into a deposit unnoticed */
/* ------------------------------------------------------------------ */

describe('finding 2: the deposit policy is not skipped by editing a booking', () => {
  test('a booking of 2 edited to 4 under « deposit from 4 » is refused, plainly', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [FROM_FOUR])
    const { created, token, slot } = await book(t, world, 2)
    expect(created.status).toBe('confirmed')
    const four =
      (await openSlots(t, world.storeId, 4)).find((s) => s.startsAt === slot.startsAt) ??
      (await openSlots(t, world.storeId, 4))[0]!
    const call = () =>
      t.mutation(api.reservations.modifyByToken, {
        token,
        date: dateIn(10),
        serviceId: four.serviceId as Id<'reservationServices'>,
        startsAt: four.startsAt,
        partySize: 4,
      })
    expect(await refusalCode(call())).toBe('payment_required_for_change')
    const message = (await refusalMessage(call()))!
    expect(message).toMatch(/acompte|garantie/i)
    expect(message).toMatch(/annulez/i)
    const row = await onlyBooking(t)
    expect(row.partySize).toBe(2)
    expect(row.status).toBe('confirmed')
    expect(row.paymentTerms).toBeUndefined()
  })

  test('a move of a booking that owed nothing, under a policy enabled since, is refused too', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    // Nothing owed: switch the policy off, book, switch it back on.
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: false,
      rules: [DEPOSIT_RULE] as never,
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    const { created, token } = await book(t, world, 2)
    expect(created.status).toBe('confirmed')
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: true,
      rules: [DEPOSIT_RULE] as never,
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    const other = (await openSlots(t, world.storeId, 2, { date: dateIn(11) }))[0]!
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token,
          date: dateIn(11),
          serviceId: other.serviceId as Id<'reservationServices'>,
          startsAt: other.startsAt,
          partySize: 2,
        }),
      ),
    ).toBe('payment_required_for_change')
  })

  test('a change the policy does not cover, and a reworded note, still go through', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [FROM_FOUR])
    const { id, token, slot } = await book(t, world, 2)
    const three = (await openSlots(t, world.storeId, 3)).find((s) => s.startsAt === slot.startsAt)!
    const res = await t.mutation(api.reservations.modifyByToken, {
      token,
      date: dateIn(10),
      serviceId: three.serviceId as Id<'reservationServices'>,
      startsAt: three.startsAt,
      partySize: 3,
    })
    expect(res.changed).toBe(true)
    // A note alone never touches the table: it is not a new booking for the policy.
    const noted = await t.mutation(api.reservations.modifyByToken, {
      token,
      date: dateIn(10),
      serviceId: three.serviceId as Id<'reservationServices'>,
      startsAt: three.startsAt,
      partySize: 3,
      note: 'Anniversaire',
    })
    expect(noted.changed).toBe(true)
    expect((await rowById(t, id))!.partySize).toBe(3)
  })

  test('the team may edit it, and is TOLD that the policy would have asked for a deposit', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [FROM_FOUR])
    const { id, slot } = await book(t, world, 2)
    const four =
      (await openSlots(t, world.storeId, 4)).find((s) => s.startsAt === slot.startsAt) ??
      (await openSlots(t, world.storeId, 4))[0]!
    const result = await world.manager.mutation(api.reservations.updateByStaff, {
      id,
      date: dateIn(10),
      serviceId: four.serviceId as Id<'reservationServices'>,
      startsAt: four.startsAt,
      partySize: 4,
    })
    expect(result.changed).toBe(true)
    expect(result).toMatchObject({
      paymentNotice: { kind: 'deposit', depositCents: 4000 },
    })
    // The host's call: the booking stays confirmed, and the history keeps the fact.
    expect((await rowById(t, id))!.status).toBe('confirmed')
    expect(
      (await eventRows(t)).some((e) => (e.note ?? '').includes('payment_policy_not_applied')),
    ).toBe(true)
  })

  test('a party seated without a booking is never told about the policy', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [FROM_FOUR])
    const { id, slot } = await book(t, world, 2)
    await t.run((ctx) => ctx.db.patch(id, { channel: 'walk_in' }))
    const four =
      (await openSlots(t, world.storeId, 4)).find((s) => s.startsAt === slot.startsAt) ??
      (await openSlots(t, world.storeId, 4))[0]!
    const result = await world.manager.mutation(api.reservations.updateByStaff, {
      id,
      date: dateIn(10),
      serviceId: four.serviceId as Id<'reservationServices'>,
      startsAt: four.startsAt,
      partySize: 4,
    })
    expect(result.changed).toBe(true)
    expect('paymentNotice' in result).toBe(false)
  })

  test('the team is told nothing when the edit does not reach a rule', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [FROM_FOUR])
    const { id, slot } = await book(t, world, 2)
    const three = (await openSlots(t, world.storeId, 3)).find((s) => s.startsAt === slot.startsAt)!
    const result = await world.manager.mutation(api.reservations.updateByStaff, {
      id,
      date: dateIn(10),
      serviceId: three.serviceId as Id<'reservationServices'>,
      startsAt: three.startsAt,
      partySize: 3,
    })
    expect(result.changed).toBe(true)
    expect('paymentNotice' in result).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* A stand-in for Stripe, for the actions that call it                 */
/* ------------------------------------------------------------------ */

/** The deployment variables `getSiteEnv()` insists on, with test-shaped values. */
function stubSiteEnv() {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud')
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site')
  vi.stubEnv('SITE_URL', 'https://example.test')
  vi.stubEnv('BETTER_AUTH_SECRET', 'a'.repeat(40))
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32))
  vi.stubEnv('AWS_REGION', 'eu-west-1')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test')
  vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket')
  vi.stubEnv('AWS_SES_FROM_EMAIL', 'noreply@example.test')
}

interface StripeCall {
  method: string
  path: string
  body: string
}

/**
 * `fetch` answers like Stripe for the routes given (`'POST /v1/refunds'`), and fails closed
 * for every other. Returns the calls it saw, so a test can prove a request was NOT sent.
 */
function stubStripe(routes: Record<string, { status: number; body: unknown }>): StripeCall[] {
  const calls: StripeCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ method, path: url.pathname, body: String(init?.body ?? '') })
      const route = routes[`${method} ${url.pathname}`]
      if (!route) throw new Error(`no stand-in for ${method} ${url.pathname}`)
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return calls
}

const HOURS = 60 * 60_000

/** A paid deposit and a refund of all of it, committed and not yet answered. */
async function reservedRefund(t: Harness, world: World, ageMs: number) {
  const { id, token } = await book(t, world, 2)
  const charge = await payBooking(t, token)
  const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
    paymentId: charge._id,
    amount: charge.amount,
    reason: 'Annulation',
    actor: 'system',
  })
  const refundId = reserved.refundId as Id<'reservationPayments'>
  await t.run((ctx) => ctx.db.patch(refundId, { createdAt: Date.now() - ageMs }))
  return { id, token, charge, refundId }
}

const row = (t: Harness, id: Id<'reservationPayments'>) => t.run((ctx) => ctx.db.get(id))

/* ------------------------------------------------------------------ */
/* 3. A refund replayed is never released, and never replayed too late */
/* ------------------------------------------------------------------ */

describe('finding 3: the refund sweep never lets go of a refund that may have gone out', () => {
  beforeEach(stubSiteEnv)

  test('a refusal on a RETRY keeps the refund committed (the first send may have succeeded)', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { charge, refundId } = await reservedRefund(t, world, 5 * 60_000)
    const calls = stubStripe({
      'POST /v1/refunds': {
        status: 400,
        body: { error: { code: 'charge_already_refunded', message: 'Charge already refunded.' } },
      },
    })
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect(calls.some((call) => call.path === '/v1/refunds')).toBe(true)
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('reserved')
    expect(refund.failure?.code).toBe('outcome_unknown')
    // The committed amount stays on the charge: a later refund cannot go out under a new key.
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('a local refusal (Stripe not connected any more) on a RETRY is unknown too', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { charge, refundId } = await reservedRefund(t, world, 5 * 60_000)
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    stubStripe({})
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect((await row(t, refundId))!.status).toBe('reserved')
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('the first send still releases on a refusal: nothing can have moved', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { token } = await book(t, world, 2)
    const charge = await payBooking(t, token)
    stubStripe({
      'POST /v1/refunds': {
        status: 400,
        body: { error: { code: 'resource_missing', message: 'No such payment_intent.' } },
      },
    })
    const asManager = world.manager
    await expect(
      asManager.action(api.reservationPaymentActions.refundReservationPayment, {
        paymentId: charge._id,
        amount: charge.amount,
      }),
    ).rejects.toThrow()
    const refunds = (await paymentRows(t)).filter((r) => r.kind === 'refund')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.status).toBe('failed')
    expect((await row(t, charge._id))!.refundedAmount).toBe(0)
  })

  test('a refund older than the horizon is NOT asked for again: it goes to a person', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { charge, refundId } = await reservedRefund(t, world, 30 * HOURS)
    const calls = stubStripe({})
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect(calls.filter((call) => call.path === '/v1/refunds')).toHaveLength(0)
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('reserved')
    expect(refund.attentionCode).toBe('refund_unconfirmed')
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    // Visible to the host: in the payment dialog's history and in the alert centre.
    const history = await world.manager.query(api.reservationPayments.historyFor, {
      reservationId: refund.reservationId,
    })
    expect(history.find((entry) => entry.id === String(refundId))?.attention?.code).toBe(
      'refund_unconfirmed',
    )
    const alerts = await world.manager.query(api.reservationAlerts.list, {
      storeId: world.storeId,
    })
    expect(alerts.enabled && alerts.alerts.map((alert) => alert.kind)).toContain(
      'payment_attention',
    )
  })

  test('the dashboard refund that follows closes the stale row by the provider total', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { charge, refundId } = await reservedRefund(t, world, 30 * HOURS)
    await t.action(internal.reservationPaymentActions.reconcile, {})
    await t.mutation(internal.reservationPayments.recordProviderRefund, {
      externalId: charge.externalId!,
      refundedTotalMinor: charge.amount,
      reason: 'Remboursement effectué depuis le tableau de bord Stripe',
    })
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('succeeded')
    expect(refund.attentionCode).toBeUndefined()
    // Nothing was refunded twice on our books.
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    expect((await paymentRows(t)).filter((r) => r.kind === 'refund')).toHaveLength(1)
  })

  test('a no-show fee whose answer was lost is not charged again past the horizon', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 4 })
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: true,
      rules: [{ id: 'g1', kind: 'guarantee', noShowFee: { mode: 'flat', cents: 3000 } }] as never,
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    const { id, token } = await book(t, world, 2)
    await payBooking(t, token)
    const start = Date.now() - 3 * HOURS
    await t.run((ctx) =>
      ctx.db.patch(id, { startsAt: start, endsAt: start + 90 * 60_000, status: 'no_show' }),
    )
    const fee = await t.mutation(internal.reservationPayments.beginFee, { reservationId: id })
    const feeId = fee.paymentId as Id<'reservationPayments'>
    await t.run((ctx) => ctx.db.patch(feeId, { createdAt: Date.now() - 30 * HOURS }))
    const calls = stubStripe({})
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    expect((await row(t, feeId))!.attentionCode).toBe('fee_unconfirmed')
    // The host looks at Stripe, then abandons it: the row closes and the alert goes.
    await world.manager.mutation(api.reservationPayments.waive, { reservationId: id })
    expect((await row(t, feeId))!.status).toBe('waived')
  })
})

/* ------------------------------------------------------------------ */
/* 6. A pending refund is not a refund; a dispute is not a refund      */
/* ------------------------------------------------------------------ */

describe('finding 6: what the provider has not confirmed is not confirmed', () => {
  beforeEach(stubSiteEnv)

  async function pendingRefundWorld(t: Harness) {
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    const charge = await payBooking(t, token)
    stubStripe({
      'POST /v1/refunds': { status: 200, body: { id: 're_pending_1', status: 'pending' } },
    })
    const result = await world.manager.action(
      api.reservationPaymentActions.refundReservationPayment,
      { paymentId: charge._id, amount: charge.amount },
    )
    const refund = (await paymentRows(t)).find((r) => r.kind === 'refund')!
    return { world, id, charge, refund, result }
  }

  test('a refund answered « pending » stays reserved, and the guest is not mailed', async () => {
    const t = newHarness()
    const { result, refund, charge } = await pendingRefundWorld(t)
    expect(result.status).toBe('pending')
    expect(refund.status).toBe('reserved')
    expect(refund.externalId).toBe('re_pending_1')
    expect(await noticeKinds(t)).not.toContain('payment_refunded')
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('the sweep reads the refund back, and confirms it only when Stripe says so', async () => {
    const t = newHarness()
    const { refund } = await pendingRefundWorld(t)
    await t.run((ctx) => ctx.db.patch(refund._id, { createdAt: Date.now() - 10 * 60_000 }))
    const calls = stubStripe({
      'GET /v1/refunds/re_pending_1': {
        status: 200,
        body: { id: 're_pending_1', status: 'pending' },
      },
    })
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    expect((await row(t, refund._id))!.status).toBe('reserved')

    stubStripe({
      'GET /v1/refunds/re_pending_1': {
        status: 200,
        body: { id: 're_pending_1', status: 'succeeded' },
      },
    })
    await t.action(internal.reservationPaymentActions.reconcile, {})
    expect((await row(t, refund._id))!.status).toBe('succeeded')
    expect(await noticeKinds(t)).toContain('payment_refunded')
  })

  test('a refund Stripe fails afterwards is released and handed to the host', async () => {
    const t = newHarness()
    const { refund, charge, world } = await pendingRefundWorld(t)
    const outcome = await t.mutation(internal.reservationPayments.settleRefundFromProvider, {
      externalRefundId: 're_pending_1',
      status: 'failed',
    })
    expect(outcome.outcome).toBe('released')
    const failed = (await row(t, refund._id))!
    expect(failed.status).toBe('failed')
    expect(failed.attentionCode).toBe('refund_failed')
    expect((await row(t, charge._id))!.refundedAmount).toBe(0)
    expect(await noticeKinds(t)).not.toContain('payment_refunded')
    const alerts = await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId })
    expect(alerts.enabled && alerts.alerts.map((alert) => alert.kind)).toContain(
      'payment_attention',
    )
    // The webhook can say it twice.
    expect(
      (
        await t.mutation(internal.reservationPayments.settleRefundFromProvider, {
          externalRefundId: 're_pending_1',
          status: 'failed',
        })
      ).outcome,
    ).toBe('ignored')
  })

  test('a dispute is its own state, raised to the host, with no refund row and no guest mail', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    const charge = await payBooking(t, token)
    const before = await noticeKinds(t)
    const result = await t.mutation(internal.reservationPayments.recordProviderDispute, {
      externalId: charge.externalId!,
      amountMinor: charge.amount,
      reason: 'Litige / rétrofacturation (fraudulent)',
    })
    expect(result.status).toBe('recorded')
    expect((await paymentRows(t)).filter((r) => r.kind === 'refund')).toHaveLength(0)
    expect((await row(t, charge._id))!.refundedAmount ?? 0).toBe(0)
    expect(await noticeKinds(t)).toEqual(before)
    const entries = await world.manager.query(api.reservationPayments.listForBookings, {
      storeId: world.storeId,
      ids: [id],
    })
    expect(entries[0]!.state).toBe('disputed')
    const alerts = await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId })
    expect(alerts.enabled && alerts.alerts.map((alert) => alert.kind)).toContain(
      'payment_attention',
    )
    // The guest never reads « litige ».
    const view = await t.query(api.reservations.getByToken, { token })
    expect(view?.payment?.state).toBe('paid')
    // A replay is harmless, and an unknown charge is not ours.
    expect(
      (
        await t.mutation(internal.reservationPayments.recordProviderDispute, {
          externalId: charge.externalId!,
          amountMinor: charge.amount,
          reason: 'x',
        })
      ).status,
    ).toBe('unchanged')
    expect(
      (
        await t.mutation(internal.reservationPayments.recordProviderDispute, {
          externalId: 'pi_not_ours',
          amountMinor: 1,
          reason: 'x',
        })
      ).status,
    ).toBe('not_found')
  })
})

/* ------------------------------------------------------------------ */
/* 5. A replayed « completed » does not revive an ended guarantee      */
/* ------------------------------------------------------------------ */

describe('finding 5: a settled-then-ended row stays ended', () => {
  test('a replayed completed fact leaves a released guarantee released', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 4 })
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: true,
      rules: [{ id: 'g1', kind: 'guarantee', noShowFee: { mode: 'flat', cents: 3000 } }] as never,
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    const { id, token } = await book(t, world, 2)
    const guarantee = await payBooking(t, token)
    expect(guarantee.status).toBe('succeeded')
    await world.manager.mutation(api.reservationPayments.waive, { reservationId: id })
    const released = (await row(t, guarantee._id))!
    expect(released.status).toBe('released')

    const replay = await t.mutation(internal.reservationPayments.settlePayment, {
      paymentId: guarantee._id,
      fact: paidFact(released) as never,
    })
    expect(replay.outcome).toBe('already')
    expect((await row(t, guarantee._id))!.status).toBe('released')
  })
})

/* ------------------------------------------------------------------ */
/* 4. Erasing an unpaid booking closes the page and keeps the money    */
/* ------------------------------------------------------------------ */

describe('finding 4: erasing a booking that awaits payment', () => {
  const erase = (t: Harness, world: World, email: string) => eraseFully(t, world.manager, email)

  test('the booking goes, the payable page is closed, the row keeps no personal data', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { token } = await book(t, world, 2, { email: 'erase@example.com' })
    const attempt = await openAttempt(t, token)
    const paymentId = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
    // A failed bank message and a card reference are what a row could hold about a person.
    await t.run((ctx) =>
      ctx.db.patch(paymentId, {
        customerRef: 'cus_x',
        methodRef: 'pm_x',
        failure: { code: 'card_declined', message: 'Carte de Marie refusée', at: Date.now() },
      }),
    )
    const result = await erase(t, world, 'erase@example.com')
    expect(result.report.complete).toBe(true)
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)

    const kept = (await row(t, paymentId))!
    expect(kept).toBeTruthy()
    expect(kept.status).toBe('pending')
    expect(kept.checkoutRef).toBeTruthy()
    expect(kept.customerRef).toBeUndefined()
    expect(kept.methodRef).toBeUndefined()
    expect(kept.failure).toBeUndefined()
    expect(kept.checkoutUrl).toBeUndefined()
    expect(JSON.stringify(kept)).not.toMatch(/erase@example\.com|Marie|Dupont/)
    expect(
      result.report.tallies.find((tally) => tally.table === 'reservationPayments'),
    ).toMatchObject({
      anonymised: 1,
    })
    // The page is closed by the erasure itself, scheduled and not left to a sweep.
    const closing = (await dispatches(t)).filter(
      (dispatch) => dispatch.type === 'close_attempt' && dispatch.paymentId === String(paymentId),
    )
    expect(closing).toHaveLength(1)
  })

  test('a payment that lands anyway is recorded, then refunded', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { token } = await book(t, world, 2, { email: 'erase2@example.com' })
    const attempt = await openAttempt(t, token)
    const paymentId = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
    await erase(t, world, 'erase2@example.com')

    const kept = (await row(t, paymentId))!
    const settled = await t.mutation(internal.reservationPayments.settlePayment, {
      paymentId,
      fact: paidFact(kept) as never,
    })
    expect(settled.outcome).toBe('orphan')
    expect((await row(t, paymentId))!.status).toBe('succeeded')
    const refunds = (await dispatches(t)).filter(
      (dispatch) => dispatch.type === 'refund' && dispatch.paymentId === String(paymentId),
    )
    expect(refunds).toHaveLength(1)
  })

  test('the webhook still finds the row by its provider reference', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { token } = await book(t, world, 2, { email: 'erase3@example.com' })
    const attempt = await openAttempt(t, token)
    const paymentId = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
    const before = (await row(t, paymentId))!
    await erase(t, world, 'erase3@example.com')
    const found = await t.query(internal.reservationPayments.findByProviderRef, {
      checkoutRef: before.checkoutRef!,
    })
    expect(found).toBe(String(paymentId))
  })
})

/* ------------------------------------------------------------------ */
/* 7. The public payment actions never store the guest's link          */
/* ------------------------------------------------------------------ */

describe('finding 7: the rate limiter keys on the booking, never on the link', () => {
  beforeEach(stubSiteEnv)

  const subjects = (t: Harness) =>
    t.run(async (ctx) =>
      (await ctx.db.query('rateLimits').collect()).map((entry) => ({
        name: (entry as { name?: string }).name,
        subject: (entry as { subject?: string }).subject,
        key: (entry as { key?: string }).key,
      })),
    )

  test('a valid link is metered on the booking id, and the link is written nowhere', async () => {
    const t = newHarness()
    const world = await paymentWorld(t, [DEPOSIT_RULE])
    const { id, token } = await book(t, world, 2)
    stubStripe({})
    await expect(
      t.action(api.reservationPaymentActions.startReservationPayment, {
        token,
        provider: 'stripe',
        returnOrigin: 'https://example.test',
      }),
    ).rejects.toThrow()
    await t.action(api.reservationPaymentActions.verifyReservationPayment, { token })
    const stored = JSON.stringify(await subjects(t))
    expect(stored).not.toContain(token)
    expect(stored).toContain(String(id))
  })

  test('random strings share ONE bucket instead of adding a row each', async () => {
    const t = newHarness()
    await paymentWorld(t, [DEPOSIT_RULE])
    stubStripe({})
    for (let i = 0; i < 5; i++) {
      const token = `not-a-booking-link-${i}-${'x'.repeat(12)}`
      await t.action(api.reservationPaymentActions.verifyReservationPayment, { token })
    }
    const stored = await subjects(t)
    expect(JSON.stringify(stored)).not.toContain('not-a-booking-link')
    expect(stored).toHaveLength(1)
  })
})
