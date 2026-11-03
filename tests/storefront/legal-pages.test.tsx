// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The storefront's legal pages, its footer links and the checkout's CGV line.
 *
 * A delivered site took orders and collected diners' personal data with no
 * mentions légales, no CGV and no privacy policy anywhere, and three social
 * icons pointing at `#`. The engine owns the three pages now; what is pinned
 * here is the property that matters most about them: nothing about the
 * establishment is invented. What the owner entered is printed, and what they
 * did not is printed as « non communiqué » — never as a plausible example.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildPublicLegalInfo } from '@be-yours/convex-functions/legalPages'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  legal: undefined as unknown,
  settings: undefined as unknown,
  availability: undefined as unknown,
  cms: {} as Record<string, Record<string, Record<string, string>>>,
}))

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server')
  return {
    useQuery: (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name === 'legalPages:getPublic') return state.legal
      if (name === 'globalSettings:get') return state.settings
      if (name === 'paymentAvailability:get') return state.availability
      return undefined
    },
    useMutation: () => async () => undefined,
  }
})

vi.mock('@/lib/cms/useCmsPage', () => ({
  useCmsPage: (slug: string) => ({
    isLoading: false,
    pageMeta: null,
    block: (blockKey: string) => ({
      values: {},
      field: (fieldKey: string) => ({
        text: state.cms[slug]?.[blockKey]?.[fieldKey] ?? null,
        mediaUrl: null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: undefined,
      }),
    }),
  }),
}))

vi.mock('@/lib/hooks', () => ({
  useStoreId: () => ({ storeId: 'store_1', store: { name: 'Chez Luigi' }, isLoading: false }),
}))

vi.mock('@/hooks/useGooglePlacesAutocomplete', () => ({
  useGooglePlacesAutocomplete: () => ({ inputRef: { current: null } }),
}))

const COMPLETE_SETTINGS = {
  seller: {
    legalName: 'SARL Chez Luigi',
    legalForm: 'SARL',
    address: { street: '1 rue de la Paix', city: 'Lyon', postalCode: '69002' },
    siren: '123456789',
    rcs: 'RCS Lyon 123 456 789',
    shareCapital: 1_000_000,
  },
  siteLegal: {
    publicationDirector: 'Luigi Rossi',
    contactEmail: 'contact@chez-luigi.fr',
    contactPhone: '04 00 00 00 00',
    host: { name: 'Hébergeur SAS', address: '1 avenue du Cloud, Paris', phone: '01 00 00 00 00' },
    mediator: { name: 'Médiateur Exemple', website: 'https://mediateur.example' },
  },
  payments: { cardProvider: 'stripe', paypal: false, cash: true },
  services: { delivery: true, dineIn: true, takeaway: true, clickAndCollect: false },
  delivery: { feeMode: 'fixed', fee: 350, freeAbove: 3000, radius: 5 },
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  state.legal = buildPublicLegalInfo(COMPLETE_SETTINGS)
  state.settings = COMPLETE_SETTINGS
  state.availability = { card: true, cardOffered: true }
  state.cms = {}
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  return container
}

const missingCount = (container: HTMLElement) =>
  container.querySelectorAll('[data-legal-missing]').length

