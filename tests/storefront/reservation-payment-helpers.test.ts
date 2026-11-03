/**
 * The pure rules behind the guest's payment screens.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. the countdown reads minutes and seconds, never negative, and a screen reader hears
 *     the hold in five coarse steps rather than sixty a minute;
 *  2. `?return=` is read the way the server writes it, and anything else is no return;
 *  3. what the SERVER knows about the booking beats what the URL says — a `?return=success`
 *     link reopened after the booking was settled shows the booking, and a `?return=cancelled`
 *     one never offers to pay twice;
 *  4. while the server has not confirmed, the page never falls back to the way to pay;
 *  5. the words said about cancelling match what the money will do.
 */

import { describe, expect, it } from 'vitest'
import {
  VERIFY_PATIENCE_MS,
  cancelConsequence,
  cancellationClosedReason,
  formatCountdown,
  holdAnnouncement,
  paymentErrorFallback,
  paymentView,
  readReturnState,
  type ManagePaymentFacts,
  type PaymentPageFacts,
} from '@/app/(storefront)/reservation/_components/reservation-payment'

const MINUTE = 60_000

describe('formatCountdown', () => {
  it('reads minutes and seconds with two digits each', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(7_000)).toBe('00:07')
    expect(formatCountdown(4 * MINUTE + 7_000)).toBe('04:07')
    expect(formatCountdown(15 * MINUTE)).toBe('15:00')
  })

  it('never goes negative and lets minutes pass 59 for a long hold', () => {
    expect(formatCountdown(-5_000)).toBe('00:00')
    expect(formatCountdown(60 * MINUTE)).toBe('60:00')
  })

  it('rounds a started second up, so the clock never shows 00:00 while time is left', () => {
    expect(formatCountdown(400)).toBe('00:01')
    expect(formatCountdown(1_000)).toBe('00:01')
    expect(formatCountdown(1_001)).toBe('00:02')
  })
})

describe('holdAnnouncement', () => {
  it('changes in five steps over a whole hold, not every second', () => {
    const spoken = new Set<string>()
    for (let left = 60 * MINUTE; left > 0; left -= 1_000) spoken.add(holdAnnouncement(left))
    expect(spoken.size).toBe(5)
  })

  it('stays the same inside a step', () => {
    expect(holdAnnouncement(9 * MINUTE)).toBe(holdAnnouncement(6 * MINUTE))
    expect(holdAnnouncement(30_000)).toBe(holdAnnouncement(59_000))
  })

  it('says plainly when the delay has passed', () => {
    expect(holdAnnouncement(0)).toBe('Le délai pour payer est dépassé.')
    expect(holdAnnouncement(-1)).toBe('Le délai pour payer est dépassé.')
  })
})

describe('readReturnState', () => {
  it('knows the two addresses the server gives the provider', () => {
    expect(readReturnState('success')).toBe('success')
    expect(readReturnState('cancelled')).toBe('cancelled')
  })

  it('takes the first of a repeated parameter', () => {
    expect(readReturnState(['cancelled', 'success'])).toBe('cancelled')
  })

  it('reads anything else as no return at all', () => {
    expect(readReturnState(undefined)).toBeNull()
    expect(readReturnState(null)).toBeNull()
    expect(readReturnState('')).toBeNull()
    expect(readReturnState('paid')).toBeNull()
    expect(readReturnState('SUCCESS')).toBeNull()
    expect(readReturnState([])).toBeNull()
  })
})

const NOW = 1_800_000_000_000

function facts(overrides: {
  status?: string
  state?: string
  holdExpiresAt?: number | null
  holdLapsed?: boolean
}): PaymentPageFacts {
  return {
    status: overrides.status ?? 'pending_payment',
    payment: {
      awaiting: (overrides.status ?? 'pending_payment') === 'pending_payment',
      holdExpiresAt:
        overrides.holdExpiresAt === undefined ? NOW + 10 * MINUTE : overrides.holdExpiresAt,
      holdLapsed: overrides.holdLapsed ?? false,
      state: overrides.state ?? 'awaiting',
    },
  }
}

