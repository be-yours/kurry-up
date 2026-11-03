import { internalMutation, internalQuery, query } from './_generated/server'
import { v } from 'convex/values'
import * as defs from '@be-yours/convex-functions/reservationPayments'
import { requireStorePermission } from '@be-yours/convex-functions/auth'
import { ReservationRefusedError } from '@be-yours/convex-functions/reservations'
import { storeQuery, storeMutation, storeIdFromField } from './lib/storeFunctions'
import { schedulePaymentDispatches, schedulePaymentEffects } from './lib/reservationSchedule'

/**
 * Paying for a booking: the shared handlers in
 * `@be-yours/convex-functions/reservationPayments`, bound to this app's builders and,
 * where a transaction ends in an e-mail or in money to move, to the scheduler.
 *
 * Every public function below says why it may be public; every staff function names the
 * permission that guards it. The provider calls themselves are in
 * `reservationPaymentActions.ts`.
 */

// === Public — the guest ===

// @public-by-design: the booking page is read by anonymous visitors before they submit; it answers what the establishment published as its payment terms, never how its policy is configured
export const getPaymentQuote = query({
  args: defs.getPaymentQuote.args,
  handler: (ctx, args) => defs.getPaymentQuote.handler(ctx, args),
})

// @public-by-design: the payment page opened from the guest's own link; the manage token is the credential; never a provider reference or a card
export const getPaymentPage = query({
  args: defs.getPaymentPage.args,
  handler: (ctx, args) => defs.getPaymentPage.handler(ctx, args),
})

// === Staff — the day book and the drawer ===

// === Staff — the payments dashboard: reservation money, read-only ===

// The permission is the payments dashboard's own. The rows are the booking money
// (`reservationPayments`), never mixed into the order revenue.
export const listLedger = storeQuery({
  permission: 'payments:read',
  args: defs.listLedger.args,
  handler: (ctx, args) => defs.listLedger.handler(ctx, args),
})

export const ledgerTotals = storeQuery({
  permission: 'payments:read',
  args: defs.ledgerTotals.args,
  handler: (ctx, args) => defs.ledgerTotals.handler(ctx, args),
})

export const listForBookings = storeQuery({
  permission: 'reservations:read',
  args: defs.listForBookings.args,
  handler: (ctx, args) => defs.listForBookings.handler(ctx, args),
})

export const historyFor = storeQuery({
  permission: 'reservations:read',
  args: defs.historyFor.args,
  storeIdFrom: storeIdFromField('reservationId', 'Reservation not found'),
  handler: (ctx, args) => defs.historyFor.handler(ctx, args),
})

export const waive = storeMutation({
  permission: 'reservations:manage',
  args: defs.waive.args,
  storeIdFrom: storeIdFromField('reservationId', 'Reservation not found'),
  handler: async (ctx, args) => {
    const { payments, ...result } = await defs.waive.handler(ctx, args)
    await schedulePaymentDispatches(ctx, payments)
    return result
  },
})

/**
 * « Marquer comme remboursé »: the host looked at the provider and a refund the engine stopped
 * asking about was made. Needs `payments:refund`, like every refund.
 */
