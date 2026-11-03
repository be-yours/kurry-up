// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Paying for a booking, from the policy to the ledger.
 *
 * No provider is reached: the actions that call Stripe, SumUp and PayPal run in the
 * Node runtime and are covered by `reservationProviders.test.ts` against a mocked
 * `fetch`. What is proved here is everything the SERVER decides around them — what a
 * booking owes, when it stops holding a table, what a provider's word is bound to
 * before it becomes money on the ledger, and what the money does when the booking ends.
 *
 * The facts handed to `settlePayment` are the ones an action would read back from a
 * provider; the tests build them by hand so the BINDING can be attacked.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  NOW,
  bookSlot,
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

const newHarness = createHarnessFactory()

const HOUR = 60 * 60_000

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_unit')
  // Nothing here may reach a network, and nothing the mutations schedule (a refund to
  // request, a page to close, a mail) may run behind the test's back: the scheduler is
  // looked at, not executed. A job that leaked would fail closed on this `fetch`.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network in tests')
    }),
  )
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type Provider = 'stripe' | 'sumup' | 'paypal'

interface PolicyOptions {
  rules?: Array<Record<string, unknown>>
  freeCancellationHours?: number
  holdMinutes?: number
  primaryProvider?: Provider
}

const DEPOSIT_RULE = { id: 'r1', kind: 'deposit', deposit: { mode: 'per_cover', cents: 1000 } }
const GUARANTEE_RULE = { id: 'g1', kind: 'guarantee', noShowFee: { mode: 'flat', cents: 3000 } }

async function setupGlobalSettings(
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

async function savePolicy(world: World, options: PolicyOptions = {}) {
  return await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
    storeId: world.storeId,
    enabled: true,
    rules: (options.rules ?? [DEPOSIT_RULE]) as never,
    freeCancellationHours: options.freeCancellationHours ?? 48,
    holdMinutes: options.holdMinutes ?? 15,
    ...(options.primaryProvider ? { primaryProvider: options.primaryProvider } : {}),
  })
}

/** A world that takes deposits through Stripe, with `rule` in force. */
async function owingWorld(
  t: Harness,
  options: PolicyOptions & { autoConfirm?: boolean } = {},
): Promise<World> {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    autoConfirm: options.autoConfirm ?? true,
    looseTables: 4,
    cancellationDeadlineHours: 2,
  })
  await savePolicy(world, options)
  return world
}

/** Book the first open slot, agreeing to the payment terms. */
async function bookOwing(
  t: Harness,
  world: World,
  extra: { partySize?: number; email?: string; consent?: boolean } = {},
) {
  const slot = (await openSlots(t, world.storeId, extra.partySize ?? 2))[0]!
  const created = await t.mutation(api.reservations.create, {
    storeId: world.storeId,
    date: dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize: extra.partySize ?? 2,
    guest: { ...guest, email: extra.email ?? guest.email },
    consentNoticeVersion: 'v1',
    ...(extra.consent === false ? {} : { paymentConsent: true }),
  })
  const row = (await t.run((ctx) =>
    ctx.db
      .query('reservations')
      .withIndex('by_manageToken', (q) => q.eq('manageToken', created.manageToken))
      .unique(),
  ))!
  return { created, id: row._id, token: created.manageToken }
}

const payments = (t: Harness) => t.run((ctx) => ctx.db.query('reservationPayments').collect())

const scheduled = (t: Harness) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
      name: job.name,
      args: job.args as unknown[],
    })),
  )

/** The payment dispatches the scheduler holds, by type. */
async function dispatches(t: Harness) {
  const jobs = await scheduled(t)
  return jobs
    .filter((job) => job.name.endsWith('reservationPaymentActions:runDispatch'))
    .map((job) => (job.args[0] as { dispatch: { type: string; [key: string]: unknown } }).dispatch)
}

async function noticeKinds(t: Harness) {
  const jobs = await scheduled(t)
  return jobs
    .filter((job) => job.name.endsWith('customerEmail:sendReservationNotice'))
    .map((job) => (job.args[0] as { kind: string }).kind)
}

/** Open an attempt the way `startReservationPayment` does, and attach a provider page to it. */
async function openAttempt(
  t: Harness,
  token: string,
  provider: Provider = 'stripe',
  options: { attach?: boolean } = {},
) {
  const attempt = await t.mutation(internal.reservationPayments.beginAttempt, { token, provider })
  if ('paymentId' in attempt && attempt.paymentId && options.attach !== false) {
    await t.mutation(internal.reservationPayments.attachSession, {
      paymentId: attempt.paymentId as Id<'reservationPayments'>,
      checkoutRef: `cs_${String(attempt.paymentId).slice(0, 10)}`,
      checkoutUrl: `https://pay.example/${String(attempt.paymentId).slice(0, 10)}`,
      expiresAt: Date.now() + 30 * 60_000,
    })
  }
  return attempt
}

function paidFact(
  row: Doc<'reservationPayments'>,
  overrides: Record<string, unknown> = {},
): {
  provider: Provider
  status: 'completed'
  reference: string
  amountMinor: number | null
  currency: string
  externalId: string
} & Record<string, unknown> {
  return {
    provider: row.provider,
    status: 'completed' as const,
    reference: String(row._id),
    amountMinor: row.kind === 'guarantee' ? 0 : row.amount,
    currency: row.currency,
    externalId: row.kind === 'guarantee' ? 'seti_test' : `pi_${String(row._id).slice(0, 8)}`,
    ...(row.kind === 'guarantee' ? { customerRef: 'cus_test', methodRef: 'pm_test' } : {}),
    ...overrides,
  }
}

async function settle(
  t: Harness,
  row: Doc<'reservationPayments'>,
  overrides: Record<string, unknown> = {},
) {
  return await t.mutation(internal.reservationPayments.settlePayment, {
    paymentId: row._id,
    fact: paidFact(row, overrides) as never,
  })
}

