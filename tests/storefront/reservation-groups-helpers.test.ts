/**
 * The pure words and rules behind large parties and limited-seat events.
 *
 * What is held here, because each breaks quietly:
 *
 *  1. a party goes the way the server's `routeParty` sends it — and the page, which reads
 *     only three numbers from `getPublicConfig`, can never disagree with it;
 *  2. the selector never stops short: it ends on one size that leads to the contact card;
 *  3. a request is never described as confirmed, and the copy makes no promise of a delay;
 *  4. the seats left are a plain number, and the ticket's calendar entry names the event.
 */

import { partyBands, routeParty, type GroupPolicy } from '@be-yours/convex-schema'
import { describe, expect, it } from 'vitest'
import {
  GROUP_HEADLINES,
  directLimit,
  groupNeedsWayOn,
  groupStateCopy,
  partyCeiling,
  partyOptions,
  proposalPaymentSentence,
  requestIntro,
  reviewWindowWords,
  routeFor,
  telHref,
  type GroupFacts,
  type GroupState,
} from '@/app/(storefront)/reservation/_components/reservation-groups'
import {
  TICKET_STATUS_COPY,
  cancelledEventCopy,
  purchaseDestination,
  renderTicketIcs,
  seatPriceText,
  seatsLeftText,
  ticketCancelConsequence,
  ticketCancellationClosed,
} from '@/app/(storefront)/reservation/_components/reservation-experiences'
import {
  KNOWN_REFUSAL_CODES,
  refusalSentence,
} from '@/app/(storefront)/reservation/_components/reservation-refusals'

const POLICY: GroupPolicy = {
  enabled: true,
  threshold: 10,
  maxSize: 40,
  reviewHours: 48,
  proposalHours: 24,
}

/** What `getPublicConfig` derives from a policy, as the page receives it. */
function configFor(maxPartySize: number, policy: GroupPolicy | null) {
  const bands = partyBands(maxPartySize, policy)
  return {
    maxPartySize,
    directMax: bands.directMax,
    groups:
      bands.groupMin !== null && bands.groupMax !== null
        ? {
            minSize: bands.groupMin,
            maxSize: bands.groupMax,
            reviewHours: policy?.reviewHours ?? 48,
          }
        : null,
  }
}

describe('which way a party goes', () => {
  it('agrees with the server for every size, with groups on', () => {
    const config = configFor(12, POLICY)
    const bands = partyBands(12, POLICY)
    for (let size = 1; size <= 60; size += 1) {
      expect(routeFor(size, config), `size ${size}`).toBe(routeParty(size, bands))
    }
  })

  it('agrees with the server for every size, with groups off', () => {
    const config = configFor(8, null)
    const bands = partyBands(8, null)
    for (let size = 1; size <= 30; size += 1) {
      expect(routeFor(size, config), `size ${size}`).toBe(routeParty(size, bands))
    }
    expect(routeFor(9, config)).toBe('contact')
  })

  it('agrees when the threshold sits above the online ceiling (the band starts after it)', () => {
    const policy = { ...POLICY, threshold: 30 }
    const config = configFor(8, policy)
    expect(config.directMax).toBe(8)
    expect(config.groups?.minSize).toBe(9)
    for (let size = 1; size <= 60; size += 1) {
      expect(routeFor(size, config)).toBe(routeParty(size, partyBands(8, policy)))
    }
  })

  it('sends a party of exactly the group maximum to a request, and one more to the contact card', () => {
    const config = configFor(6, POLICY)
    expect(routeFor(40, config)).toBe('group')
    expect(routeFor(41, config)).toBe('contact')
  })

  it('falls back to the online ceiling on a deployment that predates the groups', () => {
    const old = { maxPartySize: 6 }
    expect(directLimit(old)).toBe(6)
    expect(partyCeiling(old)).toBe(6)
    expect(routeFor(6, old)).toBe('direct')
    expect(routeFor(7, old)).toBe('contact')
  })
})

describe('the party selector', () => {
  it('reaches the group maximum when groups are on, then one « more than » size', () => {
    const options = partyOptions(configFor(6, POLICY))
    expect(options.sizes[0]).toBe(1)
    expect(options.sizes.at(-1)).toBe(40)
    expect(options.overflow).toBe(41)
  })

  it('stops at the ordinary ceiling when groups are off, still with the overflow size', () => {
    const options = partyOptions(configFor(6, null))
    expect(options.sizes.at(-1)).toBe(6)
    expect(options.overflow).toBe(7)
  })
})

