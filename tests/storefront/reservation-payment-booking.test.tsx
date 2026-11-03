// @vitest-environment jsdom

/**
 * What a guest reads and agrees to BEFORE a booking that owes money is made — on the booking
 * form and on the waitlist claim page.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. a booking that owes nothing looks exactly as it did: no payment box, the usual button,
 *     nothing sent that the server did not ask for;
 *  2. a deposit shows its amount, the terms in words, the hold and a REQUIRED box worded by
 *     the server — and nothing is sent without it;
 *  3. a guarantee says « Aucun débit maintenant » and the most it can cost;
 *  4. when what the house requires cannot be taken right now, the page says so and offers no
 *     way to book: a booking is never made without paying what is owed;
 *  5. the tick belongs to the wording it was given for — another slot, another sentence, a
 *     new tick;
 *  6. a booking born awaiting its payment sends the guest to the payment page and nowhere else.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  slots: undefined as unknown,
  entry: undefined as unknown,
  quoteFor: ((_args: unknown) => ({ required: false })) as (args: unknown) => unknown,
  quoteArgs: [] as unknown[],
  push: vi.fn(),
  create: vi.fn(),
  claim: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-waitlist-1' }),
  useRouter: () => ({ push: state.push }),
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
    if (ref === 'getPublicConfig') return state.config
    if (ref === 'getAvailability') return state.slots
    if (ref === 'getPaymentQuote') {
      state.quoteArgs.push(args)
      return state.quoteFor(args)
    }
    if (ref === 'wl.getByToken') return state.entry
    return undefined
  },
  useMutation: (ref: string) => (ref === 'create' ? state.create : state.claim),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservations: {
      getPublicConfig: 'getPublicConfig',
      getAvailability: 'getAvailability',
      create: 'create',
    },
    reservationPayments: { getPaymentQuote: 'getPaymentQuote' },
    reservationWaitlist: { getByToken: 'wl.getByToken', claim: 'wl.claim', leave: 'wl.leave' },
  },
}))
vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'stores_1', store: null, storeCount: 1, isLoading: false }),
}))

const { default: ReservationContent } =
  await import('@/app/(storefront)/reservation/_components/ReservationContent')
const { default: WaitlistContent } =
  await import('@/app/(storefront)/reservation/waitlist/[token]/_components/WaitlistContent')

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = Observer
})

const CONFIG = {
  timezone: 'Europe/Paris',
  introText: null,
  policyText: null,
  noticeVersion: 'v1',
  maxPartySize: 6,
  maxHorizonDays: 60,
  autoConfirm: true,
  cancellationDeadlineHours: 2,
  rooms: [] as Array<{ id: string; name: string }>,
  storeName: 'Chez Luigi',
  waitlistEnabled: false,
  waitlistOfferMinutes: 15,
  privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
}

const SLOTS = [
  { serviceId: 'svc_1', time: '19:00', startsAt: 1_800_000_000_000, available: true, reason: null },
  { serviceId: 'svc_1', time: '20:00', startsAt: 1_800_003_600_000, available: true, reason: null },
]

const DEPOSIT_QUOTE = {
  required: true,
  kind: 'deposit',
  currency: 'EUR',
  depositCents: 4000,
  noShowFeeCents: 0,
  freeCancellationHours: 48,
  holdMinutes: 15,
  lines: [
    'Un acompte de 40,00 € est demandé pour confirmer la réservation. Il est payé en ligne maintenant.',
    "Annulation gratuite jusqu'à 2 jours avant la réservation : l'acompte est alors remboursé en totalité.",
  ],
  consentLabel:
    "Je comprends qu'un acompte de 40,00 € est demandé pour confirmer cette réservation, et j'accepte les conditions de remboursement ci-dessus.",
  payable: true,
  providers: [{ provider: 'stripe', label: 'Carte bancaire (Stripe)' }],
  defaultProvider: 'stripe',
}

const GUARANTEE_QUOTE = {
  ...DEPOSIT_QUOTE,
  kind: 'guarantee',
  depositCents: 0,
  noShowFeeCents: 3000,
  lines: [
    "Aucun montant n'est débité maintenant : votre carte est enregistrée pour garantir la réservation.",
  ],
  consentLabel:
    "Je donne mon accord pour que l'établissement débite ma carte, en cas d'absence, de frais allant jusqu'à 30,00 €, et j'accepte les conditions ci-dessus.",
}

beforeEach(() => {
  state.config = CONFIG
  state.slots = SLOTS
  state.entry = undefined
  state.quoteFor = () => ({ required: false })
  state.quoteArgs = []
  state.push = vi.fn()
  state.create = vi.fn(async () => ({
    reference: 'RES-2026-00007',
    manageToken: 'tok-pay',
    status: 'pending_payment',
    holdExpiresAt: 1_800_000_900_000,
  }))
  state.claim = vi.fn(async () => ({
    claimed: true,
    booking: { status: 'pending_payment', manageToken: 'tok-claimed' },
  }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.useRealTimers()
})

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  return container
}

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byText = (root: HTMLElement, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) as HTMLElement

const submitButton = (c: HTMLElement) =>
  c.querySelector('button[type="submit"]') as HTMLButtonElement

async function fillGuest(container: HTMLElement) {
  await type(container.querySelector('#name')!, 'Marie Dupont')
  await type(container.querySelector('#email')!, 'marie@example.fr')
  await type(container.querySelector('#phone')!, '0612345678')
}

/** Everything the form needs except the payment box. */
async function readyToBook(container: HTMLElement, time = '19:00') {
  await type(container.querySelector('#date')!, '2027-01-15')
  await click(byText(container, 'button', time))
  await fillGuest(container)
  await click(container.querySelector('#consent')!)
}