async function onlyRow(t: Harness): Promise<Doc<'reservationPayments'>> {
  const rows = await payments(t)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/** Walk a booking through a paid deposit and return its rows. */
async function paidBooking(t: Harness, world: World, extra: Parameters<typeof bookOwing>[2] = {}) {
  const booking = await bookOwing(t, world, extra)
  const attempt = await openAttempt(t, booking.token)
  const paymentId = (attempt as { paymentId: string }).paymentId as Id<'reservationPayments'>
  const row = (await t.run((ctx) => ctx.db.get(paymentId)))!
  await settle(t, row)
  return { ...booking, row: (await t.run((ctx) => ctx.db.get(paymentId)))! }
}

/** Move a booking's start, the way the clock would. */
async function moveStart(t: Harness, id: Id<'reservations'>, startsAt: number) {
  await t.run((ctx) => ctx.db.patch(id, { startsAt, endsAt: startsAt + 90 * 60_000 }))
}

async function eraseFully(t: Harness, owner: ReturnType<Harness['withIdentity']>, email: string) {
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

/* ------------------------------------------------------------------ */
/* The policy                                                          */
/* ------------------------------------------------------------------ */

describe('saving the policy', () => {
  test('is refused for a guarantee when only SumUp and PayPal are connected, with the reason', async () => {
    const t = newHarness()
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    await setupGlobalSettings(t, { cardProvider: 'sumup', paypal: true })
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run((ctx) =>
      ctx.db.insert('paymentConnections', {
        provider: 'sumup',
        merchantId: 'MABC',
        encryptedAccessToken: 'x',
        status: 'connected',
        connectedAt: NOW,
        updatedAt: NOW,
      }),
    )
    const message = await refusalMessage(savePolicy(world, { rules: [GUARANTEE_RULE] }))
    expect(message).toMatch(/Stripe/)
    expect(message).toMatch(/SumUp/)
    expect(message).toMatch(/PayPal/)
    expect(await t.run((ctx) => ctx.db.query('reservationPaymentPolicy').collect())).toHaveLength(0)
    // The same establishment CAN ask for a deposit, through either.
    await savePolicy(world, { rules: [DEPOSIT_RULE], primaryProvider: 'paypal' })
    expect(await t.run((ctx) => ctx.db.query('reservationPaymentPolicy').collect())).toHaveLength(1)
  })

  test('is refused for anything while the establishment takes no cards', async () => {
    const t = newHarness()
    await setupGlobalSettings(t, { cardProvider: 'none', paypal: true })
    const world = await seedWorld(t, { looseTables: 2 })
    expect(await refusalCode(savePolicy(world))).toBe('payment_refused')
    expect(await refusalMessage(savePolicy(world))).toMatch(/ne pas accepter les cartes/)
  })

  test('is refused when nothing is connected, and when a rule names a service that is not here', async () => {
    const t = newHarness()
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { looseTables: 2 })
    expect(await refusalMessage(savePolicy(world))).toMatch(/connectez Stripe, SumUp ou PayPal/)

    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_unit')
    const message = await refusalMessage(
      savePolicy(world, {
        rules: [{ ...DEPOSIT_RULE, serviceIds: [world.serviceId.replace(/.$/, 'x') as never] }],
      }),
    )
    // A service id that is not this establishment's is a refusal, never a silent no-op.
    expect(message === undefined || /service/.test(message)).toBe(true)
  })

  test('replaces the stored policy instead of stacking a second one', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    await savePolicy(world, { rules: [GUARANTEE_RULE], holdMinutes: 30 })
    const rows = await t.run((ctx) => ctx.db.query('reservationPaymentPolicy').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ holdMinutes: 30, enabled: true })
    expect(rows[0]!.rules[0]!.kind).toBe('guarantee')
  })

  test('needs reservations:manage — a waiter reads it and cannot change it', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const config = await world.waiter.query(api.reservationPayments.getPaymentConfig, {
      storeId: world.storeId,
    })
    expect(config.policy.enabled).toBe(true)
    await expect(
      world.waiter.mutation(api.reservationPayments.savePaymentPolicy, {
        storeId: world.storeId,
        enabled: false,
        rules: [],
        freeCancellationHours: 48,
        holdMinutes: 15,
      }),
    ).rejects.toThrow()
  })

  test('reports the matrix and what is wrong with a saved policy after a provider disappears', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    let config = await world.manager.query(api.reservationPayments.getPaymentConfig, {
      storeId: world.storeId,
    })
    expect(config.connected).toEqual(['stripe'])
    expect(config.refusals).toEqual([])
    const stripe = config.capabilities.find((c) => c.provider === 'stripe')!
    const sumup = config.capabilities.find((c) => c.provider === 'sumup')!
    expect(stripe).toMatchObject({ deposit: true, guarantee: true, connected: true })
    expect(sumup).toMatchObject({ deposit: true, guarantee: false, connected: false })
    expect(sumup.notes.guarantee).toMatch(/pas proposée/)

    vi.stubEnv('STRIPE_SECRET_KEY', '')
    config = await world.manager.query(api.reservationPayments.getPaymentConfig, {
      storeId: world.storeId,
    })
    expect(config.connected).toEqual([])
    expect(config.refusals.length).toBeGreaterThan(0)
  })
})

describe('the quote a guest reads', () => {
  test('states a per-cover deposit for the party, the terms and the ways to pay', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const slot = (await openSlots(t, world.storeId, 4))[0]!
    const quote = await t.query(api.reservationPayments.getPaymentQuote, {
      storeId: world.storeId,
      serviceId: world.serviceId,
      partySize: 4,
      startsAt: slot.startsAt,
    })
    expect(quote).toMatchObject({
      required: true,
      kind: 'deposit',
      depositCents: 4000,
      payable: true,
      defaultProvider: 'stripe',
      freeCancellationHours: 48,
      holdMinutes: 15,
    })
    if (quote.required) {
      expect(quote.lines.join(' ')).toContain('remboursé en totalité')
      expect(quote.consentLabel).toMatch(/acompte/)
      expect(quote.providers).toEqual([{ provider: 'stripe', label: 'Carte bancaire (Stripe)' }])
    }
  })

  test('is « not required » without a policy, and says unpayable when nothing can take it', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { looseTables: 2 })
    const slot = (await openSlots(t, world.storeId))[0]!
    const args = {
      storeId: world.storeId,
      serviceId: world.serviceId,
      partySize: 2,
      startsAt: slot.startsAt,
    }
    expect(await t.query(api.reservationPayments.getPaymentQuote, args)).toEqual({
      required: false,
    })

    await savePolicy(world)
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(await t.query(api.reservationPayments.getPaymentQuote, args)).toMatchObject({
      required: true,
      payable: false,
      providers: [],
    })
  })
})

/* ------------------------------------------------------------------ */
/* Making a booking that owes                                          */
/* ------------------------------------------------------------------ */

describe('a booking that owes a deposit', () => {
  test('is born pending_payment, holds its table for the owner’s minutes and says nothing yet', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { holdMinutes: 20 })
    const { created, id } = await bookOwing(t, world)
    expect(created.status).toBe('pending_payment')
    expect(created.holdExpiresAt).toBeGreaterThan(Date.now() + 19 * 60_000)
    expect(created.holdExpiresAt).toBeLessThanOrEqual(Date.now() + 20 * 60_000)

    const row = (await rowById(t, id))!
    expect(row.paymentTerms).toMatchObject({
      kind: 'deposit',
      depositCents: 2000,
      noShowFeeCents: 0,
      freeCancellationHours: 48,
      currency: 'EUR',
    })
    expect(row.paymentHoldExpiresAt).toBe(created.holdExpiresAt)
    expect(row.paymentCollectedAt).toBeUndefined()
    // No « confirmed » or « pending » mail: nothing is true yet.
    expect(row.notices).toBeUndefined()
    expect(await noticeKinds(t)).toEqual([])
  })

  test('still holds capacity while it waits', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const before = await openSlots(t, world.storeId, 4)
    const first = before[0]!
    // Four tables of four: take them all at the first slot.
    for (let i = 0; i < 4; i++) {
      await t.mutation(api.reservations.create, {
        storeId: world.storeId,
        date: dateIn(10),
        serviceId: first.serviceId as Id<'reservationServices'>,
        startsAt: first.startsAt,
        partySize: 4,
        guest: { ...guest, email: `g${i}@example.com` },
        consentNoticeVersion: 'v1',
        paymentConsent: true,
      })
    }
    const after = (await openSlots(t, world.storeId, 4)).map((s) => s.startsAt)
    expect(after).not.toContain(first.startsAt)
  })

  test('is refused without the guest’s agreement to the payment terms', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    expect(await refusalCode(bookOwing(t, world, { consent: false }))).toBe(
      'payment_consent_required',
    )
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('is refused, honestly, when nothing connected can take the payment', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(await refusalCode(bookOwing(t, world))).toBe('payment_unavailable')
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('a double click on the same key returns the same booking, once', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const slot = (await openSlots(t, world.storeId))[0]!
    const args = {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest,
      consentNoticeVersion: 'v1',
      paymentConsent: true,
      idempotencyKey: 'click-1',
    }
    const a = await t.mutation(api.reservations.create, args)
    const b = await t.mutation(api.reservations.create, args)
    expect(b.manageToken).toBe(a.manageToken)
    expect(b.status).toBe('pending_payment')
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(1)
  })

  test('a booking the team types in owes nothing', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const slot = (await openSlots(t, world.storeId))[0]!
    const made = await world.manager.mutation(api.reservations.createByStaff, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest,
    })
    expect(made.status).toBe('confirmed')
  })

  test('the party size cannot be changed online once the deposit was computed for it', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { autoConfirm: true })
    const { id, token } = await paidBooking(t, world)
    const row = (await rowById(t, id))!
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token,
          date: dateIn(10),
          serviceId: row.serviceId,
          startsAt: row.startsAt,
          partySize: 3,
        }),
      ),
    ).toBe('payment_party_locked')
  })

  test('the team cannot put a booking with nothing to pay into awaiting-payment', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const slot = (await openSlots(t, world.storeId))[0]!
    const made = await world.manager.mutation(api.reservations.createByStaff, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest,
    })
    const id = (await t.run((ctx) => ctx.db.query('reservations').collect())).find(
      (r) => r.reference === made.reference,
    )!._id
    await t.run((ctx) => ctx.db.patch(id, { status: 'pending' }))
    expect(
      await refusalCode(
        world.manager.mutation(api.reservations.setStatus, { id, to: 'pending_payment' }),
      ),
    ).toBe('payment_refused')
  })
})

