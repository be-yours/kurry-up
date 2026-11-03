// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A refund whose outcome is unknown, once the engine has stopped asking about it.
 *
 * A refund committed on our side that the provider never confirmed stays `reserved`
 * (« en attente ») and is flagged `refund_unconfirmed` once it is older than the replay
 * horizon: asking again could pay the guest twice. It used to stay that way until a refund
 * made on the provider's own dashboard happened to be seen by a webhook — and SumUp, which
 * has no webhook, never saw one. The host now closes it themselves, having looked:
 *
 *  - « Marquer comme remboursé » (`markRefundSettled`): the host states they checked the
 *    refund at the provider. It is recorded as made, the guest is told once, the flag and the
 *    alert go, and the running refunded total is NOT counted a second time;
 *  - « Réessayer » (`retryStalledRefund`): the provider is READ first, and only when it shows
 *    nothing for this refund is it asked again, under a new key. Never for SumUp, which has no
 *    key and no read.
 *
 * Each block was written before the code and fails without it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { _resetEnvCache } from '@be-yours/core/env'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  createHarnessFactory,
  dateIn,
  eventRows,
  guest,
  openSlots,
  refusalCode,
  refusalMessage,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'
import {
  bookingByToken,
  noticeKinds,
  payBooking,
  paymentRows,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const HOURS = 60 * 60_000

beforeEach(() => {
  stubPaymentWorld()
  stubSiteEnv()
  _resetEnvCache()
})
afterEach(() => {
  unstubPaymentWorld()
  _resetEnvCache()
})

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

interface Call {
  method: string
  path: string
  search: string
  body: string
  headers: Record<string, string>
}

/**
 * `fetch` answers like the provider for the routes given (`'POST /v1/refunds'`), and fails
 * closed for every other. Returns the calls it saw, so a test can prove a request was NOT sent.
 */
function stubProvider(routes: Record<string, { status: number; body: unknown }>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({
        method,
        path: url.pathname,
        search: url.search,
        body: String(init?.body ?? ''),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
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

const DEPOSIT_RULE = { id: 'r1', kind: 'deposit', deposit: { mode: 'per_cover', cents: 1000 } }

async function paymentWorld(t: Harness): Promise<World> {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    autoConfirm: true,
    looseTables: 4,
    cancellationDeadlineHours: 2,
  })
  await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
    storeId: world.storeId,
    enabled: true,
    rules: [DEPOSIT_RULE] as never,
    freeCancellationHours: 48,
    holdMinutes: 15,
  })
  return world
}

async function book(t: Harness, world: World, partySize = 2) {
  const slot = (await openSlots(t, world.storeId, partySize, { date: dateIn(10) }))[0]!
  const created = await t.mutation(api.reservations.create, {
    storeId: world.storeId,
    date: dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize,
    guest,
    consentNoticeVersion: 'v1',
    paymentConsent: true,
  })
  const booking = (await bookingByToken(t, created.manageToken))!
  return { id: booking._id, token: created.manageToken }
}

const row = (t: Harness, id: Id<'reservationPayments'>) => t.run((ctx) => ctx.db.get(id))

/**
 * A paid deposit and a refund of `amount` of it (all by default), committed and never
 * answered, old enough to have been flagged by the sweep: what the host is looking at.
 */
async function stalledRefund(
  t: Harness,
  world: World,
  options: { amount?: number; provider?: 'stripe' | 'sumup' | 'paypal'; flagged?: boolean } = {},
) {
  const { id, token } = await book(t, world)
  const charge = await payBooking(t, token)
  const provider = options.provider ?? 'stripe'
  if (provider !== 'stripe') {
    await t.run((ctx) =>
      ctx.db.patch(charge._id, {
        provider,
        externalId: provider === 'sumup' ? 'txn_sumup_1' : 'CAPTURE-1',
        checkoutRef: provider === 'paypal' ? 'ORDER-1' : charge.checkoutRef,
      }),
    )
  }
  const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
    paymentId: charge._id,
    amount: options.amount ?? charge.amount,
    reason: 'Annulation',
    actor: 'system',
  })
  const refundId = reserved.refundId as Id<'reservationPayments'>
  await t.run((ctx) => ctx.db.patch(refundId, { createdAt: Date.now() - 30 * HOURS }))
  if (options.flagged !== false) await t.mutation(internal.reservationPayments.flagStalled, {})
  const fresh = (await row(t, charge._id))!
  return { id, token, charge: fresh, refundId }
}

