/**
 * How the booking pages write a date, and what the form says it is waiting for.
 *
 * Two small rules a guest notices at once: the first of a month is « 1er », never « 1 », and
 * a button that stays off says why in words.
 */

import { describe, expect, it } from 'vitest'
import {
  formatCalendarDate,
  formatReservationInstant,
  listInFrench,
  missingForBooking,
} from '@/app/(storefront)/reservation/_components/reservation-format'

describe('the first of the month', () => {
  it('is written « 1er » on the booking pages, as French writes it', () => {
    // Sunday 1 November 2026, 19:30 in Paris.
    const at = Date.UTC(2026, 10, 1, 18, 30)
    expect(formatReservationInstant(at, 'Europe/Paris')).toBe('dimanche 1er novembre 2026 à 19:30')
    expect(formatCalendarDate('2026-11-01')).toBe('dimanche 1er novembre 2026')
  })

  it('leaves every other day as it was', () => {
    expect(formatCalendarDate('2026-11-11')).toBe('mercredi 11 novembre 2026')
    expect(formatCalendarDate('2026-10-31')).toBe('samedi 31 octobre 2026')
    expect(formatCalendarDate('2026-11-02')).toBe('lundi 2 novembre 2026')
  })
})

describe('listing what is missing', () => {
  it('reads aloud as a person would', () => {
    expect(listInFrench([])).toBe('')
    expect(listInFrench(['votre nom'])).toBe('votre nom')
    expect(listInFrench(['votre nom', 'votre e-mail'])).toBe('votre nom et votre e-mail')
    expect(listInFrench(['a', 'b', 'c'])).toBe('a, b et c')
  })
})

const COMPLETE = {
  name: 'Marie Dupont',
  email: 'marie@example.fr',
  phone: '0612345678',
  consent: true,
  owes: false,
  paymentConsent: false,
  unpayable: false,
  checking: false,
}

describe('what the booking form is waiting for', () => {
  it('is nothing once everything is given', () => {
    expect(missingForBooking(COMPLETE)).toEqual([])
  })

  it('names each thing that is not there, in the order of the form', () => {
    expect(
      missingForBooking({ ...COMPLETE, name: ' ', email: '', phone: '06', consent: false }),
    ).toEqual([
      'votre nom',
      'votre e-mail',
      'votre téléphone',
      "la case d'acceptation des conditions de réservation",
    ])
  })

  it('tells an address that is not one from an address that is absent', () => {
    expect(missingForBooking({ ...COMPLETE, email: 'marie@' })).toEqual([
      'une adresse e-mail valide',
    ])
  })

  it('asks for the payment terms only when something is owed', () => {
    expect(missingForBooking({ ...COMPLETE, owes: false, paymentConsent: false })).toEqual([])
    expect(missingForBooking({ ...COMPLETE, owes: true, paymentConsent: false })).toEqual([
      'la case des conditions de paiement',
    ])
    expect(missingForBooking({ ...COMPLETE, owes: true, paymentConsent: true })).toEqual([])
  })

  it('says when the terms are still arriving, and when nothing can take the payment', () => {
    expect(missingForBooking({ ...COMPLETE, checking: true })).toEqual([
      'les conditions de paiement, en cours de vérification',
    ])
    expect(
      missingForBooking({ ...COMPLETE, owes: true, paymentConsent: true, unpayable: true }),
    ).toEqual(["un moyen de paiement disponible (le restaurant n'en propose pas pour l'instant)"])
  })
})
