// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The native app's card sheet: `stripe.createPaymentIntent` and
 * `stripe.verifyPaymentIntent`.
 *
 * The sheet is a second door onto the same charge the hosted checkout opens,
 * so it is held to the same rules — the same guards before Stripe is asked
 * anything, one payable charge per order whichever door opened it, and the
 * same binding of what Stripe reports to the order before anything is marked
 * paid. These drive the real actions end to end against a fake Stripe, the way
 * `checkout-session-single.test.ts` drives the hosted path.
 */

import { convexTest } from 'convex-test'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { _resetEnvCache } from '@be-yours/core/env'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = 1_700_000_000_000
/** 24 € in cents. */
const CHARGE = 2_400

interface FakeIntent {
  id: string
  status: string
  amount: number
  amount_received: number
  currency: string
  client_secret: string
  metadata: Record<string, string>
}

/** What our fake Stripe was asked to do, and what it should answer. */
const stripeFake = vi.hoisted(() => ({
  /** Every `paymentIntents.create`, with its request options. */
  created: [] as Array<{ params: Record<string, unknown>; options?: { idempotencyKey?: string } }>,
  updated: [] as Array<{ id: string; params: Record<string, unknown> }>,
  canceled: [] as string[],
  intents: new Map<string, FakeIntent>(),
  /** Stripe replays the first answer for a repeated idempotency key. */
  byKey: new Map<string, string>(),
  /** Hosted sessions, for the two-door cases. */
  sessions: new Map<string, { id: string; status: string; payment_status: string }>(),
  sessionsCreated: 0,
  expired: [] as string[],
  /** When set, `paymentIntents.create` throws a Stripe error of this `type`. */
  createErrorType: null as string | null,
}))

vi.mock('stripe', () => {
  function stripeError(message: string, fields: Record<string, unknown>) {
    return Object.assign(new Error(message), fields)
  }

  class FakeStripe {
    static createFetchHttpClient() {
      return {}
    }
    paymentIntents = {
      create: async (params: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        if (stripeFake.createErrorType) {
          throw stripeError('Invalid API Key provided', { type: stripeFake.createErrorType })
        }
        const replay = options?.idempotencyKey
          ? stripeFake.byKey.get(options.idempotencyKey)
          : undefined
        if (replay) return stripeFake.intents.get(replay)!

        stripeFake.created.push({ params, options })
        const id = `pi_test_${stripeFake.created.length}`
        const intent: FakeIntent = {
          id,
          status: 'requires_payment_method',
          amount: params.amount as number,
          amount_received: 0,
          currency: params.currency as string,
          client_secret: `${id}_secret_fake`,
          metadata: (params.metadata ?? {}) as Record<string, string>,
        }
        stripeFake.intents.set(id, intent)
        if (options?.idempotencyKey) stripeFake.byKey.set(options.idempotencyKey, id)
        return intent
      },
      retrieve: async (id: string) => {
        const intent = stripeFake.intents.get(id)
        if (!intent) {
          throw stripeError(`No such payment_intent: '${id}'`, {
            type: 'StripeInvalidRequestError',
            code: 'resource_missing',
          })
        }
        return intent
      },
      update: async (id: string, params: Record<string, unknown>) => {
        stripeFake.updated.push({ id, params })
        const intent = stripeFake.intents.get(id)!
        intent.amount = params.amount as number
        return intent
      },
      cancel: async (id: string) => {
        stripeFake.canceled.push(id)
        const intent = stripeFake.intents.get(id)!
        intent.status = 'canceled'
        return intent
      },
    }
    webhooks = {
      // The signature is not what these cases are about: the body IS the
      // event. The real verifier still runs, and normalises it.
      constructEventAsync: async (body: string) => JSON.parse(body),
    }
    checkout = {
      sessions: {
        create: async () => {
          stripeFake.sessionsCreated += 1
          const id = `cs_test_${stripeFake.sessionsCreated}`
          stripeFake.sessions.set(id, { id, status: 'open', payment_status: 'unpaid' })
          return { id, url: `https://checkout.stripe.test/${id}` }
        },
        retrieve: async (id: string) => {
          const session = stripeFake.sessions.get(id)
          if (!session) throw new Error(`No such checkout.session: ${id}`)
          return session
        },
        expire: async (id: string) => {
          stripeFake.expired.push(id)
          const session = stripeFake.sessions.get(id)
          if (session) session.status = 'expired'
          return { id, status: 'expired' }
        },
      },
    }
  }
  return { default: FakeStripe }
})

