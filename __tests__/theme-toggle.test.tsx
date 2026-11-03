// @vitest-environment jsdom

/**
 * The visitor's light, dark or system choice, from the setting to the page.
 *
 * WHAT WAS WRONG. `app/providers.tsx` mounted next-themes on
 * `defaultTheme="system" enableSystem` and nothing in the storefront could
 * change it: a diner whose device was dark got the dark storefront with no way
 * out, and a site that ships a light look and a dark one could neither say which
 * to open on nor let anyone choose. The dark-mode block in `globals.css` told
 * that story in a comment; this holds the fix.
 *
 * These tests mount the REAL `Providers`, so what is held is the wiring and not
 * a copy of it: the `theme` prop reaches next-themes as `defaultTheme`, reaches
 * the toggle as "should I exist", and a pick lands on `<html>` and in the
 * browser's storage, which is how it survives a reload. Only what has no place
 * in jsdom is replaced: the Convex client, the auth client and the toaster.
 */

import { act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useLanguageStore } from '@be-yours/restaurant'
import { Providers } from '@/app/providers'
import { ThemeToggle } from '@/components/storefront/theme-toggle'
import en from '@/lib/i18n/locales/en.json'
import fr from '@/lib/i18n/locales/fr.json'
import type { SiteTheme } from '@/lib/site-theme'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('convex/react', () => ({ ConvexReactClient: class {} }))