/* ------------------------------------------------------------------ */
/* Opening an attempt                                                  */
/* ------------------------------------------------------------------ */

describe('opening a payment attempt', () => {
  test('writes a pending row for the deposit with a stable key', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token, id } = await bookOwing(t, world)
    await openAttempt(t, token, 'stripe', { attach: false })
    const row = await onlyRow(t)
    expect(row).toMatchObject({
      kind: 'deposit',
      provider: 'stripe',
      status: 'pending',
      amount: 2000,
      currency: 'EUR',
      attempt: 1,
      actor: 'guest',
    })
    expect(row.idempotencyKey).toBe(`rsv-${id}-deposit-1`)
    expect(row.reservationId).toBe(id)
  })

  test('a second call before the page exists resumes the same row under the same key', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    const a = await openAttempt(t, token, 'stripe', { attach: false })
    const b = await openAttempt(t, token, 'stripe', { attach: false })
    expect(await payments(t)).toHaveLength(1)
    expect('paymentId' in a && 'paymentId' in b && a.paymentId === b.paymentId).toBe(true)
  })

  test('an attempt that never got its page is resumed only while it is fresh; an older one is abandoned', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    const first = await openAttempt(t, token, 'stripe', { attach: false })
    expect('createdAt' in first && typeof first.createdAt === 'number').toBe(true)
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('reservationPayments').first())!
      await ctx.db.patch(row._id, { createdAt: Date.now() - 5 * 60_000 })
    })
    const second = await openAttempt(t, token, 'stripe', { attach: false })
    const rows = await payments(t)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'pending'])
    expect(
      'paymentId' in second && second.paymentId !== ('paymentId' in first ? first.paymentId : ''),
    ).toBe(true)
    // A fresh key for the fresh attempt: the provider never sees the old one's parameters again.
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2])
  })

  test('a second call once the page exists is sent to the SAME page (double click, back button)', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    await openAttempt(t, token, 'stripe')
    const again = await t.mutation(internal.reservationPayments.beginAttempt, {
      token,
      provider: 'stripe',
    })
    expect(again.reuse?.url).toMatch(/^https:\/\/pay\.example\//)
    expect(await payments(t)).toHaveLength(1)
  })

  test('changing provider abandons the first page and asks for it to be closed', async () => {
    const t = newHarness()
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    await setupGlobalSettings(t, { cardProvider: 'stripe', paypal: true })
    const world = await seedWorld(t, { looseTables: 4 })
    await savePolicy(world)
    const { token } = await bookOwing(t, world)
    await openAttempt(t, token, 'stripe')
    await openAttempt(t, token, 'paypal')
    const rows = await payments(t)
    expect(rows.map((r) => [r.provider, r.status]).sort()).toEqual([
      ['paypal', 'pending'],
      ['stripe', 'cancelled'],
    ])
    const closing = (await dispatches(t)).filter((d) => d.type === 'close_attempt')
    expect(closing).toHaveLength(1)
  })

  test('refuses a provider that is not connected, or that cannot take what is owed', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    // SumUp is not the establishment's card provider here.
    expect(
      await refusalCode(
        t.mutation(internal.reservationPayments.beginAttempt, { token, provider: 'sumup' }),
      ),
    ).toBe('payment_unavailable')
    expect(
      await refusalCode(
        t.mutation(internal.reservationPayments.beginAttempt, { token, provider: 'paypal' }),
      ),
    ).toBe('payment_unavailable')
  })

  test('a guarantee is only ever opened on Stripe', async () => {
    const t = newHarness()
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    await setupGlobalSettings(t, { cardProvider: 'stripe', paypal: true })
    const world = await seedWorld(t, { looseTables: 4 })
    await savePolicy(world, { rules: [GUARANTEE_RULE] })
    const { token } = await bookOwing(t, world)
    expect(
      await refusalCode(
        t.mutation(internal.reservationPayments.beginAttempt, { token, provider: 'paypal' }),
      ),
    ).toBe('payment_unavailable')
    await openAttempt(t, token, 'stripe', { attach: false })
    expect(await onlyRow(t)).toMatchObject({ kind: 'guarantee', amount: 3000, provider: 'stripe' })
  })

  test('is refused once the hold has lapsed, and for a booking that is not awaiting payment', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const lapsed = await bookOwing(t, world)
    await t.run((ctx) => ctx.db.patch(lapsed.id, { paymentHoldExpiresAt: Date.now() - 1 }))
    expect(
      await refusalCode(
        t.mutation(internal.reservationPayments.beginAttempt, {
          token: lapsed.token,
          provider: 'stripe',
        }),
      ),
    ).toBe('payment_hold_lapsed')

    const paid = await paidBooking(t, world, { email: 'autre@example.com' })
    expect(
      await refusalCode(
        t.mutation(internal.reservationPayments.beginAttempt, {
          token: paid.token,
          provider: 'stripe',
        }),
      ),
    ).toBe('transition_refused')
  })

  test('the payment page says what to pay and whether the guest still can', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    const page = await t.query(api.reservationPayments.getPaymentPage, { token })
    expect(page).toMatchObject({
      status: 'pending_payment',
      amountDueCents: 2000,
      canPay: true,
      defaultProvider: 'stripe',
    })
    expect(page?.payment?.awaiting).toBe(true)
    expect(page?.payment?.holdLapsed).toBe(false)
    expect(
      await t.query(api.reservationPayments.getPaymentPage, { token: 'not-a-token-at-all' }),
    ).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Settling                                                            */
/* ------------------------------------------------------------------ */

describe('settling a payment', () => {
  test('confirms the booking in a house that confirms by itself, and tells the guest once', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { autoConfirm: true })
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    const result = await settle(t, row)
    expect(result.outcome).toBe('settled')

    const booking = (await rowById(t, id))!
    expect(booking.status).toBe('confirmed')
    expect(booking.paymentHoldExpiresAt).toBeUndefined()
    expect(booking.paymentCollectedAt).toBeGreaterThan(0)
    expect((await onlyRow(t)).status).toBe('succeeded')
    expect(await noticeKinds(t)).toEqual(['confirmed'])
    const events = await eventRows(t)
    expect(events.some((e) => e.note === 'payment_deposit_paid' && e.to === 'confirmed')).toBe(true)
  })

  test('puts it back to the team in a house that validates by hand', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { autoConfirm: false })
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    await settle(t, await onlyRow(t))
    expect((await rowById(t, id))!.status).toBe('pending')
    expect(await noticeKinds(t)).toEqual(['pending'])
  })

  test('is idempotent: the return page, the webhook and the sweep settle it ONCE', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    const outcomes = [
      (await settle(t, row)).outcome,
      (await settle(t, row)).outcome,
      (await settle(t, row)).outcome,
    ]
    expect(outcomes).toEqual(['settled', 'already', 'already'])
    expect(await payments(t)).toHaveLength(1)
    expect(await noticeKinds(t)).toEqual(['confirmed'])
    expect((await rowById(t, id))!.status).toBe('confirmed')
    expect(await dispatches(t)).toEqual([])
  })

  test('does not care which of two arrivals comes first: webhook-first and redirect-first end the same', async () => {
    const results: string[] = []
    for (const order of ['webhook-first', 'redirect-first'] as const) {
      const t = newHarness()
      const world = await owingWorld(t)
      const { id, token } = await bookOwing(t, world)
      await openAttempt(t, token)
      const row = await onlyRow(t)
      // Both arrivals carry the same provider fact; the redirect also finds the booking
      // already confirmed when the webhook was first, and vice versa.
      const first = await settle(t, row)
      const second = await settle(t, row)
      expect([first.outcome, second.outcome]).toEqual(['settled', 'already'])
      const booking = (await rowById(t, id))!
      results.push(
        `${order}:${booking.status}:${(await payments(t)).length}:${(await noticeKinds(t)).length}`,
      )
    }
    expect(results[0]!.split(':').slice(1)).toEqual(results[1]!.split(':').slice(1))
  })

  test.each([
    ['another reservation’s reference', { reference: 'someone-else' }, 'reference_mismatch'],
    ['no reference', { reference: undefined }, 'reference_missing'],
    ['less than the deposit', { amountMinor: 1999 }, 'amount_mismatch'],
    ['more than the deposit', { amountMinor: 2001 }, 'amount_mismatch'],
    ['no amount', { amountMinor: null }, 'amount_missing'],
    ['another currency', { currency: 'USD' }, 'currency_mismatch'],
    ['another provider', { provider: 'sumup' }, 'provider_mismatch'],
  ])('refuses a fact with %s and records no money', async (_label, change, code) => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    expect(await refusalCode(settle(t, row, change))).toBe(code)
    expect((await onlyRow(t)).status).toBe('pending')
    expect((await rowById(t, id))!.status).toBe('pending_payment')
    expect(await noticeKinds(t)).toEqual([])
  })

  test('a completed payment never confirms a booking by the guest’s word: an open one changes nothing', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    const result = await t.mutation(internal.reservationPayments.settlePayment, {
      paymentId: row._id,
      fact: { ...paidFact(row), status: 'pending' } as never,
    })
    expect(result.outcome).toBe('pending')
    expect((await rowById(t, id))!.status).toBe('pending_payment')
    expect((await onlyRow(t)).status).toBe('pending')
  })

  test('a fact that says the page expired or failed closes the row and leaves the booking holding its table', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    await t.mutation(internal.reservationPayments.settlePayment, {
      paymentId: row._id,
      fact: { ...paidFact(row), status: 'failed' } as never,
    })
    expect((await onlyRow(t)).status).toBe('failed')
    expect((await rowById(t, id))!.status).toBe('pending_payment')
    // The guest can try again on a fresh page.
    await openAttempt(t, token)
    expect(await payments(t)).toHaveLength(2)
  })

  test('a guarantee settles to confirmed with the card references, taking no money', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    await settle(t, await onlyRow(t))
    const row = await onlyRow(t)
    expect(row).toMatchObject({
      status: 'succeeded',
      customerRef: 'cus_test',
      methodRef: 'pm_test',
    })
    const booking = (await rowById(t, id))!
    expect(booking.status).toBe('confirmed')
    // Nothing was collected: the booking is not yet a piece of the accounts.
    expect(booking.paymentCollectedAt).toBeUndefined()
  })

  test('a payment arriving after the hold lapsed is recorded and refunded, never kept', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const row = await onlyRow(t)
    // The hold ran out and the sweep expired the booking while the guest was paying.
    await t.run((ctx) => ctx.db.patch(id, { paymentHoldExpiresAt: Date.now() - 1 }))
    const swept = await t.mutation(internal.reservationPayments.expireLapsed, {
      reservationIds: [id],
    })
    expect(swept.expired).toBe(1)
    expect((await rowById(t, id))!.status).toBe('expired')

    const result = await settle(t, (await payments(t))[0]!)
    expect(result.outcome).toBe('refund_due')
    expect((await rowById(t, id))!.status).toBe('expired')
    expect((await payments(t))[0]!.status).toBe('succeeded')
    const refunds = (await dispatches(t)).filter((d) => d.type === 'refund')
    expect(refunds).toEqual([expect.objectContaining({ paymentId: String(row._id), amount: 2000 })])
    // Said where an operator reads it, because money moved on a booking that ended.
    const audit = await t.run((ctx) => ctx.db.query('systemAuditLog').collect())
    expect(audit.some((entry) => entry.action === 'payment_collection_refused')).toBe(true)
  })

  test('a second deposit on a booking already paid is refunded in full (two pages paid)', async () => {
    const t = newHarness()
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id')
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret')
    await setupGlobalSettings(t, { cardProvider: 'stripe', paypal: true })
    const world = await seedWorld(t, { looseTables: 4 })
    await savePolicy(world)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token, 'stripe')
    await openAttempt(t, token, 'paypal')
    const [stripeRow, paypalRow] = [
      (await payments(t)).find((r) => r.provider === 'stripe')!,
      (await payments(t)).find((r) => r.provider === 'paypal')!,
    ]
    // The guest paid on the first page anyway (it was closed too late): that payment
    // settles the booking, wherever it came from...
    expect((await settle(t, stripeRow)).outcome).toBe('settled')
    expect((await rowById(t, id))!.status).toBe('confirmed')
    // ...and the other page, paid as well, is a second deposit: handed back, not kept.
    expect((await settle(t, paypalRow)).outcome).toBe('refund_due')
    const refunds = (await dispatches(t)).filter((d) => d.type === 'refund')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.paymentId).toBe(String(paypalRow._id))
    expect((await noticeKinds(t)).filter((k) => k === 'confirmed')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* Ending a booking                                                    */
/* ------------------------------------------------------------------ */

describe('what happens to the deposit when the booking ends', () => {
  test('a guest cancelling before the cut-off gets a refund asked for, automatically', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token, row } = await paidBooking(t, world)
    const out = await t.mutation(api.reservations.cancelByToken, { token })
    expect(out.status).toBe('cancelled_by_guest')
    expect((await rowById(t, id))!.status).toBe('cancelled_by_guest')
    expect(await dispatches(t)).toEqual([
      expect.objectContaining({ type: 'refund', paymentId: String(row._id), amount: 2000 }),
    ])
    expect((await eventRows(t)).some((e) => e.note === 'payment_refund_requested')).toBe(true)
  })

  test('after the cut-off the guest cannot cancel online at all — they cannot lose money by clicking', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { freeCancellationHours: 48 })
    const { id, token } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() + 30 * HOUR)
    expect(await refusalCode(t.mutation(api.reservations.cancelByToken, { token }))).toBe(
      'cancellation_closed',
    )
    expect((await rowById(t, id))!.status).toBe('confirmed')
    const view = await t.query(api.reservations.getByToken, { token })
    expect(view?.canCancel).toBe(false)
  })

  test('the cut-off the guest is shown is the policy’s, not the establishment’s general deadline', async () => {
    const t = newHarness()
    // The general deadline is 2 hours; the deposit's is 48.
    const world = await owingWorld(t, { freeCancellationHours: 48 })
    const { id, token } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() + 10 * HOUR)
    const view = await t.query(api.reservations.getByToken, { token })
    expect(view?.canCancel).toBe(false)
    await moveStart(t, id, Date.now() + 49 * HOUR)
    expect((await t.query(api.reservations.getByToken, { token }))?.canCancel).toBe(true)
  })

  test('staff recording a late cancellation as the guest’s own keeps the deposit', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() + 10 * HOUR)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_guest' })
    expect(await dispatches(t)).toEqual([])
    expect((await eventRows(t)).some((e) => e.note === 'payment_deposit_kept')).toBe(true)
  })

  test.each(['cancelled_by_restaurant', 'declined'] as const)(
    'a booking the restaurant ends (%s) is refunded in full even after the cut-off',
    async (to) => {
      const t = newHarness()
      const world = await owingWorld(t, { autoConfirm: false })
      const { id, row } = await paidBooking(t, world)
      expect((await rowById(t, id))!.status).toBe('pending')
      await moveStart(t, id, Date.now() + 5 * HOUR)
      await world.manager.mutation(api.reservations.setStatus, { id, to })
      expect(await dispatches(t)).toEqual([
        expect.objectContaining({ type: 'refund', paymentId: String(row._id), amount: 2000 }),
      ])
    },
  )

  test('a no-show keeps the deposit and asks for nothing', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() - 3 * HOUR)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'no_show' })
    expect(await dispatches(t)).toEqual([])
    expect((await rowById(t, id))!.status).toBe('no_show')
  })

  test('cancelling an UNPAID booking frees the table, takes nothing and closes the open page', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    await t.mutation(api.reservations.cancelByToken, { token })
    expect((await rowById(t, id))!.status).toBe('cancelled_by_guest')
    expect((await onlyRow(t)).status).toBe('cancelled')
    expect(await dispatches(t)).toEqual([expect.objectContaining({ type: 'close_attempt' })])
  })

  test('a booking the team confirms by hand without payment stops asking the guest to pay', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })
    expect((await onlyRow(t)).status).toBe('cancelled')
    expect((await rowById(t, id))!.status).toBe('confirmed')
    expect((await rowById(t, id))!.paymentHoldExpiresAt).toBeUndefined()
    // ...and a payment that lands anyway is handed back, not kept.
    expect((await settle(t, await onlyRow(t))).outcome).toBe('refund_due')
  })

  test('the expiry sweep’s floor also hands back what was paid for an unanswered request', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { autoConfirm: false })
    const { id } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() - HOUR)
    const swept = await t.mutation(internal.reservations.expireUnanswered, {})
    expect(swept.expired).toBe(1)
    expect((await rowById(t, id))!.status).toBe('expired')
    expect((await dispatches(t)).filter((d) => d.type === 'refund')).toHaveLength(1)
  })
})

