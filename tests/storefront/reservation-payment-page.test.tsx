// @vitest-environment jsdom

/**
 * The page a guest pays a booking's deposit — or secures its card guarantee — on, and the
 * page the payment provider sends them back to.
 *
 * What is held here, because each is the kind of rule that breaks quietly:
 *
 *  1. the page says which of its states is true, in words: waiting for the payment, back
 *     from the provider and not confirmed yet, still unconfirmed after a while, cancelled at
 *     the provider, a failed attempt, a hold that ran out, a booking that is taken, one that
 *     ended — and an unknown link;
 *  2. the countdown is a clock with no live region, and the sentence a screen reader hears
 *     changes in coarse steps only;
 *  3. one click starts one attempt, the provider's page is reached through the address the
 *     server returned, and a refusal is shown in the server's words with a way to retry;
 *  4. coming back from the provider asks the server to read the payment back EXACTLY ONCE,
 *     and the page shows what the server then holds — whichever of the webhook and that call
 *     settles first, the guest ends on the same view;
 *  5. while the server has not confirmed, the page never falls back to « Payer » — the guest
 *     may well have paid.
 */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  page: undefined as unknown,
  start: vi.fn(),
  verify: vi.fn(),
  assign: vi.fn(),
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
    return ref === 'p.getPaymentPage' ? state.page : undefined
  },
  useAction: (ref: string) => (ref === 'a.start' ? state.start : state.verify),
}))
vi.mock('@/convex/_generated/api', () => ({
  api: {
    reservationPayments: { getPaymentPage: 'p.getPaymentPage' },
    // Read only for a ticket, to name the event; `skip` for every other booking.
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
const SUMUP = { provider: 'sumup', label: 'Carte bancaire (SumUp)' }

const TERMS = [
  'Un acompte de 40,00 € est demandé pour confirmer la réservation. Il est payé en ligne maintenant.',
  "Annulation gratuite jusqu'à 2 jours avant la réservation : l'acompte est alors remboursé en totalité.",
]

function pageOf(
  overrides: Partial<{
    status: string
    kind: 'deposit' | 'guarantee'
    state: string
    holdExpiresAt: number | null
    holdLapsed: boolean
    heldCents: number
    refundedCents: number
    providers: Array<{ provider: string; label: string }>
    defaultProvider: string | null
    canPay: boolean
    autoConfirm: boolean
  }> = {},
) {
  const status = overrides.status ?? 'pending_payment'
  const kind = overrides.kind ?? 'deposit'
  const providers = overrides.providers ?? [STRIPE]
  return {
    reference: 'RES-2026-00031',
    status,
    startsAt: Date.UTC(2027, 0, 15, 19, 0),
    partySize: 2,
    timezone: 'Europe/Paris',
    storeName: 'Chez Luigi',
    autoConfirm: overrides.autoConfirm ?? true,
    amountDueCents: kind === 'deposit' ? 4000 : 0,
    providers,
    defaultProvider: overrides.defaultProvider === undefined ? 'stripe' : overrides.defaultProvider,
    canPay: overrides.canPay ?? providers.length > 0,
    manageToken: 'tok-pay-1',
    payment: {
      kind,
      currency: 'EUR',
      depositCents: kind === 'deposit' ? 4000 : 0,
      noShowFeeCents: kind === 'guarantee' ? 3000 : 0,
      freeCancellationHours: 48,
      lines: TERMS,
      state: overrides.state ?? 'awaiting',
      heldCents: overrides.heldCents ?? 0,
      refundedCents: overrides.refundedCents ?? 0,
      feeChargedCents: 0,
      awaiting: status === 'pending_payment',
      holdExpiresAt:
        overrides.holdExpiresAt === undefined ? NOW + 10 * MINUTE : overrides.holdExpiresAt,
      holdLapsed: overrides.holdLapsed ?? false,
    },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  })
  vi.setSystemTime(NOW)
  state.page = pageOf()
  state.start = vi.fn(async () => ({ redirectUrl: 'https://checkout.stripe.test/c/pay_123' }))
  state.verify = vi.fn(async () => ({ outcome: 'unknown' }))
  state.assign = vi.fn()
  vi.stubGlobal('location', {
    ...window.location,
    origin: 'https://chezluigi.example',
    assign: state.assign,
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

let current: { root: Root; returned: 'success' | 'cancelled' | null; strict: boolean } | null = null

async function mount(
  returned: 'success' | 'cancelled' | null = null,
  options: { strict?: boolean } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  current = { root, returned, strict: options.strict === true }
  await act(async () => {
    root.render(
      options.strict ? (
        <StrictMode>
          <PaymentContent returned={returned} />
        </StrictMode>
      ) : (
        <PaymentContent returned={returned} />
      ),
    )
  })
  return container
}

/** The server's answer changed: the reactive query re-renders the page. */
async function serverSays(page: unknown) {
  state.page = page
  const node = <PaymentContent returned={current!.returned} />
  await act(async () => {
    current!.root.render(current!.strict ? <StrictMode>{node}</StrictMode> : node)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const payButton = (c: HTMLElement) => c.querySelector('button[type="submit"]') as HTMLButtonElement
const heading = (c: HTMLElement) => c.querySelector('h1')?.textContent ?? ''
const timer = (c: HTMLElement) => c.querySelector('[role="timer"]')?.textContent ?? ''
const srStatus = (c: HTMLElement) => c.querySelector('p[role="status"].sr-only')?.textContent ?? ''

describe('the first moments of the page', () => {
  it('says it is loading, not that the link is dead', async () => {
    state.page = undefined
    const container = await mount()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Chargement')
    expect(container.querySelector('h1')).toBeNull()
  })

  it('says plainly that a link is unknown, with a way out', async () => {
    state.page = null
    const container = await mount()
    expect(heading(container)).toBe('Réservation introuvable')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/')
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('waiting for the payment', () => {
  it('shows the amount, what it is for, the terms and the way to pay', async () => {
    const container = await mount()
    expect(heading(container)).toBe('Régler votre acompte')
    expect(container.textContent).toMatch(/40,00\s€/)
    expect(container.textContent).toContain('RES-2026-00031')
    expect(container.textContent).toContain('2 personnes')
    for (const line of TERMS) expect(container.textContent).toContain(line)
    expect(container.textContent).toContain('confirmée dès que le paiement est reçu')
    expect(payButton(container).textContent).toMatch(/^Payer 40,00\s€$/)
    expect(payButton(container).disabled).toBe(false)
  })

  it('names the one way to pay and keeps card numbers out of the page', async () => {
    const container = await mount()
    expect(container.querySelector('[role="radiogroup"], fieldset')).toBeNull()
    expect(container.textContent).toContain('Paiement par Carte bancaire (Stripe)')
    expect(container.textContent).toContain('Aucun numéro de carte')
  })

  it('says a validated-by-hand house validates after the payment', async () => {
    state.page = pageOf({ autoConfirm: false })
    const container = await mount()
    expect(container.textContent).toContain('Une fois le paiement reçu, le restaurant doit valider')
  })

  it('says nothing is debited for a card guarantee, and the most a no-show can cost', async () => {
    state.page = pageOf({ kind: 'guarantee' })
    const container = await mount()
    expect(heading(container)).toBe('Enregistrer votre carte')
    expect(container.textContent).toContain('Aucun débit maintenant')
    expect(container.textContent).toMatch(/jusqu'à\s*30,00\s€/)
    expect(payButton(container).textContent).toBe('Enregistrer ma carte')
  })

  it('leaves a way out: the booking, where the request can be cancelled', async () => {
    const container = await mount()
    const link = [...container.querySelectorAll('a')].find((a) =>
      /Voir ma réservation/.test(a.textContent ?? ''),
    )
    expect(link?.getAttribute('href')).toBe('/reservation/manage/tok-pay-1')
  })
})

describe('the countdown', () => {
  it('shows the time left as a timer with no live region of its own', async () => {
    const container = await mount()
    expect(timer(container)).toContain('10:00')
    expect(container.querySelector('[role="timer"]')?.getAttribute('aria-live')).toBe('off')
    await advance(1_000)
    expect(timer(container)).toContain('09:59')
    await advance(59_000)
    expect(timer(container)).toContain('09:00')
  })

  it('changes what a screen reader hears only at the coarse steps', async () => {
    const container = await mount()
    const first = srStatus(container)
    expect(first).toContain('moins de 10 minutes')
    // Four minutes later, 04:... left: a new step, the previous one is not repeated.
    await advance(5 * MINUTE - 1_000)
    expect(srStatus(container)).toBe(first)
    await advance(2_000)
    expect(srStatus(container)).toContain('moins de 5 minutes')
    await advance(3 * MINUTE)
    expect(srStatus(container)).toContain('moins de 2 minutes')
    await advance(MINUTE)
    expect(srStatus(container)).toContain("moins d'une minute")
  })

  it('releases the table on screen when it reaches zero, and stops offering to pay', async () => {
    const container = await mount()
    expect(payButton(container)).not.toBeNull()
    await advance(10 * MINUTE + 1_000)
    expect(heading(container)).toBe('Le délai est dépassé, la table a été libérée')
    expect(container.querySelector('button')).toBeNull()
    expect(
      [...container.querySelectorAll('a')]
        .find((a) => a.textContent === 'Réserver à nouveau')
        ?.getAttribute('href'),
    ).toBe('/reservation')
  })
})

describe('choosing how to pay', () => {
  beforeEach(() => {
    state.page = pageOf({ providers: [STRIPE, SUMUP], defaultProvider: 'sumup' })
  })

  it('offers each way as a radio, each with its own honest note, the establishment’s choice first and checked', async () => {
    const container = await mount()
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.map((r) => r.id)).toEqual(['payment-provider-stripe', 'payment-provider-sumup'])
    expect(radios.map((r) => r.checked)).toEqual([false, true])
    expect(container.querySelector('fieldset legend')?.textContent).toContain(
      'Comment souhaitez-vous payer',
    )
    // Each option is named by its label, which carries the provider's name and note.
    expect(container.querySelector('label[for="payment-provider-sumup"]')?.textContent).toContain(
      'sur la page de paiement SumUp, remboursable par SumUp',
    )
    expect(container.querySelector('label[for="payment-provider-stripe"]')?.textContent).toContain(
      'remboursable par Stripe',
    )
  })

  it('pays through the one the guest picked', async () => {
    const container = await mount()
    await click(container.querySelector('#payment-provider-stripe')!)
    await click(payButton(container))
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ provider: 'stripe' }))
  })

  it('says so for the guarantee: only what can honour it is listed', async () => {
    state.page = pageOf({ kind: 'guarantee', providers: [STRIPE], defaultProvider: 'stripe' })
    const container = await mount()
    expect(container.textContent).toContain('enregistrée chez Stripe sans être débitée')
  })
})

describe('paying', () => {
  it('starts one attempt, then reaches the provider by the address the server returned', async () => {
    const container = await mount()
    await click(payButton(container))
    expect(state.start).toHaveBeenCalledTimes(1)
    expect(state.start).toHaveBeenCalledWith({
      token: 'tok-pay-1',
      provider: 'stripe',
      returnOrigin: 'https://chezluigi.example',
    })
    expect(state.assign).toHaveBeenCalledWith('https://checkout.stripe.test/c/pay_123')
    // Gone to the provider: the button stays busy rather than inviting a second attempt.
    expect(payButton(container).disabled).toBe(true)
    expect(payButton(container).textContent).toBe('Redirection vers le paiement…')
  })

  it('starts only one attempt on a double click', async () => {
    let release: (value: { redirectUrl: string }) => void = () => {}
    state.start = vi.fn(
      () =>
        new Promise<{ redirectUrl: string }>((resolve) => {
          release = resolve
        }),
    )
    const container = await mount()
    const button = payButton(container)
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      button.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(state.start).toHaveBeenCalledTimes(1)
    await act(async () => release({ redirectUrl: 'https://checkout.stripe.test/c/pay_123' }))
    expect(state.assign).toHaveBeenCalledTimes(1)
  })

  it("shows the server's refusal in its own words and lets the guest retry", async () => {
    state.start = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('refused'), {
          data: {
            code: 'payment_unavailable',
            message: "Le paiement n'est pas disponible en ce moment : réessayez plus tard.",
          },
        }),
      )
      .mockResolvedValueOnce({ redirectUrl: 'https://checkout.stripe.test/c/pay_456' })
    const container = await mount()
    await click(payButton(container))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('réessayez plus tard')
    expect(state.assign).not.toHaveBeenCalled()
    expect(payButton(container).disabled).toBe(false)

    await click(payButton(container))
    expect(state.start).toHaveBeenCalledTimes(2)
    expect(state.assign).toHaveBeenCalledWith('https://checkout.stripe.test/c/pay_456')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('has French words for a refusal that arrives without any', async () => {
    state.start = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'rate_limited' } })
    })
    const container = await mount()
    await click(payButton(container))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Patientez')
  })

  it('has French words for a failure that is not a refusal at all', async () => {
    state.start = vi.fn(async () => {
      throw new Error('Server Error')
    })
    const container = await mount()
    await click(payButton(container))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Veuillez réessayer')
  })

  it('says honestly that online payment is unavailable and offers no button, while the table is held', async () => {
    state.page = pageOf({ providers: [], defaultProvider: null, canPay: false })
    const container = await mount()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Le paiement en ligne n'est pas disponible en ce moment",
    )
    expect(container.querySelector('button[type="submit"]')).toBeNull()
    expect(timer(container)).toContain('10:00')
  })
})

describe('coming back from the provider', () => {
  it('asks the server to read the payment back exactly once, even when the page mounts twice', async () => {
    await mount('success', { strict: true })
    expect(state.verify).toHaveBeenCalledTimes(1)
    expect(state.verify).toHaveBeenCalledWith({ token: 'tok-pay-1' })
    await serverSays(pageOf())
    await advance(5_000)
    expect(state.verify).toHaveBeenCalledTimes(1)
  })

  it('does not ask the server when the guest did not come back from the provider', async () => {
    await mount(null)
    await mount('cancelled')
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('says it is verifying until the server shows the booking is taken, and never offers to pay again', async () => {
    const container = await mount('success')
    expect(heading(container)).toBe('Nous vérifions votre paiement…')
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Cette page se met à jour toute seule')
    expect(container.textContent).toContain('votre réservation est confirmée')
  })

  it('says a hand-validated house will then validate it', async () => {
    state.page = pageOf({ autoConfirm: false })
    const container = await mount('success')
    expect(container.textContent).toContain("transmise à l'établissement, qui doit la valider")
  })

  it('ends on the confirmation when the server settles after the guest is back', async () => {
    const container = await mount('success')
    await serverSays(pageOf({ status: 'confirmed', state: 'paid', heldCents: 4000 }))
    expect(heading(container)).toBe('Réservation confirmée')
    expect(container.textContent).toMatch(/Votre acompte de 40,00\s€ est payé/)
  })

  it('ends on the same confirmation when the webhook settled BEFORE the guest was back', async () => {
    state.page = pageOf({ status: 'confirmed', state: 'paid', heldCents: 4000 })
    const container = await mount('success')
    expect(heading(container)).toBe('Réservation confirmée')
    expect(container.textContent).toMatch(/Votre acompte de 40,00\s€ est payé/)
    expect(container.textContent).not.toContain('Nous vérifions')
    expect(container.querySelector('button')).toBeNull()
  })

  it('says plainly, after a while, that the e-mail will confirm and the page can be reopened', async () => {
    const container = await mount('success')
    await advance(19_000)
    expect(heading(container)).toBe('Nous vérifions votre paiement…')
    await advance(2_000)
    expect(heading(container)).toBe("Votre paiement n'est pas encore confirmé")
    expect(container.textContent).toContain('envoyée par e-mail')
    expect(container.textContent).toContain('la rouvrir plus tard')
    // Still no « Payer »: a second payment would only have to be refunded.
    expect(container.querySelector('button[type="submit"]')).toBeNull()
    expect(timer(container)).toContain('La table vous est gardée encore')
  })

  it('lets the guest ask again, and the page still ends on what the server holds', async () => {
    const container = await mount('success')
    await advance(21_000)
    const again = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Vérifier à nouveau',
    )!
    await click(again)
    expect(state.verify).toHaveBeenCalledTimes(2)
    await serverSays(pageOf({ status: 'confirmed', state: 'paid', heldCents: 4000 }))
    expect(heading(container)).toBe('Réservation confirmée')
  })

  it('shows a lapsed hold as lapsed, and says a late payment is refunded', async () => {
    state.page = pageOf({ status: 'expired' })
    const container = await mount('success')
    expect(heading(container)).toBe('Le délai est dépassé, la table a été libérée')
    expect(container.textContent).toContain('remboursé en totalité')
  })

  it('shows a failed attempt as a way to retry, not as a spinner that never ends', async () => {
    state.page = pageOf({ state: 'failed' })
    const container = await mount('success')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("n'a pas abouti")
    expect(payButton(container).textContent).toBe('Réessayer le paiement')
  })

  it('shows a cancelled return as nothing debited, with the clock and a retry', async () => {
    const container = await mount('cancelled')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Paiement annulé, rien n'a été débité",
    )
    expect(timer(container)).toContain('10:00')
    expect(payButton(container).textContent).toBe('Réessayer le paiement')
    await click(payButton(container))
    expect(state.start).toHaveBeenCalledTimes(1)
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('never invites a second payment on a cancelled link the webhook already settled', async () => {
    state.page = pageOf({ status: 'confirmed', state: 'paid', heldCents: 4000 })
    const container = await mount('cancelled')
    expect(heading(container)).toBe('Réservation confirmée')
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('a booking that is taken', () => {
  it('says a confirmed booking is confirmed, with its reference, time, party and what was paid', async () => {
    state.page = pageOf({ status: 'confirmed', state: 'paid', heldCents: 4000 })
    const container = await mount()
    expect(heading(container)).toBe('Réservation confirmée')
    expect(container.querySelector('[role="status"] h1')).not.toBeNull()
    expect(container.textContent).toContain('RES-2026-00031')
    expect(container.textContent).toContain('2 personnes')
    expect(container.textContent).toContain('Acompte payé')
    expect(container.textContent).toContain(TERMS[1])
    expect(
      [...container.querySelectorAll('a')]
        .find((a) => /Voir ma réservation/.test(a.textContent ?? ''))
        ?.getAttribute('href'),
    ).toBe('/reservation/manage/tok-pay-1')
  })

  it('says a request waiting for the house is a request, not a confirmation', async () => {
    state.page = pageOf({ status: 'pending', state: 'paid', heldCents: 4000, autoConfirm: false })
    const container = await mount()
    expect(heading(container)).toBe("Demande reçue — l'établissement doit la valider")
    expect(container.textContent).toContain('Le restaurant doit valider votre demande')
    expect(container.textContent).toMatch(/Votre acompte de 40,00\s€ est payé/)
  })

  it('says a secured card is secured, and nothing was debited', async () => {
    state.page = pageOf({ status: 'confirmed', kind: 'guarantee', state: 'secured' })
    const container = await mount()
    expect(container.textContent).toContain('Votre carte est enregistrée')
    expect(container.textContent).toContain("aucun débit pour l'instant")
    expect(container.textContent).toMatch(/30,00\s€/)
    expect(container.textContent).toContain('Carte garantie')
  })

  it('does not claim a payment that was never taken when the team confirmed the booking itself', async () => {
    state.page = pageOf({ status: 'confirmed', state: 'awaiting' })
    const container = await mount()
    expect(container.textContent).toContain("aucun paiement n'est plus attendu")
    expect(container.textContent).not.toContain('Votre acompte')
    // The terms were never applied to money: they are not recited as if they were.
    expect(container.textContent).not.toContain('Conditions de remboursement')
  })
})

describe('a booking that ended', () => {
  it('says so, with the refund when there is one, and a way to book again', async () => {
    state.page = pageOf({
      status: 'cancelled_by_restaurant',
      state: 'refunded',
      refundedCents: 4000,
    })
    const container = await mount()
    expect(heading(container)).toBe('Cette réservation est terminée')
    expect(container.textContent).toContain('Le restaurant a dû annuler cette réservation')
    expect(container.textContent).toMatch(/Remboursement de 40,00\s€ effectué/)
    expect(container.querySelector('button')).toBeNull()
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain(
      '/reservation',
    )
  })

  it('says a hold that lapsed released the table, with a link to book again', async () => {
    state.page = pageOf({ status: 'expired' })
    const container = await mount()
    expect(heading(container)).toBe('Le délai est dépassé, la table a été libérée')
    expect(
      [...container.querySelectorAll('a')]
        .find((a) => a.textContent === 'Réserver à nouveau')
        ?.getAttribute('href'),
    ).toBe('/reservation')
  })

  it('reads the server’s own word that the hold ran out, before the clock does', async () => {
    state.page = pageOf({ holdLapsed: true })
    const container = await mount()
    expect(heading(container)).toBe('Le délai est dépassé, la table a été libérée')
  })
})
