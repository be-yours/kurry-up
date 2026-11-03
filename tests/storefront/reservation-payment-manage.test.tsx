// @vitest-environment jsdom

/**
 * What the guest's own link says about the money of a booking.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. a booking with no payment looks as it always did — no « Paiement » block;
 *  2. the block says the state in words and the amounts the server holds: paid, refunded,
 *     the most a no-show can cost — never more;
 *  3. while a payment is awaited the block shows how long the table is held and the way back
 *     to the payment page, and stops offering it when the hold ends;
 *  4. the terms are the ones this booking agreed to, beside the owner's own wording;
 *  5. cancelling says what it does to the money BEFORE it is confirmed, and a booking that can
 *     no longer be cancelled says why, in terms of the money;
 *  6. a payment-bound booking cannot change its party size online, and says why; time, note
 *     and area stay editable.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  booking: undefined as unknown,
  tokenSlots: undefined as unknown,
  cancel: vi.fn(),
  modify: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-aaaaaaaa' }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('convex/react', () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === 'skip') return undefined
    if (ref === 'getByToken') return state.booking
    if (ref === 'getAvailabilityByToken') return state.tokenSlots
    return undefined
  },
  useMutation: (ref: string) => (ref === 'modify' ? state.modify : state.cancel),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservations: {
      getByToken: 'getByToken',
      cancelByToken: 'cancelByToken',
      reconfirmByToken: 'reconfirm',
      getAvailabilityByToken: 'getAvailabilityByToken',
      modifyByToken: 'modify',
    },
  },
}))

const { default: ManageReservationContent } =
  await import('@/app/(storefront)/reservation/manage/[token]/_components/ManageReservationContent')

const NOW = 1_800_000_000_000 - 7 * 24 * 60 * 60_000
const MINUTE = 60_000

const TERMS = [
  'Un acompte de 40,00 € est demandé pour confirmer la réservation. Il est payé en ligne maintenant.',
  "Annulation gratuite jusqu'à 2 jours avant la réservation : l'acompte est alors remboursé en totalité.",
]

function paymentOf(
  overrides: Partial<{
    kind: 'deposit' | 'guarantee'
    state: string
    heldCents: number
    refundedCents: number
    feeChargedCents: number
    awaiting: boolean
    holdExpiresAt: number | null
  }> = {},
) {
  const kind = overrides.kind ?? 'deposit'
  return {
    kind,
    currency: 'EUR',
    depositCents: kind === 'deposit' ? 4000 : 0,
    noShowFeeCents: kind === 'guarantee' ? 3000 : 0,
    freeCancellationHours: 48,
    lines: TERMS,
    state: 'paid',
    heldCents: 4000,
    refundedCents: 0,
    feeChargedCents: 0,
    awaiting: false,
    holdExpiresAt: null as number | null,
    holdLapsed: false,
    ...overrides,
  }
}

const BOOKING = {
  reference: 'RES-2026-00007',
  status: 'confirmed',
  startsAt: 1_800_000_000_000,
  endsAt: 1_800_005_400_000,
  partySize: 4,
  guestName: 'Marie Dupont',
  guestNote: null as string | null,
  timezone: 'Europe/Paris',
  storeName: 'Chez Luigi',
  storeAddress: null,
  canCancel: true,
  canModify: true,
  changeNeedsValidation: false,
  canReconfirm: false,
  canAddToCalendar: false,
  reconfirmedAt: null,
  revision: 0,
  serviceId: 'svc_1',
  maxPartySize: 6,
  maxHorizonDays: 60,
  rooms: [] as Array<{ id: string; name: string }>,
  roomPreference: null as string | null,
  storePhone: null as string | null,
  storeEmail: null as string | null,
  policyText: null as string | null,
  retentionDays: 1095,
  noteDays: 3,
  privacyNoticeVersion: null as string | null,
  payment: null as unknown,
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  state.booking = { ...BOOKING, payment: paymentOf() }
  state.tokenSlots = [
    {
      serviceId: 'svc_1',
      time: '20:00',
      startsAt: 1_800_000_000_000,
      available: true,
      reason: null,
      preference: null,
      roomName: null,
    },
  ]
  state.cancel = vi.fn(async () => ({ status: 'cancelled_by_guest' }))
  state.modify = vi.fn(async () => ({ changed: true, status: 'confirmed' }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.useRealTimers()
})

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<ManageReservationContent />)
  })
  return container
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const byText = (root: HTMLElement, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) as HTMLElement

const block = (c: HTMLElement) => c.querySelector('section[aria-labelledby="booking-payment"]')
const buttonStarting = (c: HTMLElement, start: string) =>
  [...c.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(start))

describe('a booking with no payment', () => {
  it('has no payment block and its usual cancel button', async () => {
    state.booking = { ...BOOKING, payment: null, policyText: 'Merci de prévenir en cas de retard.' }
    const container = await mount()
    expect(block(container)).toBeNull()
    expect(byText(container, 'button', 'Annuler ma réservation')).toBeDefined()
    expect(container.textContent).toContain('Merci de prévenir en cas de retard.')
    expect(container.querySelector('#booking-policy ~ ul')).toBeNull()
  })
})

describe('the payment block', () => {
  it('says a paid deposit in words and amounts', async () => {
    const container = await mount()
    const text = block(container)?.textContent ?? ''
    expect(text).toContain('Paiement')
    expect(text).toContain('Acompte payé')
    expect(text).toMatch(/Acompte demandé40,00\s€/)
    expect(text).toMatch(/Payé40,00\s€/)
    expect(text).not.toContain('Remboursé')
    expect(text).not.toContain('Payer maintenant')
  })

  it('says a refund, and that the bank decides when it arrives', async () => {
    state.booking = {
      ...BOOKING,
      status: 'cancelled_by_guest',
      canCancel: false,
      payment: paymentOf({ state: 'refunded', heldCents: 0, refundedCents: 4000 }),
    }
    const container = await mount()
    const text = block(container)?.textContent ?? ''
    expect(text).toContain('Acompte remboursé')
    expect(text).toMatch(/Remboursé40,00\s€/)
    expect(text).toContain('le délai de réception dépend de votre banque')
  })

  it('says a secured card is not charged, and the most a no-show can cost', async () => {
    state.booking = {
      ...BOOKING,
      payment: paymentOf({ kind: 'guarantee', state: 'secured', heldCents: 0 }),
    }
    const container = await mount()
    const text = block(container)?.textContent ?? ''
    expect(text).toContain('Carte garantie')
    expect(text).toMatch(/Frais d'absence, au plus30,00\s€/)
    expect(text).toContain('sans débit')
    expect(text).not.toContain('Acompte demandé')
  })

  it('says what was charged for an absence', async () => {
    state.booking = {
      ...BOOKING,
      status: 'no_show',
      canCancel: false,
      payment: paymentOf({
        kind: 'guarantee',
        state: 'fee_charged',
        heldCents: 0,
        feeChargedCents: 2500,
      }),
    }
    const container = await mount()
    const text = block(container)?.textContent ?? ''
    expect(text).toContain("Frais d'absence débités")
    expect(text).toMatch(/Frais d'absence débités25,00\s€/)
  })

  it('shows the hold and the way back to pay while a payment is awaited', async () => {
    state.booking = {
      ...BOOKING,
      status: 'pending_payment',
      canCancel: true,
      payment: paymentOf({
        state: 'awaiting',
        heldCents: 0,
        awaiting: true,
        holdExpiresAt: NOW + 10 * MINUTE,
      }),
    }
    const container = await mount()
    const timer = container.querySelector('[role="timer"]')
    expect(timer?.textContent).toContain('10:00')
    expect(timer?.getAttribute('aria-live')).toBe('off')
    const pay = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Payer maintenant',
    )
    expect(pay?.getAttribute('href')).toBe('/reservation/payment/tok-aaaaaaaa')

    await advance(61_000)
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('08:59')
  })

  it('says a card guarantee is to be saved, not paid', async () => {
    state.booking = {
      ...BOOKING,
      status: 'pending_payment',
      payment: paymentOf({
        kind: 'guarantee',
        state: 'awaiting',
        heldCents: 0,
        awaiting: true,
        holdExpiresAt: NOW + 5 * MINUTE,
      }),
    }
    const container = await mount()
    expect(
      [...container.querySelectorAll('a')].some((a) => a.textContent === 'Enregistrer ma carte'),
    ).toBe(true)
    expect(container.textContent).not.toContain('Payer maintenant')
  })

  it('stops offering the payment when the hold ends, and says the table is released', async () => {
    state.booking = {
      ...BOOKING,
      status: 'pending_payment',
      payment: paymentOf({
        state: 'awaiting',
        heldCents: 0,
        awaiting: true,
        holdExpiresAt: NOW + 2_000,
      }),
    }
    const container = await mount()
    expect(container.textContent).toContain('Payer maintenant')
    await advance(3_000)
    expect(container.textContent).not.toContain('Payer maintenant')
    expect(container.textContent).toContain(
      'Le délai pour payer est dépassé : la table est libérée',
    )
  })
})

describe('the terms', () => {
  it('shows the booking’s own terms beside the owner’s wording', async () => {
    state.booking = {
      ...BOOKING,
      policyText: 'Au-delà de 15 minutes de retard, la table peut être réattribuée.',
      payment: paymentOf(),
    }
    const container = await mount()
    const policy = container.querySelector('section[aria-labelledby="booking-policy"]')!
    expect(policy.textContent).toContain('Au-delà de 15 minutes de retard')
    for (const line of TERMS) expect(policy.textContent).toContain(line)
  })

  it('shows them even when the owner wrote nothing of their own', async () => {
    state.booking = { ...BOOKING, policyText: null, payment: paymentOf() }
    const container = await mount()
    const policy = container.querySelector('section[aria-labelledby="booking-policy"]')
    expect(policy?.textContent).toContain(TERMS[1])
  })
})

describe('cancelling', () => {
  it('says what happens to a paid deposit on the button and before the guest confirms', async () => {
    const container = await mount()
    const button = buttonStarting(container, 'Annuler')!
    expect(button.textContent).toMatch(/^Annuler : l'acompte de 40,00\s€ vous sera remboursé$/)

    await click(button)
    expect(container.textContent).toMatch(/En annulant, l'acompte de 40,00\s€ vous sera remboursé/)
    expect(state.cancel).not.toHaveBeenCalled()
    await click(byText(container, 'button', 'Oui, annuler'))
    expect(state.cancel).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa' })
  })

  it('says a secured card is released', async () => {
    state.booking = {
      ...BOOKING,
      payment: paymentOf({ kind: 'guarantee', state: 'secured', heldCents: 0 }),
    }
    const container = await mount()
    expect(buttonStarting(container, 'Annuler')?.textContent).toBe(
      'Annuler : la garantie est libérée, votre carte ne sera pas débitée',
    )
  })

  it('says nothing is debited for a request that has not been paid', async () => {
    state.booking = {
      ...BOOKING,
      status: 'pending_payment',
      payment: paymentOf({
        state: 'awaiting',
        heldCents: 0,
        awaiting: true,
        holdExpiresAt: NOW + 10 * MINUTE,
      }),
    }
    const container = await mount()
    expect(buttonStarting(container, 'Annuler')?.textContent).toBe('Annuler : rien ne sera débité')
  })

  it('says why a payment-bound booking can no longer be cancelled, in terms of the money', async () => {
    state.booking = { ...BOOKING, canCancel: false, payment: paymentOf() }
    const container = await mount()
    expect(buttonStarting(container, 'Annuler')).toBeUndefined()
    expect(container.textContent).toContain("Le délai d'annulation gratuite est dépassé")
    expect(container.textContent).toContain("l'acompte reste acquis à l'établissement")
    expect(container.textContent).toContain("contactez directement l'établissement")
  })

  it('names the largest fee for a guarantee that can no longer be cancelled', async () => {
    state.booking = {
      ...BOOKING,
      canCancel: false,
      payment: paymentOf({ kind: 'guarantee', state: 'secured', heldCents: 0 }),
    }
    const container = await mount()
    expect(container.textContent).toMatch(/frais allant jusqu'à 30,00\s€ peuvent être débités/)
  })
})

describe('changing a payment-bound booking', () => {
  const open = async (container: HTMLElement) =>
    click(byText(container, 'button', 'Modifier ma réservation'))

  it('shows the party size read-only with the reason, and keeps the rest editable', async () => {
    const container = await mount()
    await open(container)
    const party = container.querySelector('#change-party') as HTMLSelectElement
    expect(party.disabled).toBe(true)
    expect(party.value).toBe('4')
    expect(party.getAttribute('aria-describedby')).toBe('change-party-locked')
    expect(container.querySelector('#change-party-locked')?.textContent).toContain(
      'ne peut pas être modifié en ligne',
    )
    expect((container.querySelector('#change-date') as HTMLInputElement).disabled).toBe(false)
    expect((container.querySelector('#change-note') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('leaves the party size editable for a booking with no payment', async () => {
    state.booking = { ...BOOKING, payment: null }
    const container = await mount()
    await open(container)
    const party = container.querySelector('#change-party') as HTMLSelectElement
    expect(party.disabled).toBe(false)
    expect(container.querySelector('#change-party-locked')).toBeNull()
  })
})