describe('paymentView', () => {
  it('offers the way to pay while the table is held and nothing has happened', () => {
    expect(paymentView(facts({}), { now: NOW, returned: null })).toBe('awaiting')
  })

  it('shows a booking that was taken, whatever the address says', () => {
    for (const returned of [null, 'success', 'cancelled'] as const) {
      expect(
        paymentView(facts({ status: 'confirmed', state: 'paid' }), { now: NOW, returned }),
      ).toBe('settled')
      expect(paymentView(facts({ status: 'pending', state: 'paid' }), { now: NOW, returned })).toBe(
        'settled',
      )
    }
  })

  it('never offers to pay twice after a cancelled return that the webhook already settled', () => {
    expect(
      paymentView(facts({ status: 'confirmed', state: 'paid' }), {
        now: NOW,
        returned: 'cancelled',
      }),
    ).toBe('settled')
  })

  it('says the table was released once the hold ran out, by the server or by the clock', () => {
    expect(paymentView(facts({ status: 'expired' }), { now: NOW, returned: null })).toBe('lapsed')
    expect(paymentView(facts({ holdLapsed: true }), { now: NOW, returned: null })).toBe('lapsed')
    expect(paymentView(facts({ holdExpiresAt: NOW - 1 }), { now: NOW, returned: 'success' })).toBe(
      'lapsed',
    )
    expect(paymentView(facts({ holdExpiresAt: NOW }), { now: NOW, returned: null })).toBe('lapsed')
  })

  it('waits for the server after a success return, and then says so, without ever offering to pay again', () => {
    expect(paymentView(facts({}), { now: NOW, returned: 'success' })).toBe('verifying')
    expect(paymentView(facts({}), { now: NOW, returned: 'success', verifyGaveUp: true })).toBe(
      'unconfirmed',
    )
  })

  it('shows the cancelled return as a way to retry', () => {
    expect(paymentView(facts({}), { now: NOW, returned: 'cancelled' })).toBe('cancelled')
  })

  it('shows a failed attempt as a way to retry, even on a success address', () => {
    expect(paymentView(facts({ state: 'failed' }), { now: NOW, returned: null })).toBe('failed')
    expect(paymentView(facts({ state: 'failed' }), { now: NOW, returned: 'success' })).toBe(
      'failed',
    )
  })

  it('says a booking that ended another way has ended', () => {
    for (const status of ['cancelled_by_guest', 'cancelled_by_restaurant', 'declined', 'no_show']) {
      expect(paymentView(facts({ status }), { now: NOW, returned: null })).toBe('ended')
    }
    expect(paymentView(facts({ status: 'something_new' }), { now: NOW, returned: null })).toBe(
      'ended',
    )
  })

  it('has a patience that is long enough for a webhook and short enough to be honest', () => {
    expect(VERIFY_PATIENCE_MS).toBe(20_000)
  })
})

describe('paymentErrorFallback', () => {
  it('has words for each refusal the payment actions raise', () => {
    expect(paymentErrorFallback('payment_hold_lapsed')).toContain('libérée')
    expect(paymentErrorFallback('payment_unavailable')).toContain("n'est pas disponible")
    expect(paymentErrorFallback('transition_refused')).toContain("n'attend plus de paiement")
    expect(paymentErrorFallback('payment_consent_required')).toContain('Cochez la case')
    expect(paymentErrorFallback('rate_limited')).toContain('Patientez')
  })

  it('has a French sentence for a refusal it does not know', () => {
    expect(paymentErrorFallback(undefined)).toContain('Veuillez réessayer')
    expect(paymentErrorFallback('whatever')).toContain('Veuillez réessayer')
  })
})

const DEPOSIT: ManagePaymentFacts = {
  kind: 'deposit',
  currency: 'EUR',
  depositCents: 4000,
  noShowFeeCents: 0,
  state: 'paid',
  heldCents: 4000,
  refundedCents: 0,
  feeChargedCents: 0,
  awaiting: false,
}

describe('cancelConsequence', () => {
  it('states the refund of a paid deposit, with its exact amount', () => {
    expect(cancelConsequence(DEPOSIT)).toMatch(/l'acompte de 40,00\s€ vous sera remboursé/)
  })

  it('states that a secured card is released, not charged', () => {
    expect(
      cancelConsequence({
        ...DEPOSIT,
        kind: 'guarantee',
        depositCents: 0,
        noShowFeeCents: 3000,
        state: 'secured',
        heldCents: 0,
      }),
    ).toBe('la garantie est libérée, votre carte ne sera pas débitée')
  })

  it('says nothing is charged for a booking still awaiting its payment', () => {
    expect(cancelConsequence({ ...DEPOSIT, state: 'awaiting', heldCents: 0, awaiting: true })).toBe(
      'rien ne sera débité',
    )
  })

  it('promises nothing where the server has not backed it', () => {
    expect(
      cancelConsequence({ ...DEPOSIT, state: 'refunded', heldCents: 0, refundedCents: 4000 }),
    ).toBeNull()
    expect(cancelConsequence({ ...DEPOSIT, state: 'fee_charged' })).toBeNull()
    expect(cancelConsequence({ ...DEPOSIT, state: 'none', heldCents: 0 })).toBeNull()
  })
})

describe('cancellationClosedReason', () => {
  it('says the deposit is kept, and to call the establishment', () => {
    const text = cancellationClosedReason(DEPOSIT)
    expect(text).toContain("Le délai d'annulation gratuite est dépassé")
    expect(text).toContain("l'acompte reste acquis")
    expect(text).toContain("contactez directement l'établissement")
  })

  it('names the largest fee a guarantee may cost', () => {
    const text = cancellationClosedReason({
      ...DEPOSIT,
      kind: 'guarantee',
      noShowFeeCents: 3000,
      depositCents: 0,
    })
    expect(text).toMatch(/frais allant jusqu'à 30,00\s€/)
  })
})