const saved = {
  secret: undefined as string | undefined,
  publishable: undefined as string | undefined,
  webhook: undefined as string | undefined,
}

beforeAll(() => {
  // Short, dull fixtures — see `checkout-session-single.test.ts` for why a
  // realistic-looking key is a finding for the secret scan and adds nothing.
  saved.secret = process.env.STRIPE_SECRET_KEY
  saved.publishable = process.env.STRIPE_PUBLISHABLE_KEY
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake'
  saved.webhook = process.env.STRIPE_WEBHOOK_SECRET
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake'
  _resetEnvCache()
  return () => {
    if (saved.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
    else process.env.STRIPE_WEBHOOK_SECRET = saved.webhook
    if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = saved.secret
    if (saved.publishable === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY
    else process.env.STRIPE_PUBLISHABLE_KEY = saved.publishable
    _resetEnvCache()
  }
})

beforeEach(() => {
  stripeFake.created.length = 0
  stripeFake.updated.length = 0
  stripeFake.canceled.length = 0
  stripeFake.intents.clear()
  stripeFake.byKey.clear()
  stripeFake.sessions.clear()
  stripeFake.sessionsCreated = 0
  stripeFake.expired.length = 0
  stripeFake.createErrorType = null
})

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  // Payment paths queue the order confirmation at `runAfter(0)`; a job
  // cancelled mid-run surfaces as an unhandled rejection in whichever file
  // happens to be executing. Same block as the other convex suites.
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('stores', {
      name: 'Chez Probe',
      slug: 'chez-probe',
      address: {
        street: '1 rue de la Paix',
        city: 'Paris',
        postalCode: '75002',
        country: 'France',
      },
      hours: [],
      status: 'open' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function seedCardOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<'stores'>,
  orderNumber: string,
  total = CHARGE,
) {
  return t.run((ctx) =>
    ctx.db.insert('orders', {
      storeId,
      orderNumber,
      customerInfo: { name: 'Camille', email: 'camille@example.test' },
      items: [],
      type: 'pickup' as const,
      status: 'pending' as const,
      subtotal: total,
      taxAmount: 0,
      total,
      paymentStatus: 'pending' as const,
      paymentMethod: 'card',
      source: 'website' as const,
      viewToken: `vt-${orderNumber}`,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function freshOrder(total = CHARGE) {
  const t = newHarness()
  const storeId = await seedStore(t)
  const orderId = await seedCardOrder(
    t,
    storeId,
    `N-${Math.random().toString(36).slice(2, 8)}`,
    total,
  )
  return { t, storeId, orderId }
}

function openSheet(t: ReturnType<typeof convexTest>, orderId: Id<'orders'>) {
  return t.action(api.stripe.createPaymentIntent, { orderId })
}

/** The `code` a refusal carried over the wire, whatever shape it arrived in. */
async function refusalCode(run: Promise<unknown>): Promise<string | null> {
  const error = await run.then(
    () => null,
    (e: unknown) => e as { data?: unknown },
  )
  if (!error) return null
  const data = typeof error.data === 'string' ? JSON.parse(error.data) : error.data
  return (data as { code?: string } | undefined)?.code ?? String(error)
}

async function paymentsOf(t: ReturnType<typeof convexTest>, orderId: Id<'orders'>) {
  return t.run((ctx) =>
    ctx.db
      .query('payments')
      .withIndex('by_orderId', (q) => q.eq('orderId', orderId))
      .collect(),
  )
}

// ===========================================================================
// createPaymentIntent
// ===========================================================================

describe('createPaymentIntent — a first sheet', () => {
  test("asks Stripe for the order's own total, in euros, tied to the order", async () => {
    const { t, storeId, orderId } = await freshOrder()

    const result = await openSheet(t, orderId)

    expect(stripeFake.created).toHaveLength(1)
    const { params, options } = stripeFake.created[0]!
    expect(params).toMatchObject({
      amount: CHARGE,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { orderId, storeId },
      receipt_email: 'camille@example.test',
    })
    // Derived from the order, so two taps in flight reach Stripe as one create.
    expect(options?.idempotencyKey).toBe(`native-sheet:${orderId}:${CHARGE}:first`)

    expect(result).toEqual({
      paymentIntentId: 'pi_test_1',
      clientSecret: 'pi_test_1_secret_fake',
      publishableKey: 'pk_test_fake',
      amount: CHARGE,
      currency: 'EUR',
    })
  })

  test('names the intent on the order and puts a pending row on the ledger', async () => {
    // The pending row is what `payment_intent.succeeded` without metadata
    // resolves through, and what `settlePayment` promotes rather than doubles.
    const { t, orderId } = await freshOrder()

    await openSheet(t, orderId)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.stripePaymentIntentId).toBe('pi_test_1')
    const rows = await paymentsOf(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'stripe',
      externalId: 'pi_test_1',
      status: 'pending',
      amount: CHARGE,
    })
  })

  test('sends no receipt address when the diner gave none', async () => {
    const { t, orderId } = await freshOrder()
    await t.run((ctx) => ctx.db.patch(orderId, { customerInfo: { name: 'Camille' } }))

    await openSheet(t, orderId)

    expect(stripeFake.created[0]!.params).not.toHaveProperty('receipt_email')
  })

  test('records that the key works', async () => {
    const { t, orderId } = await freshOrder()

    await openSheet(t, orderId)

    const health = await t.run((ctx) => ctx.db.query('cardProviderHealth').first())
    expect(health?.usable).toBe(true)
  })
})

describe('createPaymentIntent — one order, one payable intent', () => {
  test('a second tap reuses the intent still open', async () => {
    const { t, orderId } = await freshOrder()

    const first = await openSheet(t, orderId)
    const second = await openSheet(t, orderId)

    expect(second.paymentIntentId).toBe(first.paymentIntentId)
    expect(second.clientSecret).toBe(first.clientSecret)
    expect(stripeFake.created).toHaveLength(1)
    expect(await paymentsOf(t, orderId)).toHaveLength(1)
  })

  test.each(['requires_confirmation', 'requires_action', 'processing'])(
    'an intent at %s is reused, not duplicated',
    async (status) => {
      const { t, orderId } = await freshOrder()
      const first = await openSheet(t, orderId)
      stripeFake.intents.get(first.paymentIntentId)!.status = status

      const second = await openSheet(t, orderId)

      expect(second.paymentIntentId).toBe(first.paymentIntentId)
      expect(stripeFake.created).toHaveLength(1)
    },
  )

  test("moves a reused intent to the order's new total before handing it back", async () => {
    // Otherwise the diner pays the old amount and the settlement refuses it as
    // a mismatch — after the money has left their account.
    const { t, orderId } = await freshOrder()
    const first = await openSheet(t, orderId)
    await t.run((ctx) => ctx.db.patch(orderId, { total: 3_100, subtotal: 3_100 }))

    const second = await openSheet(t, orderId)

    expect(second.paymentIntentId).toBe(first.paymentIntentId)
    expect(stripeFake.updated).toEqual([{ id: first.paymentIntentId, params: { amount: 3_100 } }])
    expect(second.amount).toBe(3_100)
  })

  test('refuses a new intent once the previous one has SUCCEEDED', async () => {
    // The diner paid; the settlement has not reached the order. A second
    // intent would take the same meal twice.
    const { t, orderId } = await freshOrder()
    const first = await openSheet(t, orderId)
    stripeFake.intents.get(first.paymentIntentId)!.status = 'succeeded'

    expect(await refusalCode(openSheet(t, orderId))).toBe('order_already_paid')
    expect(stripeFake.created).toHaveLength(1)
  })

  test('replaces a cancelled intent, under a new idempotency key', async () => {
    const { t, orderId } = await freshOrder()
    const first = await openSheet(t, orderId)
    stripeFake.intents.get(first.paymentIntentId)!.status = 'canceled'

    const second = await openSheet(t, orderId)

    expect(second.paymentIntentId).not.toBe(first.paymentIntentId)
    expect(stripeFake.created[1]!.options?.idempotencyKey).toBe(
      `native-sheet:${orderId}:${CHARGE}:${first.paymentIntentId}`,
    )
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.stripePaymentIntentId).toBe(second.paymentIntentId)
    // The cancelled intent can never collect, so its placeholder stops
    // claiming a payment in flight.
    const rows = await paymentsOf(t, orderId)
    expect(rows.find((r) => r.externalId === first.paymentIntentId)?.status).toBe('failed')
    expect(rows.find((r) => r.externalId === second.paymentIntentId)?.status).toBe('pending')
  })

  test('replaces an intent Stripe no longer knows, rather than stranding the order', async () => {
    const { t, orderId } = await freshOrder()
    await t.run((ctx) =>
      ctx.db.patch(orderId, { stripePaymentIntentId: 'pi_from_another_account' }),
    )

    const result = await openSheet(t, orderId)

    expect(result.paymentIntentId).toBe('pi_test_1')
  })

  test('expires a hosted session left open on the same order first', async () => {
    const { t, orderId } = await freshOrder()
    const hosted = await t.action(api.stripe.createCheckoutSession, {
      orderId,
      successUrl: 'https://chez-probe.fr/ok',
      cancelUrl: 'https://chez-probe.fr/ko',
    })

    await openSheet(t, orderId)

    expect(stripeFake.expired).toEqual([hosted.sessionId])
  })

  test('refuses when that hosted session has already been PAID', async () => {
    const { t, orderId } = await freshOrder()
    const hosted = await t.action(api.stripe.createCheckoutSession, {
      orderId,
      successUrl: 'https://chez-probe.fr/ok',
      cancelUrl: 'https://chez-probe.fr/ko',
    })
    const session = stripeFake.sessions.get(hosted.sessionId)!
    session.status = 'complete'
    session.payment_status = 'paid'

    expect(await refusalCode(openSheet(t, orderId))).toBe('order_already_paid')
    expect(stripeFake.created).toHaveLength(0)
  })
})

describe('createCheckoutSession — the other door closes the sheet', () => {
  test('cancels an open in-app intent before opening a hosted session', async () => {
    const { t, orderId } = await freshOrder()
    const sheet = await openSheet(t, orderId)

    await t.action(api.stripe.createCheckoutSession, {
      orderId,
      successUrl: 'https://chez-probe.fr/ok',
      cancelUrl: 'https://chez-probe.fr/ko',
    })

    expect(stripeFake.canceled).toEqual([sheet.paymentIntentId])
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.stripePaymentIntentId).toBeUndefined()
    expect((await paymentsOf(t, orderId))[0]?.status).toBe('failed')
  })

  test.each(['succeeded', 'processing'])(
    'refuses a hosted session while the in-app intent is %s',
    async (status) => {
      const { t, orderId } = await freshOrder()
      const sheet = await openSheet(t, orderId)
      stripeFake.intents.get(sheet.paymentIntentId)!.status = status

      const code = await refusalCode(
        t.action(api.stripe.createCheckoutSession, {
          orderId,
          successUrl: 'https://chez-probe.fr/ok',
          cancelUrl: 'https://chez-probe.fr/ko',
        }),
      )

      expect(code).toBe('order_already_paid')
      expect(stripeFake.sessionsCreated).toBe(0)
    },
  )
})

describe('createPaymentIntent — the refusals it shares with the hosted checkout', () => {
  test.each(['paid', 'refund_pending', 'partially_refunded', 'refunded'] as const)(
    'refuses an order already collected (%s)',
    async (paymentStatus) => {
      const { t, orderId } = await freshOrder()
      await t.run((ctx) => ctx.db.patch(orderId, { paymentStatus }))

      expect(await refusalCode(openSheet(t, orderId))).toBe('order_already_paid')
      expect(stripeFake.created).toHaveLength(0)
    },
  )

  test('refuses an order the ledger has collected before its status caught up', async () => {
    const { t, storeId, orderId } = await freshOrder()
    await t.mutation(internal.payments.internalSettle, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: 'EUR',
      provider: 'stripe' as const,
      externalId: 'pi_landed',
    })

    expect(await refusalCode(openSheet(t, orderId))).toBe('order_already_paid')
    expect(stripeFake.created).toHaveLength(0)
  })

  test('refuses a total below the card floor before Stripe is asked', async () => {
    const { t, orderId } = await freshOrder(30)

    expect(await refusalCode(openSheet(t, orderId))).toBe('below_provider_minimum')
    expect(stripeFake.created).toHaveLength(0)
  })

  test('refuses on a connection state the charge path cannot honour', async () => {
    const { t, orderId } = await freshOrder()
    await t.run((ctx) =>
      ctx.db.insert('paymentConnections', {
        provider: 'stripe' as const,
        merchantId: 'acct_test',
        status: 'connected' as const,
        connectedAt: NOW,
        updatedAt: NOW,
      }),
    )

    expect(await refusalCode(openSheet(t, orderId))).toBe('card_payment_unavailable')
    expect(stripeFake.created).toHaveLength(0)
  })

  test('a key Stripe refuses reads as card-unavailable, and is remembered', async () => {
    const { t, orderId } = await freshOrder()
    stripeFake.createErrorType = 'StripeAuthenticationError'

    expect(await refusalCode(openSheet(t, orderId))).toBe('card_payment_unavailable')
    const health = await t.run((ctx) => ctx.db.query('cardProviderHealth').first())
    expect(health?.usable).toBe(false)
  })

  test('spends the same per-order unit as the hosted checkout', async () => {
    const { t, orderId } = await freshOrder()
    await t.run((ctx) =>
      ctx.db.insert('rateLimits', {
        key: `paymentSessionPerOrder:${orderId}`,
        windowStart: Date.now(),
        count: 10,
      }),
    )

    expect(String(await refusalCode(openSheet(t, orderId)))).toMatch(
      /rate_limited|Trop de requêtes/,
    )
    expect(stripeFake.created).toHaveLength(0)
  })
})

describe('createPaymentIntent — no publishable key', () => {
  test('answers NATIVE_CARD_SHEET_UNAVAILABLE and touches nothing', async () => {
    // The app falls back to the hosted page on this code. So the card must
    // NOT be marked unavailable, nothing must be created at Stripe, and a
    // hosted session left open must still be open for that fallback's own
    // create to deal with.
    const { t, orderId } = await freshOrder()
    delete process.env.STRIPE_PUBLISHABLE_KEY
    _resetEnvCache()
    try {
      expect(await refusalCode(openSheet(t, orderId))).toBe('NATIVE_CARD_SHEET_UNAVAILABLE')
      expect(stripeFake.created).toHaveLength(0)
      expect(await t.run((ctx) => ctx.db.query('cardProviderHealth').first())).toBeNull()
      expect((await t.run((ctx) => ctx.db.get(orderId)))?.stripePaymentIntentId).toBeUndefined()

      // …and the hosted checkout still works on the same deployment.
      await expect(
        t.action(api.stripe.createCheckoutSession, {
          orderId,
          successUrl: 'https://chez-probe.fr/ok',
          cancelUrl: 'https://chez-probe.fr/ko',
        }),
      ).resolves.toMatchObject({ sessionId: 'cs_test_1' })
    } finally {
      process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake'
      _resetEnvCache()
    }
  })
})

// ===========================================================================
// verifyPaymentIntent
// ===========================================================================

/** Open a sheet, then have Stripe report it paid for `received` cents. */
async function paidSheet(received = CHARGE) {
  const { t, storeId, orderId } = await freshOrder()
  const { paymentIntentId } = await openSheet(t, orderId)
  const intent = stripeFake.intents.get(paymentIntentId)!
  intent.status = 'succeeded'
  intent.amount_received = received
  return { t, storeId, orderId, paymentIntentId }
}

describe('verifyPaymentIntent', () => {
  test('settles the order: one succeeded row, the order paid', async () => {
    const { t, orderId, paymentIntentId } = await paidSheet()

    const result = await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId })

    expect(result).toMatchObject({
      status: 'paid',
      orderId,
      viewToken: expect.stringMatching(/^vt-/),
      email: 'camille@example.test',
    })
    const rows = await paymentsOf(t, orderId)
    // The pending placeholder was PROMOTED, not doubled.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      externalId: paymentIntentId,
      status: 'succeeded',
      amount: CHARGE,
    })
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('paid')
  })

  test('is idempotent: a second call writes nothing new', async () => {
    const { t, orderId, paymentIntentId } = await paidSheet()

    await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId })
    const again = await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId })

    expect(again.status).toBe('paid')
    const rows = await paymentsOf(t, orderId)
    expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1)
  })

  test('refuses an amount that does not settle the order, and marks nothing paid', async () => {
    const { t, orderId, paymentIntentId } = await paidSheet(CHARGE - 100)

    const code = await refusalCode(t.action(api.stripe.verifyPaymentIntent, { paymentIntentId }))

    expect(code).toBe('amount_mismatch')
    expect((await paymentsOf(t, orderId)).some((r) => r.status === 'succeeded')).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('pending')
  })

  test('reports an intent that has not succeeded verbatim, and settles nothing', async () => {
    const { t, orderId } = await freshOrder()
    const { paymentIntentId } = await openSheet(t, orderId)
    stripeFake.intents.get(paymentIntentId)!.status = 'processing'

    const result = await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId })

    expect(result).toMatchObject({ status: 'processing', orderId })
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('pending')
  })

  test('answers an error for an intent that names no order', async () => {
    const t = newHarness()
    stripeFake.intents.set('pi_hosted', {
      id: 'pi_hosted',
      status: 'succeeded',
      amount: CHARGE,
      amount_received: CHARGE,
      currency: 'eur',
      client_secret: 'pi_hosted_secret',
      metadata: {},
    })

    const result = await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId: 'pi_hosted' })

    expect(result.status).toBe('error')
  })
})

