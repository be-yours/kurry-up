'use node'

import { v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import type { ActionCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { resolveStripeCharge } from '@be-yours/convex-functions/stripeChargeRouting'
import { PAYMENT_REPLAY_HORIZON_MS } from '@be-yours/convex-schema'
import { ReservationRefusedError } from '@be-yours/convex-functions/reservations'
import {
  ProviderError,
  paymentRefusal,
  paypalClient,
  paypalRefundViews,
  planStalledRefundRetry,
  readPayPalOrder,
  readStripeIntent,
  readStripeSession,
  readSumUpCheckout,
  REAL_PROVIDER_BASES,
  refundOutcomeOf,
  refundSettlement,
  resolveProviderBase,
  safeReturnOrigin,
  stripeClient,
  stripeRefundViews,
  sumupClient,
  type PaymentFact,
} from '@be-yours/convex-functions/reservationProviders'
import { getSumUpAccessToken } from './sumup'

/**
 * The provider half of paying for a booking.
 *
 * Everything that talks to Stripe, SumUp or PayPal for a table booking runs here, and
 * everything it learns goes back through `internal.reservationPayments.settlePayment`,
 * which binds what the provider said to the payment row before any money is recorded.
 * What is SENT to a provider and how its answer is READ lives in
 * `@be-yours/convex-functions/reservationProviders`, where a unit test drives it
 * against a mocked `fetch`; this file decrypts a token, reads a key, and glues the two.
 *
 * Two doors for the guest (`startReservationPayment`, `verifyReservationPayment`), two
 * for the host (`refundReservationPayment`, `chargeNoShowFee`), one for what a
 * transaction decided (`runDispatch`) and two for the clock (`sweepHolds`, `reconcile`).
 *
 * THE ORDER OF EVENTS DOES NOT MATTER. The return page, the Stripe webhook and the sweep
 * all call `reconcileRow`, which reads the checkout back from the provider and settles
 * it; the second to arrive finds the row settled and does nothing.
 */

const MINUTE_MS = 60_000

const providerValidator = v.union(v.literal('stripe'), v.literal('sumup'), v.literal('paypal'))

type Provider = 'stripe' | 'sumup' | 'paypal'

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/** The refusal a guest reads when the provider cannot be used. */
function unavailable(): ReservationRefusedError {
  return new ReservationRefusedError('payment_unavailable')
}

/**
 * A Stripe client on the deployment's key — or a refusal.
 *
 * The routing tripwire the order checkout applies (`resolveStripeCharge`) applies here
 * too: a connection state this code cannot honour stops the money before it moves.
 */
async function stripeFor(ctx: ActionCtx) {
  const connection = await ctx.runQuery(internal.paymentConnections.internalGetByProvider, {
    provider: 'stripe' as const,
  })
  try {
    resolveStripeCharge(connection)
  } catch {
    throw unavailable()
  }
  const { getSiteEnv } = await import('@be-yours/core/env')
  const key = getSiteEnv().STRIPE_SECRET_KEY
  if (!key) throw unavailable()
  return stripeClient(
    key,
    fetch,
    resolveProviderBase('stripe', process.env, REAL_PROVIDER_BASES.stripe),
  )
}

async function sumupFor(ctx: ActionCtx) {
  try {
    const { accessToken, merchantCode } = await getSumUpAccessToken(ctx)
    return {
      client: sumupClient(
        accessToken,
        fetch,
        resolveProviderBase('sumup', process.env, REAL_PROVIDER_BASES.sumup),
      ),
      merchantCode,
    }
  } catch {
    throw unavailable()
  }
}

async function paypalFor() {
  const { getSiteEnv, isSandbox } = await import('@be-yours/core/env')
  const site = getSiteEnv()
  if (!site.PAYPAL_CLIENT_ID || !site.PAYPAL_CLIENT_SECRET) throw unavailable()
  const sandbox = isSandbox('paypal')
  return paypalClient(
    {
      clientId: site.PAYPAL_CLIENT_ID,
      clientSecret: site.PAYPAL_CLIENT_SECRET,
      // Explicit, and the safe answer when unset: the sandbox, never the live host.
      sandbox,
    },
    fetch,
    resolveProviderBase(
      'paypal',
      process.env,
      sandbox ? REAL_PROVIDER_BASES.paypalSandbox : REAL_PROVIDER_BASES.paypalLive,
    ),
  )
}

/** Remember what a provider said about our credentials, as the order checkout does. */
async function recordCardHealth(
  ctx: ActionCtx,
  provider: Provider,
  usable: boolean,
  detail?: string,
) {
  if (provider === 'paypal') return
  await ctx
    .runMutation(internal.globalSettings.internalRecordCardProviderHealth, {
      provider,
      usable,
      ...(detail ? { detail } : {}),
    })
    .catch(() => undefined)
}

/* ------------------------------------------------------------------ */
/* The guest: opening a page and coming back                           */
/* ------------------------------------------------------------------ */

/**
 * Spend the public actions' allowance — on the booking, never on the link.
 *
 * The link is the guest's credential: written to the counters table as the subject it would
 * sit there in clear for every valid booking, and every random string a script tried would
 * add a row. So the link is resolved first (a read, which reaches no provider) and the
 * allowance is spent on the booking's id; a link that names no booking spends one shared
 * bucket instead, and the call is refused by whatever comes next.
 */
async function meterByBooking(ctx: ActionCtx, token: string): Promise<void> {
  const bookingId = await ctx.runQuery(internal.reservationPayments.bookingIdForToken, { token })
  await ctx.runMutation(
    internal.rateLimits.consume,
    bookingId
      ? { name: 'reservationPaymentPerBooking', subject: bookingId }
      : { name: 'reservationPaymentUnresolved', subject: 'unresolved' },
  )
}

/**
 * Send a guest to pay for their booking.
 *
 * Opens (or reuses) the attempt, asks the chosen provider for a page, remembers it on
 * the row before the guest leaves, and returns where to go. Idempotent against a double
 * click and a back button: a live page on the same provider is handed back, not remade.
 * The amount comes from the booking's own terms on the server, never from the caller.
 */
// @public-by-design: a guest paying for their booking has no account; the booking's manage token is the credential, the amount is read from the booking's own terms server-side, and the call is metered per booking before the provider is reached
export const startReservationPayment = action({
  args: {
    token: v.string(),
    provider: providerValidator,
    /** The origin of the page the guest is on, where the provider sends them back. */
    returnOrigin: v.string(),
    /**
     * The guest ticked the sentence the payment page showed. Needed only when the terms were
     * set after their request (a group the host accepted with a deposit).
     */
    consent: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ redirectUrl: string }> => {
    // BEFORE any provider is called, like every public action here (#430.5).
    await meterByBooking(ctx, args.token)

    const origin = safeReturnOrigin(args.returnOrigin, process.env.SITE_URL)
    if (!origin) throw new ReservationRefusedError('invalid_input')

    const attempt = await ctx.runMutation(internal.reservationPayments.beginAttempt, {
      token: args.token,
      provider: args.provider,
      ...(args.consent !== undefined ? { consent: args.consent } : {}),
    })
    if (attempt.reuse) return { redirectUrl: attempt.reuse.url }

    const paymentId = attempt.paymentId as Id<'reservationPayments'>
    const base = `${origin}/reservation/payment/${encodeURIComponent(args.token)}`
    const successUrl = `${base}?return=success`
    const cancelUrl = `${base}?return=cancelled`
    const now = Date.now()

    try {
      if (args.provider === 'stripe') {
        const stripe = await stripeFor(ctx)
        const input = {
          rowId: attempt.paymentId,
          reservationId: attempt.reservationId,
          storeId: attempt.storeId,
          reference: attempt.reference,
          currency: attempt.currency,
          successUrl,
          cancelUrl,
          // Stripe takes a page for at least thirty minutes; the hold sweep closes it
          // sooner when the hold is shorter. Computed from the attempt's own creation,
          // not from now: a resumed call must send the same parameters under the same
          // idempotency key, or Stripe refuses it.
          expiresAt: Math.floor(
            Math.max(attempt.holdEndsAt, attempt.createdAt + 31 * MINUTE_MS) / 1000,
          ),
          idempotencyKey: attempt.idempotencyKey,
          ...(attempt.guestEmail ? { email: attempt.guestEmail } : {}),
        }
        let session: { id: string; url: string }
        let customerRef: string | undefined
        if (attempt.kind === 'guarantee') {
          customerRef =
            attempt.customerRef ??
            (await stripe.createCustomer({
              reservationId: attempt.reservationId,
              storeId: attempt.storeId,
              idempotencyKey: `${attempt.idempotencyKey}-customer`,
            }))
          // A guarantee takes nothing now, so there is no guest address to send a
          // receipt to: Stripe is told none.
          const { email: _email, ...withoutEmail } = input
          session = await stripe.createGuaranteeSession({
            ...withoutEmail,
            customerId: customerRef,
          })
        } else {
          session = await stripe.createDepositSession({ ...input, amount: attempt.amount })
        }
        await ctx.runMutation(internal.reservationPayments.attachSession, {
          paymentId,
          checkoutRef: session.id,
          checkoutUrl: session.url,
          ...(customerRef ? { customerRef } : {}),
          expiresAt: input.expiresAt * 1000,
        })
        await recordCardHealth(ctx, 'stripe', true)
        return { redirectUrl: session.url }
      }

      if (args.provider === 'sumup') {
        const { client, merchantCode } = await sumupFor(ctx)
        const validUntil = Math.max(
          now + 4 * MINUTE_MS,
          Math.min(attempt.holdEndsAt, now + 30 * MINUTE_MS),
        )
        const checkout = await client.createHostedCheckout({
          rowId: attempt.paymentId,
          amount: attempt.amount,
          currency: attempt.currency,
          merchantCode,
          description: `Acompte — réservation ${attempt.reference}`,
          redirectUrl: successUrl,
          validUntil: new Date(validUntil).toISOString(),
        })
        await ctx.runMutation(internal.reservationPayments.attachSession, {
          paymentId,
          checkoutRef: checkout.id,
          checkoutUrl: checkout.url,
          expiresAt: validUntil,
        })
        await recordCardHealth(ctx, 'sumup', true)
        return { redirectUrl: checkout.url }
      }

      const paypal = await paypalFor()
      const order = await paypal.createOrder({
        rowId: attempt.paymentId,
        amount: attempt.amount,
        currency: attempt.currency,
        description: `Acompte — réservation ${attempt.reference}`,
        brandName: attempt.storeName || 'Restaurant',
        returnUrl: successUrl,
        cancelUrl,
      })
      await ctx.runMutation(internal.reservationPayments.attachSession, {
        paymentId,
        checkoutRef: order.id,
        checkoutUrl: order.approveUrl,
        expiresAt: attempt.holdEndsAt,
      })
      return { redirectUrl: order.approveUrl }
    } catch (error) {
      if (error instanceof ReservationRefusedError) throw error
      if (error instanceof ProviderError) {
        // The provider decided: nothing was opened, and the row says why. A failure
        // whose outcome is unknown leaves the row pending under the same key, so the
        // next call resumes it and the provider hands back the first answer.
        if (error.kind === 'refused' || error.kind === 'auth') {
          await ctx.runMutation(internal.reservationPayments.endAttempt, {
            paymentId,
            outcome: 'failed',
            code: error.code ?? `http_${error.status ?? 'none'}`,
            message: error.message,
          })
        }
        if (error.kind === 'auth') {
          await recordCardHealth(ctx, args.provider, false, error.message)
        }
        console.error(
          `[reservationPayment] ${args.provider} refused to open a page:`,
          error.message,
        )
        throw unavailable()
      }
      throw error
    }
  },
})

/**
 * The guest is back from the provider: ask it what happened, and settle.
 *
 * It settles from what the PROVIDER says, never from the fact that the guest was
 * redirected here — a return URL proves nothing. The webhook and the sweeps do the same
 * thing from the other side; whichever arrives first wins and the others do nothing.
 */
// @public-by-design: called from the payment page by a guest; the manage token is the credential, nothing the caller sends chooses what is settled (the provider's own answer, bound to the booking's own payment row, does), and the call is metered per booking
export const verifyReservationPayment = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ outcome: string }> => {
    await meterByBooking(ctx, args.token)
    const state = await ctx.runQuery(internal.reservationPayments.pendingForToken, {
      token: args.token,
    })
    if (!state || !state.paymentId) return { outcome: 'unknown' }
    if (state.rowStatus !== 'pending' || !state.hasSession)
      return { outcome: state.rowStatus ?? 'unknown' }
    return await reconcileRow(ctx, state.paymentId as Id<'reservationPayments'>)
  },
})

