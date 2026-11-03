// @vitest-environment node
/// <reference types="vite/client" />

/**
 * The server's copy of a CMS page hydrates cleanly, and the live query takes
 * over from it.
 *
 * `cms-first-paint.test.tsx` proves the HTML says the owner's words. That is
 * only half of the contract. The page is a Client Component, so the browser
 * renders it again to hydrate that HTML, and React demands the second render
 * produce what the first one did. The browser's render has no live answer
 * either (a subscription needs a socket), and it has a language store that still
 * holds the literal `"fr"` it was created with. Get either wrong and the page
 * hydrates into an error, or prints the owner's copy, then the sample copy, then
 * the owner's copy again.
 *
 * Each test here takes the HTML the real page produces on the server, hydrates
 * it with the real component in jsdom, and then plays the browser's side of the
 * conversation: the establishments arrive, the live query answers, the language
 * store becomes ready.
 *
 * WHY THE ENVIRONMENT IS `node` AND THE DOM IS ATTACHED BY HAND. The pages
 * import `server-only`, and Vite refuses to resolve that package for a
 * browser-flavoured environment even when the test mocks it — the mock only
 * wins once the import has been resolved. The server half of this file also
 * belongs where a server runs. So the DOM is a JSDOM window put on the global
 * object with Vitest's own `populateGlobal`, which is exactly what its `jsdom`
 * environment does, minus the part that trips over `server-only`.
 */

import type { ReactElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { getFunctionName } from 'convex/server'
import { JSDOM } from 'jsdom'
import { populateGlobal } from 'vitest/environments'
import { useLanguageStore, useStorefrontStoreSelection } from '@be-yours/restaurant'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OTHER_STORE, STORE, cmsPage, text, withTranslations } from './cms-fixtures'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// The server half: the same stand-ins as `cms-first-paint.test.tsx`
// ---------------------------------------------------------------------------

const cookieJar = new Map<string, string>()

const backend = vi.hoisted(() => ({
  stores: [] as Array<Record<string, unknown>>,
  pages: new Map<string, unknown>(),
}))

vi.mock('server-only', () => ({}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
  headers: async () => ({ get: () => null }),
}))

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    async query(reference: never, args: Record<string, unknown>) {
      switch (getFunctionName(reference)) {
        case 'stores:list':
          return backend.stores
        case 'stores:getBySlug':
          return backend.stores.find((s) => s.slug === args.slug) ?? null
        case 'cms:getPageBlocks':
          return backend.pages.get(`${String(args.storeId)}:${String(args.pageSlug)}`) ?? null
        default:
          return null
      }
    }
  },
}))

// ---------------------------------------------------------------------------
// The browser half: a live query we can answer when we choose
// ---------------------------------------------------------------------------

/**
 * What the Convex subscriptions currently know, by function name. Empty is the
 * state of both the server render and the first client render; answering is
 * the socket coming up. A change re-renders every subscriber, as Convex does.
 */
const live = vi.hoisted(() => {
  const answers = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => version,
    get: (name: string) => answers.get(name),
    answer(name: string, value: unknown) {
      answers.set(name, value)
      version++
      for (const listener of [...listeners]) listener()
    },
    reset() {
      answers.clear()
      version++
    },
  }
})

vi.mock('convex/react', async () => {
  const React = await import('react')
  const { getFunctionName: nameOf } = await import('convex/server')
  return {
    useQuery: (reference: never, args?: unknown) => {
      React.useSyncExternalStore(live.subscribe, live.snapshot, live.snapshot)
      return args === 'skip' ? undefined : live.get(nameOf(reference))
    },
    useMutation: () => async () => undefined,
    useAction: () => async () => undefined,
    useConvex: () => ({}),
  }
})

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {} }),
  usePathname: () => '/',
  useParams: () => ({}),
}))

// The browser. `url` matters: an opaque origin has no `localStorage`, which the
// storefront's persisted selection reads.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://luigi.test/',
  pretendToBeVisual: true,
})
populateGlobal(globalThis, dom.window, { bindFunctions: true })

// jsdom has neither; framer-motion's `whileInView` and reduced-motion probe
// reach for them on mount.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
}))

// After the DOM exists: React DOM decides at import time whether there is one.
const { hydrateRoot } = await import('react-dom/client')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mounted: Array<{ root: Root; container: HTMLElement }> = []