describe('mentions légales', () => {
  test('print the identity the owner entered, and nothing missing', async () => {
    const { LegalNoticeContent } = await import('@/components/storefront/legal')
    const container = await mount(<LegalNoticeContent />)
    const text = container.textContent ?? ''

    expect(container.querySelector('h1')?.textContent).toBe('Mentions légales')
    for (const value of [
      'SARL Chez Luigi',
      '1 rue de la Paix, 69002 Lyon',
      'RCS Lyon 123 456 789',
      'SIREN 123456789',
      'contact@chez-luigi.fr',
      'Luigi Rossi',
      'Hébergeur SAS',
      'Médiateur Exemple',
    ]) {
      expect(text).toContain(value)
    }
    expect(missingCount(container)).toBe(0)
  })

  test('say « non communiqué » for every statement not entered, and invent none', async () => {
    state.legal = buildPublicLegalInfo(null)
    const { LegalNoticeContent, NOT_PROVIDED } = await import('@/components/storefront/legal')
    const container = await mount(<LegalNoticeContent />)
    const text = container.textContent ?? ''

    // Name, seat, registration, e-mail, phone, director, host ×3, mediator.
    expect(missingCount(container)).toBe(10)
    expect(text).toContain(NOT_PROVIDED)
    expect(text).not.toMatch(/SARL|SAS|RCS \w+ \d|@/)
  })

  test('print a mediator name entered without its website', async () => {
    state.legal = buildPublicLegalInfo({
      ...COMPLETE_SETTINGS,
      siteLegal: { ...COMPLETE_SETTINGS.siteLegal, mediator: { name: 'Médiateur Exemple' } },
    })
    const { LegalNoticeContent } = await import('@/components/storefront/legal')
    const container = await mount(<LegalNoticeContent />)
    expect(container.textContent).toContain('Médiateur Exemple')
    expect(missingCount(container)).toBe(1)
  })

  test('never turn a non-https mediator website into a link', async () => {
    state.legal = buildPublicLegalInfo({
      ...COMPLETE_SETTINGS,
      siteLegal: {
        ...COMPLETE_SETTINGS.siteLegal,
        mediator: { name: 'Médiateur Exemple', website: 'javascript:alert(1)' },
      },
    })
    const { LegalNoticeContent } = await import('@/components/storefront/legal')
    const container = await mount(<LegalNoticeContent />)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.some((href) => href.startsWith('javascript:'))).toBe(false)
    expect(container.querySelector('a[href="https://mediateur.example"]')).toBeNull()
  })

  test("render the owner's richtext clause instead of the template", async () => {
    state.cms = {
      'legal-notice': {
        content: { intellectualProperty: '<p>Photos : Studio Exemple.</p>' },
      },
    }
    const { LegalNoticeContent } = await import('@/components/storefront/legal')
    const container = await mount(<LegalNoticeContent />)
    expect(container.textContent).toContain('Photos : Studio Exemple.')
    expect(container.textContent).not.toContain('droit de la propriété intellectuelle')
  })
})