/* ------------------------------------------------------------------ */
/* Reading a payment back                                              */
/* ------------------------------------------------------------------ */

/** What `attemptContext` answers: a payment row, its booking and the establishment's name. */
interface Attempt {
  chargeExternalId: string | null
  payment: {
    id: string
    kind: string
    provider: Provider
    status: string
    amount: number
    currency: string
    refundedAmount: number
    checkoutRef: string | null
    externalId: string | null
    customerRef: string | null
    methodRef: string | null
    idempotencyKey: string
    refundOf: string | null
    attempt: number
    createdAt: number
  }
  booking: {
    id: string
    storeId: string
    reference: string
    status: string
    startsAt: number
    guestEmail: string
  } | null
  storeName: string
}

/** What a provider says about a row's checkout, or `null` when there is none to ask. */
async function readFact(
  ctx: ActionCtx,
  attempt: Attempt,
  options: { capture: boolean },
): Promise<PaymentFact | null> {
  const { payment } = attempt
  if (payment.kind === 'no_show_fee') {
    // A fee is charged synchronously by `chargeNoShowFee`. Reading one back means the
    // answer was lost: ask Stripe about the intent, or repeat the SAME request under
    // the SAME key — Stripe returns the first answer instead of charging twice.
    const stripe = await stripeFor(ctx)
    if (payment.externalId) {
      return readStripeIntent(await stripe.retrievePaymentIntent(payment.externalId))
    }
    if (!payment.customerRef || !payment.methodRef || !attempt.booking) return null
    // Stripe may forget an idempotency key after 24 hours, and a repeat after that is a new
    // charge. Past the horizon the request is NOT repeated: the row is handed to a person,
    // who looks at Stripe and abandons or confirms it.
    if (Date.now() - payment.createdAt > PAYMENT_REPLAY_HORIZON_MS) {
      await ctx.runMutation(internal.reservationPayments.flagAttention, {
        paymentId: payment.id as Id<'reservationPayments'>,
        code: 'fee_unconfirmed',
      })
      return null
    }
    const intent = await stripe.chargeOffSession({
      amount: payment.amount,
      currency: payment.currency,
      customer: payment.customerRef,
      paymentMethod: payment.methodRef,
      rowId: payment.id,
      reservationId: attempt.booking.id,
      storeId: attempt.booking.storeId,
      reference: attempt.booking.reference,
      idempotencyKey: payment.idempotencyKey,
    })
    return {
      provider: 'stripe',
      status: intent.status === 'succeeded' ? 'completed' : 'pending',
      reference: intent.reference,
      amountMinor: intent.amountReceived,
      currency: intent.currency,
      externalId: intent.id,
    }
  }

  if (!payment.checkoutRef) return null
  if (payment.kind !== 'deposit' && payment.kind !== 'guarantee') return null

  if (payment.provider === 'stripe') {
    const stripe = await stripeFor(ctx)
    return readStripeSession(await stripe.retrieveSession(payment.checkoutRef), payment.kind)
  }
  if (payment.provider === 'sumup') {
    const { client } = await sumupFor(ctx)
    return readSumUpCheckout(await client.getCheckout(payment.checkoutRef))
  }
  const paypal = await paypalFor()
  const fact = readPayPalOrder(await paypal.getOrder(payment.checkoutRef))
  // Approved and not captured: the money has NOT moved, and capturing is what moves it.
  // Only for an attempt the booking is still waiting on — never for a page that was
  // abandoned, which would take money for a table nobody holds.
  if (fact.status === 'approved' && options.capture) {
    return readPayPalOrder(await paypal.captureOrder(payment.checkoutRef, payment.id))
  }
  return fact
}

