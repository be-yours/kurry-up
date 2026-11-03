// @vitest-environment jsdom

/**
 * The links a site registers, in the header and the footer a diner actually sees.
 *
 * `site-routes.test.ts` proves the registry reaches the navigation as DATA: which
 * links `siteNavLinks` hands over and how `mergeNavLinks` orders them. This file
 * proves the two components render that data, because a correct list nobody reads
 * is the failure the registry exists to remove — the header and the footer used to
 * hold fixed links with no slot for one more.
 *
 * The registry is the only thing replaced. It is mutated in place between tests
 * rather than reloaded: a module reset would give React two copies, and a hook
 * called from the second throws.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** `site/routes.ts`, as each test sets it. Emptied and refilled, never reassigned. */
const registry = vi.hoisted(() => [] as unknown[])

/**
 * What the footer reads besides the registry: the owner's blocks in « Layout du
 * storefront », by block then field, and how many establishments the deployment
 * has. Reset before each test.
 */
const owner = vi.hoisted(() => ({
  cms: {} as Record<string, Record<string, string>>,
  storeCount: 2,
}))

vi.mock('@/site/routes', () => ({ sitePublicRoutes: registry }))

let pathname = '/menu'

const STORE = { _id: 'stores_nav', name: 'Le Comptoir' }

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
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
  useQuery: () => [STORE],
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
      field: (field: string) => ({ text: owner.cms[name]?.[field] ?? null }),
    }),
  }),
}))

vi.mock('@/lib/hooks', () => ({
  useStoreId: () => ({
    storeId: STORE._id,
    store: STORE,
    storeCount: owner.storeCount,
    isLoading: false,
  }),
}))

vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({
    storeId: STORE._id,
    store: STORE,
    storeCount: owner.storeCount,
    isLoading: false,
  }),
}))

vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

vi.mock('@be-yours/restaurant', () => ({
  useCartStore: (selector?: (state: unknown) => unknown) => {
    const state = { getItemCount: () => 0, items: [], addItem: () => {} }
    return typeof selector === 'function' ? selector(state) : state
  },
  useStorefrontStoreSelection: (selector?: (state: unknown) => unknown) => {
    const state = { storeId: STORE._id, setStoreId: () => {} }
    return typeof selector === 'function' ? selector(state) : state
  },
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'nav.home': 'Accueil',
        'nav.menu': 'Carte',
        'nav.about': 'Le lieu',
        'nav.blog': 'Journal',
        'nav.contact': 'Contact',
      })[key] ?? key,
  }),
}))

// The chrome's own children drag in trees of their own, and none of them is what
// this file is about.
vi.mock('@/components/storefront/cart-sheet', () => ({ CartSheet: () => null }))
vi.mock('@/components/storefront/store-selector-dropdown', () => ({
  StoreSelectorDropdown: () => null,
}))
vi.mock('@/components/storefront/language-selector-dropdown', () => ({
  LanguageSelectorDropdown: () => null,
}))
vi.mock('@/components/storefront/user-menu', () => ({ UserMenu: () => null }))

// At rest: `motion.div` writes its initial state inline and animates from there
// on a frame loop, and nothing advances frames here.
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
  pathname = '/menu'
  registry.length = 0
  owner.cms = {}
  owner.storeCount = 2
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

/** What a site writes in `site/routes.ts`. */
function register(...entries: unknown[]): void {
  registry.splice(0, registry.length, ...entries)
}

const EVENTS = {
  path: '/evenements',
  changeFrequency: 'monthly',
  priority: 0.6,
  nav: { label: 'Événements', order: 45 },
}

/** The desktop links of the header, which are always in the document. */
const headerHrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('nav.storefront-nav-links a')].map((a) => a.getAttribute('href'))

/**
 * The links of one footer column, found by the name its `<nav>` carries: the
 * owner's title when they typed one, the catalogue key otherwise — which is what
 * the mocked `t` hands back. Empty when the column is not drawn.
 */
const footerColumn = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll(`footer nav[aria-label="${title}"] a`)].map((a) =>
    a.getAttribute('href'),
  )

const ENGINE_HEADER = ['/', '/menu', '/about', '/blog', '/contact']
const ENGINE_USEFUL_LINKS = ['/account', '/account/addresses', '/store-selector']