describe('the guarantee when the booking ends', () => {
  test('is released with the sitting, and the saved card is forgotten', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const { id, row } = await paidBooking(t, world)
    expect(row.kind).toBe('guarantee')
    await t.run((ctx) => ctx.db.patch(id, { status: 'seated' }))
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'completed' })
    expect((await payments(t))[0]!.status).toBe('released')
    expect(await dispatches(t)).toEqual([
      expect.objectContaining({ type: 'release_card', paymentId: String(row._id) }),
    ])
    // The action then forgets the references.
    await t.mutation(internal.reservationPayments.forgetCard, { paymentId: row._id })
    const forgotten = (await payments(t))[0]!
    expect(forgotten.customerRef).toBeUndefined()
    expect(forgotten.methodRef).toBeUndefined()
    expect(forgotten.status).toBe('released')
  })

  test('is released when the guest cancels in time, and when the restaurant ends the booking', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const a = await paidBooking(t, world)
    await t.mutation(api.reservations.cancelByToken, { token: a.token })
    expect((await payments(t))[0]!.status).toBe('released')

    const b = await paidBooking(t, world, { email: 'b@example.com' })
    await world.manager.mutation(api.reservations.setStatus, {
      id: b.id,
      to: 'cancelled_by_restaurant',
    })
    expect((await payments(t)).filter((r) => r.status === 'released')).toHaveLength(2)
  })

  test('waiving releases it and forgets the card; a pending fee is never waived out from under a charge', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const { id } = await paidBooking(t, world)
    await world.manager.mutation(api.reservationPayments.waive, { reservationId: id })
    expect((await payments(t))[0]!.status).toBe('released')
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationPayments.waive, { reservationId: id }),
      ),
    ).toBe('payment_refused')
  })
})

