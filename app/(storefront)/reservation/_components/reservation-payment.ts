/**
 * What the guest-facing payment screens decide from, kept pure so it can be tested
 * without a browser: the countdown's words, the way back from a provider, and which of
 * the page's views a booking is in.
 *
 * The server is the only judge of money — it confirms a booking when it has read the
 * payment back from the provider, and this file never infers "paid" from anything the
 * browser holds. What it does decide is what to SAY while the server catches up.
 */

import { formatMoney } from '@be-yours/convex-schema'

const MINUTE_MS = 60_000

/** How long the page waits for the confirmation after a provider redirect before it says so. */
export const VERIFY_PATIENCE_MS = 20_000

/** « 04:07 » — minutes and seconds left, never negative, minutes may pass 59. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The sentence a screen reader hears about the hold, in coarse steps.
 *
 * It changes five times in a whole hold, not sixty times a minute: a live region that
 * rewrote itself every second would read the guest the clock for as long as they stayed.
 * The visible countdown is a timer with no live region at all.
 */
export function holdAnnouncement(msLeft: number): string {
  if (msLeft <= 0) return 'Le délai pour payer est dépassé.'
  if (msLeft > 10 * MINUTE_MS) return 'Il vous reste plus de 10 minutes pour payer.'
  if (msLeft > 5 * MINUTE_MS) return 'Il vous reste moins de 10 minutes pour payer.'
  if (msLeft > 2 * MINUTE_MS) return 'Il vous reste moins de 5 minutes pour payer.'
  if (msLeft > MINUTE_MS) return 'Il vous reste moins de 2 minutes pour payer.'
  return "Il vous reste moins d'une minute pour payer."
}

/** What the provider's redirect said the guest did. It proves nothing: see `verifyReservationPayment`. */
export type PaymentReturn = 'success' | 'cancelled'

/** Reads `?return=` the way the server builds it; anything else is no return at all. */
export function readReturnState(value: string | string[] | null | undefined): PaymentReturn | null {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'success' || raw === 'cancelled' ? raw : null
}

/** The booking as `getPaymentPage` describes it, for what the view needs. */
export interface PaymentPageFacts {
  status: string
  payment: {
    awaiting: boolean
    holdExpiresAt: number | null
    holdLapsed: boolean
    state: string
  }
}

/** The booking has been taken: the payment settled, or the house is to validate it. */
const SETTLED_STATUSES = new Set(['confirmed', 'pending', 'arrived', 'seated', 'completed'])
/** The booking ended without the guest's payment being what ended it. */
const ENDED_STATUSES = new Set([
  'cancelled_by_guest',
  'cancelled_by_restaurant',
  'declined',
  'no_show',
])

export type PaymentView =
  /** The booking is taken: confirmed, or waiting for the house to validate it. */
  | 'settled'
  /** The booking ended (cancelled, declined, a no-show). */
  | 'ended'
  /** The hold ran out: the table is released. */
  | 'lapsed'
  /** The guest came back from the provider and the server has not confirmed yet. */
  | 'verifying'
  /** Still unconfirmed after the patience ran out: the e-mail will say, the page can be reopened. */
  | 'unconfirmed'
  /** The guest came back from the provider without paying. */
  | 'cancelled'
  /** The last attempt did not go through. */
  | 'failed'
  /** The table is held and nothing has been paid: the way to pay. */
  | 'awaiting'

/**
 * Which view the page shows.
 *
 * Order matters and is the point: what the SERVER knows about the booking (settled,
 * ended, lapsed) always beats what the URL says. A guest who reopens a `?return=success`
 * link next week sees the booking, not a spinner; one who lands on `?return=cancelled`
 * after the webhook already settled it sees the confirmation, not an invitation to pay
 * twice. The clock only decides when to STOP offering a table the server will refuse.
 */
export function paymentView(
  page: PaymentPageFacts,
  options: { now: number; returned: PaymentReturn | null; verifyGaveUp?: boolean },
): PaymentView {
  if (SETTLED_STATUSES.has(page.status)) return 'settled'
  if (ENDED_STATUSES.has(page.status)) return 'ended'
  if (page.status === 'expired') return 'lapsed'
  if (page.status !== 'pending_payment') return 'ended'

  const { holdExpiresAt, holdLapsed } = page.payment
  if (holdLapsed || (holdExpiresAt !== null && options.now >= holdExpiresAt)) return 'lapsed'
  if (page.payment.state === 'failed') return 'failed'
  // Back from the provider with no word yet. Never fall back to the way to pay here: the
  // guest may well have paid, and a second payment would only be refunded afterwards.
  if (options.returned === 'success') return options.verifyGaveUp ? 'unconfirmed' : 'verifying'
  if (options.returned === 'cancelled') return 'cancelled'
  return 'awaiting'
}

/** The French words behind a refusal the payment actions can raise, when the server sent none. */
export function paymentErrorFallback(code: string | undefined): string {
  switch (code) {
    case 'payment_hold_lapsed':
      return 'Le délai pour payer est dépassé : la table a été libérée.'
    case 'payment_unavailable':
      return "Le paiement n'est pas disponible en ce moment. Réessayez plus tard ou contactez directement l'établissement."
    case 'transition_refused':
      return "Cette réservation n'attend plus de paiement. Rechargez la page pour voir où elle en est."
    case 'payment_consent_required':
      return 'Cochez la case qui accepte les conditions de paiement pour continuer.'
    case 'rate_limited':
      return 'Trop de tentatives. Patientez une minute puis réessayez.'
    default:
      return "Le paiement n'a pas pu être lancé. Veuillez réessayer."
  }
}

/** « 2 personnes » */
export const people = (n: number) => `${n} ${n === 1 ? 'personne' : 'personnes'}`

/** What the manage page needs to say about a booking's money. */
export interface ManagePaymentFacts {
  kind: string
  currency: string
  depositCents: number
  noShowFeeCents: number
  state: string
  heldCents: number
  refundedCents: number
  feeChargedCents: number
  awaiting: boolean
}

/**
 * What cancelling does to the money, in a sentence — or `null` when it does nothing to it.
 *
 * Only said where the server's own answer backs it: a paid deposit is refunded in full when
 * the guest cancels before the cut-off (the page offers the button only then), a secured
 * card is released, and a booking still awaiting its payment owes nothing.
 */
export function cancelConsequence(payment: ManagePaymentFacts): string | null {
  const money = (cents: number) => formatMoney(cents, payment.currency)
  if (payment.awaiting) return 'rien ne sera débité'
  if (payment.kind === 'deposit' && payment.state === 'paid' && payment.heldCents > 0) {
    return `l'acompte de ${money(payment.heldCents)} vous sera remboursé`
  }
  if (payment.kind === 'guarantee' && payment.state === 'secured') {
    return 'la garantie est libérée, votre carte ne sera pas débitée'
  }
  return null
}

/** Why a payment-bound booking can no longer be cancelled online, in words. */
export function cancellationClosedReason(payment: ManagePaymentFacts): string {
  const money = (cents: number) => formatMoney(cents, payment.currency)
  const consequence =
    payment.kind === 'deposit'
      ? "l'acompte reste acquis à l'établissement"
      : `en cas d'absence, des frais allant jusqu'à ${money(payment.noShowFeeCents)} peuvent être débités`
  return `Le délai d'annulation gratuite est dépassé : vous ne pouvez plus annuler ni modifier cette réservation en ligne, et ${consequence}. Pour toute demande, contactez directement l'établissement.`
}
