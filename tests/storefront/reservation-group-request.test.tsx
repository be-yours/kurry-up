// @vitest-environment jsdom

/**
 * The booking page for a large party, as a diner meets it.
 *
 * The party size decides the form: the ordinary booking up to `directMax`, a REQUEST the host
 * must accept from the group band, and a « contactez-nous » card above it. What is held here:
 *
 *  1. each size reaches the right form, the selector ends on a size that leads to the card, and
 *     a deployment without groups (`groups: null`) behaves the same way, minus the request;
 *  2. the request says plainly that nothing is confirmed, sends exactly what was typed with the
 *     versioned agreement, and ends on a screen that does not say « confirmée »;
 *  3. the card is never a dead end — a phone, an address, or the contact page;
 *  4. a refusal is said in words, and a slot taken in the meantime drops the choice.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  slots: undefined as unknown,
  availabilityArgs: [] as unknown[],
  quoteArgs: [] as unknown[],
  create: vi.fn(),
  requestGroup: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
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
    if (ref === 'getPaymentQuote') {
      state.quoteArgs.push(args)
      return { required: false }
    }
    if (ref === 'getAvailability') {
      state.availabilityArgs.push(args)
      return state.slots
    }
    return undefined
  },
  useMutation: (ref: string) => (ref === 'requestGroup' ? state.requestGroup : state.create),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservationPayments: { getPaymentQuote: 'getPaymentQuote' },
    reservations: {
      getPublicConfig: 'getPublicConfig',
      getAvailability: 'getAvailability',
      create: 'create',
    },
    reservationGroups: { requestGroup: 'requestGroup' },
  },
}))
vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'stores_1', store: null, storeCount: 1, isLoading: false }),
}))

const { default: ReservationContent } =
  await import('@/app/(storefront)/reservation/_components/ReservationContent')

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = Observer
})

const REVIEW_EXPIRES = Date.UTC(2027, 0, 12, 12, 0)

const CONFIG = {
  timezone: 'Europe/Paris',
  introText: null,
  policyText: null,
  noticeVersion: 'v1',
  maxPartySize: 8,
  maxHorizonDays: 365,
  autoConfirm: true,
  cancellationDeadlineHours: 2,
  rooms: [{ id: 'room_1', name: 'Terrasse' }],
  storeName: 'Chez Luigi',
  waitlistEnabled: false,
  waitlistOfferMinutes: 15,
  privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
  directMax: 9,
  groups: { minSize: 10, maxSize: 40, reviewHours: 48 },
  contact: { phone: '01 40 50 60 70', email: 'luigi@example.fr' },
}

const SLOTS = [
  { serviceId: 'svc_1', time: '19:00', startsAt: 1_800_000_000_000, available: true, reason: null },
  { serviceId: 'svc_1', time: '20:00', startsAt: 1_800_003_600_000, available: true, reason: null },
]

beforeEach(() => {
  state.config = CONFIG
  state.slots = SLOTS
  state.availabilityArgs = []
  state.quoteArgs = []
  state.create = vi.fn()
  state.requestGroup = vi.fn(async () => ({
    reference: 'RES-2027-00021',
    manageToken: 'tok-group-1',
    status: 'pending',
    reviewExpiresAt: REVIEW_EXPIRES,
  }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
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

const byText = (root: HTMLElement, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) as HTMLElement

const groupForm = (c: HTMLElement) =>
  c.querySelector('form[aria-labelledby="group-request-title"]') as HTMLFormElement | null

/** Party of `size`, on a date, with the 19:00 slot picked. */
async function pick(container: HTMLElement, size: number, time = '19:00') {
  await choose(container.querySelector('#party')!, String(size))
  await type(container.querySelector('#date')!, '2027-01-15')
  if (time) await click(byText(container, 'button', time))
}

async function fillRequest(container: HTMLElement) {
  await type(container.querySelector('#gr-name')!, 'Marie Dupont')
  await type(container.querySelector('#gr-email')!, 'marie@example.fr')
  await type(container.querySelector('#gr-phone')!, '0612345678')
}