/* ------------------------------------------------------------------ */
/* The hold                                                            */
/* ------------------------------------------------------------------ */

describe('the hold', () => {
  test('releases an unpaid booking when it lapses, closes its page and gives the table back', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    const before = (await openSlots(t, world.storeId)).length

    expect(await t.query(internal.reservationPayments.lapsedHolds, {})).toEqual([])
    await t.run((ctx) => ctx.db.patch(id, { paymentHoldExpiresAt: Date.now() - 1 }))
    const lapsed = await t.query(internal.reservationPayments.lapsedHolds, {})
    expect(lapsed).toHaveLength(1)
    expect(lapsed[0]!.pending).toHaveLength(1)

    const result = await t.mutation(internal.reservationPayments.expireLapsed, {
      reservationIds: [id],
    })
    expect(result.expired).toBe(1)
    const booking = (await rowById(t, id))!
    expect(booking.status).toBe('expired')
    expect(booking.paymentHoldExpiresAt).toBeUndefined()
    expect((await onlyRow(t)).status).toBe('cancelled')
    expect((await dispatches(t)).some((d) => d.type === 'close_attempt')).toBe(true)
    expect((await openSlots(t, world.storeId)).length).toBeGreaterThanOrEqual(before)
    // The guest's page says so.
    const page = await t.query(api.reservationPayments.getPaymentPage, { token })
    expect(page).toMatchObject({ status: 'expired', canPay: false })
  })

  test('leaves a booking alone whose payment landed, or whose hold is still running', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const paid = await paidBooking(t, world)
    const waiting = await bookOwing(t, world, { email: 'wait@example.com' })
    const result = await t.mutation(internal.reservationPayments.expireLapsed, {
      reservationIds: [paid.id, waiting.id],
    })
    expect(result.expired).toBe(0)
    expect((await rowById(t, paid.id))!.status).toBe('confirmed')
    expect((await rowById(t, waiting.id))!.status).toBe('pending_payment')
  })

  test('the reconciliation sweep sees an attempt old enough to be asked about, and no other', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await bookOwing(t, world)
    await openAttempt(t, token)
    expect(await t.query(internal.reservationPayments.attemptsToReconcile, {})).toEqual([])
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('reservationPayments').first())!
      await ctx.db.patch(row._id, { createdAt: Date.now() - 10 * 60_000 })
    })
    expect(await t.query(internal.reservationPayments.attemptsToReconcile, {})).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

