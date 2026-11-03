// @vitest-environment jsdom

/**
 * What a guest reads and agrees to around a booking, and the waitlist as they meet it.
 *
 * Three things are held here, because each is the kind of rule that breaks quietly:
 *
 *  1. the privacy notice is on the form, quotes the retention the server sent (never a
 *     period the sweep does not enforce), and its VERSION travels with the booking;
 *  2. the marketing box is unchecked by default, never ticked for the guest, and only
 *     sends its wording version when the guest ticked it;
 *  3. « Me prévenir » exists only when the owner turned the waitlist on AND the day is
 *     full, promises no table, and the guest's own page tells the truth about each state
 *     of the entry — in particular it never shows an offer the server says has lapsed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  quote: { required: false } as unknown,
  push: vi.fn(),
  config: undefined as unknown,
  slots: undefined as unknown,
  booking: undefined as unknown,
  entry: undefined as unknown,
  create: vi.fn(),
  join: vi.fn(),
  claim: vi.fn(),
  leave: vi.fn(),
  cancel: vi.fn(),
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
    if (ref === 'getPaymentQuote') return state.quote
    if (ref === 'getAvailability') return state.slots
    if (ref === 'getByToken') return state.booking
    if (ref === 'wl.getByToken') return state.entry
    return undefined
  },
  useMutation: (ref: string) =>
    ref === 'create'
      ? state.create
      : ref === 'wl.join'
        ? state.join
        : ref === 'wl.claim'
          ? state.claim
          : ref === 'wl.leave'
            ? state.leave
            : state.cancel,
}))

vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservationPayments: { getPaymentQuote: 'getPaymentQuote' },
    reservations: {
      getPublicConfig: 'getPublicConfig',
      getAvailability: 'getAvailability',
      getByToken: 'getByToken',
      create: 'create',
      cancelByToken: 'cancelByToken',
      reconfirmByToken: 'reconfirm',
      getAvailabilityByToken: 'getAvailabilityByToken',
      modifyByToken: 'modify',
    },
    reservationWaitlist: {
      join: 'wl.join',
      getByToken: 'wl.getByToken',
      claim: 'wl.claim',
      leave: 'wl.leave',
    },
  },
}))

vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'stores_1', store: null, storeCount: 1, isLoading: false }),
}))

const { default: ReservationContent } =
  await import('@/app/(storefront)/reservation/_components/ReservationContent')
const { default: WaitlistContent } =
  await import('@/app/(storefront)/reservation/waitlist/[token]/_components/WaitlistContent')
const { default: ManageReservationContent } =
  await import('@/app/(storefront)/reservation/manage/[token]/_components/ManageReservationContent')

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
  policyText: 'Au-delà de 15 minutes de retard, la table peut être réattribuée.',
  noticeVersion: 'v1',
  maxPartySize: 6,
  maxHorizonDays: 60,
  autoConfirm: true,
  cancellationDeadlineHours: 2,
  rooms: [] as Array<{ id: string; name: string }>,
  storeName: 'Chez Luigi',
  waitlistEnabled: true,
  waitlistOfferMinutes: 15,
  privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
}

const open = (time: string, startsAt: number) => ({
  serviceId: 'svc_1',
  time,
  startsAt,
  available: true,
  reason: null,
  preference: null,
  roomName: null,
})
const full = (time: string, startsAt: number) => ({
  serviceId: 'svc_1',
  time,
  startsAt,
  available: false,
  reason: 'no_table',
  preference: null,
  roomName: null,
})

const OPEN_SLOTS = [open('19:00', 1_800_000_000_000), open('20:00', 1_800_003_600_000)]
const FULL_SLOTS = [
  full('19:00', 1_800_000_000_000),
  full('19:30', 1_800_001_800_000),
  full('20:00', 1_800_003_600_000),
]

beforeEach(() => {
  state.quote = { required: false }
  state.push = vi.fn()
  state.config = CONFIG
  state.slots = OPEN_SLOTS
  state.booking = undefined
  state.entry = undefined
  state.create = vi.fn(async () => ({
    reference: 'RES-2026-00007',
    manageToken: 'tok-bbbbbbbb',
    status: 'confirmed',
  }))
  // The answer carries no token: the guest's own link goes to their address by e-mail.
  state.join = vi.fn(async () => ({ joined: true }))
  state.claim = vi.fn(async () => ({ claimed: true, booking: {} }))
  state.leave = vi.fn(async () => ({ left: true }))
  state.cancel = vi.fn(async () => ({ status: 'cancelled_by_guest' }))
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

async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byText = (root: HTMLElement, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) as HTMLElement

async function bookAt(container: HTMLElement, time: string) {
  await type(container.querySelector('#date')!, '2027-01-15')
  await click(byText(container, 'button', time))
  await type(container.querySelector('#name')!, 'Marie Dupont')
  await type(container.querySelector('#email')!, 'marie@example.fr')
  await type(container.querySelector('#phone')!, '0612345678')
}

const submitForm = (container: HTMLElement) =>
  act(async () => {
    ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })

describe('the privacy notice on the booking form', () => {
  it('is shown before the guest agrees, and quotes the retention the server sent', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    const text = container.textContent ?? ''
    expect(text).toContain('Chez Luigi utilise votre nom, votre e-mail et votre téléphone')
    expect(text).toContain('conservées 3 ans après votre repas')
    expect(text).toContain('effacée 3 jours après le repas')
    expect(text).toContain('CNIL')
    // The conditions the owner wrote sit beside it, not in place of it.
    expect(text).toContain('la table peut être réattribuée')
  })

  it('quotes a shorter window when the owner set one', async () => {
    state.config = { ...CONFIG, privacy: { ...CONFIG.privacy, retentionDays: 365 } }
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    expect(container.textContent).toContain('conservées un an après votre repas')
  })

  it('records which version the guest saw with the booking', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    await click(container.querySelector('#consent')!)
    await submitForm(container)
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        consentNoticeVersion: 'v1',
        privacyNoticeVersion: 'fr-2026-10',
      }),
    )
  })

  it('needs the agreement, which is one box: the conditions and the notice together', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    const label = container.querySelector('label[for="consent"]')!.textContent
    expect(label).toContain("J'accepte les conditions de réservation")
    expect(label).toContain('utilise mes données')
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })
})

describe('the marketing box', () => {
  it('is unchecked, optional, and says it starts a confirmation rather than subscribing', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    const box = container.querySelector('#marketing') as HTMLElement
    expect(box.getAttribute('data-state')).toBe('unchecked')
    const text = container.textContent ?? ''
    expect(text).toContain('Je souhaite recevoir les nouvelles et offres de Chez Luigi par e-mail')
    expect(text).toContain('Facultatif')
    expect(text).toContain('sans confirmation, rien ne vous sera envoyé')
  })

  it('does not stop a booking, and sends no marketing version when left alone', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    await click(container.querySelector('#consent')!)
    await submitForm(container)
    expect(state.create).toHaveBeenCalledTimes(1)
    expect(state.create.mock.calls[0]![0]).not.toHaveProperty('marketingOptInVersion')
    expect(container.textContent).not.toContain('confirmer votre inscription')
  })

  it('sends its wording version when ticked, and tells the guest a confirmation is coming', async () => {
    const container = await mount(<ReservationContent />)
    await bookAt(container, '20:00')
    await click(container.querySelector('#consent')!)
    await click(container.querySelector('#marketing')!)
    await submitForm(container)
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({ marketingOptInVersion: 'fr-2026-10' }),
    )
    expect(container.textContent).toContain('un e-mail vous demande de confirmer votre inscription')
  })
})

describe('« Me prévenir si une table se libère »', () => {
  async function fullDay() {
    state.slots = FULL_SLOTS
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    return container
  }

  it('is offered on a full day, and promises no table', async () => {
    const container = await fullDay()
    const text = container.textContent ?? ''
    expect(text).toContain('Me prévenir si une table se libère')
    expect(text).toContain("Ce n'est pas une réservation")
    expect(text).toContain("aucune table n'est gardée")
  })

  it('is not offered while the owner has not turned it on', async () => {
    state.config = { ...CONFIG, waitlistEnabled: false }
    const container = await fullDay()
    expect(container.textContent).not.toContain('Me prévenir')
  })

  it('is not offered before a date is chosen', async () => {
    state.slots = FULL_SLOTS
    const container = await mount(<ReservationContent />)
    expect(container.textContent).not.toContain('Me prévenir')
  })

  it('is not offered when a table is free', async () => {
    state.slots = OPEN_SLOTS
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    expect(container.textContent).not.toContain('Me prévenir')
  })

  it('is not offered on a day with no service at all', async () => {
    state.slots = []
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    expect(container.textContent).toContain("Aucun service n'est proposé")
    expect(container.textContent).not.toContain('Me prévenir')
  })

  it('asks for a name, an address and the agreement, and a phone only if offered', async () => {
    const container = await fullDay()
    await click(byText(container, 'button', 'Demander à être prévenu'))
    const submit = byText(container, 'button', 'Me prévenir') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await type(container.querySelector('#wl-name')!, 'Marie Dupont')
    await type(container.querySelector('#wl-email')!, 'pas-une-adresse')
    await click(container.querySelector('#wl-consent')!)
    expect(submit.disabled).toBe(true)
    await type(container.querySelector('#wl-email')!, 'marie@example.fr')
    expect(submit.disabled).toBe(false)
    // A phone that is typed has to be one; left empty it is fine.
    await type(container.querySelector('#wl-phone')!, '12')
    expect(submit.disabled).toBe(true)
    await type(container.querySelector('#wl-phone')!, '')
    expect(submit.disabled).toBe(false)
  })

  it('quotes how long the request is kept, and what the one e-mail will be', async () => {
    const container = await fullDay()
    await click(byText(container, 'button', 'Demander à être prévenu'))
    const text = container.textContent ?? ''
    expect(text).toContain('un seul e-mail')
    expect(text).toContain('valable un temps limité')
    expect(text).toContain('7 jours après la date souhaitée')
  })

  it('sends the wish, the party, the area and the notice version, then says the link is on its way by e-mail', async () => {
    const container = await fullDay()
    await click(byText(container, 'button', 'Demander à être prévenu'))
    await type(container.querySelector('#wl-name')!, 'Marie Dupont')
    await type(container.querySelector('#wl-email')!, 'marie@example.fr')
    await type(container.querySelector('#wl-from')!, '19:30')
    await type(container.querySelector('#wl-to')!, '20:00')
    await click(container.querySelector('#wl-consent')!)
    await click(byText(container, 'button', 'Me prévenir'))

    expect(state.join).toHaveBeenCalledWith({
      storeId: 'stores_1',
      guest: { name: 'Marie Dupont', email: 'marie@example.fr' },
      partySize: 2,
      date: '2027-01-15',
      earliest: '19:30',
      latest: '20:00',
      privacyNoticeVersion: 'fr-2026-10',
    })
    expect(container.textContent).toContain("Vous êtes sur la liste d'attente")
    // Nobody is handed a credential on screen: the page only says where the link goes.
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain("est envoyé à l'adresse indiquée")
  })

  it('completes a half window with the other end of the day, and refuses a reversed one', async () => {
    const container = await fullDay()
    await click(byText(container, 'button', 'Demander à être prévenu'))
    await type(container.querySelector('#wl-name')!, 'Marie')
    await type(container.querySelector('#wl-email')!, 'marie@example.fr')
    await click(container.querySelector('#wl-consent')!)
    await type(container.querySelector('#wl-from')!, '19:30')
    await click(byText(container, 'button', 'Me prévenir'))
    expect(state.join).toHaveBeenCalledWith(
      expect.objectContaining({ earliest: '19:30', latest: '20:00' }),
    )
  })

  it('explains a refusal and keeps what the guest typed', async () => {
    state.join = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: { code: 'invalid_input', message: 'Une table correspond déjà à votre demande.' },
      })
    })
    const container = await fullDay()
    await click(byText(container, 'button', 'Demander à être prévenu'))
    await type(container.querySelector('#wl-name')!, 'Marie')
    await type(container.querySelector('#wl-email')!, 'marie@example.fr')
    await click(container.querySelector('#wl-consent')!)
    await click(byText(container, 'button', 'Me prévenir'))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('correspond déjà')
    expect((container.querySelector('#wl-name') as HTMLInputElement).value).toBe('Marie')
  })
})

describe('the guest’s waitlist page', () => {
  const NOW = 1_800_000_000_000
  const ENTRY = {
    status: 'waiting',
    date: '2027-01-15',
    partySize: 2,
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    earliest: null as string | null,
    latest: null as string | null,
    offer: null as null | { startsAt: number; expiresAt: number; roomName: string | null },
    lapsed: false,
    needsPhone: false,
    manageToken: null as string | null,
    reservationRef: null as string | null,
    policyText: 'Au-delà de 15 minutes de retard, la table peut être réattribuée.',
    noticeVersion: 'v1',
    autoConfirm: true,
    cancellationDeadlineHours: 2,
    privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })

  it('says the link is dead when the server knows no such request', async () => {
    state.entry = null
    const container = await mount(<WaitlistContent />)
    expect(container.textContent).toContain('Demande introuvable')
  })

  it('says what is true while waiting: nothing is held, and an e-mail will come', async () => {
    state.entry = { ...ENTRY, earliest: '19:30', latest: '20:30' }
    const container = await mount(<WaitlistContent />)
    const text = container.textContent ?? ''
    expect(text).toContain("Aucune table n'est gardée pour vous")
    expect(text).toContain('de 19:30 à 20:30')
    expect(text).toContain('vendredi 15 janvier 2027')
    expect(byText(container, 'button', 'Retirer ma demande')).toBeDefined()
    expect(byText(container, 'button', 'Réserver cette table')).toBeUndefined()
  })

  it('withdraws the request on a click and says what happens to the data', async () => {
    state.entry = ENTRY
    const container = await mount(<WaitlistContent />)
    await click(byText(container, 'button', 'Retirer ma demande'))
    expect(state.leave).toHaveBeenCalledWith({ token: 'tok-waitlist-1' })
    expect(container.textContent).toContain('Demande retirée')
    expect(container.textContent).toContain('7 jours après la date souhaitée')
  })

  describe('with a table offered', () => {
    const OFFERED = {
      ...ENTRY,
      status: 'offered',
      offer: { startsAt: NOW + 3_600_000, expiresAt: NOW + 10 * 60_000, roomName: 'Terrasse' },
    }

    it('shows the table, the area and until when it is kept', async () => {
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      const text = container.textContent ?? ''
      expect(text).toContain("Une table s'est libérée")
      expect(text).toContain('zone « Terrasse »')
      expect(text).toContain('encore 10 min')
      expect(text).toContain('proposée à la personne suivante')
    })

    it('will not book without the agreement, then books with the server’s own notice version', async () => {
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      const take = byText(container, 'button', 'Réserver cette table') as HTMLButtonElement
      expect(take.disabled).toBe(true)
      await click(container.querySelector('#consent')!)
      expect(take.disabled).toBe(false)
      await click(take)
      expect(state.claim).toHaveBeenCalledWith({
        token: 'tok-waitlist-1',
        consentNoticeVersion: 'v1',
        privacyNoticeVersion: 'fr-2026-10',
      })
    })

    it('has the marketing box unchecked, and sends its version only when ticked', async () => {
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      expect(container.querySelector('#marketing')!.getAttribute('data-state')).toBe('unchecked')
      await click(container.querySelector('#consent')!)
      await click(container.querySelector('#marketing')!)
      await click(byText(container, 'button', 'Réserver cette table'))
      expect(state.claim).toHaveBeenCalledWith(
        expect.objectContaining({ marketingOptInVersion: 'fr-2026-10' }),
      )
    })

    it('asks for a phone number only when the guest gave none, and sends it', async () => {
      state.entry = { ...OFFERED, needsPhone: true }
      const container = await mount(<WaitlistContent />)
      await click(container.querySelector('#consent')!)
      const take = byText(container, 'button', 'Réserver cette table') as HTMLButtonElement
      expect(take.disabled).toBe(true)
      await type(container.querySelector('#phone')!, '0612345678')
      expect(take.disabled).toBe(false)
      await click(take)
      expect(state.claim).toHaveBeenCalledWith(expect.objectContaining({ phone: '0612345678' }))
    })

    it('says so when the server refuses, and keeps the button for another try', async () => {
      state.claim = vi.fn(async () => {
        throw Object.assign(new Error('refused'), {
          data: { code: 'offer_unavailable', message: "Cette proposition n'est plus valable." },
        })
      })
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      await click(container.querySelector('#consent')!)
      await click(byText(container, 'button', 'Réserver cette table'))
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('plus valable')
    })

    it('says the table is gone when the server could not give it after all', async () => {
      state.claim = vi.fn(async () => ({ claimed: false }))
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      await click(container.querySelector('#consent')!)
      await click(byText(container, 'button', 'Réserver cette table'))
      expect(container.textContent).toContain("La table n'est plus disponible")
    })

    it('turns the offer down on « Non merci », which lets the table go on', async () => {
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      await click(byText(container, 'button', 'Non merci'))
      expect(state.leave).toHaveBeenCalledWith({ token: 'tok-waitlist-1' })
      expect(container.textContent).toContain('Demande retirée')
    })

    it('stops showing the offer the moment its time has passed, even if the server has not caught up', async () => {
      state.entry = OFFERED
      const container = await mount(<WaitlistContent />)
      expect(byText(container, 'button', 'Réserver cette table')).toBeDefined()
      await act(async () => {
        vi.setSystemTime(NOW + 11 * 60_000)
        vi.advanceTimersByTime(15_000)
      })
      expect(container.textContent).toContain('La proposition a expiré')
      expect(byText(container, 'button', 'Réserver cette table')).toBeUndefined()
    })
  })

  it('never shows an offer the server says has lapsed', async () => {
    state.entry = { ...ENTRY, status: 'offered', lapsed: true, offer: null }
    const container = await mount(<WaitlistContent />)
    expect(container.textContent).toContain('La proposition a expiré')
    expect(byText(container, 'button', 'Réserver cette table')).toBeUndefined()
  })

  it('sends a guest who took the table on to their booking', async () => {
    state.entry = {
      ...ENTRY,
      status: 'booked',
      manageToken: 'tok-manage-1',
      reservationRef: 'RES-2026-00042',
    }
    const container = await mount(<WaitlistContent />)
    expect(container.textContent).toContain('Table réservée')
    expect(container.textContent).toContain('RES-2026-00042')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/reservation/manage/tok-manage-1',
    )
  })

  it('says a pending booking still waits for the restaurant', async () => {
    state.entry = { ...ENTRY, status: 'booked', autoConfirm: false, reservationRef: 'RES-1' }
    const container = await mount(<WaitlistContent />)
    expect(container.textContent).toContain('doit valider votre demande')
  })
})

describe('« Données personnelles » on the guest’s booking page', () => {
  const BOOKING = {
    reference: 'RES-2026-00007',
    status: 'confirmed',
    startsAt: 1_800_000_000_000,
    endsAt: 1_800_005_400_000,
    partySize: 4,
    guestName: 'Marie Dupont',
    guestNote: null,
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    storeAddress: null,
    canCancel: true,
    canModify: false,
    changeNeedsValidation: false,
    canReconfirm: false,
    canAddToCalendar: false,
    reconfirmedAt: null,
    revision: 0,
    serviceId: 'svc_1',
    maxPartySize: 6,
    maxHorizonDays: 60,
    rooms: [] as Array<{ id: string; name: string }>,
    roomPreference: null,
    storePhone: '01 02 03 04 05',
    storeEmail: 'bonjour@chez-luigi.example',
    policyText: 'Au-delà de 15 minutes de retard, la table peut être réattribuée.',
    retentionDays: 1095,
    noteDays: 3,
    privacyNoticeVersion: 'fr-2026-10',
  }

  it('says what is kept, for how long, how to ask, and how to reach the restaurant', async () => {
    state.booking = BOOKING
    const container = await mount(<ManageReservationContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('Données personnelles')
    expect(text).toContain('Chez Luigi conserve votre nom, votre e-mail, votre téléphone')
    expect(text).toContain('pendant 3 ans après le repas')
    expect(text).toContain('contactez Chez Luigi en indiquant le numéro de cette réservation')
    expect(text).toContain('01 02 03 04 05')
    expect(text).toContain('bonjour@chez-luigi.example')
    expect(text).toContain('fr-2026-10')
  })

  it('shows the cancellation wording again, and nothing about money', async () => {
    state.booking = BOOKING
    const container = await mount(<ManageReservationContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('Conditions de réservation')
    expect(text).toContain('la table peut être réattribuée')
    expect(text).not.toMatch(/acompte|garantie|prélèv|€/i)
  })

  it('draws no empty block when there is no policy and no way to reach the restaurant', async () => {
    state.booking = { ...BOOKING, policyText: null, storePhone: null, storeEmail: null }
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).not.toContain('Conditions de réservation')
    expect(container.textContent).not.toContain('Pour les joindre')
    expect(container.textContent).toContain('Données personnelles')
  })
})