/**
 * Ask the provider about one payment row and record the answer.
 *
 * Shared by the return page, the webhook, the close of an abandoned page and both
 * sweeps. A fact that does not match its row is a REFUSAL: the money moved, so it is
 * recorded where an operator reads it (`recordRefusedCollection`), the row is closed so
 * the sweeps stop asking, and nothing is settled.
 */
async function reconcileRow(
  ctx: ActionCtx,
  paymentId: Id<'reservationPayments'>,
): Promise<{ outcome: string }> {
  const attempt = await ctx.runQuery(internal.reservationPayments.attemptContext, { paymentId })
  if (!attempt || attempt.payment.kind === 'refund') return { outcome: 'ignored' }
  if (attempt.payment.status === 'succeeded') return { outcome: 'already' }

  const capture =
    attempt.payment.status === 'pending' && attempt.booking?.status === 'pending_payment'
  let fact: PaymentFact | null
  try {
    fact = await readFact(ctx, attempt, { capture })
  } catch (error) {
    if (error instanceof ProviderError || error instanceof ReservationRefusedError) {
      console.warn(`[reservationPayment] could not read ${paymentId}:`, error.message)
      return { outcome: 'unreachable' }
    }
    throw error
  }
  if (!fact) return { outcome: 'no_session' }

  try {
    const result = await ctx.runMutation(internal.reservationPayments.settlePayment, {
      paymentId,
      fact,
    })
    return { outcome: result.outcome }
  } catch (error) {
    const refusal = paymentRefusal(error)
    if (!refusal) throw error
    await ctx
      .runMutation(internal.payments.internalRecordRefusedCollection, {
        provider: attempt.payment.provider,
        code: refusal.code,
        message: refusal.message,
        eventType: 'reservation.reconcile',
        ...(fact.externalId ? { externalId: fact.externalId } : {}),
        orderId: String(paymentId),
        ...(attempt.booking ? { storeId: attempt.booking.storeId } : {}),
      })
      .catch(() => undefined)
    await ctx.runMutation(internal.reservationPayments.endAttempt, {
      paymentId,
      outcome: 'failed',
      code: refusal.code,
      message: refusal.message,
    })
    return { outcome: 'refused' }
  }
}