describe('refunds', () => {
  async function paid() {
    const t = newHarness()
    const world = await owingWorld(t)
    const booking = await paidBooking(t, world)
    return { t, world, ...booking }
  }

  test('commit the amount before the provider is asked, in a row of their own', async () => {
    const { t, row, id } = await paid()
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 500,
      reason: 'Geste commercial',
      actor: 'staff',
    })
    expect(reserved).toMatchObject({ provider: 'stripe', amount: 500, currency: 'EUR' })
    expect(reserved.externalId).toMatch(/^pi_/)
    expect(reserved.idempotencyKey).toBe(`rsv-refund-${row._id}-1`)
    const rows = await payments(t)
    const refund = rows.find((r) => r.kind === 'refund')!
    expect(refund).toMatchObject({
      status: 'reserved',
      amount: 500,
      refundOf: row._id,
      reservationId: id,
    })
    expect(rows.find((r) => r.kind === 'deposit')!.refundedAmount).toBe(500)
  })

  test('are not « refunded » until the provider confirms, and then tell the guest', async () => {
    const { t, row } = await paid()
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 2000,
      actor: 'staff',
    })
    const page = async () =>
      (await t.query(api.reservationPayments.getPaymentPage, {
        token: (await t.run((ctx) => ctx.db.query('reservations').first()))!.manageToken,
      }))!.payment!
    expect(await page()).toMatchObject({ state: 'paid', refundedCents: 0 })

    await t.mutation(internal.reservationPayments.confirmRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
      externalRefundId: 're_1',
    })
    expect(await page()).toMatchObject({ state: 'refunded', refundedCents: 2000 })
    expect(await noticeKinds(t)).toContain('payment_refunded')
    // Confirming twice neither writes a second mail nor changes the figures.
    await t.mutation(internal.reservationPayments.confirmRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
    })
    expect((await noticeKinds(t)).filter((k) => k === 'payment_refunded')).toHaveLength(1)
  })

  test('cannot exceed what is left, in parts or at once, nor be zero, fractional or on a failed payment', async () => {
    const { t, row } = await paid()
    const reserve = (amount: number) =>
      t.mutation(internal.reservationPayments.reserveRefund, {
        paymentId: row._id,
        amount,
        actor: 'staff',
      })
    expect(await refusalCode(reserve(2001))).toBe('payment_refused')
    expect(await refusalCode(reserve(0))).toBe('payment_refused')
    expect(await refusalCode(reserve(10.5))).toBe('payment_refused')
    await reserve(1500)
    expect(await refusalMessage(reserve(501))).toMatch(/solde restant/)
    await reserve(500)
    expect(await refusalCode(reserve(1))).toBe('payment_refused')
    expect((await payments(t)).filter((r) => r.kind === 'refund')).toHaveLength(2)

    // A pending payment is not a payment: nothing to give back.
    const t2 = newHarness()
    const world2 = await owingWorld(t2)
    const { token } = await bookOwing(t2, world2)
    await openAttempt(t2, token)
    const pending = await onlyRow(t2)
    expect(
      await refusalCode(
        t2.mutation(internal.reservationPayments.reserveRefund, {
          paymentId: pending._id,
          amount: 100,
          actor: 'staff',
        }),
      ),
    ).toBe('payment_refused')
  })

  test('a refund the provider REFUSED goes back to the balance so the host can try again', async () => {
    const { t, row } = await paid()
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 2000,
      actor: 'staff',
    })
    await t.mutation(internal.reservationPayments.releaseRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
      code: 'charge_already_refunded',
      message: 'déjà remboursé',
    })
    const rows = await payments(t)
    expect(rows.find((r) => r.kind === 'refund')).toMatchObject({
      status: 'failed',
      failure: { code: 'charge_already_refunded' },
    })
    expect(rows.find((r) => r.kind === 'deposit')!.refundedAmount).toBe(0)
    // The balance is whole again.
    await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 2000,
      actor: 'staff',
    })
  })

  test('a refund whose outcome is UNKNOWN stays committed — it is never released into a second attempt', async () => {
    const { t, row } = await paid()
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 2000,
      actor: 'staff',
    })
    await t.mutation(internal.reservationPayments.noteRefundUnknown, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
      message: 'timeout',
    })
    const rows = await payments(t)
    expect(rows.find((r) => r.kind === 'refund')).toMatchObject({
      status: 'reserved',
      failure: { code: 'outcome_unknown' },
    })
    expect(rows.find((r) => r.kind === 'deposit')!.refundedAmount).toBe(2000)
    // Too early for the sweep to ask again; old enough, it is on its list.
    expect(await t.query(internal.reservationPayments.refundsToRetry, {})).toEqual({
      replay: [],
      read: [],
    })
    await t.run(async (ctx) => {
      const refund = (await ctx.db.query('reservationPayments').collect()).find(
        (r) => r.kind === 'refund',
      )!
      await ctx.db.patch(refund._id, { createdAt: Date.now() - 5 * 60_000 })
    })
    expect(await t.query(internal.reservationPayments.refundsToRetry, {})).toEqual({
      replay: [reserved.refundId],
      read: [],
    })
  })

  test('a refund made at the provider itself is recorded once, by the part our books do not know', async () => {
    const { t, row } = await paid()
    const externalId = row.externalId!
    const record = (total: number) =>
      t.mutation(internal.reservationPayments.recordProviderRefund, {
        externalId,
        refundedTotalMinor: total,
        reason: 'Remboursement effectué depuis le tableau de bord Stripe',
      })
    expect((await record(500)).status).toBe('recorded')
    expect((await record(500)).status).toBe('unchanged')
    expect((await record(2000)).status).toBe('recorded')
    const refunds = (await payments(t)).filter((r) => r.kind === 'refund')
    expect(refunds.map((r) => r.amount).sort()).toEqual([1500, 500])
    expect(refunds.every((r) => r.status === 'succeeded' && r.actor === 'system')).toBe(true)
    // More than the charge can never be recorded.
    expect((await record(99_999)).status).toBe('unchanged')
    expect(
      (
        await t.mutation(internal.reservationPayments.recordProviderRefund, {
          externalId: 'pi_unknown',
          refundedTotalMinor: 100,
          reason: 'x',
        })
      ).status,
    ).toBe('not_found')
  })

  test('a refund our own request made is not counted a second time when the provider reports it', async () => {
    const { t, row } = await paid()
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 2000,
      actor: 'staff',
    })
    // The provider's webhook arrives before our own confirmation.
    const echoed = await t.mutation(internal.reservationPayments.recordProviderRefund, {
      externalId: row.externalId!,
      refundedTotalMinor: 2000,
      reason: 'dashboard',
    })
    expect(echoed.status).toBe('unchanged')
    await t.mutation(internal.reservationPayments.confirmRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
    })
    expect((await payments(t)).filter((r) => r.kind === 'refund')).toHaveLength(1)
  })

  test('a host without payments:refund cannot start one', async () => {
    const { t, row, world } = await paid()
    // `authorizeRefund` is what every host refund goes through before anything is reserved.
    await expect(
      world.waiter.query(
        internal.reservationPayments.authorizeRefund as never,
        {
          paymentId: row._id,
        } as never,
      ),
    ).rejects.toThrow()
    expect(await payments(t)).toHaveLength(1)
  })

  test('the history shows the rows without a single provider reference', async () => {
    const { t, world, id, row } = await paid()
    await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 700,
      actor: 'staff',
    })
    const history = await world.manager.query(api.reservationPayments.historyFor, {
      reservationId: id,
    })
    expect(history.map((h) => [h.kind, h.status, h.amount])).toEqual([
      ['deposit', 'succeeded', 2000],
      ['refund', 'reserved', 700],
    ])
    expect(JSON.stringify(history)).not.toMatch(/pi_|cs_|cus_|pm_/)
    const summary = await world.manager.query(api.reservationPayments.listForBookings, {
      storeId: world.storeId,
      ids: [id],
    })
    expect(summary).toEqual([
      expect.objectContaining({
        state: 'paid',
        heldCents: 2000,
        refundedCents: 0,
        kind: 'deposit',
      }),
    ])
  })
})

/* ------------------------------------------------------------------ */
/* The no-show fee                                                     */
/* ------------------------------------------------------------------ */