// ===========================================================================
// The webhook: `payment_intent.succeeded` for an intent the sheet confirmed
// ===========================================================================

let eventCounter = 0

/** Deliver one `payment_intent.succeeded` through the real route and verifier. */
function deliverIntentSucceeded(
  t: ReturnType<typeof convexTest>,
  intent: {
    id: string
    amount_received: number
    currency?: string
    metadata?: Record<string, string>
  },
  eventId = `evt_native_${++eventCounter}`,
) {
  return t.fetch('/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    body: JSON.stringify({
      id: eventId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intent.id,
          amount: intent.amount_received,
          amount_received: intent.amount_received,
          currency: intent.currency ?? 'eur',
          metadata: intent.metadata ?? {},
        },
      },
    }),
  })
}

describe('the webhook settles an in-app intent by its own metadata', () => {
  test("the verifier reports the intent's order, store and COLLECTED amount", async () => {
    const t = newHarness()

    const result = await t.action(internal.stripeWebhookVerify.verify, {
      signature: 't=1,v1=fake',
      body: JSON.stringify({
        id: 'evt_v1',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_v1',
            amount: 9_999,
            amount_received: CHARGE,
            currency: 'eur',
            metadata: { orderId: 'order_x', storeId: 'store_y' },
          },
        },
      }),
    })

    expect(result).toMatchObject({
      eventId: 'evt_v1',
      eventType: 'payment_intent.succeeded',
      paymentIntent: 'pi_v1',
      orderId: 'order_x',
      storeId: 'store_y',
      amountTotal: CHARGE,
      currency: 'EUR',
    })
  })

  test('an intent with no metadata of ours reports no order', async () => {
    const t = newHarness()

    const result = await t.action(internal.stripeWebhookVerify.verify, {
      signature: 't=1,v1=fake',
      body: JSON.stringify({
        id: 'evt_v2',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_v2', amount_received: CHARGE, currency: 'eur', metadata: {} } },
      }),
    })

    expect(result).toMatchObject({ paymentIntent: 'pi_v2', orderId: null, storeId: null })
  })

  test('settles an order that has NO payment row yet', async () => {
    // The diner paid in the sheet and the app died before `verifyPaymentIntent`
    // — and the placeholder row never landed either. The metadata is enough.
    const { t, storeId, orderId } = await freshOrder()

    const response = await deliverIntentSucceeded(t, {
      id: 'pi_orphan',
      amount_received: CHARGE,
      metadata: { orderId, storeId },
    })

    expect(response.status).toBe(200)
    const rows = await paymentsOf(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ externalId: 'pi_orphan', status: 'succeeded', amount: CHARGE })
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('paid')
  })

  test("promotes the sheet's pending row rather than writing a second", async () => {
    const { t, storeId, orderId } = await freshOrder()
    const { paymentIntentId } = await openSheet(t, orderId)

    await deliverIntentSucceeded(t, {
      id: paymentIntentId,
      amount_received: CHARGE,
      metadata: { orderId, storeId },
    })

    const rows = await paymentsOf(t, orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ externalId: paymentIntentId, status: 'succeeded' })
  })

  test("and the app's own verify afterwards writes nothing new", async () => {
    const { t, storeId, orderId } = await freshOrder()
    const { paymentIntentId } = await openSheet(t, orderId)
    await deliverIntentSucceeded(t, {
      id: paymentIntentId,
      amount_received: CHARGE,
      metadata: { orderId, storeId },
    })
    const intent = stripeFake.intents.get(paymentIntentId)!
    intent.status = 'succeeded'
    intent.amount_received = CHARGE

    const result = await t.action(api.stripe.verifyPaymentIntent, { paymentIntentId })

    expect(result.status).toBe('paid')
    expect((await paymentsOf(t, orderId)).filter((r) => r.status === 'succeeded')).toHaveLength(1)
  })

  test('refuses an amount that does not settle the order: 200, recorded, nothing paid', async () => {
    const { t, storeId, orderId } = await freshOrder()

    const response = await deliverIntentSucceeded(t, {
      id: 'pi_short',
      amount_received: CHARGE - 1,
      metadata: { orderId, storeId },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, refused: 'amount_mismatch' })
    expect((await paymentsOf(t, orderId)).some((r) => r.status === 'succeeded')).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('pending')
    const audit = await t.run((ctx) => ctx.db.query('systemAuditLog').collect())
    const refusal = audit.find((e) => e.action === 'payment_collection_refused')
    expect(refusal).toBeDefined()
    expect(JSON.parse(refusal!.details!)).toMatchObject({
      code: 'amount_mismatch',
      externalId: 'pi_short',
      eventType: 'payment_intent.succeeded',
    })
  })

  test("refuses a currency that is not the order's", async () => {
    const { t, storeId, orderId } = await freshOrder()

    const response = await deliverIntentSucceeded(t, {
      id: 'pi_usd',
      amount_received: CHARGE,
      currency: 'usd',
      metadata: { orderId, storeId },
    })

    expect(await response.json()).toEqual({ received: true, refused: 'currency_mismatch' })
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('pending')
  })

  test('an intent WITHOUT metadata keeps the old path: resolved by the stored row only', async () => {
    // A hosted checkout's intent. With no row for it, nothing is settled here
    // — the reconciliation sweep owns that case, as before.
    const { t, orderId } = await freshOrder()

    const response = await deliverIntentSucceeded(t, {
      id: 'pi_hosted_unknown',
      amount_received: CHARGE,
    })

    expect(response.status).toBe(200)
    expect(await paymentsOf(t, orderId)).toHaveLength(0)
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe('pending')
  })

  test('a replayed delivery is answered as a duplicate', async () => {
    const { t, storeId, orderId } = await freshOrder()
    const intent = { id: 'pi_replayed', amount_received: CHARGE, metadata: { orderId, storeId } }

    await deliverIntentSucceeded(t, intent, 'evt_replayed')
    const second = await deliverIntentSucceeded(t, intent, 'evt_replayed')

    expect(await second.json()).toEqual({ received: true, duplicate: true })
    expect(await paymentsOf(t, orderId)).toHaveLength(1)
  })
})