/**
 * A provider event named a payment: read it back and settle.
 *
 * The Stripe webhook is only a trigger — the event is verified by its signature, but
 * the row is settled from the checkout read back through the API, so an event that
 * arrives incomplete (a setup session without its intent) settles the same way as one
 * that carries everything. `ref` is what Stripe echoed back; it may be anybody's, which
 * is why it is resolved rather than trusted.
 */
export const reconcileByRef = internalAction({
  args: {
    paymentRef: v.optional(v.string()),
    checkoutRef: v.optional(v.string()),
    externalId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ outcome: string }> => {
    let id: string | null = null
    if (args.paymentRef) {
      id = await ctx.runQuery(internal.reservationPayments.resolveRowId, { ref: args.paymentRef })
    }
    if (!id) {
      id = await ctx.runQuery(internal.reservationPayments.findByProviderRef, {
        ...(args.checkoutRef ? { checkoutRef: args.checkoutRef } : {}),
        ...(args.externalId ? { externalId: args.externalId } : {}),
      })
    }
    if (!id) return { outcome: 'not_ours' }
    return await reconcileRow(ctx, id as Id<'reservationPayments'>)
  },
})

/** A card declined off-session is a fee that failed; the guest and the team are told. */
export const failFeeFromEvent = internalAction({
  args: { paymentRef: v.string(), code: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<{ failed: boolean }> => {
    const id = await ctx.runQuery(internal.reservationPayments.resolveRowId, {
      ref: args.paymentRef,
    })
    if (!id) return { failed: false }
    const result = await ctx.runMutation(internal.reservationPayments.failFee, {
      paymentId: id as Id<'reservationPayments'>,
      code: args.code,
      message: args.message,
    })
    return { failed: result.failed }
  },
})

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

interface ReservedRefund {
  refundId: string
  provider: Provider
  externalId: string
  amount: number
  currency: string
  idempotencyKey: string
}

/**
 * Ask the provider for a refund that was already committed, and record its answer.
 *
 *  - confirmed: the provider said the refund is done — only now is it a refund, and the guest
 *    is told;
 *  - pending: the provider accepted it and said it is not done (Stripe `pending`, PayPal
 *    `PENDING`): the row stays committed with the provider's refund id, nothing says
 *    « remboursé » and the guest is not mailed, until the provider's own word (a webhook, or
 *    the sweep reading the refund back);
 *  - refused (a 4xx, or the credentials) on the FIRST send: nothing moved, the committed amount
 *    goes back and the host can try again;
 *  - unknown (no answer, a 5xx, a timeout): the refund may have been made. It STAYS committed
 *    and is asked again by the sweep under the same key — never released, because releasing
 *    would let the host send it a second time.
 *
 * `retry` is the sweep asking again. A request that may already have gone out can answer
 * « refused » for a reason that is its own success (the key has expired and the charge is
 * already refunded), so on a retry NOTHING is released on the strength of a refusal, a local
 * refusal or the credentials: it is all « unknown », and a provider that says in so many words
 * that the refund failed is the only thing that ends it.
 */
async function executeRefund(
  ctx: ActionCtx,
  reserved: ReservedRefund,
  reason?: string,
  options: { retry?: boolean } = {},
): Promise<{ status: 'confirmed' | 'pending'; amount: number }> {
  const refundId = reserved.refundId as Id<'reservationPayments'>
  let externalRefundId: string
  let settlement: 'confirmed' | 'pending' | 'failed' = 'confirmed'
  try {
    if (reserved.provider === 'stripe') {
      const stripe = await stripeFor(ctx)
      const refund = await stripe.refund({
        paymentIntent: reserved.externalId,
        amount: reserved.amount,
        reason,
        idempotencyKey: reserved.idempotencyKey,
      })
      externalRefundId = refund.id
      settlement = refundSettlement('stripe', refund.status)
    } else if (reserved.provider === 'paypal') {
      const paypal = await paypalFor()
      const refund = await paypal.refund({
        captureId: reserved.externalId,
        amount: reserved.amount,
        currency: reserved.currency,
        idempotencyKey: reserved.idempotencyKey,
      })
      externalRefundId = refund.id
      settlement = refundSettlement('paypal', refund.status)
    } else {
      const { client } = await sumupFor(ctx)
      // No idempotency key exists at SumUp: this is sent once, and a failure of unknown
      // outcome is left for a person to check there.
      await client.refund(reserved.externalId, reserved.amount)
      externalRefundId = reserved.externalId
    }
  } catch (error) {
    const outcome = refundOutcomeOf(error)
    const message = error instanceof Error ? error.message : 'Remboursement impossible.'
    if (
      !options.retry &&
      (error instanceof ReservationRefusedError || outcome === 'refused' || outcome === 'auth')
    ) {
      await ctx.runMutation(internal.reservationPayments.releaseRefund, {
        refundId,
        code: error instanceof ProviderError ? (error.code ?? undefined) : undefined,
        message,
      })
      throw new ReservationRefusedError(
        'payment_refused',
        `Le fournisseur de paiement a refusé le remboursement : ${message}`,
      )
    }
    await ctx.runMutation(internal.reservationPayments.noteRefundUnknown, { refundId, message })
    console.error(`[reservationPayment] refund ${reserved.refundId} outcome unknown:`, message)
    return { status: 'pending', amount: reserved.amount }
  }

  if (settlement === 'pending') {
    await ctx.runMutation(internal.reservationPayments.noteRefundPending, {
      refundId,
      externalRefundId,
    })
    return { status: 'pending', amount: reserved.amount }
  }
  if (settlement === 'failed') {
    // The provider said so in so many words: nothing moved, on a retry as on the first send.
    await ctx.runMutation(internal.reservationPayments.settleRefundFromProvider, {
      refundId,
      status: 'failed',
    })
    throw new ReservationRefusedError(
      'payment_refused',
      'Le fournisseur de paiement a refusé le remboursement.',
    )
  }
  await ctx.runMutation(internal.reservationPayments.confirmRefund, { refundId, externalRefundId })
  return { status: 'confirmed', amount: reserved.amount }
}

/**
 * The host refunds a deposit (or a fee), in full or in part.
 *
 * Nothing is recorded as refunded until the provider confirms; a failure whose outcome
 * is unknown answers « en attente » and the row says so. Needs `payments:refund`, the
 * same permission the order refunds ask.
 */
// @guarded-inline: internal.reservationPayments.authorizeRefund requires payments:refund on the payment's establishment before anything is reserved or sent
export const refundReservationPayment = action({
  args: {
    paymentId: v.id('reservationPayments'),
    /** Integer cents. */
    amount: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: 'confirmed' | 'pending'; amount: number }> => {
    await ctx.runQuery(internal.reservationPayments.authorizeRefund, { paymentId: args.paymentId })
    const reserved = await ctx.runMutation(internal.reservationPayments.reserveRefund, {
      paymentId: args.paymentId,
      amount: args.amount,
      reason: args.reason,
      actor: 'staff',
    })
    return await executeRefund(ctx, reserved, args.reason)
  },
})

/**
 * « Réessayer » on a refund the engine stopped asking about. The provider is READ first.
 *
 * The sweep stops replaying a refund at the horizon because the provider may have forgotten its
 * key, and a request sent after that is a new refund: it could pay the guest twice. A host's
 * retry is therefore not a replay. What it does:
 *
 *  1. if the provider already answered this refund with an id, read THAT refund and settle it;
 *  2. otherwise list the provider's refunds for the payment (`planStalledRefundRetry`): one that
 *     is confirmed closes the row, one still pending is linked to it so the sweep reads it, and
 *     only when nothing there could be this refund is the amount asked again, under a NEW key;
 *  3. a read that fails sends nothing and changes nothing.
 *
 * SumUp is refused before anything is read: it has no key and no way to list a refund.
 * Needs `payments:refund`, like every refund.
 */
// @guarded-inline: internal.reservationPayments.authorizeRefund requires payments:refund on the refund's establishment before the provider is read or asked
export const retryStalledRefund = action({
  args: { refundId: v.id('reservationPayments') },
  handler: async (ctx, args): Promise<{ status: 'confirmed' | 'pending'; amount: number }> => {
    await ctx.runQuery(internal.reservationPayments.authorizeRefund, { paymentId: args.refundId })
    const state = await ctx.runQuery(internal.reservationPayments.stalledRefundContext, {
      refundId: args.refundId,
    })

    // 1. The provider already gave this refund an id: read it, never repeat it.
    if (state.externalRefundId) {
      const refund = await readProviderRefund(ctx, state.provider, state.externalRefundId)
      const settlement = refundSettlement(state.provider, refund.status)
      if (settlement === 'confirmed') {
        await ctx.runMutation(internal.reservationPayments.confirmRefund, {
          refundId: args.refundId,
          externalRefundId: state.externalRefundId,
        })
        return { status: 'confirmed', amount: state.amount }
      }
      if (settlement === 'failed') {
        await ctx.runMutation(internal.reservationPayments.settleRefundFromProvider, {
          refundId: args.refundId,
          status: 'failed',
        })
        throw new ReservationRefusedError(
          'payment_refused',
          'Le fournisseur de paiement a échoué ce remboursement : le client n’a pas été remboursé. Refaites-le depuis cette réservation.',
        )
      }
      return { status: 'pending', amount: state.amount }
    }

    // 2. Read what the provider shows for this payment before deciding anything.
    let views
    try {
      if (state.provider === 'stripe') {
        views = stripeRefundViews(await (await stripeFor(ctx)).listRefunds(state.chargeExternalId))
      } else {
        if (!state.chargeCheckoutRef) throw unavailable()
        views = paypalRefundViews(await (await paypalFor()).getOrder(state.chargeCheckoutRef))
      }
    } catch (error) {
      if (error instanceof ReservationRefusedError) throw error
      if (!(error instanceof ProviderError)) throw error
      throw new ReservationRefusedError(
        'payment_refused',
        `Le fournisseur de paiement n'a pas pu être interrogé (${error.message}) : rien n'a été renvoyé. Réessayez dans un moment.`,
      )
    }
    const plan = planStalledRefundRetry({
      refunds: views,
      amount: state.amount,
      claimedIds: state.claimedIds,
      settledWithoutId: state.settledWithoutId,
    })
    if (plan.kind === 'recorded') {
      await ctx.runMutation(internal.reservationPayments.confirmRefund, {
        refundId: args.refundId,
        externalRefundId: plan.externalRefundId,
      })
      return { status: 'confirmed', amount: state.amount }
    }
    if (plan.kind === 'pending') {
      if (plan.externalRefundId) {
        await ctx.runMutation(internal.reservationPayments.noteRefundPending, {
          refundId: args.refundId,
          externalRefundId: plan.externalRefundId,
        })
      }
      return { status: 'pending', amount: state.amount }
    }

    // 3. Nothing at the provider could be this refund: ask for it, under a key it has never seen.
    const reserved = await ctx.runMutation(internal.reservationPayments.rekeyStalledRefund, {
      refundId: args.refundId,
    })
    return await executeRefund(ctx, reserved)
  },
})

async function readProviderRefund(
  ctx: ActionCtx,
  provider: 'stripe' | 'paypal',
  externalRefundId: string,
): Promise<{ id: string; status: string }> {
  try {
    return provider === 'stripe'
      ? await (await stripeFor(ctx)).retrieveRefund(externalRefundId)
      : await (await paypalFor()).getRefund(externalRefundId)
  } catch (error) {
    if (error instanceof ReservationRefusedError) throw error
    if (!(error instanceof ProviderError)) throw error
    throw new ReservationRefusedError(
      'payment_refused',
      `Le fournisseur de paiement n'a pas pu être interrogé (${error.message}) : rien n'a été modifié. Réessayez dans un moment.`,
    )
  }
}

/**
 * Ask again for a refund that was committed and never confirmed (same key, same refund).
 *
 * Only while the provider still honours the key: `refundsToRetry` hands over nothing older
 * than `PAYMENT_REPLAY_HORIZON_MS`, and `flagStalled` gives the rest to a person.
 */
async function retryRefund(ctx: ActionCtx, refundId: Id<'reservationPayments'>) {
  const attempt = await ctx.runQuery(internal.reservationPayments.attemptContext, {
    paymentId: refundId,
  })
  if (!attempt || attempt.payment.status !== 'reserved' || !attempt.chargeExternalId) return
  // SumUp offers no way to ask twice safely: its refunds are checked by a person.
  if (attempt.payment.provider === 'sumup') return
  // The provider already answered this refund with an id of its own: it is read, not repeated.
  if (attempt.payment.externalId) return
  // Belt and braces with the query: never replay a request the provider may have forgotten.
  if (Date.now() - attempt.payment.createdAt > PAYMENT_REPLAY_HORIZON_MS) return
  try {
    await executeRefund(
      ctx,
      {
        refundId: attempt.payment.id,
        provider: attempt.payment.provider,
        externalId: attempt.chargeExternalId,
        amount: attempt.payment.amount,
        currency: attempt.payment.currency,
        idempotencyKey: attempt.payment.idempotencyKey,
      },
      undefined,
      { retry: true },
    )
  } catch (error) {
    console.warn(
      `[reservationPayment] refund ${refundId} refused on retry:`,
      (error as Error).message,
    )
  }
}

/** Ask a provider how a refund it left pending stands, and record its word. Safe at any age. */
async function readPendingRefund(ctx: ActionCtx, refundId: Id<'reservationPayments'>) {
  const attempt = await ctx.runQuery(internal.reservationPayments.attemptContext, {
    paymentId: refundId,
  })
  if (!attempt || attempt.payment.status !== 'reserved' || !attempt.payment.externalId) return
  const provider = attempt.payment.provider
  if (provider === 'sumup') return
  try {
    const refund =
      provider === 'stripe'
        ? await (await stripeFor(ctx)).retrieveRefund(attempt.payment.externalId)
        : await (await paypalFor()).getRefund(attempt.payment.externalId)
    const settlement = refundSettlement(provider, refund.status)
    if (settlement === 'pending') return
    await ctx.runMutation(internal.reservationPayments.settleRefundFromProvider, {
      refundId,
      status: settlement,
    })
  } catch (error) {
    if (!(error instanceof ProviderError) && !(error instanceof ReservationRefusedError))
      throw error
    console.warn(`[reservationPayment] could not read refund ${refundId}:`, error.message)
  }
}

/* ------------------------------------------------------------------ */
/* The no-show fee                                                     */
/* ------------------------------------------------------------------ */

/**
 * The host charges a no-show fee to the card a guest secured their table with.
 *
 * Every guard is `noShowFeeRefusal`'s, applied in `beginFee` before anything is sent:
 * a recorded no-show that was due, a guarantee that stands, an amount inside what the
 * guest was told, no charge in flight, three attempts in all. A declined card is an
 * answer — the row says why and the guest and the team are told, once; nothing retries
 * by itself. A failure of unknown outcome leaves the row pending: the sweep repeats the
 * SAME request, which Stripe answers with the first result instead of charging twice.
 */
// @guarded-inline: internal.reservationPayments.authorizeFee requires reservations:manage on the booking's establishment before the fee is opened
export const chargeNoShowFee = action({
  args: {
    reservationId: v.id('reservations'),
    /** Integer cents. Absent: whatever is left of the cap the guest was shown. */
    amount: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: 'charged' | 'failed' | 'pending'; amount: number; reason?: string }> => {
    await ctx.runQuery(internal.reservationPayments.authorizeFee, {
      reservationId: args.reservationId,
    })
    const fee = await ctx.runMutation(internal.reservationPayments.beginFee, {
      reservationId: args.reservationId,
      ...(args.amount !== undefined ? { amount: args.amount } : {}),
    })
    const paymentId = fee.paymentId as Id<'reservationPayments'>
    try {
      const stripe = await stripeFor(ctx)
      const intent = await stripe.chargeOffSession({
        amount: fee.amount,
        currency: fee.currency,
        customer: fee.customerRef,
        paymentMethod: fee.methodRef,
        rowId: fee.paymentId,
        reservationId: fee.reservationId,
        storeId: fee.storeId,
        reference: fee.reference,
        idempotencyKey: fee.idempotencyKey,
      })
      if (intent.status === 'succeeded') {
        await ctx.runMutation(internal.reservationPayments.settlePayment, {
          paymentId,
          fact: {
            provider: 'stripe',
            status: 'completed',
            reference: intent.reference,
            amountMinor: intent.amountReceived,
            currency: intent.currency,
            externalId: intent.id,
          },
        })
        return { status: 'charged', amount: fee.amount }
      }
      // `requires_action`: the bank wants the cardholder, who is not here.
      await ctx.runMutation(internal.reservationPayments.failFee, {
        paymentId,
        code: intent.status === 'requires_action' ? 'authentication_required' : intent.status,
        message: 'La banque demande une authentification du titulaire : débit impossible sans lui.',
      })
      return { status: 'failed', amount: fee.amount, reason: 'authentication_required' }
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === 'refused' || error.kind === 'auth')) {
        const code = error.declineCode ?? error.code ?? `http_${error.status ?? 'none'}`
        await ctx.runMutation(internal.reservationPayments.failFee, {
          paymentId,
          code,
          message: error.message,
        })
        return { status: 'failed', amount: fee.amount, reason: code }
      }
      if (error instanceof ReservationRefusedError) {
        await ctx.runMutation(internal.reservationPayments.failFee, {
          paymentId,
          code: 'provider_unavailable',
          message: "Stripe n'est pas utilisable pour le moment.",
        })
        throw error
      }
      console.error('[reservationPayment] fee charge outcome unknown:', (error as Error).message)
      return { status: 'pending', amount: fee.amount }
    }
  },
})

