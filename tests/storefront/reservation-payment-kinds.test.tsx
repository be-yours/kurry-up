// @vitest-environment jsdom

/**
 * The payment page for a group the host accepted and for seats at an event.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. terms set AFTER the guest's request (a group accepted with a deposit) are shown in a
 *     required box before the provider buttons, nothing starts without the tick, and the tick
 *     travels as `consent: true` — while a booking whose terms were agreed at the form has no
 *     such box and sends no `consent` at all;
 *  2. the terms the page lists are the server's `termLines`;
 *  3. a ticket's page speaks of seats and of the event, never of a deposit or a table, and its
 *     way back after paying is the ticket, not the booking form;
 *  4. a group, like a ticket, is confirmed by the payment itself, whatever the house's usual
 *     confirmation mode.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  page: undefined as unknown,
  booking: undefined as unknown,
  start: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-pay-1' }),
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
    if (ref === 'p.getPaymentPage') return state.page
    if (ref === 'r.getByToken') return state.booking
    return undefined
  },
  useAction: (ref: string) => (ref === 'a.start' ? state.start : state.verify),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservationPayments: { getPaymentPage: 'p.getPaymentPage' },
    reservations: { getByToken: 'r.getByToken' },
    reservationPaymentActions: {
      startReservationPayment: 'a.start',
      verifyReservationPayment: 'a.verify',
    },
  },
}))

const { default: PaymentContent } =
  await import('@/app/(storefront)/reservation/payment/[token]/_components/PaymentContent')

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const STRIPE = { provider: 'stripe', label: 'Carte bancaire (Stripe)' }
const GROUP_LINES = [
  'Un acompte de 200,00 € est demandé pour confirmer la réservation. Il est payé en ligne maintenant.',
  "Annulation gratuite jusqu'à 2 jours avant la réservation : l'acompte est alors remboursé en totalité.",
]
const TICKET_LINES = [
  "Annulation gratuite jusqu'à 48 h avant : les places sont remboursées en totalité.",
]
const GROUP_CONSENT =
  "J'accepte de payer un acompte de 200,00 € maintenant pour confirmer mon groupe."

function pageOf(overrides: Record<string, unknown> = {}) {
  const status = (overrides.status as string | undefined) ?? 'pending_payment'
  return {
    reference: 'RES-2027-00031',
    status,
    serverNow: NOW,
    startsAt: Date.UTC(2027, 0, 15, 19, 0),
    partySize: 14,
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    autoConfirm: false,
    amountDueCents: 20_000,
    providers: [STRIPE],
    defaultProvider: 'stripe',
    canPay: true,
    manageToken: 'tok-pay-1',
    kind: 'group',
    purpose: 'group',
    consentLabel: GROUP_CONSENT as string | null,
    termLines: GROUP_LINES,
    payment: {
      kind: 'deposit',
      currency: 'EUR',
      depositCents: 20_000,
      noShowFeeCents: 0,
      freeCancellationHours: 48,
      lines: GROUP_LINES,
      state: 'awaiting',
      heldCents: 0,
      refundedCents: 0,
      feeChargedCents: 0,
      awaiting: status === 'pending_payment',
      holdExpiresAt: NOW + 20 * MINUTE,
      holdLapsed: false,
    },
    ...overrides,
  }
}

function ticketPage(overrides: Record<string, unknown> = {}) {
  const { payment, ...rest } = overrides
  const base = pageOf({
    kind: 'experience',
    purpose: 'experience',
    consentLabel: null,
    termLines: TICKET_LINES,
    partySize: 3,
    amountDueCents: 13_500,
    startsAt: Date.UTC(2027, 0, 15, 18, 30),
    ...rest,
  })
  return {
    ...base,
    payment: { ...base.payment, depositCents: 13_500, lines: TICKET_LINES, ...(payment as object) },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeAll(() => {
  // The checkbox primitive measures itself; jsdom has no ResizeObserver.
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = Observer
})

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  })
  vi.setSystemTime(NOW)
  state.page = pageOf()
  state.booking = {
    experience: { title: 'Soirée dégustation' },
  }
  state.start = vi.fn(async () => ({ redirectUrl: 'https://checkout.stripe.test/c/pay_123' }))
  state.verify = vi.fn(async () => ({ outcome: 'unknown' }))
  vi.stubGlobal('location', {
    ...window.location,
    origin: 'https://chezluigi.example',
    assign: vi.fn(),
  })
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<PaymentContent returned={null} />)
  })
  return container
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

const payButton = (c: HTMLElement) => c.querySelector('button[type="submit"]') as HTMLButtonElement
const heading = (c: HTMLElement) => c.querySelector('h1')?.textContent ?? ''
const link = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)

describe('terms the guest has not agreed to yet', () => {
  it('shows the sentence in a required box BEFORE the provider button', async () => {
    const container = await mount()
    const box = container.querySelector('#payment-agreement')!
    expect(box).not.toBeNull()
    expect(container.querySelector('label[for="payment-agreement"]')?.textContent).toBe(
      GROUP_CONSENT,
    )
    // Before the button, in document order.
    expect(
      box.compareDocumentPosition(payButton(container)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(payButton(container).disabled).toBe(true)
  })

  it('lists the terms the server sent', async () => {
    const container = await mount()
    for (const line of GROUP_LINES) expect(container.textContent).toContain(line)
  })

  it('starts nothing without the tick, then pays with `consent: true`', async () => {
    const container = await mount()
    await submit(container)
    expect(state.start).not.toHaveBeenCalled()
    await click(container.querySelector('#payment-agreement')!)
    expect(payButton(container).disabled).toBe(false)
    await submit(container)
    expect(state.start).toHaveBeenCalledTimes(1)
    expect(state.start).toHaveBeenCalledWith({
      token: 'tok-pay-1',
      provider: 'stripe',
      returnOrigin: 'https://chezluigi.example',
      consent: true,
    })
  })

  it("shows the server's refusal in words if it still asks for the agreement", async () => {
    state.start = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'payment_consent_required' } })
    })
    const container = await mount()
    await click(container.querySelector('#payment-agreement')!)
    await submit(container)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Cochez la case')
  })

  it('shows no box, and sends no `consent`, when the terms were agreed at the form', async () => {
    state.page = pageOf({ consentLabel: null, kind: null, purpose: 'booking' })
    const container = await mount()
    expect(container.querySelector('#payment-agreement')).toBeNull()
    expect(payButton(container).disabled).toBe(false)
    await submit(container)
    expect(state.start.mock.calls[0]![0]).not.toHaveProperty('consent')
  })

  it('still reads a page from a server that sends neither field', async () => {
    const { consentLabel, termLines, kind, purpose, ...old } = pageOf()
    void consentLabel
    void termLines
    void kind
    void purpose
    state.page = old
    const container = await mount()
    expect(container.querySelector('#payment-agreement')).toBeNull()
    for (const line of GROUP_LINES) expect(container.textContent).toContain(line)
  })
})

describe('a group the host accepted', () => {
  it('says the deposit is the group’s, and that the payment confirms it, whatever the house mode', async () => {
    const container = await mount()
    expect(heading(container)).toBe("Régler l'acompte de votre groupe")
    expect(container.textContent).toContain(
      'Votre réservation est confirmée dès que le paiement est reçu',
    )
    expect(container.textContent).not.toContain('le restaurant doit valider votre demande')
    expect(container.textContent).toContain('14 personnes')
  })
})

describe('seats at an event', () => {
  beforeEach(() => {
    state.page = ticketPage()
  })

  it('speaks of seats, names the event and holds the seats, not a table', async () => {
    const container = await mount()
    expect(heading(container)).toBe('Régler vos places')
    expect(container.textContent).toContain('Soirée dégustation')
    expect(container.textContent).toContain('3 places')
    expect(container.textContent).not.toContain('Convives')
    expect(container.textContent).toMatch(/135,00\s€/)
    expect(container.textContent).toContain('pour 3 places, à régler maintenant pour les confirmer')
    expect(container.textContent).toContain('Vos places vous sont gardées encore')
    expect(container.textContent).not.toContain('La table vous est gardée')
    expect(container.textContent).not.toContain("d'acompte")
    expect(container.textContent).toContain(
      'Vos places sont confirmées dès que le paiement est reçu',
    )
    for (const line of TICKET_LINES) expect(container.textContent).toContain(line)
  })

  it('needs no agreement here: it was given with the purchase', async () => {
    const container = await mount()
    expect(container.querySelector('#payment-agreement')).toBeNull()
    expect(payButton(container).disabled).toBe(false)
  })

  it('confirms the seats and leads to the ticket once paid', async () => {
    state.page = ticketPage({
      status: 'confirmed',
      payment: { state: 'paid', heldCents: 13_500, awaiting: false },
    })
    const container = await mount()
    expect(heading(container)).toBe('Places confirmées')
    expect(container.textContent).toContain('Vos places sont payées')
    expect(container.textContent).toContain('Places payées')
    expect(container.textContent).toContain('Vos places sont réservées')
    expect(link(container, 'Voir mes places')?.getAttribute('href')).toBe(
      '/reservation/manage/tok-pay-1',
    )
  })

  it('leads back to the events, not the table form, when the hold lapses', async () => {
    state.page = ticketPage({ status: 'expired' })
    const container = await mount()
    expect(heading(container)).toBe('Le délai est dépassé, les places ont été libérées')
    expect(link(container, 'Voir les événements')?.getAttribute('href')).toBe('/reservation#events')
  })

  it('says seats ended without a payment, in seats', async () => {
    state.page = ticketPage({ status: 'cancelled_by_restaurant' })
    const container = await mount()
    expect(heading(container)).toBe('Ces places ne sont plus à régler')
    expect(container.textContent).toContain("L'établissement a dû annuler ces places")
    expect(link(container, 'Voir les événements')).toBeDefined()
    expect(link(container, 'Voir mes places')).toBeDefined()
  })
})