describe('what a request says', () => {
  const intro = requestIntro({ storeName: 'Chez Luigi', partySize: 14, reviewHours: 48 }).join(' ')

  it('says plainly that nothing is confirmed or paid', () => {
    expect(intro).toContain("Rien n'est confirmé")
    expect(intro).toContain("rien n'est à payer")
    expect(intro).toContain("Chez Luigi doit l'accepter")
  })

  it('says how long the place is held, in the words a person uses', () => {
    expect(intro).toContain('2 jours')
    expect(reviewWindowWords(1)).toBe('1 heure')
    expect(reviewWindowWords(6)).toBe('6 heures')
    expect(reviewWindowWords(24)).toBe('24 heures')
    expect(reviewWindowWords(36)).toBe('36 heures')
    expect(reviewWindowWords(72)).toBe('3 jours')
  })

  it('says what happens when nobody answers, instead of promising an answer', () => {
    expect(intro).toContain('expire')
    expect(intro).not.toMatch(/sous\s+\d+\s?h/i)
    expect(intro).not.toMatch(/Nous répondons|Réponse rapide/)
  })
})

describe('what the manage page says of a request', () => {
  const base = (state: GroupState, extra: Partial<GroupFacts> = {}): GroupFacts => ({
    state,
    requestedStartsAt: Date.UTC(2027, 0, 15, 19, 0),
    reviewExpiresAt: Date.UTC(2027, 0, 10, 12, 0),
    hostMessage: null,
    proposal: null,
    ...extra,
  })
  const ctx = { storeName: 'Chez Luigi', timezone: 'Europe/Paris' }

  it('has a headline and a sentence for every state', () => {
    for (const state of Object.keys(GROUP_HEADLINES) as GroupState[]) {
      expect(GROUP_HEADLINES[state].length).toBeGreaterThan(5)
      expect(groupStateCopy(base(state), ctx).length).toBeGreaterThan(10)
    }
  })

  it('calls a waiting request not confirmed and names the deadline in the restaurant clock', () => {
    const copy = groupStateCopy(base('review'), ctx)
    expect(copy).toContain("n'est pas confirmée")
    expect(copy).toContain('10 janvier 2027 à 13:00')
    expect(copy).toContain('expire')
  })

  it('says a lapsed review no longer holds a place', () => {
    expect(groupStateCopy(base('review_lapsed'), ctx)).toContain("n'est plus gardée")
  })

  it('offers a way on, and no button, for the states that end online', () => {
    expect(
      (['review_lapsed', 'proposal_lapsed', 'declined', 'expired'] as GroupState[]).map(
        groupNeedsWayOn,
      ),
    ).toEqual([true, true, true, true])
    expect(groupNeedsWayOn('review')).toBe(false)
    expect(groupNeedsWayOn('approved')).toBe(false)
  })

  it('says in words what a proposal asks for, before it is accepted', () => {
    const deposit = proposalPaymentSentence({
      kind: 'deposit',
      depositCents: 20_000,
      noShowFeeCents: 0,
      freeCancellationHours: 48,
      currency: 'EUR',
      lines: [],
    })
    expect(deposit).toMatch(/acompte de 200,00\s€/)
    expect(deposit).toContain('page de paiement')
    const guarantee = proposalPaymentSentence({
      kind: 'guarantee',
      depositCents: 0,
      noShowFeeCents: 3_000,
      freeCancellationHours: 48,
      currency: 'EUR',
      lines: [],
    })
    expect(guarantee).toContain('aucun débit maintenant')
    expect(proposalPaymentSentence(null)).toBeNull()
  })
})

describe('the contact way on', () => {
  it('writes a tel: address from whatever was typed', () => {
    expect(telHref('01 40 50 60 70')).toBe('tel:0140506070')
    expect(telHref('+33 (0)1 40 50 60 70')).toBe('tel:+330140506070')
  })
})

describe('refusals, in plain French', () => {
  it('has words for every code the groups and the events add', () => {
    for (const code of [
      'group_not_offered',
      'party_contact_only',
      'payment_consent_required',
      'experience_unavailable',
      'experience_sold_out',
      'proposal_unavailable',
      'group_request_closed',
    ]) {
      expect(KNOWN_REFUSAL_CODES).toContain(code)
      expect(refusalSentence({ code }, 'x')).not.toBe('x')
    }
  })

  it("prefers the server's own sentence, which can name what is missing", () => {
    expect(
      refusalSentence({ code: 'experience_sold_out', message: 'Il reste 2 places.' }, 'x'),
    ).toBe('Il reste 2 places.')
  })

  it('falls back only for a value that is not a refusal at all', () => {
    expect(refusalSentence(null, 'Réessayez.')).toBe('Réessayez.')
    expect(refusalSentence({ code: 'something_new' }, 'Réessayez.')).toBe('Réessayez.')
  })
})