/* ------------------------------------------------------------------ */
/* What a transaction decided                                          */
/* ------------------------------------------------------------------ */

const dispatchValidator = v.union(
  v.object({
    type: v.literal('refund'),
    paymentId: v.string(),
    amount: v.number(),
    reason: v.string(),
  }),
  v.object({ type: v.literal('close_attempt'), paymentId: v.string() }),
  v.object({ type: v.literal('release_card'), paymentId: v.string() }),
)

/** Close an abandoned page at its provider so it can no longer be paid. */
async function closeAttempt(ctx: ActionCtx, paymentId: Id<'reservationPayments'>) {
  const attempt = await ctx.runQuery(internal.reservationPayments.attemptContext, { paymentId })
  if (!attempt || !attempt.payment.checkoutRef) return
  const { provider, checkoutRef } = attempt.payment
  try {
    if (provider === 'stripe') await (await stripeFor(ctx)).expireSession(checkoutRef)
    else if (provider === 'sumup') await (await sumupFor(ctx)).client.deactivate(checkoutRef)
    // PayPal has nothing to close: an approved order is only captured while the booking
    // waits for it (`readFact`), and an unapproved one lapses by itself.
  } catch (error) {
    // The provider would not close it — usually because it has already been completed.
    // Read it back: money that moved on a page we gave up on is settled and refunded.
    if (!(error instanceof ProviderError) && !(error instanceof ReservationRefusedError))
      throw error
  }
  await reconcileRow(ctx, paymentId)
}