/** The HTML the server would send for a route, and the tree it would hydrate. */
async function serverRender(
  load: () => Promise<{ default: () => unknown }>,
): Promise<{ html: string; element: ReactElement }> {
  const { default: Page } = await load()
  const element = (await Page()) as ReactElement
  return { html: renderToString(element), element }
}

const about = () => serverRender(() => import('@/app/(storefront)/about/page'))
const contact = () => serverRender(() => import('@/app/(storefront)/contact/page'))
const home = () => serverRender(() => import('@/app/(storefront)/page'))

/** Hydrate `html` with `element`, as the browser does, and report what React said. */
async function hydrate(html: string, element: ReactElement) {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)

  const recoverable: unknown[] = []
  let root!: Root
  await act(async () => {
    root = hydrateRoot(container, element, {
      onRecoverableError: (error) => recoverable.push(error),
    })
  })
  mounted.push({ root, container })

  return { container, recoverable }
}

const textOf = (container: HTMLElement) => (container.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The browser's connection comes up and the visitor's establishment resolves. */
async function connect(storeId: string, stores: Array<Record<string, unknown>> = [STORE]) {
  await act(async () => {
    live.answer('stores:list', stores)
    useStorefrontStoreSelection.setState({ storeId })
  })
}

let consoleErrors: unknown[][] = []

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://convex.test')
  cookieJar.clear()
  backend.stores = [STORE]
  backend.pages.clear()
  live.reset()
  window.localStorage.clear()
  useStorefrontStoreSelection.setState({ storeId: null })
  useLanguageStore.setState({
    locale: 'fr',
    defaultLocale: 'fr',
    availableLanguages: [],
    overrides: {},
    isReady: false,
  })
  consoleErrors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args)
  })
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Anything React reported about the server HTML and the first client render disagreeing. */
const hydrationComplaints = () =>
  consoleErrors.filter((args) =>
    /hydrat|did not match|didn't match|mismatch/i.test(args.map(String).join(' ')),
  )

const luigiAbout = (title = 'Une cuisine de quartier') =>
  cmsPage(
    {
      hero: {
        badge: text('Depuis 1987'),
        title: text(title),
        subtitle: text('Rue des Martyrs.'),
      },
    },
    withTranslations({
      hero: { title: { en: 'A neighbourhood kitchen' } },
    }),
  )

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