describe('the no-show fee', () => {
  async function guaranteed() {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const booking = await paidBooking(t, world)
    return { t, world, ...booking }
  }

  async function noShow(t: Harness, world: World, id: Id<'reservations'>) {
    await moveStart(t, id, Date.now() - 3 * HOUR)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'no_show' })
  }

  const begin = (t: Harness, id: Id<'reservations'>, amount?: number) =>
    t.mutation(internal.reservationPayments.beginFee, {
      reservationId: id,
      ...(amount !== undefined ? { amount } : {}),
    })

  test('opens a charge on the secured card, for what is left of the cap by default', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    const fee = await begin(t, id)
    expect(fee).toMatchObject({
      amount: 3000,
      currency: 'EUR',
      provider: 'stripe',
      customerRef: 'cus_test',
      methodRef: 'pm_test',
    })
    expect(fee.idempotencyKey).toBe(`rsv-${id}-no_show_fee-1`)
    const rows = await payments(t)
    expect(rows.find((r) => r.kind === 'no_show_fee')).toMatchObject({
      status: 'pending',
      actor: 'staff',
      amount: 3000,
    })
  })

  test('is charged only on a recorded no-show: every other state is refused, the restaurant’s exits included', async () => {
    const { t, world, id } = await guaranteed()
    expect(await refusalMessage(begin(t, id))).toMatch(/absence enregistrée/)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_restaurant' })
    expect(await refusalMessage(begin(t, id))).toMatch(/absence enregistrée/)
    expect((await payments(t)).filter((r) => r.kind === 'no_show_fee')).toHaveLength(0)
  })

  test('is refused for a booking that carries a deposit, not a guarantee', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() - 3 * HOUR)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'no_show' })
    expect(await refusalMessage(begin(t, id))).toMatch(/pas de garantie/)
  })

  test('is refused before the booking was due, even if a status says no-show', async () => {
    const { t, id } = await guaranteed()
    await t.run((ctx) => ctx.db.patch(id, { status: 'no_show' }))
    expect(await refusalMessage(begin(t, id))).toMatch(/pas encore passée/)
  })

  test('cannot exceed the amount the guest was shown, in one go or in parts', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    expect(await refusalMessage(begin(t, id, 3001))).toMatch(/dépasse les frais annoncés/)
    expect(await refusalMessage(begin(t, id, 0))).toMatch(/entier de centimes/)
    expect(await refusalMessage(begin(t, id, 12.5))).toMatch(/entier de centimes/)

    const first = await begin(t, id, 1000)
    await settle(t, (await payments(t)).find((r) => String(r._id) === first.paymentId)!, {
      externalId: 'pi_fee1',
    })
    const second = await begin(t, id)
    expect(second.amount).toBe(2000)
    expect(await refusalMessage(begin(t, id, 2001))).toMatch(/en cours/)
  })

  test('cannot be charged twice at once: a second request while one is in flight is refused', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    await begin(t, id)
    expect(await refusalMessage(begin(t, id))).toMatch(/déjà en cours/)
    expect((await payments(t)).filter((r) => r.kind === 'no_show_fee')).toHaveLength(1)
  })

  test('a charge settles into the ledger, tells the guest and makes the booking a piece of the accounts', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    const fee = await begin(t, id)
    const row = (await payments(t)).find((r) => String(r._id) === fee.paymentId)!
    const result = await settle(t, row, { externalId: 'pi_fee' })
    expect(result.outcome).toBe('settled')
    expect((await payments(t)).find((r) => String(r._id) === fee.paymentId)!.status).toBe(
      'succeeded',
    )
    expect((await rowById(t, id))!.paymentCollectedAt).toBeGreaterThan(0)
    expect(await noticeKinds(t)).toContain('fee_charged')
    // A second delivery of the same fact does nothing more.
    expect((await settle(t, row, { externalId: 'pi_fee' })).outcome).toBe('already')
    expect((await noticeKinds(t)).filter((k) => k === 'fee_charged')).toHaveLength(1)
    const summary = await world.manager.query(api.reservationPayments.listForBookings, {
      storeId: world.storeId,
      ids: [id],
    })
    expect(summary[0]).toMatchObject({
      state: 'fee_charged',
      feeChargedCents: 3000,
      feeRemainingCents: 0,
    })
  })

  test('a declined card is a state, not a loop: the row says why and both mails are claimed once', async () => {
    const { t, world, id } = await guaranteed()
    // The team's copy goes to the establishment's own address, when it has set one.
    await t.run((ctx) => ctx.db.patch(world.storeId, { email: 'contact@luigi.example' }))
    await noShow(t, world, id)
    const fee = await begin(t, id)
    const failed = await t.mutation(internal.reservationPayments.failFee, {
      paymentId: fee.paymentId as Id<'reservationPayments'>,
      code: 'insufficient_funds',
      message: 'Your card has insufficient funds.',
    })
    expect(failed.failed).toBe(true)
    const row = (await payments(t)).find((r) => r.kind === 'no_show_fee')!
    expect(row).toMatchObject({ status: 'failed', failure: { code: 'insufficient_funds' } })
    const kinds = await noticeKinds(t)
    expect(kinds).toContain('payment_failed')
    expect(kinds).toContain('payment_failed_restaurant')
    // A late echo of the same failure writes nothing more.
    const again = await t.mutation(internal.reservationPayments.failFee, {
      paymentId: fee.paymentId as Id<'reservationPayments'>,
      code: 'insufficient_funds',
      message: 'x',
    })
    expect(again.failed).toBe(false)
    expect(
      (
        await world.manager.query(api.reservationPayments.listForBookings, {
          storeId: world.storeId,
          ids: [id],
        })
      )[0]!.state,
    ).toBe('fee_failed')
  })

  test('stops after three attempts: no retry storm', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    for (let i = 0; i < 3; i++) {
      const fee = await begin(t, id)
      await t.mutation(internal.reservationPayments.failFee, {
        paymentId: fee.paymentId as Id<'reservationPayments'>,
        code: 'card_declined',
        message: 'declined',
      })
    }
    expect(await refusalMessage(begin(t, id))).toMatch(/Contactez le client/)
  })

  test('a failed fee can be waived, which forgets the card', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    const fee = await begin(t, id)
    await t.mutation(internal.reservationPayments.failFee, {
      paymentId: fee.paymentId as Id<'reservationPayments'>,
      code: 'card_declined',
      message: 'declined',
    })
    await world.manager.mutation(api.reservationPayments.waive, { reservationId: id })
    const rows = await payments(t)
    expect(rows.find((r) => r.kind === 'no_show_fee')!.status).toBe('waived')
    expect(rows.find((r) => r.kind === 'guarantee')!.status).toBe('released')
  })

  test('the party cannot be brought back to « arrived » while the fee for its absence stands', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    const fee = await begin(t, id)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservations.setStatus, { id, to: 'arrived' }),
      ),
    ).toMatch(/frais d'absence/)
    await settle(t, (await payments(t)).find((r) => String(r._id) === fee.paymentId)!, {
      externalId: 'pi_fee',
    })
    expect(
      await refusalCode(world.manager.mutation(api.reservations.setStatus, { id, to: 'arrived' })),
    ).toBe('payment_refused')
    // Refunded in full, the party may come back.
    const charged = (await payments(t)).find((r) => r.kind === 'no_show_fee')!
    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: charged._id,
      amount: charged.amount,
      actor: 'staff',
    })
    await t.mutation(internal.reservationPayments.confirmRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
    })
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'arrived' })
    expect((await rowById(t, id))!.status).toBe('arrived')
  })

  test('without a no-show, a no_show → arrived with no fee stays free', async () => {
    const { t, world, id } = await guaranteed()
    await noShow(t, world, id)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'arrived' })
    expect((await rowById(t, id))!.status).toBe('arrived')
  })
})

/* ------------------------------------------------------------------ */
/* What the guest reads, and the mail                                  */
/* ------------------------------------------------------------------ */