async function submit(container: HTMLElement) {
  await act(async () => {
    submitButton(container).form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
}

describe('a booking that owes nothing', () => {
  it('shows no payment box and keeps its usual button and request', async () => {
    state.create = vi.fn(async () => ({
      reference: 'RES-2026-00007',
      manageToken: 'tok-bbbbbbbb',
      status: 'confirmed',
    }))
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(container.querySelector('[data-testid="payment-box"]')).toBeNull()
    expect(submitButton(container).textContent).toBe('Confirmer la réservation')
    expect(submitButton(container).disabled).toBe(false)

    await submit(container)
    const sent = state.create.mock.calls[0]![0] as Record<string, unknown>
    expect('paymentConsent' in sent).toBe(false)
    expect(state.push).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Réservation confirmée')
  })

  it('waits for the quote before it can be sent: it cannot know yet what it agrees to', async () => {
    state.quoteFor = () => undefined
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(submitButton(container).disabled).toBe(true)
    expect(container.textContent).toContain('Vérification des conditions de paiement')
  })

  it('asks the server about the chosen slot and party, once a slot is chosen', async () => {
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    expect(state.quoteArgs).toHaveLength(0)
    await click(byText(container, 'button', '20:00'))
    expect(state.quoteArgs.at(-1)).toEqual({
      storeId: 'stores_1',
      serviceId: 'svc_1',
      partySize: 2,
      startsAt: 1_800_003_600_000,
    })
  })
})

describe('a booking that owes a deposit', () => {
  beforeEach(() => {
    state.quoteFor = () => DEPOSIT_QUOTE
  })

  it('shows the amount, the terms, the hold and a required box before anything is sent', async () => {
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    const box = container.querySelector('[data-testid="payment-box"]') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.textContent).toContain('Un acompte est demandé')
    expect(box.textContent).toMatch(/40,00\s€/)
    expect(box.textContent).toContain("Annulation gratuite jusqu'à 2 jours avant la réservation")
    expect(box.textContent).toContain('La table vous est gardée 15 minutes pour payer')
    expect(box.textContent).toContain(DEPOSIT_QUOTE.consentLabel)
    // Named by its heading, and the box is not ticked for the guest.
    expect(box.getAttribute('aria-labelledby')).toBe('payment-title')
    expect(container.querySelector('#payment-consent')?.getAttribute('aria-checked')).toBe('false')
  })

  it('will not send without the payment box ticked, even with every other agreement', async () => {
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(submitButton(container).textContent).toBe('Continuer vers le paiement')
    expect(submitButton(container).disabled).toBe(true)

    await click(container.querySelector('#payment-consent')!)
    expect(submitButton(container).disabled).toBe(false)

    await click(container.querySelector('#payment-consent')!)
    expect(submitButton(container).disabled).toBe(true)
  })

  it('records the agreement with the booking and goes to the payment page, not to a confirmation', async () => {
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    await click(container.querySelector('#payment-consent')!)
    await submit(container)

    expect(state.create).toHaveBeenCalledTimes(1)
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ paymentConsent: true }))
    expect(state.push).toHaveBeenCalledWith('/reservation/payment/tok-pay')
    expect(container.textContent).not.toContain('Réservation confirmée')
    // A second tap while the page opens cannot make a second booking.
    expect(submitButton(container).disabled).toBe(true)
  })

  it('does not call the booking confirmed in the recap: it is confirmed when the payment is received', async () => {
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(container.textContent).toContain('confirmée dès que votre paiement est reçu')
    expect(container.textContent).not.toContain('confirmée immédiatement')
    // The cancellation terms are the payment's own, in the box: no second, generic delay.
    expect(container.textContent).not.toContain("Annulation en ligne possible jusqu'à 2 h")
  })

  it('says a validated-by-hand house validates after the payment', async () => {
    state.config = { ...CONFIG, autoConfirm: false }
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(container.textContent).toContain(
      'Une fois votre paiement reçu, le restaurant doit valider',
    )
  })

  it('drops the tick when another slot changes what is owed, because the wording is different', async () => {
    state.quoteFor = (args) =>
      (args as { startsAt: number }).startsAt === 1_800_000_000_000
        ? DEPOSIT_QUOTE
        : {
            ...DEPOSIT_QUOTE,
            depositCents: 8000,
            consentLabel:
              "Je comprends qu'un acompte de 80,00 € est demandé pour confirmer cette réservation.",
          }
    const container = await mount(<ReservationContent />)
    await readyToBook(container, '19:00')
    await click(container.querySelector('#payment-consent')!)
    expect(submitButton(container).disabled).toBe(false)

    await click(byText(container, 'button', '20:00'))
    expect(container.textContent).toMatch(/80,00\s€/)
    expect(container.querySelector('#payment-consent')?.getAttribute('aria-checked')).toBe('false')
    expect(submitButton(container).disabled).toBe(true)
  })

  it("shows the server's refusal in its own words and stays on the form", async () => {
    state.create = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'payment_unavailable',
          message: "Le paiement demandé pour cette réservation n'est pas disponible en ce moment.",
        },
      })
    })
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    await click(container.querySelector('#payment-consent')!)
    await submit(container)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("n'est pas disponible")
    expect(state.push).not.toHaveBeenCalled()
    expect(submitButton(container).disabled).toBe(false)
  })
})

