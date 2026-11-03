// @vitest-environment jsdom

/**
 * The guest's own link for a group request and for seats at an event.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. a group request says where it stands in its own words — waiting (until when the place is
 *     held), a proposal (what was asked beside what is proposed, the host's note, the payment
 *     in words), lapsed, awaiting payment, confirmed, declined, expired — and a request that
 *     cannot go on online ends on the contact card, never on a bare sentence;
 *  2. accepting a proposal that carries a payment sends the guest to the payment page, refusing
 *     asks once more, and a refusal from the server is shown in words;
 *  3. neither kind offers « Modifier »;
 *  4. a ticket speaks of seats and of the event, cancels by the event's own cut-off, says a
 *     cancelled event with the host's message and the refund, and its calendar entry names the
 *     event rather than a table.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  booking: undefined as unknown,
  push: vi.fn(),
  cancel: vi.fn(),
  respond: vi.fn(),
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
    return ref === 'getByToken' ? state.booking : undefined
  },
  useMutation: (ref: string) => (ref === 'respond' ? state.respond : state.cancel),
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
    reservationGroups: { respondToProposal: 'respond' },
  },
}))

const { default: ManageReservationContent } =
  await import('@/app/(storefront)/reservation/manage/[token]/_components/ManageReservationContent')

const NOW = Date.UTC(2027, 0, 8, 10, 0)
const HOUR = 60 * 60_000
const EVENT_START = Date.UTC(2027, 0, 15, 18, 30)
const EVENT_END = Date.UTC(2027, 0, 15, 21, 0)

const BASE = {
  reference: 'RES-2027-00021',
  status: 'pending',
  serviceId: 'svc_1',
  startsAt: Date.UTC(2027, 0, 15, 19, 0),
  endsAt: Date.UTC(2027, 0, 15, 21, 0),
  partySize: 14,
  guestName: 'Marie Dupont',
  guestNote: null as string | null,
  timezone: 'Europe/Paris',
  storeName: 'Chez Luigi',
  storeAddress: '12 rue des Lilas, 75011 Paris' as string | null,
  storePhone: '01 40 50 60 70' as string | null,
  storeEmail: 'luigi@example.fr' as string | null,
  policyText: 'Au-delà de 15 minutes de retard, la table peut être réattribuée.',
  canCancel: true,
  canModify: false,
  changeNeedsValidation: false,
  changeCutoffHours: 2,
  canReconfirm: false,
  canAddToCalendar: false,
  reconfirmedAt: null,
  revision: 0,
  maxPartySize: 8,
  maxHorizonDays: 60,
  rooms: [] as Array<{ id: string; name: string }>,
  roomPreference: null as string | null,
  retentionDays: 1095,
  noteDays: 3,
  privacyNoticeVersion: null as string | null,
  payment: null as unknown,
  kind: null as 'group' | 'experience' | null,
  group: null as unknown,
  experience: null as unknown,
}

const DEPOSIT_LINES = [
  'Un acompte de 200,00 € est demandé pour confirmer la réservation. Il est payé en ligne maintenant.',
  "Annulation gratuite jusqu'à 2 jours avant la réservation : l'acompte est alors remboursé en totalité.",
]

function groupOf(overrides: Record<string, unknown> = {}) {
  return {
    state: 'review',
    requestedStartsAt: Date.UTC(2027, 0, 15, 19, 0),
    occasion: 'Anniversaire de Paul',
    budget: 'Menu unique, 45 € par personne',
    message: 'Nous arriverons ensemble.',
    reviewExpiresAt: NOW + 48 * HOUR,
    hostMessage: null as string | null,
    decidedAt: null,
    proposal: null as unknown,
    consentLabel: null,
    ...overrides,
  }
}

function proposalOf(overrides: Record<string, unknown> = {}) {
  return {
    startsAt: Date.UTC(2027, 0, 15, 20, 30),
    expiresAt: NOW + 24 * HOUR,
    lapsed: false,
    note: 'La salle du fond est libre à 20:30.',
    terms: null as unknown,
    ...overrides,
  }
}

const DEPOSIT_TERMS = {
  kind: 'deposit',
  depositCents: 20_000,
  noShowFeeCents: 0,
  freeCancellationHours: 48,
  currency: 'EUR',
  lines: DEPOSIT_LINES,
}

function ticketOf(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE,
    status: 'confirmed',
    partySize: 3,
    kind: 'experience' as const,
    startsAt: EVENT_START,
    endsAt: EVENT_END,
    canAddToCalendar: true,
    experience: {
      id: 'exp_1',
      title: 'Soirée dégustation',
      imageUrl: 'https://img.example/soiree.jpg' as string | null,
      startsAt: EVENT_START,
      endsAt: EVENT_END,
      cancellationCutoffHours: 48,
      cancelled: false,
      cancelReason: null as string | null,
    },
    ...overrides,
  }
}

function paymentOf(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'deposit',
    currency: 'EUR',
    depositCents: 13_500,
    noShowFeeCents: 0,
    freeCancellationHours: 48,
    lines: ["Annulation gratuite jusqu'à 48 h avant : les places sont remboursées en totalité."],
    state: 'paid',
    heldCents: 13_500,
    refundedCents: 0,
    feeChargedCents: 0,
    awaiting: false,
    holdExpiresAt: null as number | null,
    holdLapsed: false,
    ...overrides,
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  state.booking = undefined
  state.push = vi.fn()
  state.cancel = vi.fn(async () => ({ status: 'cancelled_by_guest' }))
  state.respond = vi.fn(async () => ({ status: 'confirmed' }))
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

const button = (c: HTMLElement, text: string | RegExp) =>
  [...c.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
const link = (c: HTMLElement, text: string | RegExp) =>
  [...c.querySelectorAll('a')].find((a) =>
    typeof text === 'string' ? a.textContent?.trim() === text : text.test(a.textContent ?? ''),
  ) as HTMLAnchorElement | undefined
const headings = (c: HTMLElement) => [...c.querySelectorAll('h1, h2')].map((h) => h.textContent)

describe('a group request on the guest link', () => {
  it('says a waiting request is not confirmed, with the deadline, and lets the guest withdraw it', async () => {
    state.booking = { ...BASE, kind: 'group', group: groupOf() }
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Ma demande de groupe')
    expect(headings(container)).toContain('Demande envoyée : pas encore confirmée')
    expect(container.textContent).toContain("n'est pas confirmée")
    // 10:00 UTC on the 10th is 11:00 in Paris.
    expect(container.textContent).toContain('10 janvier 2027 à 11:00')
    expect(container.textContent).toContain('Anniversaire de Paul')
    expect(container.textContent).toContain('Menu unique, 45 € par personne')
    expect(container.textContent).toContain('14 personnes')
    expect(button(container, 'Retirer ma demande')).toBeDefined()
    expect(button(container, /Modifier/)).toBeUndefined()
    // The generic « réservation confirmée » line of an ordinary booking is not shown.
    expect(container.textContent).not.toContain('Votre table est réservée')
  })

  it('withdraws a request after asking once, in the words of a request', async () => {
    state.booking = { ...BASE, kind: 'group', group: groupOf() }
    const container = await mount()
    await click(button(container, 'Retirer ma demande')!)
    expect(container.textContent).toContain('Retirer cette demande ?')
    expect(container.textContent).toContain('La place gardée pour votre groupe sera libérée')
    await click(button(container, 'Oui, retirer')!)
    expect(state.cancel).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa' })
  })

  it('shows a proposal beside what was asked, with the host note, and no payment when it carries none', async () => {
    state.booking = {
      ...BASE,
      startsAt: Date.UTC(2027, 0, 15, 20, 30),
      kind: 'group',
      group: groupOf({ state: 'proposal', proposal: proposalOf() }),
    }
    const container = await mount()
    const card = container.querySelector('[data-testid="group-proposal"]')!
    expect(card.textContent).toContain('Ce que vous aviez demandé')
    expect(card.textContent).toContain('15 janvier 2027 à 20:00')
    expect(card.textContent).toContain('Ce qui est proposé')
    expect(card.textContent).toContain('15 janvier 2027 à 21:30')
    expect(card.textContent).toContain('La salle du fond est libre à 20:30.')
    expect(card.textContent).toContain("Aucun paiement n'est demandé")
    // The asked-for time is the one in the summary while the proposal is open.
    expect(container.textContent).toContain('Demandé pour')
    // The two answers; « Annuler » is not offered beside them.
    expect(button(container, 'Accepter cette proposition')).toBeDefined()
    expect(button(container, 'Refuser')).toBeDefined()
    expect(button(container, /Annuler/)).toBeUndefined()
  })

  it('accepts a proposal without a payment and stays on the page', async () => {
    state.booking = {
      ...BASE,
      kind: 'group',
      group: groupOf({ state: 'proposal', proposal: proposalOf() }),
    }
    const container = await mount()
    await click(button(container, 'Accepter cette proposition')!)
    expect(state.respond).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa', accept: true })
    expect(state.push).not.toHaveBeenCalled()
  })

  it('says the payment of a proposal in words, then sends the guest to pay when they accept', async () => {
    state.respond = vi.fn(async () => ({ status: 'pending_payment' }))
    state.booking = {
      ...BASE,
      kind: 'group',
      group: groupOf({ state: 'proposal', proposal: proposalOf({ terms: DEPOSIT_TERMS }) }),
    }
    const container = await mount()
    const card = container.querySelector('[data-testid="group-proposal"]')!
    expect(card.textContent).toMatch(/acompte de 200,00\s€/)
    for (const line of DEPOSIT_LINES) expect(card.textContent).toContain(line)
    await click(button(container, 'Accepter cette proposition')!)
    expect(state.push).toHaveBeenCalledWith('/reservation/payment/tok-aaaaaaaa')
  })

  it('asks before refusing, because refusing lets the place go', async () => {
    state.booking = {
      ...BASE,
      kind: 'group',
      group: groupOf({ state: 'proposal', proposal: proposalOf() }),
    }
    const container = await mount()
    await click(button(container, 'Refuser')!)
    expect(container.textContent).toContain('Refuser cette proposition ?')
    expect(container.textContent).toContain('sera libérée')
    expect(state.respond).not.toHaveBeenCalled()
    await click(button(container, 'Non, revenir')!)
    expect(button(container, 'Accepter cette proposition')).toBeDefined()
    await click(button(container, 'Refuser')!)
    await click(button(container, 'Oui, refuser')!)
    expect(state.respond).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa', accept: false })
  })

  it("shows the server's refusal when the proposal is no longer valid", async () => {
    state.respond = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'proposal_unavailable' } })
    })
    state.booking = {
      ...BASE,
      kind: 'group',
      group: groupOf({ state: 'proposal', proposal: proposalOf() }),
    }
    const container = await mount()
    await click(button(container, 'Accepter cette proposition')!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Cette proposition n'est plus valable",
    )
  })

  it('ends a lapsed proposal on the contact card and a way to ask again', async () => {
    state.booking = {
      ...BASE,
      kind: 'group',
      group: groupOf({
        state: 'proposal_lapsed',
        proposal: proposalOf({ lapsed: true, expiresAt: NOW - HOUR }),
      }),
    }
    const container = await mount()
    expect(headings(container)).toContain('Cette proposition a expiré')
    expect(container.querySelector('[data-testid="group-proposal"]')).toBeNull()
    expect(button(container, 'Accepter cette proposition')).toBeUndefined()
    const card = container.querySelector('[data-testid="contact-card"]')!
    expect(card.querySelector('a[href="tel:0140506070"]')).not.toBeNull()
    expect(link(container, 'Faire une nouvelle demande')?.getAttribute('href')).toBe('/reservation')
  })

  it('says a declined request with the host reason, and a way on', async () => {
    state.booking = {
      ...BASE,
      status: 'declined',
      canCancel: false,
      kind: 'group',
      group: groupOf({
        state: 'declined',
        hostMessage: 'Nous sommes fermés pour travaux ce soir-là.',
      }),
    }
    const container = await mount()
    expect(headings(container)).toContain("Le restaurant n'a pas pu accepter votre demande")
    expect(container.textContent).toContain('Nous sommes fermés pour travaux ce soir-là.')
    expect(container.querySelector('[data-testid="contact-card"]')).not.toBeNull()
  })

  it('says an expired request and a lapsed review with a way on, never a bare sentence', async () => {
    for (const [status, groupState, headline] of [
      ['expired', 'expired', 'Cette demande a expiré'],
      ['pending', 'review_lapsed', 'Le délai de réponse est dépassé'],
    ] as const) {
      state.booking = {
        ...BASE,
        status,
        canCancel: false,
        kind: 'group',
        group: groupOf({ state: groupState }),
      }
      const container = await mount()
      expect(headings(container), groupState).toContain(headline)
      expect(container.querySelector('[data-testid="contact-card"]'), groupState).not.toBeNull()
    }
  })

  it('shows an accepted request awaiting its payment with the hold and the way to pay', async () => {
    state.booking = {
      ...BASE,
      status: 'pending_payment',
      kind: 'group',
      group: groupOf({ state: 'awaiting_payment' }),
      payment: paymentOf({
        state: 'awaiting',
        heldCents: 0,
        depositCents: 20_000,
        lines: DEPOSIT_LINES,
        awaiting: true,
        holdExpiresAt: NOW + 30 * 60_000,
      }),
    }
    const container = await mount()
    expect(headings(container)).toContain('Demande acceptée : il reste à régler')
    expect(container.textContent).toContain('La table vous est gardée encore')
    expect(container.textContent).toContain('30:00')
    expect(link(container, 'Payer maintenant')?.getAttribute('href')).toBe(
      '/reservation/payment/tok-aaaaaaaa',
    )
  })

  it('shows a confirmed group with the host message and no « Modifier »', async () => {
    state.booking = {
      ...BASE,
      status: 'confirmed',
      canAddToCalendar: true,
      kind: 'group',
      group: groupOf({ state: 'approved', hostMessage: 'Nous vous réservons la grande salle.' }),
    }
    const container = await mount()
    expect(headings(container)).toContain('Votre groupe est confirmé')
    expect(container.textContent).toContain('Nous vous réservons la grande salle.')
    expect(button(container, /Modifier/)).toBeUndefined()
    expect(button(container, 'Annuler ma réservation')).toBeDefined()
    expect(button(container, 'Ajouter à mon agenda')).toBeDefined()
  })
})

describe('seats at an event on the guest link', () => {
  it('speaks of seats and of the event, not of a table', async () => {
    state.booking = ticketOf()
    const container = await mount()
    expect(container.querySelector('h1')?.textContent).toBe('Mes places')
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Soirée dégustation')
    expect(container.textContent).toContain('Soirée dégustation')
    expect(container.textContent).toContain('3 places')
    expect(container.textContent).not.toContain('Convives')
    expect(container.textContent).toContain('Vos places sont réservées')
    expect(container.textContent).not.toContain('Votre table')
    // The house's table policy is not the event's.
    expect(container.textContent).not.toContain('la table peut être réattribuée')
    expect(button(container, /Modifier/)).toBeUndefined()
  })

  it("cancels the seats, saying what it does to the money in the ticket's words", async () => {
    state.booking = ticketOf({ payment: paymentOf() })
    const container = await mount()
    const cancel = button(container, /Annuler/)!
    expect(cancel.textContent).toMatch(/le prix des places \(135,00\s€\) vous sera remboursé/)
    await click(cancel)
    expect(container.textContent).toContain('Annuler ces places ?')
    expect(container.textContent).toContain('Les places seront libérées')
    expect(container.textContent).not.toContain('La table sera libérée')
    await click(button(container, 'Oui, annuler')!)
    expect(state.cancel).toHaveBeenCalledWith({ token: 'tok-aaaaaaaa' })
  })

  it("says the event's own cut-off when cancelling is no longer possible", async () => {
    state.booking = ticketOf({ canCancel: false, payment: paymentOf() })
    const container = await mount()
    expect(button(container, /Annuler/)).toBeUndefined()
    expect(container.textContent).toContain(
      "Le délai d'annulation de cet événement (48 h avant le début)",
    )
    expect(container.textContent).toContain('le prix des places reste acquis')
  })

  it("labels the money of a ticket with the ticket's words", async () => {
    state.booking = ticketOf({ payment: paymentOf() })
    const container = await mount()
    expect(container.textContent).toContain('Prix des places')
    expect(container.textContent).toContain('Places payées')
    expect(container.textContent).not.toContain('Acompte demandé')
  })

  it('says a cancelled event with the host message and the refund, and a way to reach them', async () => {
    state.booking = ticketOf({
      status: 'cancelled_by_restaurant',
      canCancel: false,
      canAddToCalendar: false,
      payment: paymentOf({ state: 'refunded', heldCents: 0, refundedCents: 13_500 }),
      experience: {
        id: 'exp_1',
        title: 'Soirée dégustation',
        imageUrl: null,
        startsAt: EVENT_START,
        endsAt: EVENT_END,
        cancellationCutoffHours: 48,
        cancelled: true,
        cancelReason: 'Le chef est souffrant.',
      },
    })
    const container = await mount()
    expect(headings(container)).toContain('Cet événement est annulé')
    expect(container.textContent).toContain('Chez Luigi a annulé cet événement')
    expect(container.textContent).toContain('Le chef est souffrant.')
    expect(container.textContent).toMatch(/Vos places sont remboursées : 135,00\s€/)
    expect(container.textContent).toContain('Places remboursées')
    expect(container.querySelector('[data-testid="contact-card"]')).not.toBeNull()
    expect(button(container, /Annuler/)).toBeUndefined()
  })

  it('names the event in the calendar entry, not a table', async () => {
    let captured: Blob | null = null
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        captured = blob
        return 'blob:ticket'
      },
      revokeObjectURL: () => {},
    })
    state.booking = ticketOf()
    const container = await mount()
    await click(button(container, 'Ajouter à mon agenda')!)
    expect(captured).not.toBeNull()
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(captured as unknown as Blob)
    })
    const unfolded = text.replace(/\r\n /g, '')
    expect(unfolded).toContain('SUMMARY:Soirée dégustation chez Chez Luigi')
    expect(unfolded).toContain('DTSTART:20270115T183000Z')
    expect(unfolded).not.toContain('Réservation chez')
  })
})
