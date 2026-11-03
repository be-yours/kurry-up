// @vitest-environment jsdom

/**
 * « Réserver » exists only while the establishment's reservation switch says so.
 *
 * Every surface that can show the button — the desktop header, the mobile menu
 * and the footer's owner-typed columns — reads one answer
 * (`resolveReservationEntry` through `useReservationEntry`), and this file holds
 * them to it. The owner's promise is « désactivé : plus aucun bouton », and a
 * promise about a button is only kept if the page is looked at. `off` is also
 * the case that matters most: it must win over a stored external address, so
 * that switching the module off for a season does not leave a link behind.
 *
 * Only the store the visitor is browsing is replaced between tests.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  cms: {} as Record<string, Record<string, string>>,
}))

vi.mock('@/site/routes', () => ({ sitePublicRoutes: [] }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/menu',
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('convex/react', () => ({
  useQuery: () => [{ _id: 'stores_1', name: 'Le Comptoir', ...state.store }],
  useMutation: () => async () => null,
  useAction: () => async () => null,
}))

const apiProxy: unknown = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : apiProxy) },
)
vi.mock('@/convex/_generated/api', () => ({ api: apiProxy }))

vi.mock('@/lib/cms/useCmsPage', () => ({
  useCmsPage: () => ({
    block: (name: string) => ({
      field: (field: string) => ({ text: state.cms[name]?.[field] ?? null }),
    }),
  }),
}))

const useStoreIdMock = () => ({
  storeId: 'stores_1',
  store: { _id: 'stores_1', name: 'Le Comptoir', ...state.store },
  storeCount: 1,
  isLoading: false,
})
vi.mock('@/lib/hooks', () => ({ useStoreId: useStoreIdMock }))
vi.mock('@/lib/hooks/use-store-id', () => ({ useStoreId: useStoreIdMock }))

vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

vi.mock('@be-yours/restaurant', () => ({
  useCartStore: (selector?: (s: unknown) => unknown) => {
    const s = { getItemCount: () => 0, items: [], addItem: () => {} }
    return typeof selector === 'function' ? selector(s) : s
  },
  useStorefrontStoreSelection: (selector?: (s: unknown) => unknown) => {
    const s = { storeId: 'stores_1', setStoreId: () => {} }
    return typeof selector === 'function' ? selector(s) : s
  },
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'nav.home': 'Accueil',
        'nav.menu': 'Carte',
        'nav.about': 'Le lieu',
        'nav.blog': 'Journal',
        'nav.contact': 'Contact',
        'nav.reserve': 'Réserver',
        'accessibility.openMenu': 'Ouvrir le menu',
        'accessibility.closeMenu': 'Fermer le menu',
      })[key] ?? key,
  }),
}))

vi.mock('@/components/storefront/cart-sheet', () => ({ CartSheet: () => null }))
vi.mock('@/components/storefront/store-selector-dropdown', () => ({
  StoreSelectorDropdown: () => null,
}))
vi.mock('@/components/storefront/language-selector-dropdown', () => ({
  LanguageSelectorDropdown: () => null,
}))
vi.mock('@/components/storefront/user-menu', () => ({ UserMenu: () => null }))

vi.mock('framer-motion', () => {
  const passthrough = ({
    children,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) => {
    const {
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      variants: _v,
      whileHover: _wh,
      whileTap: _wt,
      whileInView: _wi,
      viewport: _vp,
      layout: _l,
      layoutId: _li,
      drag: _d,
      style,
      className,
      ...html
    } = rest as Record<string, unknown>
    return (
      <div className={className as string} style={style as React.CSSProperties} {...html}>
        {children}
      </div>
    )
  }
  return {
    motion: new Proxy({}, { get: () => passthrough }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    MotionConfig: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  }
})

const { StorefrontHeader } = await import('@/components/storefront/storefront-header')
const { StorefrontFooter } = await import('@/components/storefront/storefront-footer')

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = Observer
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Observer
})

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  state.store = {}
  state.cms = {}
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

const LINK = 'https://www.thefork.fr/restaurant/le-comptoir'

/** Every « Réserver » anchor in the container, wherever it sits. */
const reserveLinks = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].filter((a) => a.textContent?.trim() === 'Réserver')

/** The mobile menu is closed until its button is pressed. */
async function openMobileMenu(container: HTMLElement) {
  const button = container.querySelector('button[aria-label="Ouvrir le menu"]') as HTMLElement
  await act(async () => button.click())
}

describe('the header', () => {
  it('shows no « Réserver » on a store that never set one', async () => {
    const container = await mount(<StorefrontHeader />)
    await openMobileMenu(container)
    expect(reserveLinks(container)).toHaveLength(0)
  })

  it('shows no « Réserver » when the switch is off — even with an address stored', async () => {
    state.store = { reservationMode: 'off', reservationUrl: LINK }
    const container = await mount(<StorefrontHeader />)
    await openMobileMenu(container)
    expect(reserveLinks(container)).toHaveLength(0)
  })

  it('keeps showing the owner’s tool on a row that predates the switch', async () => {
    state.store = { reservationUrl: LINK }
    const container = await mount(<StorefrontHeader />)
    const [desktop] = reserveLinks(container)
    expect(desktop?.getAttribute('href')).toBe(LINK)
    expect(desktop?.getAttribute('target')).toBe('_blank')
    expect(desktop?.getAttribute('rel')).toContain('noopener')
  })

  it('shows the owner’s tool in the desktop bar AND the mobile menu', async () => {
    state.store = { reservationMode: 'external', reservationUrl: LINK }
    const container = await mount(<StorefrontHeader />)
    expect(reserveLinks(container)).toHaveLength(1)
    await openMobileMenu(container)
    expect(reserveLinks(container)).toHaveLength(2)
  })

  it('routes to the booking page inside the site when the engine’s own is on', async () => {
    state.store = { reservationMode: 'native' }
    const container = await mount(<StorefrontHeader />)
    const [link] = reserveLinks(container)
    expect(link?.getAttribute('href')).toBe('/reservation')
    expect(link?.getAttribute('target')).toBeNull()
  })

  it('refuses an unsafe stored address instead of printing it', async () => {
    state.store = { reservationMode: 'external', reservationUrl: 'javascript:alert(1)' }
    const container = await mount(<StorefrontHeader />)
    await openMobileMenu(container)
    expect(reserveLinks(container)).toHaveLength(0)
  })
})

describe('the footer', () => {
  const typedLinks = {
    footerNav: {
      link1Label: 'Réserver une table',
      link1Url: '/reservation',
      link2Label: 'La carte',
      link2Url: '/menu',
    },
  }
  const navHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll('footer nav[aria-label="footer.navigation"] a')].map((a) =>
      a.getAttribute('href'),
    )

  it('drops a link the owner typed to the booking page when the switch is off', async () => {
    state.cms = typedLinks
    state.store = { reservationMode: 'off' }
    const container = await mount(<StorefrontFooter />)
    expect(navHrefs(container)).toEqual(['/menu'])
  })

  it('keeps that link while the engine’s own booking page is on', async () => {
    state.cms = typedLinks
    state.store = { reservationMode: 'native' }
    const container = await mount(<StorefrontFooter />)
    expect(navHrefs(container)).toEqual(['/reservation', '/menu'])
  })

  it('falls back to the engine’s links when the booking link was all they had typed', async () => {
    state.cms = { footerNav: { link1Label: 'Réserver', link1Url: '/reservation' } }
    state.store = {}
    const container = await mount(<StorefrontFooter />)
    expect(navHrefs(container)).toContain('/menu')
    expect(navHrefs(container)).not.toContain('/reservation')
  })
})
