import type { MutationCtx } from '../_generated/server'
import type { Id } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import type { ReservationNoticeDispatch } from '@be-yours/convex-functions/reservationNotices'
import type { PaymentDispatch } from '@be-yours/convex-functions/reservationPaymentLedger'

/**
 * What the reservation mutations hand to the scheduler once their transaction has
 * decided it: the waitlist offers a freed table produced, and the confirmation
 * e-mail of a marketing opt-in the guest ticked on the booking form.
 *
 * Both live here, not in the shared handlers, for the reason every other notice
 * does: `ctx.scheduler` needs `internal.*`, which only an app has. Both are
 * SCHEDULED rather than awaited, so a refused send cannot roll back a booking or a
 * cancellation that has been made.
 */

/** One e-mail per offer the matcher made. */
export async function scheduleWaitlistOffers(
  ctx: MutationCtx,
  offers: ReadonlyArray<{ waitlistEntryId: string }>,
) {
  for (const offer of offers) {
    await ctx.scheduler.runAfter(0, internal.customerEmail.sendWaitlistOffer, {
      waitlistEntryId: offer.waitlistEntryId as Id<'waitlistEntries'>,
    })
  }
}

/** The e-mail that carries a waitlist entry's own link to the address stored on it. */
export async function scheduleWaitlistLink(
  ctx: MutationCtx,
  link: { waitlistEntryId: string } | null,
) {
  if (!link) return
  await ctx.scheduler.runAfter(0, internal.customerEmail.sendWaitlistLink, {
    waitlistEntryId: link.waitlistEntryId as Id<'waitlistEntries'>,
  })
}

/**
 * Start the double opt-in for a guest who ticked the marketing box.
 *
 * Booking never subscribes anyone: the subscriber was minted `pending`, and this
 * mails the confirmation link. They are subscribed when they follow it.
 */
export async function scheduleMarketingConfirmation(
  ctx: MutationCtx,
  subscriberId: string | null | undefined,
) {
  if (!subscriberId) return
  await ctx.scheduler.runAfter(0, internal.emailAutomationActions.sendConfirmation, {
    subscriberId: subscriberId as Id<'emailSubscribers'>,
  })
}

/**
 * Send the guest the e-mail the shared handler decided on.
 *
 * The rule about WHO is mailed, and the at-most-once claim, live in
 * `reservationNotices`, inside the transaction that changes the booking; this only
 * schedules the send.
 */
export async function scheduleReservationNotice(
  ctx: MutationCtx,
  notice: ReservationNoticeDispatch | null,
) {
  if (!notice) return
  await ctx.scheduler.runAfter(0, internal.customerEmail.sendReservationNotice, {
    reservationId: notice.reservationId as Id<'reservations'>,
    kind: notice.kind,
  })
}

/**
 * Hand the money a transaction decided to move to the scheduler: a refund to ask the
 * provider for, an attempt to close, a card to forget.
 *
 * SCHEDULED, never awaited: a provider that is slow or down must not roll back the
 * cancellation, the expiry or the settlement that decided it. What goes wrong is
 * recorded on the payment row and swept again (`reservationPaymentActions.sweep*`).
 */
export async function schedulePaymentDispatches(
  ctx: MutationCtx,
  dispatches: ReadonlyArray<PaymentDispatch>,
) {
  for (const dispatch of dispatches) {
    await ctx.scheduler.runAfter(0, internal.reservationPaymentActions.runDispatch, {
      dispatch,
    })
  }
}

/** Everything a payment transaction hands on: its notices, its money and its waitlist offers. */
export async function schedulePaymentEffects(
  ctx: MutationCtx,
  effects: {
    notices?: ReadonlyArray<ReservationNoticeDispatch>
    payments?: ReadonlyArray<PaymentDispatch>
    offers?: ReadonlyArray<{ waitlistEntryId: string }>
  },
) {
  for (const notice of effects.notices ?? []) await scheduleReservationNotice(ctx, notice)
  await schedulePaymentDispatches(ctx, effects.payments ?? [])
  await scheduleWaitlistOffers(ctx, effects.offers ?? [])
}