export const markRefundSettled = storeMutation({
  permission: 'payments:refund',
  args: defs.markRefundSettled.args,
  storeIdFrom: storeIdFromField('refundId', 'Payment not found'),
  handler: async (ctx, args, identity) => {
    const { notices, payments, offers, ...result } = await defs.markRefundSettled.handler(
      ctx,
      args,
      identity,
    )
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

// === Staff — the settings card ===

export const getPaymentConfig = storeQuery({
  permission: 'reservations:read',
  args: defs.getPaymentConfig.args,
  handler: (ctx, args) => defs.getPaymentConfig.handler(ctx, args),
})

export const savePaymentPolicy = storeMutation({
  permission: 'reservations:manage',
  args: defs.savePaymentPolicy.args,
  handler: (ctx, args) => defs.savePaymentPolicy.handler(ctx, args),
})

// === Internal — reached from the actions, the webhook and the crons ===

/** Open (or reuse) the attempt a guest is about to pay through. */
export const beginAttempt = internalMutation({
  args: defs.beginAttempt.args,
  handler: async (ctx, args) => {
    const result = await defs.beginAttempt.handler(ctx, args)
    // Another provider's open page is closed so a booking never has two payable pages.
    await schedulePaymentDispatches(ctx, result.payments)
    const { payments: _payments, ...rest } = result
    return rest
  },
})

export const attachSession = internalMutation({
  args: defs.attachSession.args,
  handler: (ctx, args) => defs.attachSession.handler(ctx, args),
})

export const endAttempt = internalMutation({
  args: defs.endAttempt.args,
  handler: (ctx, args) => defs.endAttempt.handler(ctx, args),
})

/** Record what a provider said about a payment, exactly once. */
export const settlePayment = internalMutation({
  args: defs.settlePayment.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.settlePayment.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

export const attemptContext = internalQuery({
  args: defs.attemptContext.args,
  handler: (ctx, args) => defs.attemptContext.handler(ctx, args),
})

export const resolveRowId = internalQuery({
  args: defs.resolveRowId.args,
  handler: (ctx, args) => defs.resolveRowId.handler(ctx, args),
})

export const findByProviderRef = internalQuery({
  args: defs.findByProviderRef.args,
  handler: (ctx, args) => defs.findByProviderRef.handler(ctx, args),
})

export const bookingIdForToken = internalQuery({
  args: defs.bookingIdForToken.args,
  handler: (ctx, args) => defs.bookingIdForToken.handler(ctx, args),
})

export const pendingForToken = internalQuery({
  args: defs.pendingForToken.args,
  handler: (ctx, args) => defs.pendingForToken.handler(ctx, args),
})

export const lapsedHolds = internalQuery({
  args: defs.lapsedHolds.args,
  handler: (ctx) => defs.lapsedHolds.handler(ctx),
})

/** Release the tables of unpaid holds that ran out. */
export const expireLapsed = internalMutation({
  args: defs.expireLapsed.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.expireLapsed.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

export const attemptsToReconcile = internalQuery({
  args: defs.attemptsToReconcile.args,
  handler: (ctx, args) => defs.attemptsToReconcile.handler(ctx, args),
})

export const refundsToRetry = internalQuery({
  args: defs.refundsToRetry.args,
  handler: (ctx) => defs.refundsToRetry.handler(ctx),
})

export const reserveRefund = internalMutation({
  args: defs.reserveRefund.args,
  handler: (ctx, args) => defs.reserveRefund.handler(ctx, args),
})

export const confirmRefund = internalMutation({
  args: defs.confirmRefund.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.confirmRefund.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

export const releaseRefund = internalMutation({
  args: defs.releaseRefund.args,
  handler: (ctx, args) => defs.releaseRefund.handler(ctx, args),
})

export const noteRefundUnknown = internalMutation({
  args: defs.noteRefundUnknown.args,
  handler: (ctx, args) => defs.noteRefundUnknown.handler(ctx, args),
})

/** The provider accepted a refund and said it is not done: keep its id, say nothing yet. */
export const noteRefundPending = internalMutation({
  args: defs.noteRefundPending.args,
  handler: (ctx, args) => defs.noteRefundPending.handler(ctx, args),
})

/** The provider's own word on a refund it had left pending (the sweep, or its webhook). */
export const settleRefundFromProvider = internalMutation({
  args: defs.settleRefundFromProvider.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.settleRefundFromProvider.handler(
      ctx,
      args,
    )
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

/** The cardholder disputed a charge: the host is told, the guest is not mailed. */
export const recordProviderDispute = internalMutation({
  args: defs.recordProviderDispute.args,
  handler: (ctx, args) => defs.recordProviderDispute.handler(ctx, args),
})

/** Hand to a person what can no longer be asked again without risking a second movement. */
export const flagStalled = internalMutation({
  args: defs.flagStalled.args,
  handler: (ctx) => defs.flagStalled.handler(ctx),
})

export const flagAttention = internalMutation({
  args: defs.flagAttention.args,
  handler: (ctx, args) => defs.flagAttention.handler(ctx, args),
})

/** A refund the provider made on its own side (dashboard, dispute). */
export const recordProviderRefund = internalMutation({
  args: defs.recordProviderRefund.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.recordProviderRefund.handler(
      ctx,
      args,
    )
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

/** What « Réessayer » needs to read the provider, or the refusal in words. */
export const stalledRefundContext = internalQuery({
  args: defs.stalledRefundContext.args,
  handler: (ctx, args) => defs.stalledRefundContext.handler(ctx, args),
})

/** A new key and a fresh replay window for a stalled refund the provider showed nothing of. */
export const rekeyStalledRefund = internalMutation({
  args: defs.rekeyStalledRefund.args,
  handler: (ctx, args) => defs.rekeyStalledRefund.handler(ctx, args),
})

export const beginFee = internalMutation({
  args: defs.beginFee.args,
  handler: (ctx, args) => defs.beginFee.handler(ctx, args),
})

export const failFee = internalMutation({
  args: defs.failFee.args,
  handler: async (ctx, args) => {
    const { notices, payments, offers, ...result } = await defs.failFee.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, payments, offers })
    return result
  },
})

export const forgetCard = internalMutation({
  args: defs.forgetCard.args,
  handler: (ctx, args) => defs.forgetCard.handler(ctx, args),
})

// === Internal — the permission checks of the two host actions ===
//
// An action has no database and cannot read the caller's role; these run as queries so
// the identity propagates (the pattern `payments.internalLoadForRefund` uses).

/** The caller may refund money on this booking's establishment. */
export const authorizeRefund = internalQuery({
  args: { paymentId: v.id('reservationPayments') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.paymentId)
    if (!row) throw new ReservationRefusedError('invalid_input')
    await requireStorePermission(ctx, row.storeId, 'payments:refund')
    return { storeId: String(row.storeId) }
  },
})

/** The caller may take a no-show fee on this booking's establishment. */
export const authorizeFee = internalQuery({
  args: { reservationId: v.id('reservations') },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.reservationId)
    if (!booking) throw new ReservationRefusedError('invalid_input')
    await requireStorePermission(ctx, booking.storeId, 'reservations:manage')
    return { storeId: String(booking.storeId) }
  },
})