/** Forget a card a released guarantee no longer needs: the Stripe customer goes. */
async function releaseCard(ctx: ActionCtx, paymentId: Id<'reservationPayments'>) {
  const attempt = await ctx.runQuery(internal.reservationPayments.attemptContext, { paymentId })
  if (!attempt || attempt.payment.provider !== 'stripe' || !attempt.payment.customerRef) return
  try {
    await (await stripeFor(ctx)).deleteCustomer(attempt.payment.customerRef)
  } catch (error) {
    // Already gone is as good as deleted; anything else is left, and logged for a person.
    if (!(error instanceof ProviderError && error.status === 404)) {
      console.warn(
        '[reservationPayment] could not delete the saved card:',
        (error as Error).message,
      )
      return
    }
  }
  await ctx.runMutation(internal.reservationPayments.forgetCard, { paymentId })
}

/** Do what a settled transaction asked for: refund, close, forget. Scheduled, never awaited by it. */
export const runDispatch = internalAction({
  args: { dispatch: dispatchValidator },
  handler: async (ctx, { dispatch }): Promise<void> => {
    const paymentId = dispatch.paymentId as Id<'reservationPayments'>
    if (dispatch.type === 'close_attempt') return await closeAttempt(ctx, paymentId)
    if (dispatch.type === 'release_card') return await releaseCard(ctx, paymentId)

    // A refund the engine decided on (the guest cancelled in time, the house ended the
    // booking, a payment arrived too late). Reserved and sent like the host's own.
    let reserved: ReservedRefund
    try {
      reserved = await ctx.runMutation(internal.reservationPayments.reserveRefund, {
        paymentId,
        amount: dispatch.amount,
        reason: dispatch.reason,
        actor: 'system',
      })
    } catch (error) {
      // Nothing left to refund (the host got there first) is a normal outcome.
      if (error instanceof ReservationRefusedError || (error as { data?: unknown }).data) {
        console.warn(`[reservationPayment] refund of ${dispatch.paymentId} not reserved`)
        return
      }
      throw error
    }
    try {
      await executeRefund(ctx, reserved, dispatch.reason)
    } catch (error) {
      console.error(`[reservationPayment] automatic refund failed:`, (error as Error).message)
    }
  },
})

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * Release the tables of unpaid holds that ran out (cron, every two minutes).
 *
 * A hold is a table kept for a guest who has not paid yet, for the time the owner set.
 * Before a booking is expired, each attempt still open is read back: a guest who paid in
 * the last seconds settles the booking instead of losing it. Whatever is still unpaid is
 * expired, its pages closed and its table offered to the waitlist; a payment that lands
 * after that is refunded by `settlePayment`.
 */