describe("hydrating the server's copy", () => {
  it.each([
    ['about', about, 'Une cuisine de quartier'],
    ['contact', contact, 'Une question pour Luigi'],
    ['homepage', home, 'Le feu de bois'],
  ])('hydrates the server HTML of the %s page without a mismatch', async (page, render, title) => {
    backend.pages.set(
      `${STORE._id}:${page}`,
      cmsPage({ hero: { title: text(title), subtitle: text('Rue des Martyrs.') } }),
    )

    const { html, element } = await render()
    const { container, recoverable } = await hydrate(html, element)

    expect(recoverable).toEqual([])
    expect(hydrationComplaints()).toEqual([])
    expect(textOf(container)).toContain(title)
  })

  it("keeps the owner's copy on screen across hydration", async () => {
    backend.pages.set(`${STORE._id}:about`, luigiAbout())

    const { html, element } = await about()
    const before = textOf(Object.assign(document.createElement('div'), { innerHTML: html }))
    const { container } = await hydrate(html, element)

    expect(before).toContain('Une cuisine de quartier')
    expect(textOf(container)).toBe(before)
  })

  it('would notice a mismatch: a client that holds the copy the server did not', async () => {
    // The guard on the guard. Server HTML rendered with no copy (an unreachable
    // backend), hydrated by a client that has some, is exactly a mismatch; if
    // the detector above could not see one, "no complaints" would mean nothing.
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const withCopy = await about()
    backend.pages.clear()
    const withoutCopy = await about()

    const { recoverable } = await hydrate(withoutCopy.html, withCopy.element)

    expect(recoverable.length + hydrationComplaints().length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The live query takes over
// ---------------------------------------------------------------------------

describe('the live query takes over', () => {
  it("shows an owner's later edit in place of the server's copy", async () => {
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)
    expect(textOf(container)).toContain('Une cuisine de quartier')

    await connect(STORE._id)
    await act(async () => {
      live.answer('cms:getPageBlocks', luigiAbout('Une cuisine de famille'))
    })

    expect(textOf(container)).toContain('Une cuisine de famille')
    expect(textOf(container)).not.toContain('Une cuisine de quartier')
  })

  it('does not flash the sample copy while the live query is still loading', async () => {
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    // The establishments are known, the page is not yet: the previous version
    // of this hook went back to the sample copy here.
    await connect(STORE._id)

    expect(textOf(container)).toContain('Une cuisine de quartier')
    expect(textOf(container)).not.toContain('Une passion pour la')
  })

  it('keeps the sample copy for a field the live page leaves empty', async () => {
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    await connect(STORE._id)
    await act(async () => {
      live.answer('cms:getPageBlocks', { pageMeta: null, blocks: [] })
    })

    // The owner cleared the page: what was a server copy becomes the code's.
    expect(textOf(container)).toContain('Une passion pour la')
    expect(textOf(container)).not.toContain('Une cuisine de quartier')
  })

  it('treats a null answer from the live query as an answer, not as loading', async () => {
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    await connect(STORE._id)
    await act(async () => {
      live.answer('cms:getPageBlocks', null)
    })

    // `undefined` is Convex's "not here yet" and is the only thing the server's
    // copy stands in for. `null` is an answer, and what it says is that there is
    // nothing: the code's copy shows, not a stale one the server read earlier.
    expect(textOf(container)).toContain('Une passion pour la')
    expect(textOf(container)).not.toContain('Une cuisine de quartier')
  })
})

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

describe('the language the server chose', () => {
  it('hydrates English while the language store still holds its default', async () => {
    cookieJar.set('beid_locale', 'en')
    backend.pages.set(`${STORE._id}:about`, luigiAbout())

    const { html, element } = await about()
    expect(html).toContain('A neighbourhood kitchen')

    // The store is at `"fr"`, not ready: resolving with it would print French
    // where the server printed English.
    const { container, recoverable } = await hydrate(html, element)

    expect(recoverable).toEqual([])
    expect(hydrationComplaints()).toEqual([])
    expect(textOf(container)).toContain('A neighbourhood kitchen')
  })

  it('stays English when the live copy arrives before the store is ready', async () => {
    cookieJar.set('beid_locale', 'en')
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    await connect(STORE._id)
    await act(async () => {
      live.answer('cms:getPageBlocks', luigiAbout())
    })

    // English, then French, then English again was the other way to get this
    // wrong: the live data lands first, the store catches up a moment later.
    expect(textOf(container)).toContain('A neighbourhood kitchen')
    expect(textOf(container)).not.toContain('Une cuisine de quartier')

    await act(async () => {
      useLanguageStore.setState({ isReady: true, locale: 'en' })
    })
    expect(textOf(container)).toContain('A neighbourhood kitchen')
  })

  it('follows the visitor once the language store is ready', async () => {
    cookieJar.set('beid_locale', 'en')
    backend.pages.set(`${STORE._id}:about`, luigiAbout())
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    await act(async () => {
      useLanguageStore.setState({ isReady: true, locale: 'fr' })
    })

    expect(textOf(container)).toContain('Une cuisine de quartier')
    expect(textOf(container)).not.toContain('A neighbourhood kitchen')
  })
})

// ---------------------------------------------------------------------------
// Which establishment
// ---------------------------------------------------------------------------

describe('the establishment the server read', () => {
  it("never shows its copy on another establishment's page", async () => {
    backend.stores = [STORE, OTHER_STORE]
    backend.pages.set(`${STORE._id}:about`, cmsPage({ hero: { title: text('Paris') } }))
    const { html, element } = await about()
    const { container } = await hydrate(html, element)
    expect(textOf(container)).toContain('Paris')

    // The visitor had chosen Lyon in an earlier visit; the server did not know.
    await connect(OTHER_STORE._id, [STORE, OTHER_STORE])

    expect(textOf(container)).not.toContain('Paris')
    expect(textOf(container)).toContain('Une passion pour la')

    await act(async () => {
      live.answer('cms:getPageBlocks', cmsPage({ hero: { title: text('Lyon') } }))
    })
    expect(textOf(container)).toContain('Lyon')
    expect(textOf(container)).not.toContain('Paris')
  })

  it('keeps the copy for the establishment it was read for', async () => {
    backend.stores = [STORE, OTHER_STORE]
    backend.pages.set(`${STORE._id}:about`, cmsPage({ hero: { title: text('Paris') } }))
    const { html, element } = await about()
    const { container } = await hydrate(html, element)

    await connect(STORE._id, [STORE, OTHER_STORE])

    expect(textOf(container)).toContain('Paris')
  })
})