vi.mock('@convex-dev/better-auth/react', () => ({
  ConvexBetterAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/auth-client', () => ({ authClient: {} }))

vi.mock('sonner', () => ({ Toaster: () => null }))

const html = document.documentElement
const mounted: Array<{ root: Root; container: HTMLElement }> = []

/** What the device reports; jsdom has no `matchMedia`, next-themes needs one. */
let deviceIsDark = false

const LIGHT_SITE: SiteTheme = { default: 'light', toggle: true }

beforeEach(() => {
  deviceIsDark = false
  window.localStorage.clear()
  html.className = ''
  html.removeAttribute('style')
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: deviceIsDark && query.includes('dark'),
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  setLanguage('fr')
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The catalogues the storefront seeds the language store with. */
function setLanguage(locale: 'fr' | 'en') {
  act(() => {
    useLanguageStore.setState({
      locale,
      defaultLocale: 'fr',
      availableLanguages: [],
      overrides: {},
      staticStrings: new Map([
        ['fr', fr],
        ['en', en],
      ]),
      isReady: true,
    })
  })
}

const tree = (site?: SiteTheme) => (
  <Providers theme={site}>
    <ThemeToggle />
  </Providers>
)

function container(): HTMLElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

async function mount(site?: SiteTheme): Promise<HTMLElement> {
  const element = container()
  const root = createRoot(element)
  mounted.push({ root, container: element })
  await act(async () => {
    root.render(tree(site))
  })
  return element
}

const toggle = (within: HTMLElement) =>
  within.querySelector<HTMLButtonElement>('[data-testid="theme-toggle"]')

const label = (within: HTMLElement) => toggle(within)?.getAttribute('aria-label')

async function press(within: HTMLElement) {
  await act(async () => {
    toggle(within)?.click()
  })
}

const stored = () => window.localStorage.getItem('theme')

describe('a site that says nothing about its colour scheme', () => {
  test('follows the visitor’s device, as it always did', async () => {
    deviceIsDark = true
    const page = await mount()

    expect(html.classList.contains('dark')).toBe(true)
    expect(label(page)).toBe('Changer de thème (actuellement : système)')
  })

  test('is light on a light device', async () => {
    await mount()

    expect(html.classList.contains('dark')).toBe(false)
    expect(html.classList.contains('light')).toBe(true)
  })
})

describe('the scheme a site opens in', () => {
  test('beats the device: a site that opens light is light on a dark phone', async () => {
    deviceIsDark = true
    const page = await mount(LIGHT_SITE)

    expect(html.classList.contains('light')).toBe(true)
    expect(html.classList.contains('dark')).toBe(false)
    expect(label(page)).toBe('Changer de thème (actuellement : clair)')
  })

  test('can be dark on a light device', async () => {
    const page = await mount({ default: 'dark', toggle: true })

    expect(html.classList.contains('dark')).toBe(true)
    expect(label(page)).toBe('Changer de thème (actuellement : sombre)')
  })

  test('is not a lock: a choice the visitor already made wins', async () => {
    window.localStorage.setItem('theme', 'dark')
    const page = await mount(LIGHT_SITE)

    expect(html.classList.contains('dark')).toBe(true)
    expect(label(page)).toBe('Changer de thème (actuellement : sombre)')
  })
})

describe('the toggle', () => {
  test('steps light, dark, system, light — on the page and in the browser’s storage', async () => {
    const page = await mount(LIGHT_SITE)

    await press(page)
    expect(label(page)).toBe('Changer de thème (actuellement : sombre)')
    expect(html.classList.contains('dark')).toBe(true)
    expect(stored()).toBe('dark')

    // "System" is the device again, and here the device is dark.
    deviceIsDark = true
    await press(page)
    expect(label(page)).toBe('Changer de thème (actuellement : système)')
    expect(html.classList.contains('dark')).toBe(true)
    expect(stored()).toBe('system')

    await press(page)
    expect(label(page)).toBe('Changer de thème (actuellement : clair)')
    expect(html.classList.contains('light')).toBe(true)
    expect(html.classList.contains('dark')).toBe(false)
    expect(stored()).toBe('light')
  })

  test('remembers the pick on the next visit', async () => {
    const first = await mount(LIGHT_SITE)
    await press(first)
    expect(stored()).toBe('dark')

    // A reload: a new tree over the same browser.
    const second = await mount(LIGHT_SITE)
    expect(label(second)).toBe('Changer de thème (actuellement : sombre)')
    expect(html.classList.contains('dark')).toBe(true)
  })

  test('is a button with a name, and the name is also what hovering shows', async () => {
    const page = await mount()
    const button = toggle(page)

    expect(button?.tagName).toBe('BUTTON')
    expect(button?.getAttribute('type')).toBe('button')
    expect(button?.getAttribute('aria-label')).toBeTruthy()
    expect(button?.getAttribute('title')).toBe(button?.getAttribute('aria-label'))
    // The hook a site's own stylesheet can select, next to `storefront-nav*`.
    expect(button?.classList.contains('storefront-theme-toggle')).toBe(true)
  })

  test('speaks the diner’s language', async () => {
    setLanguage('en')
    const page = await mount(LIGHT_SITE)

    expect(label(page)).toBe('Change theme (currently: light)')
  })

  test('is not on the page when the site turns it off, and the scheme still applies', async () => {
    deviceIsDark = true
    const page = await mount({ default: 'light', toggle: false })

    expect(toggle(page)).toBeNull()
    expect(page.querySelector('button')).toBeNull()
    expect(html.classList.contains('light')).toBe(true)
  })
})

describe('on the full-screen mobile menu', () => {
  /* What is read here is the class list the DOM ends up with, which is a fact
     about the markup and the only thing jsdom can say about a focus ring: the
     menu is painted `--primary`, and the global `outline-ring/50` in
     `globals.css` is `--primary` too, so without a class of its own a keyboard
     user would see no indicator on this control (#725 found the same on the
     account trigger beside it). */
  test('draws its focus ring in ink, on the pair its neighbours use', async () => {
    const element = container()
    const root = createRoot(element)
    mounted.push({ root, container: element })
    await act(async () => {
      root.render(
        <Providers>
          <ThemeToggle variant="overlay" />
        </Providers>,
      )
    })

    const classes = toggle(element)?.classList
    expect(classes?.contains('focus-visible:outline-primary-foreground')).toBe(true)
    // The close button's pair, and the one `UserMenu`'s `overlay` takes.
    expect(classes?.contains('bg-primary-hover')).toBe(true)
    expect(classes?.contains('text-primary-foreground')).toBe(true)
    // And not the hero photograph's white ink, which is the defect #725 fixed.
    expect(classes?.contains('text-white')).toBe(false)
  })
})

describe('hydration', () => {
  test('draws what the server drew, even for a visitor who has already chosen', async () => {
    // The server has no `localStorage`, so it renders the site's default. The
    // icon is what is compared, not the words: during the server pass zustand
    // answers from the language store's INITIAL state, which has no catalogue.
    const markup = renderToString(tree(LIGHT_SITE))
    expect(markup).toContain('lucide-sun')
    expect(markup).not.toContain('lucide-moon')

    // The visitor's browser holds a different choice, and next-themes reads it
    // in the very first client render. Drawing that straight away would not
    // match the markup above.
    window.localStorage.setItem('theme', 'dark')
    const element = container()
    element.innerHTML = markup

    const problems: unknown[] = []
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let root!: Root
    await act(async () => {
      root = hydrateRoot(element, tree(LIGHT_SITE), {
        onRecoverableError: (error) => problems.push(error),
      })
    })
    mounted.push({ root, container: element })

    expect(problems).toEqual([])
    expect(logged).not.toHaveBeenCalled()
    // And once hydration is over it shows what the visitor chose.
    expect(label(element)).toBe('Changer de thème (actuellement : sombre)')
    expect(element.querySelector('.lucide-moon')).not.toBeNull()
  })
})