export const sweepHolds = internalAction({
  args: {},
  handler: async (ctx): Promise<{ examined: number; expired: number }> => {
    const lapsed = await ctx.runQuery(internal.reservationPayments.lapsedHolds, {})
    if (lapsed.length === 0) return { examined: 0, expired: 0 }
    for (const hold of lapsed) {
      for (const paymentId of hold.pending) {
        try {
          await reconcileRow(ctx, paymentId as Id<'reservationPayments'>)
        } catch (error) {
          console.warn(
            '[reservationPayment] hold sweep could not read a payment:',
            (error as Error).message,
          )
        }
      }
    }
    const result = await ctx.runMutation(internal.reservationPayments.expireLapsed, {
      reservationIds: lapsed.map((hold) => hold.reservationId as Id<'reservations'>),
    })
    return { examined: lapsed.length, expired: result.expired }
  },
})

/**
 * Ask the providers about every attempt still open, and every refund still unconfirmed
 * (cron, every ten minutes).
 *
 * The recovery path of everything above: a guest who paid and closed the tab, a webhook
 * that never came, a fee whose answer was lost, a refund that timed out. SumUp and PayPal
 * have no webhook here, so for them this IS the confirmation when the guest does not come
 * back. One payment's failure does not stop the others.
 */
export const reconcile = internalAction({
  args: {},
  handler: async (ctx): Promise<{ examined: number; settled: number; refunds: number }> => {
    const ids = await ctx.runQuery(internal.reservationPayments.attemptsToReconcile, {})
    let settled = 0
    for (const id of ids) {
      try {
        const result = await reconcileRow(ctx, id as Id<'reservationPayments'>)
        if (result.outcome === 'settled' || result.outcome === 'refund_due') settled += 1
      } catch (error) {
        console.error(`[reservationPayment] reconcile ${id}:`, (error as Error).message)
      }
    }
    // What the provider may have forgotten is handed to a person BEFORE anything is asked again.
    await ctx.runMutation(internal.reservationPayments.flagStalled, {})
    const refunds = await ctx.runQuery(internal.reservationPayments.refundsToRetry, {})
    for (const id of refunds.replay) {
      try {
        await retryRefund(ctx, id as Id<'reservationPayments'>)
      } catch (error) {
        console.error(`[reservationPayment] refund retry ${id}:`, (error as Error).message)
      }
    }
    for (const id of refunds.read) {
      try {
        await readPendingRefund(ctx, id as Id<'reservationPayments'>)
      } catch (error) {
        console.error(`[reservationPayment] refund read ${id}:`, (error as Error).message)
      }
    }
    return {
      examined: ids.length,
      settled,
      refunds: refunds.replay.length + refunds.read.length,
    }
  },
})