describe('conditions générales de vente', () => {
  test('state the withdrawal-right exclusion for perishable food', async () => {
    const { TermsOfSaleContent } = await import('@/components/storefront/legal')
    const container = await mount(<TermsOfSaleContent />)
    expect(container.textContent).toContain('L221-28')
    expect(container.textContent).toContain('toutes taxes comprises')
  })

  test('list the payment methods switched on and the delivery terms entered', async () => {
    const { TermsOfSaleContent } = await import('@/components/storefront/legal')
    const container = await mount(<TermsOfSaleContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('carte bancaire')
    expect(text).toContain('espèces')
    expect(text).not.toContain('PayPal.')
    expect(text).toContain('rayon de 5 km')
    expect(text).toMatch(/Frais de livraison : 3,50\s€/)
  })

  test("do not mention a card to a cash-only establishment's diners", async () => {
    const cashOnly = {
      ...COMPLETE_SETTINGS,
      payments: { cardProvider: 'none', paypal: false, cash: true },
      services: { ...COMPLETE_SETTINGS.services, delivery: false },
    }
    state.settings = cashOnly
    state.legal = buildPublicLegalInfo(cashOnly)
    const { TermsOfSaleContent } = await import('@/components/storefront/legal')
    const container = await mount(<TermsOfSaleContent />)
    const text = container.textContent ?? ''
    expect(text).not.toContain('carte bancaire')
    expect(text).not.toContain('rayon de')
  })
})

describe('politique de confidentialité', () => {
  test('name the controller, the window privacy.ts enforces and the processors in use', async () => {
    const { PrivacyPolicyContent } = await import('@/components/storefront/legal')
    const container = await mount(<PrivacyPolicyContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('SARL Chez Luigi')
    expect(text).toContain('3 ans')
    expect(text).toContain('supprimées automatiquement')
    expect(text).toContain('Stripe')
    expect(text).toContain('Convex, Inc.')
    expect(text).toContain('Hébergeur SAS')
    expect(text).not.toContain('SumUp')
    expect(text).toContain('CNIL')
  })

  test('do not claim automatic deletion while the owner has paused it', async () => {
    state.legal = buildPublicLegalInfo({
      ...COMPLETE_SETTINGS,
      dataRetention: { customerDataDays: 730, enabled: false, updatedAt: 0 },
    })
    const { PrivacyPolicyContent } = await import('@/components/storefront/legal')
    const container = await mount(<PrivacyPolicyContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('2 ans')
    expect(text).not.toContain('supprimées automatiquement')
  })
})

describe('politique de confidentialité — les réservations de table', () => {
  test('say what a booking, the guest book and the waitlist keep, and for how long', async () => {
    state.legal = buildPublicLegalInfo({
      ...COMPLETE_SETTINGS,
      dataRetention: { customerDataDays: 1095, reservationDays: 365, enabled: true, updatedAt: 0 },
    })
    const { PrivacyPolicyContent } = await import('@/components/storefront/legal')
    const container = await mount(<PrivacyPolicyContent />)
    const text = container.textContent ?? ''
    expect(text).toContain('Votre réservation de table')
    expect(text).toContain('une fiche par client')
    expect(text).toContain('demander à être prévenu')
    // The window the owner set, not the customer one, and the request erased within days.
    expect(text).toContain('conservées 1 an après le repas')
    expect(text).toContain('effacée 3 jours après le repas')
    expect(text).toContain("n'est jamais recopiée dans la fiche client")
    // The thank-you e-mail is the establishment's choice, and its answer stays private.
    expect(text).toContain("Lorsque l'établissement a activé l'e-mail de remerciement")
    expect(text).toContain("n'est lue que par l'équipe de l'établissement")
    expect(text).toContain("elle n'est jamais publiée sur ce site")
  })

  test('say what a deposit or a card guarantee keeps, whatever the establishment has set up', async () => {
    const { PrivacyPolicyContent } = await import('@/components/storefront/legal')
    const container = await mount(<PrivacyPolicyContent />)
    const text = container.textContent ?? ''
    // Unconditional: the notice is the same whether or not a deposit is asked today.
    expect(text).toContain("Lorsqu'un acompte ou une garantie est demandé")
    expect(text).toContain("Le paiement d'une réservation")
    expect(text).toContain('ne conserve aucun numéro de carte')
    expect(text).toContain("le montant, les dates et l'état du paiement")
    // The accounts keep the money's trace even when the booking is erased.
    expect(text).toContain('même si la réservation est effacée')
    expect(text).toContain('libérée après votre venue ou si la réservation est annulée')
  })
})

describe('formatRetention', () => {
  test('reads whole years and months as such, and keeps the rest in days', async () => {
    const { formatRetention } = await import('@/components/storefront/legal')
    expect(formatRetention(1095)).toBe('3 ans')
    expect(formatRetention(365)).toBe('1 an')
    expect(formatRetention(180)).toBe('6 mois')
    expect(formatRetention(760)).toBe('760 jours')
  })
})

describe('the footer', () => {
  test('links the three legal pages', async () => {
    const { StorefrontFooter } = await import('@/components/storefront/storefront-footer')
    const container = await mount(<StorefrontFooter />)
    const nav = container.querySelector('nav[aria-label="Informations légales"]')
    const hrefs = [...(nav?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/mentions-legales', '/cgv', '/confidentialite'])
  })

  test('shows no social icon the owner has not configured', async () => {
    const { StorefrontFooter } = await import('@/components/storefront/storefront-footer')
    const container = await mount(<StorefrontFooter />)
    expect(container.querySelector('a[href="#"]')).toBeNull()
    expect(container.querySelector('a[aria-label="Instagram"]')).toBeNull()
  })

  test('shows a configured network, and refuses a non-https address', async () => {
    state.cms = {
      'storefront-layout': {
        social: {
          instagram: 'https://www.instagram.com/chezluigi',
          facebook: 'javascript:alert(1)',
        },
      },
    }
    const { StorefrontFooter } = await import('@/components/storefront/storefront-footer')
    const container = await mount(<StorefrontFooter />)
    expect(container.querySelector('a[aria-label="Instagram"]')?.getAttribute('href')).toBe(
      'https://www.instagram.com/chezluigi',
    )
    expect(container.querySelector('a[aria-label="Facebook"]')).toBeNull()
  })
})

describe('socialLinks', () => {
  test('keeps https URLs only, in a fixed order', async () => {
    const { socialLinks } = await import('@/lib/social-links')
    expect(
      socialLinks({
        twitter: ' https://x.com/luigi ',
        facebook: 'http://facebook.com/luigi',
        instagram: '',
      }),
    ).toEqual([{ platform: 'twitter', href: 'https://x.com/luigi', label: 'X (Twitter)' }])
  })
})

describe('the checkout', () => {
  test('states acceptance of the CGV beside the order button, with both links', async () => {
    const { CheckoutForm } = await import('@/components/storefront/checkout-form')
    const container = await mount(
      <CheckoutForm
        onSubmit={() => undefined}
        isSubmitting={false}
        addresses={[]}
        isAuthenticated
        services={{ dineIn: true, takeaway: true, delivery: true, clickAndCollect: true }}
      />,
    )
    const line = container.querySelector('[data-testid="checkout-terms-acceptance"]')
    expect(line?.textContent).toContain('vous acceptez nos')
    const hrefs = [...(line?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/cgv', '/confidentialite'])
  })
})