describe('the header', () => {
  it("holds the engine's five links when the site registered nothing", async () => {
    const container = await mount(<StorefrontHeader />)

    expect(headerHrefs(container)).toEqual(ENGINE_HEADER)
  })

  it('holds a registered link where its order puts it', async () => {
    register(EVENTS)
    const container = await mount(<StorefrontHeader />)

    // 45 sits between the engine's fourth link (Journal, 40) and its fifth
    // (Contact, 50).
    expect(headerHrefs(container)).toEqual([
      '/',
      '/menu',
      '/about',
      '/blog',
      '/evenements',
      '/contact',
    ])
    expect(
      container.querySelector('nav.storefront-nav-links a[href="/evenements"]')?.textContent,
    ).toBe('Événements')
  })

  it("puts a link with no order after the engine's", async () => {
    register({ ...EVENTS, nav: { label: 'Événements' } })
    const container = await mount(<StorefrontHeader />)

    expect(headerHrefs(container)).toEqual([...ENGINE_HEADER, '/evenements'])
  })

  it('holds the link in the mobile menu as well, once it is open', async () => {
    register(EVENTS)
    const container = await mount(<StorefrontHeader />)
    const link = 'a[href="/evenements"]'

    expect(container.querySelectorAll(link)).toHaveLength(1)

    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="accessibility.openMenu"]',
    )
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The desktop bar and the full-screen menu.
    expect(container.querySelectorAll(link)).toHaveLength(2)
  })

  it('holds nothing for a footer link, nor for a page with no link at all', async () => {
    register(
      { ...EVENTS, nav: { label: 'Événements', placement: 'footer' } },
      { path: '/discrete', changeFrequency: 'yearly', priority: 0.2 },
    )
    const container = await mount(<StorefrontHeader />)

    expect(headerHrefs(container)).toEqual(ENGINE_HEADER)
  })

  it('holds nothing once the entry is removed', async () => {
    register(EVENTS)
    const withEntry = await mount(<StorefrontHeader />)
    expect(headerHrefs(withEntry)).toContain('/evenements')

    register()
    const without = await mount(<StorefrontHeader />)

    expect(headerHrefs(without)).toEqual(ENGINE_HEADER)
  })

  it('does not show a second link to a page the engine already links', async () => {
    register({
      path: '/about',
      changeFrequency: 'daily',
      priority: 1,
      nav: { label: 'Notre histoire' },
    })
    const container = await mount(<StorefrontHeader />)

    expect(headerHrefs(container)).toEqual(ENGINE_HEADER)
    expect(container.textContent).not.toContain('Notre histoire')
  })

  it("survives an entry it cannot read, and still shows the engine's links", async () => {
    register(null, 3, { path: 'evenements' }, EVENTS)
    const container = await mount(<StorefrontHeader />)

    expect(headerHrefs(container)).toEqual([
      '/',
      '/menu',
      '/about',
      '/blog',
      '/evenements',
      '/contact',
    ])
  })
})

describe('the footer', () => {
  const usefulLinks = (container: HTMLElement) => footerColumn(container, 'footer.usefulLinks')

  it("holds the engine's three useful links when the site registered nothing", async () => {
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual(ENGINE_USEFUL_LINKS)
  })

  it("holds a footer link after the engine's useful links", async () => {
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual([...ENGINE_USEFUL_LINKS, '/evenements'])
    expect(container.querySelector('footer nav a[href="/evenements"]')?.textContent).toBe(
      'Événements',
    )
  })

  it("places a footer link by its order against the engine's 10, 20, 30", async () => {
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer', order: 15 } })
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual([
      '/account',
      '/evenements',
      '/account/addresses',
      '/store-selector',
    ])
  })

  it('holds nothing for a header link', async () => {
    register(EVENTS)
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual(ENGINE_USEFUL_LINKS)
    expect(container.querySelector('a[href="/evenements"]')).toBeNull()
  })

  it('holds nothing once the entry is removed', async () => {
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const withEntry = await mount(<StorefrontFooter />)
    expect(usefulLinks(withEntry)).toContain('/evenements')

    register()
    const without = await mount(<StorefrontFooter />)

    expect(usefulLinks(without)).toEqual(ENGINE_USEFUL_LINKS)
  })

  it('leaves the legal links where they were', async () => {
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const container = await mount(<StorefrontFooter />)
    const legal = [
      ...container.querySelectorAll('footer nav[aria-label="Informations légales"] a'),
    ].map((a) => a.getAttribute('href'))

    expect(legal).toEqual(['/mentions-legales', '/cgv', '/confidentialite'])
  })

  it('counts only the defaults that are drawn, so a single establishment has no selector link', async () => {
    owner.storeCount = 1
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer', order: 15 } })
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual(['/account', '/evenements', '/account/addresses'])
  })

  it("is one of the column's defaults: links the owner types for it replace it", async () => {
    owner.cms.footerUseful = { link1Label: 'Notre carte', link1Url: '/menu' }
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual(['/menu'])
    expect(container.querySelector('a[href="/evenements"]')).toBeNull()
  })

  it('is not drawn when the owner hides the column', async () => {
    owner.cms.footerUseful = { display: 'hide' }
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const container = await mount(<StorefrontFooter />)

    expect(usefulLinks(container)).toEqual([])
    expect(container.querySelector('a[href="/evenements"]')).toBeNull()
  })

  it('leaves the navigation column to the engine and the owner', async () => {
    register({ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } })
    const container = await mount(<StorefrontFooter />)

    expect(footerColumn(container, 'footer.navigation')).toEqual([
      '/menu',
      '/cart',
      '/account/orders',
      '/account/favorites',
    ])
  })
})
