/**
 * What the groups and the events suites share: a deployment that takes cards through Stripe,
 * a way to settle a payment the way a provider would, and a look at what the scheduler holds.
 *
 * Not a test file: Vitest runs `*.test.ts` only. No provider is ever reached — the facts the
 * suites hand to `settlePayment` are the ones an action would read back from a provider.
 */

import { vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { NOW, type Harness } from './reservation-fixtures'

/** Stripe's key, a network that fails closed, and the timers the scheduler must not run. */
export function stubPaymentWorld() {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_unit')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network in tests')
    }),
  )
  vi.useFakeTimers({ toFake: ['setTimeout'] })
}

export function unstubPaymentWorld() {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
}

/** An establishment that takes cards through Stripe, and PayPal when asked. */
export async function setupGlobalSettings(
  t: Harness,
  payments: { cardProvider: 'stripe' | 'sumup' | 'none'; paypal: boolean } = {
    cardProvider: 'stripe',
    paypal: false,
  },
) {
  await t.run((ctx) =>
    ctx.db.insert('globalSettings', {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      payments: { ...payments, cash: true },
      updatedAt: NOW,
    }),
  )
}

export const scheduled = (t: Harness) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
      name: job.name,
      args: job.args as unknown[],
    })),
  )

/** The booking notices the scheduler holds: the kind of each. */
export async function noticeKinds(t: Harness): Promise<string[]> {
  const jobs = await scheduled(t)
  return jobs
    .filter((job) => job.name.endsWith('customerEmail:sendReservationNotice'))
    .map((job) => (job.args[0] as { kind: string }).kind)
}

/** The payment dispatches the scheduler holds. */
export async function dispatches(t: Harness) {
  const jobs = await scheduled(t)
  return jobs
    .filter((job) => job.name.endsWith('reservationPaymentActions:runDispatch'))
    .map((job) => (job.args[0] as { dispatch: { type: string; [key: string]: unknown } }).dispatch)
}

/** The seat alerts the scheduler holds. */
export async function seatAlertJobs(t: Harness) {
  const jobs = await scheduled(t)
  return jobs.filter((job) => job.name.endsWith('customerEmail:sendExperienceSeatAlert'))
}

export const paymentRows = (t: Harness) =>
  t.run((ctx) => ctx.db.query('reservationPayments').collect())

export const bookingByToken = (t: Harness, token: string) =>
  t.run((ctx) =>
    ctx.db
      .query('reservations')
      .withIndex('by_manageToken', (q) => q.eq('manageToken', token))
      .unique(),
  )

/**
 * Open an attempt the way `startReservationPayment` does — with the guest's consent where the
 * terms were set after the request — and attach a provider page to it.
 */
export async function openAttempt(
  t: Harness,
  token: string,
  options: { provider?: 'stripe' | 'sumup' | 'paypal'; consent?: boolean } = {},
) {
  const attempt = await t.mutation(internal.reservationPayments.beginAttempt, {
    token,
    provider: options.provider ?? 'stripe',
    ...(options.consent !== undefined ? { consent: options.consent } : {}),
  })
  if ('paymentId' in attempt && attempt.paymentId) {
    await t.mutation(internal.reservationPayments.attachSession, {
      paymentId: attempt.paymentId as Id<'reservationPayments'>,
      checkoutRef: `cs_${String(attempt.paymentId).slice(0, 10)}`,
      checkoutUrl: `https://pay.example/${String(attempt.paymentId).slice(0, 10)}`,
      expiresAt: Date.now() + 30 * 60_000,
    })
  }
  return attempt
}

export function paidFact(row: Doc<'reservationPayments'>) {
  return {
    provider: row.provider,
    status: 'completed' as const,
    reference: String(row._id),
    amountMinor: row.kind === 'guarantee' ? 0 : row.amount,
    currency: row.currency,
    externalId: row.kind === 'guarantee' ? 'seti_test' : `pi_${String(row._id).slice(0, 8)}`,
    ...(row.kind === 'guarantee' ? { customerRef: 'cus_test', methodRef: 'pm_test' } : {}),
  }
}

/** The provider confirms the payment of a booking's open attempt. */
export async function payBooking(
  t: Harness,
  token: string,
  options: { consent?: boolean } = {},
): Promise<Doc<'reservationPayments'>> {
  const attempt = await openAttempt(t, token, options)
  const id = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
  const row = (await t.run((ctx) => ctx.db.get(id)))!
  await t.mutation(internal.reservationPayments.settlePayment, {
    paymentId: id,
    fact: paidFact(row) as never,
  })
  return (await t.run((ctx) => ctx.db.get(id)))!
}

/** The group policy an establishment runs, saved the way the settings card saves it. */
export function saveGroupPolicy(
  world: { manager: ReturnType<Harness['withIdentity']>; storeId: Id<'stores'> },
  overrides: Partial<{
    enabled: boolean
    threshold: number
    maxSize: number
    reviewHours: number
    proposalHours: number
  }> = {},
) {
  return world.manager.mutation(api.reservationGroups.saveGroupPolicy, {
    storeId: world.storeId,
    enabled: true,
    threshold: 9,
    maxSize: 20,
    reviewHours: 48,
    proposalHours: 24,
    ...overrides,
  })
}

/** Erase a guest completely, following the continuation the way the wrapper does. */
export async function eraseFully(
  t: Harness,
  owner: ReturnType<Harness['withIdentity']>,
  email: string,
) {
  let result = await owner.mutation(api.privacy.eraseDataSubject, { email })
  let guard = 0
  while (!result.complete) {
    if (guard++ > 50) throw new Error('erasure never completed')
    result = await t.mutation(internal.privacy.continueErasure, {
      email,
      storeIds: result.storeIds as Id<'stores'>[],
      everyStore: result.everyStore,
      actor: result.actor,
      state: result.state,
    })
  }
  return result
}