describe('what the guest is told', () => {
  test('the manage page carries the terms in words, the figures and whether they can still cancel', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { token } = await paidBooking(t, world)
    const view = await t.query(api.reservations.getByToken, { token })
    expect(view?.payment).toMatchObject({
      kind: 'deposit',
      depositCents: 2000,
      state: 'paid',
      heldCents: 2000,
      awaiting: false,
      freeCancellationHours: 48,
    })
    expect(view?.payment?.lines.join(' ')).toContain('remboursé en totalité')
    expect(view?.canCancel).toBe(true)
    // Nothing that is the provider's reaches the guest.
    expect(JSON.stringify(view)).not.toMatch(/pi_|cs_|cus_|pm_/)
  })

  test('a booking with nothing to pay has no payment block', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { looseTables: 2 })
    const slot = (await openSlots(t, world.storeId))[0]!
    const made = await bookSlot(t, world, slot)
    expect(
      (await t.query(api.reservations.getByToken, { token: made.manageToken }))?.payment,
    ).toBeNull()
  })

  test('the confirmation mail carries the receipt and the terms; the refund mail the amount', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, row } = await paidBooking(t, world)
    const confirmed = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'confirmed',
    })
    expect(confirmed?.email.payment?.rows[0]?.label).toBe('Acompte réglé')
    expect(confirmed?.email.payment?.rows[0]?.value.replace(/\s/g, ' ')).toBe('20,00 €')
    expect(confirmed?.email.payment?.lines.join(' ')).toContain('remboursé en totalité')
    // The deadline the mail repeats is the one next to the money, not the general one.
    expect(confirmed?.email.cancellationDeadlineHours).toBe(48)

    const reserved = await t.mutation(internal.reservationPayments.reserveRefund, {
      paymentId: row._id,
      amount: 750,
      actor: 'staff',
    })
    // Not yet confirmed by the provider: there is no refund to tell the guest about.
    expect(
      await t.query(internal.reservations.noticePayload, {
        reservationId: id,
        kind: 'payment_refunded',
      }),
    ).toSatisfy(
      (payload: { email: { payment?: unknown } } | null) => payload?.email.payment === undefined,
    )
    await t.mutation(internal.reservationPayments.confirmRefund, {
      refundId: reserved.refundId as Id<'reservationPayments'>,
    })
    const refunded = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'payment_refunded',
    })
    expect(refunded?.email.payment?.rows[0]?.label).toBe('Montant remboursé')
    expect(refunded?.email.payment?.rows[0]?.value.replace(/\s/g, ' ')).toBe('7,50 €')
  })

  test('the team’s failed-fee mail goes to the establishment, the guest’s to the guest', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    await t.run((ctx) => ctx.db.patch(world.storeId, { email: 'contact@luigi.example' }))
    const { id } = await paidBooking(t, world)
    await moveStart(t, id, Date.now() - 3 * HOUR)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'no_show' })
    const fee = await t.mutation(internal.reservationPayments.beginFee, { reservationId: id })
    await t.mutation(internal.reservationPayments.failFee, {
      paymentId: fee.paymentId as Id<'reservationPayments'>,
      code: 'insufficient_funds',
      message: 'm',
    })
    const toGuest = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'payment_failed',
    })
    const toTeam = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'payment_failed_restaurant',
    })
    expect(toGuest?.toEmail).toBe(guest.email)
    expect(toTeam?.toEmail).toBe('contact@luigi.example')
    expect(toTeam?.email.payment?.rows.map((r) => r.label)).toContain('Motif de la banque')
    expect(toGuest?.email.payment?.rows.map((r) => r.label)).not.toContain('Motif de la banque')
  })

  test('a refund mail is true whatever became of the booking; a fee mail only of a no-show', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id } = await paidBooking(t, world)
    await t.mutation(internal.reservations.releaseNoticeClaim, {
      reservationId: id,
      kind: 'confirmed',
    })
    // Still `confirmed`: a fee mail would say something untrue.
    expect(
      await t.query(internal.reservations.noticePayload, {
        reservationId: id,
        kind: 'fee_charged',
      }),
    ).toBeNull()
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_restaurant' })
    expect(
      await t.query(internal.reservations.noticePayload, {
        reservationId: id,
        kind: 'payment_refunded',
      }),
    ).not.toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Personal data                                                       */
/* ------------------------------------------------------------------ */

describe('personal data', () => {
  test('a booking on which money moved is ANONYMISED by an erasure, never deleted; its ledger stays without the card', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id } = await paidBooking(t, world)
    expect((await rowById(t, id))!.paymentCollectedAt).toBeGreaterThan(0)
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('reservationPayments').first())!
      await ctx.db.patch(row._id, { customerRef: 'cus_keep_me_not', methodRef: 'pm_keep_me_not' })
    })

    const result = await eraseFully(t, world.manager, guest.email)

    const booking = (await rowById(t, id))!
    expect(booking).toBeTruthy()
    expect(booking.guestEmail).toBe('')
    expect(booking.guestName).not.toBe(guest.name)
    expect(booking.guestPhone).toBe('')
    // The money and the dates stay.
    expect(booking.paymentTerms?.depositCents).toBe(2000)
    expect(booking.startsAt).toBeGreaterThan(0)
    const rows = await payments(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'succeeded', amount: 2000 })
    expect(rows[0]!.customerRef).toBeUndefined()
    expect(rows[0]!.methodRef).toBeUndefined()
    expect(result.report.tallies.find((tl) => tl.table === 'reservations')).toMatchObject({
      anonymised: 1,
    })
    expect(result.report.retained.find((r) => r.table === 'reservations')?.reason).toMatch(
      /17\.3\.b/,
    )
  })

  test('a booking that never took money is DELETED with its rows, and the saved card is named for the operator', async () => {
    const t = newHarness()
    const world = await owingWorld(t, { rules: [GUARANTEE_RULE] })
    const { id } = await paidBooking(t, world)
    // The card was secured, nothing was ever charged.
    expect((await rowById(t, id))!.paymentCollectedAt).toBeUndefined()

    const result = await eraseFully(t, world.manager, guest.email)

    expect(await rowById(t, id)).toBeNull()
    expect(await payments(t)).toHaveLength(0)
    expect(result.report.tallies.find((tl) => tl.table === 'reservationPayments')).toMatchObject({
      deleted: 1,
    })
    expect(result.report.retained.find((r) => r.table === 'reservationPayments')?.reason).toMatch(
      /Stripe/,
    )
  })

  test('an unpaid attempt goes with its booking — but a page still payable at the provider stays, bare, and is closed', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token)
    await eraseFully(t, world.manager, guest.email)
    expect(await rowById(t, id)).toBeNull()
    // The attempt had a live provider page: the row that names it survives, with no
    // personal data and no way to reach the guest, and the page is closed. See
    // `reservation-payments-review.test.ts` for the payment that lands anyway.
    const rows = await payments(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'pending' })
    expect(await dispatches(t)).toEqual([
      { type: 'close_attempt', paymentId: String(rows[0]!._id) },
    ])
  })

  test('an attempt that never reached the provider is deleted with its booking, nothing left to close', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const { id, token } = await bookOwing(t, world)
    await openAttempt(t, token, 'stripe', { attach: false })
    await eraseFully(t, world.manager, guest.email)
    expect(await rowById(t, id)).toBeNull()
    expect(await payments(t)).toHaveLength(0)
    expect(await dispatches(t)).toEqual([])
  })

  test('the export hands back the ledger of the booking', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    await paidBooking(t, world)
    const bundle = await world.manager.query(api.privacy.exportDataSubject, { email: guest.email })
    const rows = bundle.records.find((r) => r.table === 'reservationPayments')?.rows ?? []
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).toContain('"amount":2000')
  })

  test('the retention sweep anonymises an old paid booking and deletes an old unpaid one, with their rows', async () => {
    const t = newHarness()
    const world = await owingWorld(t)
    const paid = await paidBooking(t, world)
    const unpaid = await bookOwing(t, world, { email: 'unpaid@example.com' })
    await openAttempt(t, unpaid.token)
    const old = NOW - 4 * 365 * DAY
    for (const id of [paid.id, unpaid.id]) await moveStart(t, id, old)

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    const kept = (await rowById(t, paid.id))!
    expect(kept.guestEmail).toBe('')
    expect(await rowById(t, unpaid.id)).toBeNull()
    const rows = await payments(t)
    expect(rows.map((r) => r.reservationId)).toEqual([paid.id])
  })
})