describe('a booking that owes a card guarantee', () => {
  it('says nothing is debited now, and the most a no-show can cost', async () => {
    state.quoteFor = () => GUARANTEE_QUOTE
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    const box = container.querySelector('[data-testid="payment-box"]') as HTMLElement
    expect(box.textContent).toContain('Une garantie par carte est demandée')
    expect(box.textContent).toContain('Aucun débit maintenant')
    expect(box.textContent).toMatch(/jusqu'à\s*30,00\s€/)
    expect(box.textContent).toContain(GUARANTEE_QUOTE.consentLabel)
    expect(box.textContent).not.toContain('à régler en ligne maintenant')
  })
})

describe('when what the house requires cannot be taken right now', () => {
  it('says so honestly and offers no way to book', async () => {
    state.quoteFor = () => ({
      ...DEPOSIT_QUOTE,
      payable: false,
      providers: [],
      defaultProvider: null,
    })
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    const alert = container.querySelector('[data-testid="payment-box"] [role="alert"]')
    expect(alert?.textContent).toContain("Le paiement en ligne n'est pas disponible en ce moment")
    expect(alert?.textContent).toContain('demande un acompte')
    expect(container.querySelector('#payment-consent')).toBeNull()
    expect(submitButton(container).disabled).toBe(true)
  })

  it('says the same for a guarantee, in its own words', async () => {
    state.quoteFor = () => ({
      ...GUARANTEE_QUOTE,
      payable: false,
      providers: [],
      defaultProvider: null,
    })
    const container = await mount(<ReservationContent />)
    await readyToBook(container)
    expect(container.querySelector('[data-testid="payment-box"]')?.textContent).toContain(
      "L'enregistrement de carte n'est pas disponible",
    )
    expect(submitButton(container).disabled).toBe(true)
  })
})

describe('the waitlist claim page', () => {
  const NOW = 1_800_000_000_000
  const ENTRY = {
    status: 'offered',
    date: '2027-01-15',
    partySize: 2,
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    earliest: null,
    latest: null,
    offer: { startsAt: NOW + 3_600_000, expiresAt: NOW + 10 * 60_000, roomName: null },
    lapsed: false,
    needsPhone: false,
    manageToken: null,
    reservationRef: null,
    policyText: null,
    noticeVersion: 'v1',
    autoConfirm: true,
    cancellationDeadlineHours: 2,
    privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
    payment: null as unknown,
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })

  const claimButton = (c: HTMLElement) =>
    [...c.querySelectorAll('button')].find((b) =>
      /^(Réserver cette table|Continuer vers le paiement)$/.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement

  it('keeps its usual button and request for a table that owes nothing', async () => {
    state.entry = { ...ENTRY, payment: { required: false } }
    const container = await mount(<WaitlistContent />)
    expect(container.querySelector('[data-testid="payment-box"]')).toBeNull()
    await click(container.querySelector('#consent')!)
    expect(claimButton(container).textContent).toBe('Réserver cette table')
    await click(claimButton(container))
    const sent = state.claim.mock.calls[0]![0] as Record<string, unknown>
    expect('paymentConsent' in sent).toBe(false)
  })

  it('shows the terms and the required box before the table can be taken', async () => {
    state.entry = { ...ENTRY, payment: DEPOSIT_QUOTE }
    const container = await mount(<WaitlistContent />)
    expect(container.querySelector('[data-testid="payment-box"]')?.textContent).toContain(
      'Un acompte est demandé',
    )
    await click(container.querySelector('#consent')!)
    expect(claimButton(container).textContent).toBe('Continuer vers le paiement')
    expect(claimButton(container).disabled).toBe(true)

    await click(container.querySelector('#payment-consent')!)
    expect(claimButton(container).disabled).toBe(false)
  })

  it('claims with the agreement and goes to the payment page when the booking awaits its payment', async () => {
    state.entry = { ...ENTRY, payment: DEPOSIT_QUOTE }
    const container = await mount(<WaitlistContent />)
    await click(container.querySelector('#consent')!)
    await click(container.querySelector('#payment-consent')!)
    await click(claimButton(container))

    expect(state.claim).toHaveBeenCalledWith(expect.objectContaining({ paymentConsent: true }))
    expect(state.push).toHaveBeenCalledWith('/reservation/payment/tok-claimed')
    // Not « Table réservée »: nothing is booked until the payment is received.
    expect(container.textContent).toContain('Redirection vers le paiement')
    expect(container.textContent).not.toContain('Table réservée')
  })

  it('does not go to the payment page for a booking that is already taken', async () => {
    state.claim = vi.fn(async () => ({
      claimed: true,
      booking: { status: 'confirmed', manageToken: 'tok-claimed' },
    }))
    state.entry = { ...ENTRY, payment: { required: false } }
    const container = await mount(<WaitlistContent />)
    await click(container.querySelector('#consent')!)
    await click(claimButton(container))
    expect(state.push).not.toHaveBeenCalled()
  })

  it('offers no way to claim when the payment cannot be taken right now', async () => {
    state.entry = {
      ...ENTRY,
      payment: { ...DEPOSIT_QUOTE, payable: false, providers: [], defaultProvider: null },
    }
    const container = await mount(<WaitlistContent />)
    await click(container.querySelector('#consent')!)
    expect(container.querySelector('[data-testid="payment-box"] [role="alert"]')).not.toBeNull()
    expect(claimButton(container).disabled).toBe(true)
  })
})
