// @vitest-environment jsdom

/**
 * The « Événements » section of the booking page, as a diner meets it.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. the section renders NOTHING while there is no event, and a card says what it is — title,
 *     time in the establishment's clock, price (« Gratuit » for nothing) — with the one action
 *     that fits its state: buy, be told, or the moment sales open;
 *  2. the seats left are a plain number, in a neutral voice: no urgency word and no alarm
 *     colour anywhere in the card's source or its rendering;
 *  3. buying shows the price, the terms in words and the hold BEFORE submitting, needs the two
 *     agreements, sends exactly what was typed and leaves for the payment page (paid) or the
 *     ticket (free);
 *  4. « Me prévenir » says in as many words that nothing is held, and records the notice version.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RESERVATION_EXPERIENCE_ALERT_NOTICE_VERSION } from '@be-yours/convex-schema'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  cards: undefined as unknown,
  quote: undefined as unknown,
  quoteArgs: [] as unknown[],
  push: vi.fn(),
  buy: vi.fn(),
  joinAlert: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: state.push }),
}))
vi.mock('convex/react', () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === 'skip') return undefined
    if (ref === 'getPublicConfig') return state.config
    if (ref === 'listPublic') return state.cards
    if (ref === 'getPurchaseQuote') {
      state.quoteArgs.push(args)
      return typeof state.quote === 'function'
        ? (state.quote as (args: unknown) => unknown)(args)
        : state.quote
    }
    return undefined
  },
  useMutation: (ref: string) => (ref === 'buy' ? state.buy : state.joinAlert),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservations: { getPublicConfig: 'getPublicConfig' },
    reservationExperiences: {
      listPublic: 'listPublic',
      getPurchaseQuote: 'getPurchaseQuote',
      buy: 'buy',
      joinAlert: 'joinAlert',
    },
  },
}))
vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'stores_1', store: null, storeCount: 1, isLoading: false }),
}))

const { default: ExperiencesSection } =
  await import('@/app/(storefront)/reservation/_components/ExperiencesSection')

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
  noticeVersion: 'v1',
  storeName: 'Chez Luigi',
  privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
}

const EVENT_START = Date.UTC(2027, 0, 15, 18, 30)
const EVENT_END = Date.UTC(2027, 0, 15, 21, 0)

function cardOf(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp_1',
    title: 'Soirée dégustation',
    description: 'Cinq vins, cinq assiettes, avec le sommelier.',
    imageUrl: 'https://img.example/soiree.jpg' as string | null,
    startsAt: EVENT_START,
    endsAt: EVENT_END,
    seats: 24,
    seatsLeft: 12,
    priceCents: 4_500,
    free: false,
    currency: 'EUR',
    state: 'on_sale',
    maxSeatsPerBooking: 6,
    cancellationCutoffHours: 48,
    salesOpensAt: null as number | null,
    salesClosesAt: null as number | null,
    ...overrides,
  }
}

const PAID_QUOTE = (args: unknown) => {
  const seats = (args as { seats: number }).seats
  return {
    state: 'on_sale',
    seatsLeft: 12,
    refusal: null,
    totalCents: 4_500 * seats,
    currency: 'EUR',
    free: false,
    lines: ["Annulation gratuite jusqu'à 48 h avant : les places sont remboursées en totalité."],
    consentLabel: `J'accepte de payer ${seats * 45},00 € maintenant pour ${seats} place(s).`,
    holdMinutes: 15,
    payable: true,
    providers: [
      { provider: 'stripe', label: 'Carte bancaire (Stripe)' },
      { provider: 'paypal', label: 'PayPal' },
    ],
  }
}

const FREE_QUOTE = {
  state: 'on_sale',
  seatsLeft: 12,
  refusal: null,
  totalCents: 0,
  currency: 'EUR',
  free: true,
}

beforeEach(() => {
  state.config = CONFIG
  state.cards = [cardOf()]
  state.quote = PAID_QUOTE
  state.quoteArgs = []
  state.push = vi.fn()
  state.buy = vi.fn(async () => ({
    reference: 'RES-2027-00031',
    manageToken: 'tok-ticket-1',
    status: 'pending_payment',
    holdExpiresAt: 1,
  }))
  state.joinAlert = vi.fn(async () => ({ joined: true }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<ExperiencesSection />)
  })
  return container
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const button = (c: HTMLElement, text: string | RegExp) =>
  [...c.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined

const purchaseForm = (c: HTMLElement) =>
  c.querySelector('form[aria-label^="Réserver des places"]') as HTMLFormElement | null
const alertForm = (c: HTMLElement) =>
  c.querySelector('form[aria-label^="Me prévenir"]') as HTMLFormElement | null

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function fillGuest(c: HTMLElement) {
  await type(c.querySelector('#exp-exp_1-name')!, 'Marie Dupont')
  await type(c.querySelector('#exp-exp_1-email')!, 'marie@example.fr')
  await type(c.querySelector('#exp-exp_1-phone')!, '0612345678')
}

describe('the section', () => {
  it('renders nothing while the list is empty, loading or the establishment is unknown', async () => {
    for (const scenario of [
      { cards: [] as unknown[] },
      { cards: undefined },
      { cards: [cardOf()], config: undefined },
    ]) {
      state.cards = scenario.cards
      state.config = 'config' in scenario ? scenario.config : CONFIG
      const container = await mount()
      expect(container.innerHTML).toBe('')
    }
  })

  it('is the anchor the e-mail alert links to, named by its heading', async () => {
    const container = await mount()
    const section = container.querySelector('section#events')!
    expect(section).not.toBeNull()
    expect(section.getAttribute('aria-labelledby')).toBe('experiences-title')
    expect(container.querySelector('#experiences-title')?.textContent).toBe('Événements')
  })

  it('scrolls to the anchor once the list has arrived, when the page was opened on it', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    window.location.hash = '#events'
    await mount()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    window.location.hash = ''
  })
})

describe('a card', () => {
  it('says what the event is, when, and what a seat costs', async () => {
    const container = await mount()
    const card = container.querySelector('article')!
    expect(card.querySelector('h3')?.textContent).toBe('Soirée dégustation')
    expect(card.querySelector('img')?.getAttribute('alt')).toBe('Soirée dégustation')
    // The establishment's clock, not the browser's: 19:30 in Paris, until 22:00.
    expect(card.textContent).toContain('vendredi 15 janvier 2027 à 19:30')
    expect(card.textContent).toContain("jusqu'à 22:00")
    expect(card.textContent).toContain('Cinq vins, cinq assiettes')
    expect(card.textContent).toMatch(/45,00\s€ par place/)
    expect(card.textContent).toContain("Annulation possible jusqu'à 48 h avant le début")
  })

  it('says the seats left as a plain number', async () => {
    const container = await mount()
    expect(container.querySelector('article')?.textContent).toContain('12 places restantes')
    state.cards = [cardOf({ seatsLeft: 1 })]
    const second = await mount()
    expect(second.querySelector('article')?.textContent).toContain('1 place restante')
  })

  it('says Gratuit for a free event, and draws no image when there is none', async () => {
    state.cards = [cardOf({ free: true, priceCents: 0, imageUrl: null })]
    const container = await mount()
    expect(container.querySelector('article')?.textContent).toContain('Gratuit')
    expect(container.querySelector('article')?.textContent).not.toContain('par place')
    expect(container.querySelector('img')).toBeNull()
  })

  it('offers « Réserver » when seats are on sale', async () => {
    const container = await mount()
    expect(button(container, /^Réserver/)).toBeDefined()
    expect(button(container, /Me prévenir/)).toBeUndefined()
  })

  it('says Complet and offers « Me prévenir » when sold out, with no seat count and no purchase', async () => {
    state.cards = [cardOf({ state: 'sold_out', seatsLeft: 0, maxSeatsPerBooking: 1 })]
    const container = await mount()
    const card = container.querySelector('article')!
    expect(card.textContent).toContain('Complet')
    expect(card.textContent).not.toContain('places restantes')
    expect(button(container, /^Réserver/)).toBeUndefined()
    expect(button(container, /^Me prévenir/)).toBeDefined()
  })

  it('says when sales open, in the establishment clock, and offers nothing to press', async () => {
    state.cards = [cardOf({ state: 'upcoming', salesOpensAt: Date.UTC(2027, 0, 4, 9, 0) })]
    const container = await mount()
    expect(container.querySelector('article')?.textContent).toContain(
      'Ventes ouvertes à partir du lundi 4 janvier 2027 à 10:00',
    )
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('the tone of a card', () => {
  const URGENCY =
    /plus que|derni[eè]res?\s+(places?|chances?)|vite\b|urgent|presque (complet|plus)|bient[oô]t (complet|épuisé)|ne tardez|d[ée]p[êe]chez|se vendent|part(ent)? vite|offre limit[ée]e|personnes regardent|en train de (regarder|consulter)|compte à rebours|hurry|only \d+ left|selling fast/i
  const ALARM =
    /text-(red|orange|amber|rose|yellow)|bg-(red|orange|amber|rose|yellow)|destructive|animate-|pulse|blink|countdown/
  // The shared button carries `aria-invalid:*-destructive` variants that never apply here: in
  // the render, only a colour class standing on its own counts.
  const ALARM_IN_RENDER =
    /(?:^|[\s"])(?:text|bg|border)-(?:red|orange|amber|rose|yellow|destructive)\b|animate-|pulse/

  it('uses no urgency word when few seats are left, in the render', async () => {
    for (const seatsLeft of [1, 2, 3, 5]) {
      state.cards = [cardOf({ seatsLeft })]
      const container = await mount()
      const card = container.querySelector('article')!
      expect(card.textContent, `seatsLeft ${seatsLeft}`).not.toMatch(URGENCY)
      expect(card.innerHTML, `seatsLeft ${seatsLeft}`).not.toMatch(ALARM_IN_RENDER)
    }
  })

  it('uses none in the source that draws it either', () => {
    for (const file of [
      'app/(storefront)/reservation/_components/ExperienceCard.tsx',
      'app/(storefront)/reservation/_components/ExperiencesSection.tsx',
      'app/(storefront)/reservation/_components/reservation-experiences.ts',
    ]) {
      const code = readFileSync(join(process.cwd(), file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n')
      expect(code, file).not.toMatch(URGENCY)
      expect(code, file).not.toMatch(ALARM)
    }
  })
})

describe('buying seats', () => {
  async function open(container: HTMLElement) {
    await click(button(container, /^Réserver/)!)
  }

  it('opens an inline form that offers up to the seats one purchase may take', async () => {
    const container = await mount()
    await open(container)
    const options = [...container.querySelectorAll<HTMLOptionElement>('#exp-exp_1-seats option')]
    expect(options.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(options[0]?.textContent).toBe('1 place')
    expect(button(container, /^Réserver/)).toBeUndefined()
    await click(button(container, 'Fermer')!)
    expect(purchaseForm(container)).toBeNull()
    expect(button(container, /^Réserver/)).toBeDefined()
  })

  it('shows the price, the terms and the hold before anything is sent, and follows the seats', async () => {
    const container = await mount()
    await open(container)
    const box = container.querySelector('[data-testid="experience-payment-box"]')!
    expect(box.textContent).toMatch(/45,00\s€/)
    expect(box.textContent).toContain('remboursées en totalité')
    expect(box.textContent).toContain('15 minutes')
    expect(box.textContent).toContain('Carte bancaire (Stripe), PayPal')
    await choose(container.querySelector('#exp-exp_1-seats')!, '3')
    expect(state.quoteArgs.at(-1)).toEqual({ experienceId: 'exp_1', seats: 3 })
    expect(container.querySelector('[data-testid="experience-payment-box"]')?.textContent).toMatch(
      /135,00\s€/,
    )
  })

  it('needs the privacy agreement AND the payment terms, and sends exactly what was typed', async () => {
    const container = await mount()
    await open(container)
    await choose(container.querySelector('#exp-exp_1-seats')!, '2')
    await fillGuest(container)
    await type(container.querySelector('#exp-exp_1-note')!, 'Un convive sans gluten')
    const submitButton = purchaseForm(container)!.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)
    await click(container.querySelector('#exp-exp_1-consent')!)
    expect(submitButton.disabled).toBe(true)
    await click(container.querySelector('#exp-exp_1-payment-consent')!)
    expect(submitButton.disabled).toBe(false)
    expect(submitButton.textContent).toBe('Continuer vers le paiement')

    await submit(purchaseForm(container)!)
    expect(state.buy).toHaveBeenCalledTimes(1)
    const payload = state.buy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload).toMatchObject({
      experienceId: 'exp_1',
      seats: 2,
      guest: { name: 'Marie Dupont', email: 'marie@example.fr', phone: '0612345678' },
      note: 'Un convive sans gluten',
      consentNoticeVersion: 'v1',
      paymentConsent: true,
    })
    expect(typeof payload.privacyNoticeVersion).toBe('string')
    expect(typeof payload.idempotencyKey).toBe('string')
    expect(payload).not.toHaveProperty('marketingOptInVersion')
    // A paid ticket leaves for the payment page.
    expect(state.push).toHaveBeenCalledWith('/reservation/payment/tok-ticket-1')
  })

  it('forgets the payment tick when the seats change: other seats, other sentence', async () => {
    const container = await mount()
    await open(container)
    await fillGuest(container)
    await click(container.querySelector('#exp-exp_1-consent')!)
    await click(container.querySelector('#exp-exp_1-payment-consent')!)
    const submitButton = purchaseForm(container)!.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement
    expect(submitButton.disabled).toBe(false)
    await choose(container.querySelector('#exp-exp_1-seats')!, '4')
    expect(submitButton.disabled).toBe(true)
  })

  it('confirms a free event at once and leaves for the ticket, with no payment box', async () => {
    state.cards = [cardOf({ free: true, priceCents: 0 })]
    state.quote = FREE_QUOTE
    state.buy = vi.fn(async () => ({
      reference: 'RES-2027-00032',
      manageToken: 'tok-ticket-2',
      status: 'confirmed',
    }))
    const container = await mount()
    await open(container)
    expect(container.querySelector('[data-testid="experience-payment-box"]')).toBeNull()
    expect(container.textContent).toContain('Cet événement est gratuit')
    await fillGuest(container)
    await click(container.querySelector('#exp-exp_1-consent')!)
    const submitButton = purchaseForm(container)!.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement
    expect(submitButton.textContent).toBe('Confirmer mes places')
    expect(submitButton.disabled).toBe(false)
    await submit(purchaseForm(container)!)
    expect(state.buy.mock.calls[0]![0]).not.toHaveProperty('paymentConsent')
    expect(state.push).toHaveBeenCalledWith('/reservation/manage/tok-ticket-2')
  })

  it('records the marketing choice only when the guest made it', async () => {
    const container = await mount()
    await open(container)
    await fillGuest(container)
    await click(container.querySelector('#exp-exp_1-consent')!)
    await click(container.querySelector('#exp-exp_1-payment-consent')!)
    await click(container.querySelector('#exp-exp_1-marketing')!)
    await submit(purchaseForm(container)!)
    expect(state.buy.mock.calls[0]![0]).toHaveProperty('marketingOptInVersion')
  })

  it("blocks and says why when the server's quote refuses these seats", async () => {
    state.quote = {
      ...PAID_QUOTE({ seats: 1 }),
      refusal: 'Il ne reste pas assez de places pour votre demande.',
    }
    const container = await mount()
    await open(container)
    await fillGuest(container)
    await click(container.querySelector('#exp-exp_1-consent')!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('pas assez de places')
    expect(
      (purchaseForm(container)!.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('says honestly when online payment is unavailable and offers no way to agree', async () => {
    state.quote = { ...PAID_QUOTE({ seats: 1 }), payable: false, providers: [] }
    const container = await mount()
    await open(container)
    expect(container.textContent).toContain("Le paiement en ligne n'est pas disponible")
    expect(container.querySelector('#exp-exp_1-payment-consent')).toBeNull()
  })

  it("shows the server's refusal in words and lets the guest retry", async () => {
    state.buy = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'experience_sold_out' } })
    })
    const container = await mount()
    await open(container)
    await fillGuest(container)
    await click(container.querySelector('#exp-exp_1-consent')!)
    await click(container.querySelector('#exp-exp_1-payment-consent')!)
    await submit(purchaseForm(container)!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('complet')
    expect(state.push).not.toHaveBeenCalled()
    expect(
      (purchaseForm(container)!.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('closes the form when the seats sell out under the guest, back to « Complet »', async () => {
    const container = await mount()
    await open(container)
    expect(purchaseForm(container)).not.toBeNull()
    state.cards = [cardOf({ state: 'sold_out', seatsLeft: 0 })]
    await act(async () => {
      mounted[0]!.root.render(<ExperiencesSection />)
    })
    expect(purchaseForm(container)).toBeNull()
    expect(container.textContent).toContain('Complet')
    expect(button(container, /^Me prévenir/)).toBeDefined()
  })
})

describe('« Me prévenir »', () => {
  const soldOut = () => [cardOf({ state: 'sold_out', seatsLeft: 0, maxSeatsPerBooking: 1 })]

  beforeEach(() => {
    state.cards = soldOut()
  })

  it('says before anything is typed that it is not a booking and nothing is held', async () => {
    const container = await mount()
    await click(button(container, /^Me prévenir/)!)
    const form = alertForm(container)!
    expect(form.textContent).toContain("Ce n'est pas une réservation : aucune place n'est gardée")
    expect(form.textContent).toContain('Aucune place ne vous est gardée')
  })

  it('needs the notice ticked, and sends the version of the wording on screen', async () => {
    const container = await mount()
    await click(button(container, /^Me prévenir/)!)
    await type(container.querySelector('#alert-exp_1-name')!, 'Marie Dupont')
    await type(container.querySelector('#alert-exp_1-email')!, 'marie@example.fr')
    await choose(container.querySelector('#alert-exp_1-party')!, '2')
    const form = alertForm(container)!
    const send = form.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await click(container.querySelector('#alert-exp_1-consent')!)
    expect(send.disabled).toBe(false)
    await submit(form)
    expect(state.joinAlert).toHaveBeenCalledWith({
      experienceId: 'exp_1',
      guest: { name: 'Marie Dupont', email: 'marie@example.fr' },
      partySize: 2,
      noticeVersion: RESERVATION_EXPERIENCE_ALERT_NOTICE_VERSION,
    })
  })

  it('confirms in as many words that nothing is held for the guest', async () => {
    const container = await mount()
    await click(button(container, /^Me prévenir/)!)
    await type(container.querySelector('#alert-exp_1-name')!, 'Marie Dupont')
    await type(container.querySelector('#alert-exp_1-email')!, 'marie@example.fr')
    await click(container.querySelector('#alert-exp_1-consent')!)
    await submit(alertForm(container)!)
    const done = container.querySelector('[role="status"]')!
    expect(done.textContent).toContain('vous serez prévenu(e)')
    expect(done.textContent).toContain("Aucune place n'est gardée pour vous")
    expect(done.textContent).toContain('un seul e-mail')
    expect(done.textContent).toContain('vendues à qui réserve en premier')
    expect(alertForm(container)).toBeNull()
  })

  it("shows the server's sentence when seats came back in the meantime", async () => {
    state.joinAlert = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'invalid_input',
          message:
            'Des places sont en vente pour ce nombre de personnes : vous pouvez les réserver directement.',
        },
      })
    })
    const container = await mount()
    await click(button(container, /^Me prévenir/)!)
    await type(container.querySelector('#alert-exp_1-name')!, 'Marie Dupont')
    await type(container.querySelector('#alert-exp_1-email')!, 'marie@example.fr')
    await click(container.querySelector('#alert-exp_1-consent')!)
    await submit(alertForm(container)!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'vous pouvez les réserver directement',
    )
  })

  it('names a party that may be too large when the server only says the input is invalid', async () => {
    state.joinAlert = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'invalid_input',
          message: 'Les informations de la réservation sont incomplètes ou invalides.',
        },
      })
    })
    const container = await mount()
    await click(button(container, /^Me prévenir/)!)
    await type(container.querySelector('#alert-exp_1-name')!, 'Marie Dupont')
    await type(container.querySelector('#alert-exp_1-email')!, 'marie@example.fr')
    await click(container.querySelector('#alert-exp_1-consent')!)
    await submit(alertForm(container)!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('nombre de places')
  })
})