const noteLines = async (t: Harness) => (await eventRows(t)).map((event) => event.note)
const refundNotices = async (t: Harness) =>
  (await noticeKinds(t)).filter((kind) => kind === 'payment_refunded')

/* ------------------------------------------------------------------ */
/* « Marquer comme remboursé »                                         */
/* ------------------------------------------------------------------ */

describe('marking a stalled refund as made', () => {
  test('closes it: succeeded, flag and alert gone, the guest told once, the total untouched', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { charge, refundId, id } = await stalledRefund(t, world)
    expect((await row(t, refundId))!.attentionCode).toBe('refund_unconfirmed')
    const before = await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId })
    expect(before.enabled && before.alerts.map((alert) => alert.kind)).toContain(
      'payment_attention',
    )
    expect(await refundNotices(t)).toHaveLength(0)

    const result = await world.manager.mutation(api.reservationPayments.markRefundSettled, {
      refundId,
    })
    expect(result).toMatchObject({ status: 'settled', amount: charge.amount, provider: 'stripe' })

    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('succeeded')
    expect(refund.attentionCode).toBeUndefined()
    expect(refund.attentionAt).toBeUndefined()
    expect(refund.failure).toBeUndefined()
    expect(refund.settledAt).toBeTypeOf('number')
    // Committed when it was reserved: closing it adds nothing a second time.
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    expect((await paymentRows(t)).filter((r) => r.kind === 'refund')).toHaveLength(1)

    const after = await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId })
    expect(after.enabled && after.alerts.map((alert) => alert.kind)).not.toContain(
      'payment_attention',
    )
    expect(await refundNotices(t)).toHaveLength(1)
    // The history says it was the host's word, not the provider's.
    const notes = await noteLines(t)
    expect(notes).toContain('payment_refund_marked_by_host')
    expect(notes).not.toContain('payment_refunded')
    const booking = (await t.run((ctx) => ctx.db.get(id)))!
    expect(booking.status).toBe('confirmed')
  })

  test('is written to the audit log with who confirmed, the booking and the amount, and no guest', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { charge, refundId } = await stalledRefund(t, world)
    await world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId })
    const audit = (await t.run((ctx) => ctx.db.query('systemAuditLog').collect())).filter(
      (entry) => entry.action === 'reservation_refund_marked',
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      performedBy: 'manager',
      targetStoreId: world.storeId,
      result: 'success',
    })
    expect(audit[0]!.details).toContain('Stripe')
    expect(audit[0]!.details).toContain((charge.amount / 100).toFixed(2).replace('.', ','))
    // The log is read by the whole team and sits outside the erasure set.
    expect(audit[0]!.details).not.toContain(guest.email)
    expect(audit[0]!.details).not.toContain(guest.name)
  })

  test('a double click is one refund, one mail, one history line and one audit line', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { charge, refundId } = await stalledRefund(t, world)
    const first = await world.manager.mutation(api.reservationPayments.markRefundSettled, {
      refundId,
    })
    const second = await world.manager.mutation(api.reservationPayments.markRefundSettled, {
      refundId,
    })
    expect(first.status).toBe('settled')
    expect(second.status).toBe('already_settled')
    expect(await refundNotices(t)).toHaveLength(1)
    expect((await noteLines(t)).filter((n) => n === 'payment_refund_marked_by_host')).toHaveLength(
      1,
    )
    const audit = await t.run((ctx) => ctx.db.query('systemAuditLog').collect())
    expect(audit.filter((entry) => entry.action === 'reservation_refund_marked')).toHaveLength(1)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('two clicks at once settle once', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { charge, refundId } = await stalledRefund(t, world)
    const results = await Promise.all([
      world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
      world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['already_settled', 'settled'])
    expect(await refundNotices(t)).toHaveLength(1)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('a partial refund closes at its own amount and leaves the rest refundable', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { charge, refundId } = await stalledRefund(t, world, { amount: 500 })
    const result = await world.manager.mutation(api.reservationPayments.markRefundSettled, {
      refundId,
    })
    expect(result.amount).toBe(500)
    const refreshed = (await row(t, charge._id))!
    expect(refreshed.refundedAmount).toBe(500)
    expect(refreshed.amount - (refreshed.refundedAmount ?? 0)).toBe(charge.amount - 500)
  })

  test.each(['stripe', 'sumup', 'paypal'] as const)(
    'works for a %s refund: the provider does not matter, the host’s check does',
    async (provider) => {
      const t = newHarness()
      const world = await paymentWorld(t)
      const { refundId } = await stalledRefund(t, world, { provider })
      const result = await world.manager.mutation(api.reservationPayments.markRefundSettled, {
        refundId,
      })
      expect(result).toMatchObject({ status: 'settled', provider })
      expect((await row(t, refundId))!.status).toBe('succeeded')
    },
  )

  test('needs payments:refund: a waiter and a stranger are refused, and nothing changes', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    await expect(
      world.waiter.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    ).rejects.toThrow()
    await expect(
      t.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    ).rejects.toThrow()
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('reserved')
    expect(refund.attentionCode).toBe('refund_unconfirmed')
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('a team member of another establishment cannot close this one’s refund', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    const other = await seedWorld(t, { looseTables: 1, profiles: false })
    const outsider = t.withIdentity({ subject: 'outsider' })
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'outsider',
        role: 'client_admin',
        storeIds: [other.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    await expect(
      outsider.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    ).rejects.toThrow()
    expect((await row(t, refundId))!.status).toBe('reserved')
  })

  test('refuses a refund still being handled automatically: it is not flagged yet', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world, { flagged: false })
    const message = await refusalMessage(
      world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    )
    expect(message).toMatch(/en cours de traitement/)
    expect((await row(t, refundId))!.status).toBe('reserved')
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('refuses a refund the provider failed, one that was released, and a charge', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    await t.mutation(internal.reservationPayments.releaseRefund, { refundId })
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
      ),
    ).toBe('payment_refused')
    expect((await row(t, refundId))!.status).toBe('failed')
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationPayments.markRefundSettled, {
          refundId: charge._id,
        }),
      ),
    ).toBe('payment_refused')
    // Nothing was said to the guest by either.
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('never closes a refund that would put the refunded total above what was captured', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world, { amount: 1500 })
    // Corrupted books: another reserved refund brings the committed total over the charge.
    await t.run((ctx) =>
      ctx.db.insert('reservationPayments', {
        storeId: charge.storeId,
        reservationId: charge.reservationId,
        kind: 'refund',
        provider: 'stripe',
        status: 'reserved',
        amount: 1000,
        currency: charge.currency,
        refundOf: charge._id,
        attempt: 2,
        idempotencyKey: 'rsv-refund-test-2',
        actor: 'system',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
      ),
    ).toBe('payment_refused')
    expect((await row(t, refundId))!.status).toBe('reserved')
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('refuses an unknown id without writing anything', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    await t.run((ctx) => ctx.db.delete(refundId))
    await expect(
      world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId }),
    ).rejects.toThrow()
    expect(await t.run((ctx) => ctx.db.query('systemAuditLog').collect())).toHaveLength(0)
  })

  test('a refund the provider later reports on its own is not counted twice', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    await world.manager.mutation(api.reservationPayments.markRefundSettled, { refundId })
    // The dashboard refund is then seen by a webhook: the total is already ours.
    await t.mutation(internal.reservationPayments.recordProviderRefund, {
      externalId: charge.externalId!,
      refundedTotalMinor: charge.amount,
      reason: 'Remboursement effectué depuis le tableau de bord Stripe',
    })
    expect((await paymentRows(t)).filter((r) => r.kind === 'refund')).toHaveLength(1)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    expect(await refundNotices(t)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* « Réessayer »                                                       */
/* ------------------------------------------------------------------ */

describe('asking again for a stalled refund', () => {
  const retry = (world: World, refundId: Id<'reservationPayments'>) =>
    world.manager.action(api.reservationPaymentActions.retryStalledRefund, { refundId })

  test('is never offered for SumUp: no key, no read, nothing is sent', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world, { provider: 'sumup' })
    const calls = stubProvider({})
    await expect(retry(world, refundId)).rejects.toThrow(/SumUp/)
    expect(calls).toHaveLength(0)
    expect((await row(t, refundId))!.status).toBe('reserved')
  })

  test('needs payments:refund', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    const calls = stubProvider({})
    await expect(
      world.waiter.action(api.reservationPaymentActions.retryStalledRefund, { refundId }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('refuses a refund that is not flagged, and one that is already settled', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const fresh = await stalledRefund(t, world, { flagged: false })
    const calls = stubProvider({})
    await expect(retry(world, fresh.refundId)).rejects.toThrow()
    await t.mutation(internal.reservationPayments.confirmRefund, { refundId: fresh.refundId })
    await expect(retry(world, fresh.refundId)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('Stripe already shows the refund as made: it is recorded, nothing is sent again', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    const calls = stubProvider({
      'GET /v1/refunds': {
        status: 200,
        body: { data: [{ id: 're_seen_1', status: 'succeeded', amount: charge.amount }] },
      },
    })
    const result = await retry(world, refundId)
    expect(result).toMatchObject({ status: 'confirmed', amount: charge.amount })
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('succeeded')
    expect(refund.externalId).toBe('re_seen_1')
    expect(refund.attentionCode).toBeUndefined()
    expect(await refundNotices(t)).toHaveLength(1)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    // The read named this payment and no other.
    expect(new URLSearchParams(calls[0]!.search).get('payment_intent')).toBe(charge.externalId)
  })

  test('Stripe shows nothing: the refund is asked again under a NEW key, and confirmed', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    const oldKey = (await row(t, refundId))!.idempotencyKey
    const calls = stubProvider({
      'GET /v1/refunds': { status: 200, body: { data: [] } },
      'POST /v1/refunds': { status: 200, body: { id: 're_new_1', status: 'succeeded' } },
    })
    const result = await retry(world, refundId)
    expect(result).toMatchObject({ status: 'confirmed', amount: charge.amount })
    const post = calls.find((call) => call.method === 'POST')!
    expect(post.headers['idempotency-key']).toBeTruthy()
    expect(post.headers['idempotency-key']).not.toBe(oldKey)
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('succeeded')
    expect(refund.idempotencyKey).toBe(post.headers['idempotency-key'])
    expect(refund.attentionCode).toBeUndefined()
    expect(await refundNotices(t)).toHaveLength(1)
    // Still one refund row and the charge counted once.
    expect((await paymentRows(t)).filter((r) => r.kind === 'refund')).toHaveLength(1)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
  })

  test('the read comes BEFORE the send: a failing read sends nothing and changes nothing', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    const before = (await row(t, refundId))!
    const calls = stubProvider({
      'GET /v1/refunds': { status: 503, body: { error: { message: 'unavailable' } } },
      'POST /v1/refunds': { status: 200, body: { id: 're_x', status: 'succeeded' } },
    })
    await expect(retry(world, refundId)).rejects.toThrow()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    const after = (await row(t, refundId))!
    expect(after.status).toBe('reserved')
    expect(after.idempotencyKey).toBe(before.idempotencyKey)
    expect(after.attentionCode).toBe('refund_unconfirmed')
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('Stripe shows the refund still pending: its id is kept for the sweep, nothing is sent', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    const calls = stubProvider({
      'GET /v1/refunds': {
        status: 200,
        body: { data: [{ id: 're_wait_1', status: 'pending', amount: charge.amount }] },
      },
    })
    const result = await retry(world, refundId)
    expect(result).toMatchObject({ status: 'pending' })
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('reserved')
    expect(refund.externalId).toBe('re_wait_1')
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('a refund of ANOTHER row of the same charge is not mistaken for this one', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world, { amount: 500 })
    // An earlier refund of the same 5 € was confirmed with its id: the provider lists it, and it
    // is that row's, not this one's.
    await t.run((ctx) =>
      ctx.db.insert('reservationPayments', {
        storeId: charge.storeId,
        reservationId: charge.reservationId,
        kind: 'refund',
        provider: 'stripe',
        status: 'succeeded',
        amount: 500,
        currency: charge.currency,
        refundOf: charge._id,
        externalId: 're_other_1',
        attempt: 2,
        idempotencyKey: 'rsv-refund-other',
        actor: 'staff',
        createdAt: Date.now() - 40 * HOURS,
        updatedAt: Date.now() - 40 * HOURS,
      }),
    )
    await t.run((ctx) => ctx.db.patch(charge._id, { refundedAmount: 1000 }))
    const calls = stubProvider({
      'GET /v1/refunds': {
        status: 200,
        body: { data: [{ id: 're_other_1', status: 'succeeded', amount: 500 }] },
      },
      'POST /v1/refunds': { status: 200, body: { id: 're_new_2', status: 'succeeded' } },
    })
    const result = await retry(world, refundId)
    expect(result.status).toBe('confirmed')
    // The provider showed nothing of THIS refund, so it was sent.
    expect(calls.some((call) => call.method === 'POST')).toBe(true)
  })

  test('a refusal of the new request releases the amount and says so', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    stubProvider({
      'GET /v1/refunds': { status: 200, body: { data: [] } },
      'POST /v1/refunds': {
        status: 400,
        body: { error: { code: 'charge_already_refunded', message: 'Charge already refunded.' } },
      },
    })
    await expect(retry(world, refundId)).rejects.toThrow()
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('failed')
    expect((await row(t, charge._id))!.refundedAmount).toBe(0)
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('an outage on the new request leaves it committed, and gives it a fresh replay window', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world)
    stubProvider({
      'GET /v1/refunds': { status: 200, body: { data: [] } },
      'POST /v1/refunds': { status: 503, body: { error: { message: 'down' } } },
    })
    const result = await retry(world, refundId)
    expect(result.status).toBe('pending')
    const refund = (await row(t, refundId))!
    expect(refund.status).toBe('reserved')
    expect(refund.createdAt).toBeGreaterThan(Date.now() - HOURS)
    expect((await row(t, charge._id))!.refundedAmount).toBe(charge.amount)
    expect(await refundNotices(t)).toHaveLength(0)
  })

  test('a refund the provider already answered with an id is read, not repeated', async () => {
    const t = newHarness()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world)
    await t.mutation(internal.reservationPayments.noteRefundPending, {
      refundId,
      externalRefundId: 're_known_1',
    })
    const calls = stubProvider({
      'GET /v1/refunds/re_known_1': {
        status: 200,
        body: { id: 're_known_1', status: 'succeeded' },
      },
    })
    const result = await retry(world, refundId)
    expect(result.status).toBe('confirmed')
    expect(calls.map((call) => call.method)).toEqual(['GET'])
    expect((await row(t, refundId))!.status).toBe('succeeded')
    expect(await refundNotices(t)).toHaveLength(1)
  })

  test('PayPal: the order is read first; a refund it lists as completed is recorded', async () => {
    const t = newHarness()
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    _resetEnvCache()
    const world = await paymentWorld(t)
    const { refundId, charge } = await stalledRefund(t, world, { provider: 'paypal' })
    const calls = stubProvider({
      'POST /v1/oauth2/token': { status: 200, body: { access_token: 'tok' } },
      'GET /v2/checkout/orders/ORDER-1': {
        status: 200,
        body: {
          id: 'ORDER-1',
          purchase_units: [
            {
              payments: {
                refunds: [
                  {
                    id: 'PP-REF-1',
                    status: 'COMPLETED',
                    amount: { value: (charge.amount / 100).toFixed(2), currency_code: 'EUR' },
                  },
                ],
              },
            },
          ],
        },
      },
    })
    const result = await retry(world, refundId)
    expect(result.status).toBe('confirmed')
    expect(calls.some((call) => call.method === 'POST' && call.path.includes('/refund'))).toBe(
      false,
    )
    expect((await row(t, refundId))!.externalId).toBe('PP-REF-1')
    expect(await refundNotices(t)).toHaveLength(1)
  })

  test('PayPal: an order with no refund is asked again, under a new request id', async () => {
    const t = newHarness()
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    _resetEnvCache()
    const world = await paymentWorld(t)
    const { refundId } = await stalledRefund(t, world, { provider: 'paypal' })
    const oldKey = (await row(t, refundId))!.idempotencyKey
    const calls = stubProvider({
      'POST /v1/oauth2/token': { status: 200, body: { access_token: 'tok' } },
      'GET /v2/checkout/orders/ORDER-1': {
        status: 200,
        body: { id: 'ORDER-1', purchase_units: [{ payments: {} }] },
      },
      'POST /v2/payments/captures/CAPTURE-1/refund': {
        status: 201,
        body: { id: 'PP-REF-2', status: 'COMPLETED' },
      },
    })
    const result = await retry(world, refundId)
    expect(result.status).toBe('confirmed')
    const post = calls.find((call) => call.path.endsWith('/refund'))!
    expect(post.headers['paypal-request-id']).toBeTruthy()
    expect(post.headers['paypal-request-id']).not.toBe(oldKey)
  })
})