async function submitRequest(container: HTMLElement) {
  await act(async () => {
    groupForm(container)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('which form a party meets', () => {
  it('keeps the ordinary form up to the direct maximum', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 9)
    expect(container.querySelector('#name')).not.toBeNull()
    expect(container.querySelector('#gr-name')).toBeNull()
    expect(container.textContent).not.toContain('Demande de groupe')
    expect(container.querySelector('fieldset legend')?.textContent).toContain('Convives')
  })

  it('offers every size up to the group maximum, then one « more than » size', async () => {
    const container = await mount(<ReservationContent />)
    const options = [...container.querySelectorAll<HTMLOptionElement>('#party option')]
    expect(options[0]?.value).toBe('1')
    expect(options[39]?.value).toBe('40')
    expect(options.at(-1)?.value).toBe('41')
    expect(options.at(-1)?.textContent).toBe('Plus de 40 personnes')
  })

  it('turns a party from the group band into a request, said plainly', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    // The slots are asked for THIS party: the server answers with the group engine.
    expect(state.availabilityArgs.at(-1)).toMatchObject({ date: '2027-01-15', partySize: 14 })
    expect(container.textContent).toContain("14 personnes, c'est une demande")
    expect(groupForm(container)).not.toBeNull()
    expect(container.querySelector('#name')).toBeNull()
    expect(container.textContent).toContain("Rien n'est confirmé")
    expect(container.textContent).toContain('2 jours')
    // No payment step in a request, and no area wish (the host seats a group).
    expect(state.quoteArgs).toHaveLength(0)
    expect(container.textContent).not.toContain('Zone souhaitée')
    expect(container.textContent).not.toContain('Un acompte est demandé')
  })

  it('does not look for a waitlist for a request, even on a full day', async () => {
    state.config = { ...CONFIG, waitlistEnabled: true }
    state.slots = [{ ...SLOTS[0]!, available: false, reason: 'no_table' }]
    const container = await mount(<ReservationContent />)
    await pick(container, 14, '')
    expect(container.textContent).not.toContain('Me prévenir si une table se libère')
    // A way on instead of a dead end.
    expect(container.querySelector('[data-testid="contact-card"]')).not.toBeNull()
  })
})

