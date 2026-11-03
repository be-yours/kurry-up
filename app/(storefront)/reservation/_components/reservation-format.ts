/**
 * How a booking is written for a diner.
 *
 * The restaurant's clock, not the browser's: a diner travelling, or a tablet set
 * to the wrong zone, must still read the time the table is held for.
 */

import { frenchOrdinalDay } from '@be-yours/convex-schema'

/** "2026-11-03" for an instant, in the restaurant's calendar. */
export function isoDateInZone(at: number, timezone: string): string {
  // `en-CA` prints year-month-day, which is the shape a date input wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at))
}

/** "mardi 3 novembre 2026 à 19:30", and « dimanche 1er novembre 2026 » on the first. */
export function formatReservationInstant(at: number, timezone: string): string {
  return frenchOrdinalDay(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date(at)),
  )
}

/** "mardi 3 novembre 2026" for a calendar date: the weekday of a date does not depend on a zone. */
export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  // Noon UTC: far from any midnight, so no zone can move the day.
  return frenchOrdinalDay(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', dateStyle: 'full' }).format(
      new Date(Date.UTC(year!, month! - 1, day!, 12)),
    ),
  )
}

/** "19:30" in the restaurant's clock. */
export function formatClock(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at))
}

/** What a diner is told about each state of their booking. */
export const STATUS_COPY = {
  pending:
    'Le restaurant doit valider votre demande. Retrouvez sa réponse sur le lien de votre réservation.',
  pending_payment: 'Votre réservation attend un règlement pour être confirmée.',
  confirmed: 'Votre table est réservée. À bientôt !',
  arrived: 'Vous êtes attendu(e) : bon appétit !',
  seated: 'Vous êtes installé(e) : bon appétit !',
  completed: 'Merci de votre visite.',
  cancelled_by_guest: 'Vous avez annulé cette réservation.',
  cancelled_by_restaurant: 'Le restaurant a dû annuler cette réservation.',
  no_show: "Cette réservation est close : la table n'a pas été occupée.",
  expired: 'Cette demande a expiré sans réponse du restaurant.',
  declined: "Le restaurant n'a pas pu accepter cette demande.",
} as const

/** « a », « a et b », « a, b et c » — a list the way a person reads it aloud. */
export function listInFrench(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`
}

/**
 * What the booking form is still waiting for, in the guest's own words — or an empty list when
 * nothing is. The submit button stays off until then, and a button that is off with no word
 * about why leaves a guest on a phone tapping at it.
 */
export function missingForBooking(form: {
  name: string
  email: string
  phone: string
  consent: boolean
  /** Something is owed: the box that agrees to the payment terms must be ticked too. */
  owes: boolean
  paymentConsent: boolean
  /** Something is owed and no provider can take it. */
  unpayable: boolean
  /** The payment terms have not arrived yet. */
  checking: boolean
}): string[] {
  const missing: string[] = []
  if (form.name.trim().length === 0) missing.push('votre nom')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    missing.push(form.email.trim().length === 0 ? 'votre e-mail' : 'une adresse e-mail valide')
  }
  if (form.phone.trim().length < 3) missing.push('votre téléphone')
  if (!form.consent) missing.push("la case d'acceptation des conditions de réservation")
  if (form.owes && !form.paymentConsent) missing.push('la case des conditions de paiement')
  if (form.checking) missing.push('les conditions de paiement, en cours de vérification')
  if (form.unpayable)
    missing.push("un moyen de paiement disponible (le restaurant n'en propose pas pour l'instant)")
  return missing
}