describe('an event, in words', () => {
  it('says the seats left as a plain number, in a neutral voice', () => {
    expect(seatsLeftText(12)).toBe('12 places restantes')
    expect(seatsLeftText(1)).toBe('1 place restante')
    for (const n of [1, 2, 3, 9]) {
      expect(seatsLeftText(n)).not.toMatch(/plus que|derni|vite|urgent|presque/i)
    }
  })

  it('says Gratuit for nothing, and the price per seat otherwise', () => {
    expect(seatPriceText({ free: true, priceCents: 0, currency: 'EUR' })).toBe('Gratuit')
    expect(seatPriceText({ free: false, priceCents: 4_500, currency: 'EUR' })).toMatch(
      /45,00\s€ par place/,
    )
  })

  it('sends a paid ticket to pay and a confirmed one to its page', () => {
    expect(purchaseDestination('pending_payment', 'tok-1')).toBe('/reservation/payment/tok-1')
    expect(purchaseDestination('confirmed', 'tok-1')).toBe('/reservation/manage/tok-1')
  })

  it("speaks of seats on a ticket's page, never of a table", () => {
    for (const sentence of Object.values(TICKET_STATUS_COPY)) {
      expect(sentence).not.toMatch(/table/i)
    }
    expect(ticketCancellationClosed({ cutoffHours: 48, paid: true })).toContain('48 h')
    expect(ticketCancellationClosed({ cutoffHours: 48, paid: true })).toContain(
      'le prix des places reste acquis',
    )
    expect(ticketCancellationClosed({ cutoffHours: 48, paid: false })).not.toContain('acquis')
  })

  it('says what cancelling does to the money of a ticket', () => {
    const paid = {
      currency: 'EUR',
      depositCents: 9_000,
      state: 'paid',
      heldCents: 9_000,
      refundedCents: 0,
      awaiting: false,
    }
    expect(ticketCancelConsequence(paid)).toMatch(
      /le prix des places \(90,00\s€\) vous sera remboursé/,
    )
    expect(
      ticketCancelConsequence({ ...paid, state: 'awaiting', heldCents: 0, awaiting: true }),
    ).toBe('rien ne sera débité')
    expect(ticketCancelConsequence(null)).toBeNull()
  })

  it("tells a cancelled event's guest what happened, with the host's words and the refund", () => {
    const lines = cancelledEventCopy({
      storeName: 'Chez Luigi',
      cancelReason: 'Le chef est souffrant.',
      payment: {
        currency: 'EUR',
        depositCents: 9_000,
        state: 'paid',
        heldCents: 9_000,
        refundedCents: 0,
        awaiting: false,
      },
    }).join(' ')
    expect(lines).toContain('Chez Luigi a annulé cet événement')
    expect(lines).toContain('Le chef est souffrant.')
    expect(lines).toContain('remboursées en totalité')
  })
})

describe("the ticket's calendar entry", () => {
  const ics = renderTicketIcs({
    reference: 'RES-2027-00004',
    title: 'Soirée dégustation, accords mets et vins',
    startsAt: Date.UTC(2027, 0, 15, 18, 30),
    endsAt: Date.UTC(2027, 0, 15, 21, 0),
    storeName: 'Chez Luigi',
    location: '12 rue des Lilas, 75011 Paris',
    seats: 2,
    now: Date.UTC(2027, 0, 1),
    sequence: 0,
  })
  const unfolded = ics.replace(/\r\n /g, '')

  it('carries the event title, not a table', () => {
    expect(unfolded).toContain('SUMMARY:Soirée dégustation\\, accords mets et vins chez Chez Luigi')
    expect(unfolded).not.toContain('Réservation chez')
    expect(unfolded).toContain('pour 2 places')
  })

  it('keeps the booking reference as its identity, so adding it twice updates one entry', () => {
    expect(unfolded).toContain('UID:RES-2027-00004@reservation')
    expect(unfolded).toContain('DTSTART:20270115T183000Z')
    expect(unfolded).toContain('DTEND:20270115T210000Z')
  })

  it('folds long lines at 75 octets, as the format requires', () => {
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
  })
})
