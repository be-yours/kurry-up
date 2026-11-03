/**
 * Limited-seat events, as a guest reads them: the words on a card, the words on a ticket's
 * manage page and the calendar entry that carries the event's own title.
 *
 * Pure, so it is tested without a browser. The tone is deliberate and held by a test: the
 * seats left are a PLAIN NUMBER. Nothing here nudges — no « plus que », no « dernières
 * places », no colour, no clock. A guest decides on a fact, not on pressure.
 */

import { formatMoney } from '@be-yours/convex-schema'
import { formatClock, formatReservationInstant } from './reservation-format'

/** « 12 places restantes », « 1 place restante ». A number, said once, in a neutral voice. */
export function seatsLeftText(seatsLeft: number): string {
  return `${seatsLeft} ${seatsLeft === 1 ? 'place restante' : 'places restantes'}`
}

/** « 3 places », « 1 place ». */
export const placesWord = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`

/** What one seat costs: « Gratuit », or « 45,00 € par place ». */
export function seatPriceText(card: {
  free: boolean
  priceCents: number
  currency: string
}): string {
  return card.free ? 'Gratuit' : `${formatMoney(card.priceCents, card.currency)} par place`
}

/** « mardi 3 novembre 2026 à 19:30, jusqu'à 22:00 » in the establishment's clock. */
export function eventWhenText(
  card: { startsAt: number; endsAt: number },
  timezone: string,
): string {
  return `${formatReservationInstant(card.startsAt, timezone)}, jusqu'à ${formatClock(card.endsAt, timezone)}`
}

/** « Ventes ouvertes à partir du mardi 3 novembre 2026 à 10:00 ». */
export function salesOpenText(salesOpensAt: number, timezone: string): string {
  return `Ventes ouvertes à partir du ${formatReservationInstant(salesOpensAt, timezone)}`
}

/** Where a purchase sends the guest: to pay, or to their tickets. */
export function purchaseDestination(status: string, token: string): string {
  return status === 'pending_payment'
    ? `/reservation/payment/${token}`
    : `/reservation/manage/${token}`
}

/** The most seats an alert can name when the card cannot say what the event allows. */
export const ALERT_PARTY_CEILING = 20

/* ------------------------------------------------------------------ */
/* A ticket on the manage page                                         */
/* ------------------------------------------------------------------ */

/** What a ticket's holder is told about each state of it. */
export const TICKET_STATUS_COPY: Readonly<Record<string, string>> = {
  pending: "L'établissement doit valider vos places. Retrouvez sa réponse sur ce lien.",
  pending_payment: 'Vos places attendent un règlement pour être confirmées.',
  confirmed: 'Vos places sont réservées. À bientôt !',
  arrived: 'Vous êtes attendu(e) : bonne soirée !',
  seated: 'Vous êtes installé(e) : bonne soirée !',
  completed: 'Merci de votre venue.',
  cancelled_by_guest: 'Vous avez annulé ces places.',
  cancelled_by_restaurant: "L'établissement a dû annuler ces places.",
  no_show: "Ces places n'ont pas été utilisées.",
  expired: 'Le délai pour payer est dépassé : les places ont été libérées.',
  declined: "L'établissement n'a pas pu accepter cette demande.",
}

/** The money side of a ticket that was paid, said with the ticket's words, not a table's. */
export interface TicketPaymentFacts {
  currency: string
  depositCents: number
  state: string
  heldCents: number
  refundedCents: number
  awaiting: boolean
}

/** What cancelling does to a ticket's money, or `null` when it does nothing to it. */
export function ticketCancelConsequence(payment: TicketPaymentFacts | null): string | null {
  if (!payment) return null
  if (payment.awaiting) return 'rien ne sera débité'
  if (payment.state === 'paid' && payment.heldCents > 0) {
    return `le prix des places (${formatMoney(payment.heldCents, payment.currency)}) vous sera remboursé`
  }
  return null
}

/** Why a ticket can no longer be cancelled online, in words, with the event's own cut-off. */
export function ticketCancellationClosed(input: { cutoffHours: number; paid: boolean }): string {
  const hours = `${input.cutoffHours} h`
  return input.paid
    ? `Le délai d'annulation de cet événement (${hours} avant le début) est dépassé : vous ne pouvez plus annuler en ligne et le prix des places reste acquis à l'établissement. Pour toute demande, contactez directement l'établissement.`
    : `Le délai d'annulation de cet événement (${hours} avant le début) est dépassé : vous ne pouvez plus annuler en ligne. Pour toute demande, contactez directement l'établissement.`
}

/** The sentence under a cancelled event: what happened, and what happens to the money. */
export function cancelledEventCopy(input: {
  storeName: string
  cancelReason: string | null
  payment: TicketPaymentFacts | null
}): string[] {
  const name = input.storeName.trim() || "L'établissement"
  const out = [`${name} a annulé cet événement.`]
  if (input.cancelReason) out.push(`Son message : « ${input.cancelReason} »`)
  const paid = input.payment && input.payment.heldCents + input.payment.refundedCents > 0
  if (paid && input.payment) {
    out.push(
      input.payment.refundedCents > 0
        ? `Vos places sont remboursées : ${formatMoney(input.payment.refundedCents, input.payment.currency)}. Le délai de réception dépend de votre banque.`
        : 'Vos places payées sont remboursées en totalité : le remboursement est demandé automatiquement, et le délai de réception dépend de votre banque.',
    )
  }
  return out
}

/* ------------------------------------------------------------------ */
/* The calendar entry                                                  */
/* ------------------------------------------------------------------ */

export interface TicketIcsInput {
  reference: string
  /** The event's own title: the calendar entry is the evening, not a table. */
  title: string
  startsAt: number
  endsAt: number
  storeName: string
  location?: string
  seats: number
  now: number
  sequence?: number
}

const clamp = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are escaped. */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function icsInstant(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** RFC 5545 §3.1: a line is at most 75 octets; the rest continues after a space. */
function icsFold(line: string): string {
  const encoder = new TextEncoder()
  const out: string[] = []
  let current = ''
  let size = 0
  for (const char of line) {
    const width = encoder.encode(char).length
    const limit = out.length === 0 ? 75 : 74
    if (size + width > limit) {
      out.push(current)
      current = ''
      size = 0
    }
    current += char
    size += width
  }
  out.push(current)
  return out.join('\r\n ')
}

/**
 * A ticket as an `.ics` file: the same shape as a booking's (`renderReservationIcs`, which
 * has no title to give), with the event's title as the summary. One event, UTC times, an
 * entry to keep; the `UID` is the booking's reference so adding it twice updates one entry.
 */
export function renderTicketIcs(input: TicketIcsInput): string {
  const store = clamp(input.storeName, 120)
  const title = clamp(input.title, 120)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BeYours//Reservation//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(clamp(input.reference, 40))}@reservation`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence ?? 0))}`,
    `DTSTAMP:${icsInstant(input.now)}`,
    `DTSTART:${icsInstant(input.startsAt)}`,
    `DTEND:${icsInstant(input.endsAt)}`,
    `SUMMARY:${icsText(store ? `${title} chez ${store}` : title)}`,
    ...(input.location ? [`LOCATION:${icsText(`${store}, ${clamp(input.location, 200)}`)}`] : []),
    `DESCRIPTION:${icsText(`Réservation ${clamp(input.reference, 40)} pour ${placesWord(input.seats)}.`)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(icsFold).join('\r\n')}\r\n`
}
