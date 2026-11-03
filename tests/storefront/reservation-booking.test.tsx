// @vitest-environment jsdom

/**
 * The booking form and the guest's manage page, as a diner meets them.
 *
 * The server decides what is bookable (`computeSlots`) and this page only draws
 * it, so these tests hold the drawing to the rules a diner relies on: only open
 * slots can be picked, nothing is sent without the agreement, a slot taken in
 * the meantime is explained rather than swallowed, and the link in the guest's
 * hands shows the booking and cancels it only while the server says it may.
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
  tokenSlots: undefined as unknown,
  tokenSlotArgs: [] as unknown[],
  availabilityArgs: [] as unknown[],
  create: vi.fn(),
  cancel: vi.fn(),
  reconfirm: vi.fn(),
  modify: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-aaaaaaaa' }),
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
    if (ref === 'getAvailability') {
      state.availabilityArgs.push(args)
      return state.slots
    }
    if (ref === 'getByToken') return state.booking
    if (ref === 'getAvailabilityByToken') {
      state.tokenSlotArgs.push(args)
      return state.tokenSlots
    }
    return undefined
  },
  useMutation: (ref: string) =>
    ref === 'create'
      ? state.create
      : ref === 'reconfirm'
        ? state.reconfirm
        : ref === 'modify'
          ? state.modify
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
  },
}))

vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'stores_1', store: null, storeCount: 1, isLoading: false }),
}))

const { default: ReservationContent } =
  await import('@/app/(storefront)/reservation/_components/ReservationContent')
const { default: ManageReservationContent } =
  await import('@/app/(storefront)/reservation/manage/[token]/_components/ManageReservationContent')

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
  waitlistEnabled: false,
  waitlistOfferMinutes: 15,
  privacy: { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 },
}

const SLOTS = [
  { serviceId: 'svc_1', time: '19:00', startsAt: 1_800_000_000_000, available: true, reason: null },
  {
    serviceId: 'svc_1',
    time: '19:30',
    startsAt: 1_800_001_800_000,
    available: false,
    reason: 'no_table',
  },
  { serviceId: 'svc_1', time: '20:00', startsAt: 1_800_003_600_000, available: true, reason: null },
]

beforeEach(() => {
  state.quote = { required: false }
  state.push = vi.fn()
  state.config = CONFIG
  state.slots = SLOTS
  state.booking = undefined
  state.tokenSlots = undefined
  state.tokenSlotArgs = []
  state.availabilityArgs = []
  state.modify = vi.fn(async () => ({ changed: true, status: 'confirmed' }))
  state.create = vi.fn(async () => ({
    reference: 'RES-2026-00007',
    manageToken: 'tok-bbbbbbbb',
    status: 'confirmed',
  }))
  state.cancel = vi.fn(async () => ({ status: 'cancelled_by_guest' }))
  state.reconfirm = vi.fn(async () => ({ reconfirmedAt: 1_799_999_000_000 }))
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

/** Type into a controlled input the way a browser does. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
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

async function fillGuest(container: HTMLElement) {
  await type(container.querySelector('#name')!, 'Marie Dupont')
  await type(container.querySelector('#email')!, 'marie@example.fr')
  await type(container.querySelector('#phone')!, '0612345678')
}

describe('the booking page', () => {
  it('says so when the book is not open, rather than showing a form that cannot work', async () => {
    state.config = null
    const container = await mount(<ReservationContent />)
    expect(container.textContent).toContain('Réservation indisponible')
    expect(container.querySelector('form')).toBeNull()
  })

  it('offers only the open slots, and nothing to choose before a date', async () => {
    const container = await mount(<ReservationContent />)
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(0)

    await type(container.querySelector('#date')!, '2027-01-15')
    const times = [...container.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent)
    expect(times).toEqual(['19:00', '20:00'])
  })

  it('says the day is full instead of leaving an empty picker', async () => {
    state.slots = [{ ...SLOTS[1]! }]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    expect(container.textContent).toContain('complet')
  })

  it('will not send without the agreement, then books and shows the number and the link', async () => {
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '20:00'))
    await fillGuest(container)

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    await click(container.querySelector('#consent')!)
    expect(submit.disabled).toBe(false)

    await act(async () => {
      submit.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(state.create).toHaveBeenCalledTimes(1)
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: 'stores_1',
        date: '2027-01-15',
        serviceId: 'svc_1',
        startsAt: 1_800_003_600_000,
        partySize: 2,
        consentNoticeVersion: 'v1',
        guest: { name: 'Marie Dupont', email: 'marie@example.fr', phone: '0612345678' },
      }),
    )
    expect(container.textContent).toContain('Réservation confirmée')
    expect(container.textContent).toContain('RES-2026-00007')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/reservation/manage/tok-bbbbbbbb',
    )
  })

  it('says what the button is waiting for, and ties the sentence to the button', async () => {
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '20:00'))
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    const hint = () => container.querySelector('[data-testid="booking-submit-hint"]')

    // Nothing typed yet: every missing thing is named, in the order of the form.
    expect(submit.disabled).toBe(true)
    expect(hint()?.textContent).toBe(
      "Pour continuer, il manque : votre nom, votre e-mail, votre téléphone et la case d'acceptation des conditions de réservation.",
    )
    expect(submit.getAttribute('aria-describedby')).toBe(hint()?.id)

    // Only the agreement is left: the sentence shrinks to it, and never says more than is true.
    await fillGuest(container)
    expect(hint()?.textContent).toBe(
      "Pour continuer, il manque : la case d'acceptation des conditions de réservation.",
    )
    await type(container.querySelector('#email')!, 'marie@')
    expect(hint()?.textContent).toContain('une adresse e-mail valide')

    // Everything given: no sentence, no dangling description, an enabled button.
    await type(container.querySelector('#email')!, 'marie@example.fr')
    await click(container.querySelector('#consent')!)
    expect(submit.disabled).toBe(false)
    expect(hint()).toBeNull()
    expect(submit.hasAttribute('aria-describedby')).toBe(false)
  })

  it('books the service the guest picked when two open at the same minute', async () => {
    state.slots = [
      {
        serviceId: 'svc_salle',
        time: '19:00',
        startsAt: 1_800_000_000_000,
        available: true,
        reason: null,
      },
      {
        serviceId: 'svc_terrasse',
        time: '19:00',
        startsAt: 1_800_000_000_000,
        available: true,
        reason: null,
      },
    ]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    const buttons = [...container.querySelectorAll('button[aria-pressed]')] as HTMLElement[]
    expect(buttons).toHaveLength(2)
    await click(buttons[1]!)
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false')

    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'svc_terrasse' }),
    )
  })

  it('still books where crypto.randomUUID is missing, as on a plain-HTTP preview', async () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const container = await mount(<ReservationContent />)
      await type(container.querySelector('#date')!, '2027-01-15')
      await click(byText(container, 'button', '19:00'))
      await fillGuest(container)
      await click(container.querySelector('#consent')!)
      await act(async () => {
        ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      )
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    }
  })

  it('tells a validated-by-hand booking apart from a confirmed one', async () => {
    state.config = { ...CONFIG, autoConfirm: false }
    state.create = vi.fn(async () => ({
      reference: 'RES-2026-00008',
      manageToken: 'tok-bbbbbbbb',
      status: 'pending',
    }))
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '19:00'))
    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(container.textContent).toContain('Demande envoyée')
    expect(container.textContent).not.toContain('Réservation confirmée')
  })

  it('explains a slot taken in the meantime and drops the choice', async () => {
    state.create = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'slot_unavailable',
          message: "Ce créneau n'est plus disponible. Choisissez un autre horaire.",
        },
      })
    })
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '19:00'))
    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    // The choice is dropped so the guest picks again, and the reason stays on screen.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "n'est plus disponible",
    )
    expect(container.querySelector('#name')).toBeNull()
    expect(container.textContent).not.toContain('Réservation confirmée')
  })
})

describe('the manage page', () => {
  const BOOKING = {
    reference: 'RES-2026-00007',
    status: 'confirmed',
    startsAt: 1_800_000_000_000,
    endsAt: 1_800_005_400_000,
    partySize: 4,
    guestName: 'Marie Dupont',
    guestNote: 'Chaise haute',
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    storeAddress: '1 rue de la Paix, 75002 Paris',
    canCancel: true,
    canModify: true,
    changeNeedsValidation: false,
    canReconfirm: true,
    canAddToCalendar: true,
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
  }

  it('says the link is dead when the server knows no such booking', async () => {
    state.booking = null
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain('Réservation introuvable')
  })

  it('shows the booking, asks before cancelling, then cancels', async () => {
    state.booking = BOOKING
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain('RES-2026-00007')
    expect(container.textContent).toContain('Chaise haute')
    expect(container.textContent).toContain('Chez Luigi')

    await click(byText(container, 'button', 'Annuler ma réservation'))
    expect(state.cancel).not.toHaveBeenCalled()
    await click(byText(container, 'button', 'Oui, annuler'))
    expect(state.cancel).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa' })
  })

  it('offers no button once the server says the deadline has passed', async () => {
    state.booking = { ...BOOKING, canCancel: false }
    const container = await mount(<ManageReservationContent />)
    expect(byText(container, 'button', 'Annuler ma réservation')).toBeUndefined()
    expect(container.textContent).toContain("Le délai d'annulation en ligne est dépassé")
    expect(container.textContent).toContain('contactez directement le restaurant')
  })

  it('offers nothing to cancel on a booking that is already over', async () => {
    state.booking = { ...BOOKING, status: 'cancelled_by_guest', canCancel: false }
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain('Vous avez annulé cette réservation')
    expect(container.textContent).not.toContain('délai d')
  })

  it('lets the guest say they are coming, in one click', async () => {
    state.booking = BOOKING
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).not.toContain('votre venue est confirmée')

    await click(byText(container, 'button', 'Je serai là'))
    expect(state.reconfirm).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa' })
  })

  it('thanks a guest who has already confirmed instead of asking again', async () => {
    state.booking = { ...BOOKING, reconfirmedAt: 1_799_999_000_000, canReconfirm: true }
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain('Merci, votre venue est confirmée.')
    expect(byText(container, 'button', 'Je serai là')).toBeUndefined()
  })

  it('does not ask a booking that cannot be honoured any more to confirm', async () => {
    state.booking = { ...BOOKING, status: 'pending', canReconfirm: false, canCancel: true }
    const container = await mount(<ManageReservationContent />)
    expect(byText(container, 'button', 'Je serai là')).toBeUndefined()
  })

  it('shows why a confirmation failed and keeps the button', async () => {
    state.booking = BOOKING
    state.reconfirm = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'transition_refused',
          message: 'Cette réservation ne peut plus être confirmée.',
        },
      })
    })
    const container = await mount(<ManageReservationContent />)
    await click(byText(container, 'button', 'Je serai là'))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('ne peut plus')
    expect(byText(container, 'button', 'Je serai là')).toBeDefined()
  })

  it('hands the guest a calendar file built from the booking on the page', async () => {
    state.booking = BOOKING
    const created: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:calendar'
    })
    const revokeObjectURL = vi.fn()
    // `URL` itself stays the real one: only these two members are swapped, and
    // put back afterwards, so no other test in the file sees the stubs.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const container = await mount(<ManageReservationContent />)
      await click(byText(container, 'button', 'Ajouter à mon agenda'))

      expect(clicked).toHaveBeenCalledTimes(1)
      expect(created[0].type).toContain('text/calendar')
      const file = await created[0].text()
      expect(file).toContain('UID:RES-2026-00007@reservation')
      expect(file).toContain('DTSTART:20270115T080000Z')
      expect(file).toContain('LOCATION:Chez Luigi\\, 1 rue de la Paix\\, 75002 Paris')
      // Not revoked in the same breath as the click, but not kept for ever either.
      expect(revokeObjectURL).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:calendar'), {
        timeout: 3000,
      })
    } finally {
      clicked.mockRestore()
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    }
  })

  it('offers no calendar file for a table that is not held', async () => {
    state.booking = { ...BOOKING, status: 'pending', canAddToCalendar: false }
    const container = await mount(<ManageReservationContent />)
    expect(byText(container, 'button', 'Ajouter à mon agenda')).toBeUndefined()
  })
})

describe('the area preference on the booking page', () => {
  const ROOMS = [
    { id: 'room_salle', name: 'Salle' },
    { id: 'room_terrasse', name: 'Terrasse' },
  ]
  const slot = (time: string, startsAt: number, extra: Record<string, unknown> = {}) => ({
    serviceId: 'svc_1',
    time,
    startsAt,
    available: true,
    reason: null,
    preference: null,
    roomName: null,
    ...extra,
  })
  const radios = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLInputElement>('input[name="room-preference"]'),
  ]

  it('offers no choice of area when there is none to make', async () => {
    const container = await mount(<ReservationContent />)
    expect(radios(container)).toHaveLength(0)
    expect(container.textContent).not.toContain('Zone souhaitée')
  })

  it('offers « Peu importe » first and selected, then each area', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    const container = await mount(<ReservationContent />)
    expect(radios(container).map((r) => r.parentElement?.textContent)).toEqual([
      'Peu importe',
      'Salle',
      'Terrasse',
    ])
    expect(radios(container).map((r) => r.checked)).toEqual([true, false, false])
    // A group with a name, so a screen reader announces what the choice is about.
    expect(container.querySelector('fieldset legend')?.textContent).toBeDefined()
    expect(container.textContent).toContain('Zone souhaitée')
  })

  it('asks the server for the area chosen, and for none by default', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    expect(state.availabilityArgs.at(-1)).not.toHaveProperty('roomPreference')

    await click(radios(container)[2]!)
    expect(state.availabilityArgs.at(-1)).toMatchObject({ roomPreference: 'room_terrasse' })
    expect(radios(container)[2]!.checked).toBe(true)
  })

  it('drops a slot already chosen when the area changes: it was picked for another area', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [slot('19:00', 1_800_000_000_000)]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '19:00'))
    expect(container.querySelector('#name')).not.toBeNull()
    await click(radios(container)[1]!)
    expect(container.querySelector('#name')).toBeNull()
  })

  it('names the other area on a slot the preferred one cannot give, and says so above the slots', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [
      slot('19:00', 1_800_000_000_000, { preference: 'met', roomName: 'Terrasse' }),
      slot('20:00', 1_800_003_600_000, { preference: 'other', roomName: 'Salle' }),
    ]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(radios(container)[2]!)

    const buttons = [...container.querySelectorAll('button[aria-pressed]')]
    expect(buttons[0]!.textContent).toBe('19:00')
    expect(buttons[1]!.textContent).toBe('20:00zone « Salle »')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'La zone « Terrasse » est complète à certains horaires',
    )
  })

  it('says the whole day is in the other area, rather than hiding it', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [slot('19:00', 1_800_000_000_000, { preference: 'other', roomName: 'Salle' })]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(radios(container)[2]!)
    expect(container.textContent).toContain('est complète à ces horaires')
    expect(container.textContent).toContain('19:00')
  })

  it('books the other area only as an explicit choice, the recap saying so first', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [slot('19:00', 1_800_000_000_000, { preference: 'other', roomName: 'Salle' })]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(radios(container)[2]!)
    await click(byText(container, 'button', '19:00zone « Salle »'))
    expect(container.querySelector('#recap')!.parentElement!.textContent).toContain(
      'La zone « Terrasse » est complète à cette heure : votre table est dans la zone « Salle ».',
    )

    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({ roomPreference: 'room_terrasse', acceptOtherRoom: true }),
    )
  })

  it('sends the preference without the acceptance when the area is the one asked for', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [slot('19:00', 1_800_000_000_000, { preference: 'met', roomName: 'Terrasse' })]
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(radios(container)[2]!)
    await click(byText(container, 'button', '19:00'))
    expect(container.querySelector('#recap')!.parentElement!.textContent).toContain(
      'Zone : « Terrasse »',
    )
    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    const sent = state.create.mock.calls[0]![0] as Record<string, unknown>
    expect(sent.roomPreference).toBe('room_terrasse')
    expect(sent).not.toHaveProperty('acceptOtherRoom')
  })

  it('sends no preference for a diner who chose none, even with areas on offer', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(byText(container, 'button', '19:00'))
    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    const sent = state.create.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).not.toHaveProperty('roomPreference')
    expect(sent).not.toHaveProperty('acceptOtherRoom')
  })

  it('explains an area that filled up in the meantime and drops the choice', async () => {
    state.config = { ...CONFIG, rooms: ROOMS }
    state.slots = [slot('19:00', 1_800_000_000_000, { preference: 'met', roomName: 'Terrasse' })]
    state.create = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'area_unavailable',
          message: "La zone choisie n'est plus disponible à cette heure.",
        },
      })
    })
    const container = await mount(<ReservationContent />)
    await type(container.querySelector('#date')!, '2027-01-15')
    await click(radios(container)[2]!)
    await click(byText(container, 'button', '19:00'))
    await fillGuest(container)
    await click(container.querySelector('#consent')!)
    await act(async () => {
      ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('La zone choisie')
    expect(container.querySelector('#name')).toBeNull()
  })
})

describe('the guest changing their booking', () => {
  const OPEN = (time: string, startsAt: number, extra: Record<string, unknown> = {}) => ({
    serviceId: 'svc_1',
    time,
    startsAt,
    available: true,
    reason: null,
    preference: null,
    roomName: null,
    ...extra,
  })
  const BOOKING = {
    reference: 'RES-2026-00007',
    status: 'confirmed',
    serviceId: 'svc_1',
    startsAt: 1_800_000_000_000,
    endsAt: 1_800_005_400_000,
    partySize: 4,
    guestName: 'Marie Dupont',
    guestNote: 'Chaise haute',
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
    maxPartySize: 6,
    maxHorizonDays: 60,
    rooms: [] as Array<{ id: string; name: string }>,
    roomPreference: null as string | null,
  }
  const open = async (container: HTMLElement) =>
    click(byText(container, 'button', 'Modifier ma réservation'))
  const submit = async (container: HTMLElement) =>
    act(async () => {
      ;(
        container.querySelector('form[aria-labelledby="change-title"]') as HTMLFormElement
      ).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

  beforeEach(() => {
    state.booking = BOOKING
    state.tokenSlots = [
      OPEN('19:00', 1_799_998_200_000),
      OPEN('20:00', 1_800_000_000_000),
      OPEN('20:30', 1_800_001_800_000),
    ]
  })

  it('offers the change only while the server says it may', async () => {
    state.booking = { ...BOOKING, canModify: false }
    const container = await mount(<ManageReservationContent />)
    expect(byText(container, 'button', 'Modifier ma réservation')).toBeUndefined()
    expect(container.textContent).toContain('Le délai de modification en ligne est dépassé')
    // Cancelling is still there: the two deadlines are separate.
    expect(byText(container, 'button', 'Annuler ma réservation')).toBeDefined()
  })

  it('says both deadlines have passed when they have', async () => {
    state.booking = { ...BOOKING, canModify: false, canCancel: false }
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain(
      "Les délais de modification et d'annulation en ligne sont dépassés",
    )
  })

  it('opens a form with what the booking has now, and nothing to send yet', async () => {
    const container = await mount(<ManageReservationContent />)
    await open(container)
    expect((container.querySelector('#change-party') as HTMLSelectElement).value).toBe('4')
    expect((container.querySelector('#change-note') as HTMLTextAreaElement).value).toBe(
      'Chaise haute',
    )
    const current = byText(container, 'button', '20:00')
    expect(current.getAttribute('aria-pressed')).toBe('true')
    // Nothing changed, nothing to save: the button is off.
    expect(
      (byText(container, 'button', 'Enregistrer la modification') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('asks the server for the slots of this booking, not of a new one', async () => {
    const container = await mount(<ManageReservationContent />)
    await open(container)
    expect(state.tokenSlotArgs.at(-1)).toMatchObject({
      token: 'tok-aaaaaaaa',
      partySize: 4,
      roomPreference: null,
    })
  })

  it('moves the booking to another time and sends the slot with its service', async () => {
    const container = await mount(<ManageReservationContent />)
    await open(container)
    await click(byText(container, 'button', '20:30'))
    expect(container.textContent).toContain('Nouvelle réservation : 4 personnes')
    await submit(container)

    expect(state.modify).toHaveBeenCalledWith({
      token: 'tok-aaaaaaaa',
      date: expect.stringMatching(/^2027-01-15$/),
      serviceId: 'svc_1',
      startsAt: 1_800_001_800_000,
      partySize: 4,
      note: 'Chaise haute',
      roomPreference: null,
    })
    expect(container.textContent).toContain('Modification enregistrée.')
    expect(container.querySelector('form[aria-labelledby="change-title"]')).toBeNull()
  })

  it('changing the party or the date drops the time: it was picked for another', async () => {
    const container = await mount(<ManageReservationContent />)
    await open(container)
    const party = container.querySelector('#change-party') as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(party, '2')
      party.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(
      (byText(container, 'button', 'Enregistrer la modification') as HTMLButtonElement).disabled,
    ).toBe(true)
    await click(byText(container, 'button', '19:00'))
    await submit(container)
    expect(state.modify).toHaveBeenCalledWith(
      expect.objectContaining({ partySize: 2, startsAt: 1_799_998_200_000 }),
    )
  })

  it('rewording the note alone sends the booking’s own time, even if that hour is no longer on offer', async () => {
    state.tokenSlots = [OPEN('21:00', 1_800_003_600_000)]
    const container = await mount(<ManageReservationContent />)
    await open(container)
    await type(container.querySelector('#change-note') as HTMLTextAreaElement, 'Anniversaire')
    await submit(container)
    expect(state.modify).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'svc_1',
        startsAt: 1_800_000_000_000,
        note: 'Anniversaire',
      }),
    )
  })

  it('warns a guest of a house that validates by hand, only when the time or party moves', async () => {
    state.booking = { ...BOOKING, changeNeedsValidation: true }
    const container = await mount(<ManageReservationContent />)
    await open(container)
    expect(container.textContent).not.toContain('à valider de nouveau')
    await type(container.querySelector('#change-note') as HTMLTextAreaElement, 'Autre')
    expect(container.textContent).not.toContain('à valider de nouveau')

    await click(byText(container, 'button', '20:30'))
    expect(container.textContent).toContain('votre réservation sera à valider de nouveau')
  })

  it('says a change waits for the restaurant when it was sent back', async () => {
    state.modify = vi.fn(async () => ({ changed: true, status: 'pending' }))
    const container = await mount(<ManageReservationContent />)
    await open(container)
    await click(byText(container, 'button', '20:30'))
    await submit(container)
    expect(container.textContent).toContain('le restaurant doit la valider')
  })

  it('explains a time taken in the meantime, keeps the form and drops the choice', async () => {
    state.modify = vi.fn(async () => {
      throw Object.assign(new Error('refused'), {
        data: {
          code: 'slot_unavailable',
          message: "Ce créneau n'est plus disponible. Choisissez un autre horaire.",
        },
      })
    })
    const container = await mount(<ManageReservationContent />)
    await open(container)
    await click(byText(container, 'button', '20:30'))
    await submit(container)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "n'est plus disponible",
    )
    expect(container.querySelector('form[aria-labelledby="change-title"]')).not.toBeNull()
    expect(byText(container, 'button', '20:30').getAttribute('aria-pressed')).toBe('false')
  })

  it('closes with nothing sent when the guest keeps the booking', async () => {
    const container = await mount(<ManageReservationContent />)
    await open(container)
    await click(byText(container, 'button', 'Garder ma réservation'))
    expect(state.modify).not.toHaveBeenCalled()
    expect(container.querySelector('form[aria-labelledby="change-title"]')).toBeNull()
  })

  it('names the area the booking asked for, and lets it be changed', async () => {
    state.booking = {
      ...BOOKING,
      rooms: [
        { id: 'room_salle', name: 'Salle' },
        { id: 'room_terrasse', name: 'Terrasse' },
      ],
      roomPreference: 'room_terrasse',
    }
    const container = await mount(<ManageReservationContent />)
    expect(container.textContent).toContain('Zone souhaitée')
    expect(container.textContent).toContain('Terrasse')

    await open(container)
    const radios = [
      ...container.querySelectorAll<HTMLInputElement>('input[name="change-room-preference"]'),
    ]
    expect(radios.map((r) => r.checked)).toEqual([false, false, true])
    await click(radios[1]!)
    expect(state.tokenSlotArgs.at(-1)).toMatchObject({ roomPreference: 'room_salle' })
    await click(byText(container, 'button', '20:30'))
    await submit(container)
    expect(state.modify).toHaveBeenCalledWith(
      expect.objectContaining({ roomPreference: 'room_salle' }),
    )
  })

  it('stamps the calendar file with the booking’s revision, so it replaces the one saved before', async () => {
    state.booking = { ...BOOKING, canAddToCalendar: true, revision: 3 }
    const created: Blob[] = []
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:calendar'
    })
    URL.revokeObjectURL = vi.fn()
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const container = await mount(<ManageReservationContent />)
      await click(byText(container, 'button', 'Ajouter à mon agenda'))
      expect(await created[0]!.text()).toContain('SEQUENCE:3')
    } finally {
      clicked.mockRestore()
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    }
  })
})