describe('above every band', () => {
  it('shows the contact card with a phone and an address, and looks up no slot', async () => {
    const container = await mount(<ReservationContent />)
    await choose(container.querySelector('#party')!, '41')
    await type(container.querySelector('#date')!, '2027-01-15')
    const card = container.querySelector('[data-testid="contact-card"]')!
    expect(card.textContent).toContain('plus de 40 personnes')
    expect(card.querySelector('a[href="tel:0140506070"]')?.textContent).toContain('01 40 50 60 70')
    expect(card.querySelector('a[href^="mailto:luigi@example.fr"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Horaire')
    expect(state.availabilityArgs).toHaveLength(0)
    expect(groupForm(container)).toBeNull()
    expect(container.querySelector('button[type="submit"]')).toBeNull()
  })

  it('shows only what exists: an address alone', async () => {
    state.config = { ...CONFIG, contact: { phone: null, email: 'luigi@example.fr' } }
    const container = await mount(<ReservationContent />)
    await choose(container.querySelector('#party')!, '41')
    const card = container.querySelector('[data-testid="contact-card"]')!
    expect(card.querySelector('a[href^="tel:"]')).toBeNull()
    expect(card.querySelector('a[href^="mailto:"]')).not.toBeNull()
  })

  it('points to the contact page when the establishment has neither', async () => {
    state.config = { ...CONFIG, contact: { phone: null, email: null } }
    const container = await mount(<ReservationContent />)
    await choose(container.querySelector('#party')!, '41')
    const card = container.querySelector('[data-testid="contact-card"]')!
    expect(card.querySelector('a[href="/contact"]')).not.toBeNull()
    expect(card.textContent).toContain("l'adresse indiquée")
  })

  it('treats a deployment without groups the same way, past the ordinary ceiling', async () => {
    state.config = { ...CONFIG, maxPartySize: 8, directMax: 8, groups: null }
    const container = await mount(<ReservationContent />)
    const options = [...container.querySelectorAll<HTMLOptionElement>('#party option')]
    expect(options.at(-2)?.value).toBe('8')
    expect(options.at(-1)?.textContent).toBe('Plus de 8 personnes')
    await choose(container.querySelector('#party')!, '9')
    expect(container.querySelector('[data-testid="contact-card"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Demande de groupe')
    expect(state.availabilityArgs).toHaveLength(0)
  })

  it('still reads a configuration that predates the groups', async () => {
    const { directMax, groups, contact, ...old } = CONFIG
    void directMax
    void groups
    void contact
    state.config = old
    const container = await mount(<ReservationContent />)
    const options = [...container.querySelectorAll<HTMLOptionElement>('#party option')]
    expect(options.at(-2)?.value).toBe('8')
    await choose(container.querySelector('#party')!, '9')
    expect(container.querySelector('[data-testid="contact-card"]')?.textContent).toContain(
      "l'adresse indiquée",
    )
  })
})

describe('sending a request', () => {
  it('will not send without the agreement', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    const submit = groupForm(container)!.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await click(container.querySelector('#gr-consent')!)
    expect(submit.disabled).toBe(false)
  })

  it('sends what was typed with the versioned agreement and no payment', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 14, '20:00')
    await fillRequest(container)
    await type(container.querySelector('#gr-occasion')!, 'Anniversaire de Paul')
    await type(container.querySelector('#gr-note')!, 'Deux personnes sans gluten')
    await type(container.querySelector('#gr-budget')!, 'Menu unique, 45 € par personne')
    await type(container.querySelector('#gr-message')!, 'Nous arriverons ensemble.')
    await click(container.querySelector('#gr-consent')!)
    await submitRequest(container)

    expect(state.requestGroup).toHaveBeenCalledTimes(1)
    const payload = state.requestGroup.mock.calls[0]![0] as Record<string, unknown>
    expect(payload).toMatchObject({
      storeId: 'stores_1',
      date: '2027-01-15',
      serviceId: 'svc_1',
      startsAt: 1_800_003_600_000,
      partySize: 14,
      guest: { name: 'Marie Dupont', email: 'marie@example.fr', phone: '0612345678' },
      note: 'Deux personnes sans gluten',
      occasion: 'Anniversaire de Paul',
      budget: 'Menu unique, 45 € par personne',
      message: 'Nous arriverons ensemble.',
      consentNoticeVersion: 'v1',
    })
    expect(typeof payload.privacyNoticeVersion).toBe('string')
    expect(typeof payload.idempotencyKey).toBe('string')
    // Marketing is never ticked for the guest, and a request owes nothing.
    expect(payload).not.toHaveProperty('marketingOptInVersion')
    expect(payload).not.toHaveProperty('paymentConsent')
    expect(state.create).not.toHaveBeenCalled()
  })

  it('records the marketing choice only when the guest made it', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    await click(container.querySelector('#gr-consent')!)
    await click(container.querySelector('#gr-marketing')!)
    await submitRequest(container)
    expect(state.requestGroup.mock.calls[0]![0]).toHaveProperty('marketingOptInVersion')
    expect(container.textContent).toContain('un e-mail vous demande de confirmer')
  })

  it('ends on a screen that says nothing is confirmed, until when the place is held, and where to follow it', async () => {
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    await click(container.querySelector('#gr-consent')!)
    await submitRequest(container)

    expect(container.querySelector('h1')?.textContent).toBe('Demande envoyée')
    expect(container.textContent).toContain("n'est pas encore confirmée")
    expect(container.textContent).not.toContain('Réservation confirmée')
    expect(container.textContent).toContain('RES-2027-00021')
    // In the restaurant's clock: 13:00 in Paris in January.
    expect(container.textContent).toContain('12 janvier 2027 à 13:00')
    expect(container.textContent).toContain('expire')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/reservation/manage/tok-group-1',
    )
    expect(container.querySelector('form')).toBeNull()
  })

  it('keeps one idempotency key for a double tap', async () => {
    let release: () => void = () => {}
    state.requestGroup = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              reference: 'RES-2027-00021',
              manageToken: 'tok-group-1',
              status: 'pending',
              reviewExpiresAt: REVIEW_EXPIRES,
            })
        }),
    )
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    await click(container.querySelector('#gr-consent')!)
    await submitRequest(container)
    await submitRequest(container)
    expect(state.requestGroup).toHaveBeenCalledTimes(1)
    await act(async () => release())
  })

  it('says a refusal in its own words and lets the guest retry', async () => {
    state.requestGroup = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'group_not_offered' } })
    })
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    await click(container.querySelector('#gr-consent')!)
    await submitRequest(container)
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('ne prend pas de demande de groupe')
    expect(groupForm(container)).not.toBeNull()
    expect(
      (groupForm(container)!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('drops the choice and keeps the reason when the slot was taken in the meantime', async () => {
    state.requestGroup = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'slot_unavailable',
          message: "Ce créneau n'est plus disponible. Choisissez un autre horaire.",
        },
      })
    })
    const container = await mount(<ReservationContent />)
    await pick(container, 14)
    await fillRequest(container)
    await click(container.querySelector('#gr-consent')!)
    await submitRequest(container)
    expect(groupForm(container)).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "n'est plus disponible",
    )
    expect(
      [...container.querySelectorAll('button[aria-pressed]')].every(
        (b) => b.getAttribute('aria-pressed') === 'false',
      ),
    ).toBe(true)
  })
})
