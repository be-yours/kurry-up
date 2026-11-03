// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The footer, as a site can now configure it.
 *
 * It printed « Commandez en ligne, retirez en magasin ou faites-vous livrer
 * directement chez vous » on every site, delivering or not; a fixed set of
 * links — « Box », « Mes commandes », « Nos restaurants » — whose last one led
 * to a selector even on a deployment with a single establishment; and three
 * social icons, so a client on Instagram, TikTok and Snapchat got one.
 *
 * What is pinned is what an owner can now do, and what a fresh site no longer
 * says: nothing about delivery, links in the visitor's language, the selector
 * only where there is a choice to make, an owner's own links in place of the
 * engine's, a column that can be hidden, and an `href` that is never
 * `javascript:`.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fr from '@/lib/i18n/locales/fr.json'
import en from '@/lib/i18n/locales/en.json'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  storeCount: 1,
  /** block key → field key → text, as the CMS would hand it over. */
  cms: {} as Record<string, Record<string, string>>,
}))

vi.mock('convex/react', () => ({
  useMutation: () => async () => undefined,
}))

vi.mock('@/lib/hooks', () => ({
  useStoreId: () => ({
    storeId: 'store_1',
    store: { name: 'Maison Binato' },
    storeCount: state.storeCount,
    isLoading: false,
  }),
}))

vi.mock('@/lib/cms/useCmsPage', () => ({
  useCmsPage: () => ({
    isLoading: false,
    pageMeta: null,
    block: (blockKey: string) => ({
      values: {},
      field: (fieldKey: string) => ({
        text: state.cms[blockKey]?.[fieldKey] ?? null,
        mediaUrl: null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: undefined,
      }),
    }),
  }),
}))

const mounted: Array<{ root: Root; container: HTMLElement }> = []

/** Put the language store where a storefront that has loaded its catalogues is. */
async function speak(locale: 'fr' | 'en') {
  const { useLanguageStore } = await import('@be-yours/restaurant')
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

beforeEach(async () => {
  state.storeCount = 1
  state.cms = {}
  await speak('fr')
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mountFooter(): Promise<HTMLElement> {
  const { StorefrontFooter } = await import('@/components/storefront/storefront-footer')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<StorefrontFooter />)
  })
  return container
}

/** The links of the column titled `title` (its `<nav>` carries that name), or null. */
function column(container: HTMLElement, title: string) {
  const nav = container.querySelector(`nav[aria-label="${title}"]`)
  if (!nav) return null
  return [...nav.querySelectorAll('a')].map((a) => ({
    label: a.textContent,
    href: a.getAttribute('href'),
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
  }))
}

describe("a fresh site's footer", () => {
  test('says nothing about delivery', async () => {
    const container = await mountFooter()

    expect(container.textContent).not.toMatch(/livr/i)
    expect(container.textContent).not.toContain('faites-vous')
    // The client's stylesheet hid the engine's sentence with
    // `.storefront-footer-cols > div:first-child > p`; there is no such
    // paragraph to hide now.
    expect(container.querySelector('.storefront-footer-cols > div:first-child > p')).toBeNull()
  })

  test("offers the engine's links, in the visitor's language and without « Box »", async () => {
    const container = await mountFooter()

    expect(column(container, 'Navigation')).toEqual([
      expect.objectContaining({ label: 'Menu', href: '/menu' }),
      expect.objectContaining({ label: 'Panier', href: '/cart' }),
      expect.objectContaining({ label: 'Mes commandes', href: '/account/orders' }),
      expect.objectContaining({ label: 'Mes favoris', href: '/account/favorites' }),
    ])
    expect(container.textContent).not.toContain('Box')
  })

  test('sends no visitor to a selector when there is one establishment', async () => {
    const container = await mountFooter()

    expect(column(container, 'Liens utiles')).toEqual([
      expect.objectContaining({ label: 'Mon compte', href: '/account' }),
      expect.objectContaining({ label: 'Mes adresses', href: '/account/addresses' }),
    ])
    expect(container.querySelector('a[href="/store-selector"]')).toBeNull()
  })

  test('keeps the selector link where there is a choice to make', async () => {
    state.storeCount = 2
    const container = await mountFooter()

    expect(column(container, 'Liens utiles')).toContainEqual(
      expect.objectContaining({ label: 'Nos restaurants', href: '/store-selector' }),
    )
  })

  test("follows the visitor's language", async () => {
    await speak('en')
    state.storeCount = 2
    const container = await mountFooter()

    expect(column(container, 'Navigation')?.map((l) => l.label)).toEqual([
      'Menu',
      'Cart',
      'My orders',
      'My favourites',
    ])
    expect(column(container, 'Useful links')?.map((l) => l.label)).toEqual([
      'My account',
      'My addresses',
      'Our restaurants',
    ])
  })

  test('lays out four columns', async () => {
    const container = await mountFooter()

    expect(container.querySelector('.storefront-footer-cols')?.className).toContain(
      'lg:grid-cols-4',
    )
  })
})

describe('what an owner can configure', () => {
  test('writes their own sentence under the name', async () => {
    state.cms = { footer: { tagline: 'Cuisine antillaise et traiteur à La Défense' } }
    const container = await mountFooter()

    const sentence = container.querySelector('.storefront-footer-cols > div:first-child > p')
    expect(sentence?.textContent).toBe('Cuisine antillaise et traiteur à La Défense')
  })

  test("replaces a column's links with their own, and keeps the other column", async () => {
    state.cms = {
      footerNav: {
        title: 'La maison',
        link1Label: 'Événements',
        link1Url: '/evenements',
        link2Label: 'Réserver',
        link2Url: 'https://www.thefork.fr/restaurant/x',
        link3Label: 'Écrire',
        link3Url: 'mailto:bonjour@maisonbinato.fr',
      },
    }
    const container = await mountFooter()

    expect(column(container, 'Navigation')).toBeNull()
    expect(column(container, 'La maison')).toEqual([
      expect.objectContaining({ label: 'Événements', href: '/evenements', target: null }),
      expect.objectContaining({
        label: 'Réserver',
        href: 'https://www.thefork.fr/restaurant/x',
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
      expect.objectContaining({
        label: 'Écrire',
        href: 'mailto:bonjour@maisonbinato.fr',
        target: null,
      }),
    ])
    // The engine's links are gone from that column, not appended to.
    expect(container.querySelector('a[href="/cart"]')).toBeNull()
    // …and untouched in the other one.
    expect(column(container, 'Liens utiles')?.map((l) => l.label)).toEqual([
      'Mon compte',
      'Mes adresses',
    ])
  })

  test('never prints an address it would not trust, nor a link with half its parts', async () => {
    state.cms = {
      footerUseful: {
        link1Label: 'Piège',
        link1Url: 'javascript:alert(1)',
        link2Label: 'Autre piège',
        link2Url: '//evil.example',
        link3Label: 'Sans adresse',
        link4Url: '/sans-texte',
        link5Label: 'Légitime',
        link5Url: '/a-propos',
      },
    }
    const container = await mountFooter()

    expect(column(container, 'Liens utiles')).toEqual([
      expect.objectContaining({ label: 'Légitime', href: '/a-propos' }),
    ])
    expect(container.innerHTML).not.toContain('javascript:')
    expect(container.innerHTML).not.toContain('evil.example')
  })

  test('hides a column, and the grid closes up around the rest', async () => {
    state.cms = { footerUseful: { display: 'hide' } }
    const container = await mountFooter()

    expect(column(container, 'Liens utiles')).toBeNull()
    expect(column(container, 'Navigation')).not.toBeNull()
    expect(container.querySelector('.storefront-footer-cols')?.className).toContain(
      'lg:grid-cols-3',
    )
  })

  test('hides both, leaving the brand and the newsletter', async () => {
    state.cms = { footerNav: { display: 'hide' }, footerUseful: { display: 'hide' } }
    const container = await mountFooter()

    expect(
      container.querySelectorAll("nav[aria-label]:not([aria-label='Informations légales'])"),
    ).toHaveLength(0)
    expect(container.querySelector('.storefront-footer-cols')?.className).toContain(
      'lg:grid-cols-2',
    )
    expect(container.querySelector('input[type="email"]')).not.toBeNull()
  })

  test("keeps the owner's links in a hidden column out of the page", async () => {
    state.cms = { footerNav: { display: 'hide', link1Label: 'Caché', link1Url: '/cache' } }
    const container = await mountFooter()

    expect(container.querySelector('a[href="/cache"]')).toBeNull()
  })
})

describe('the social icons', () => {
  test("shows Instagram, TikTok and Snapchat for a client on those three, in the engine's order", async () => {
    state.cms = {
      social: {
        snapchat: 'https://www.snapchat.com/add/maisonbinato',
        tiktok: 'https://www.tiktok.com/@maisonbinato',
        instagram: 'https://www.instagram.com/maisonbinato',
      },
    }
    const container = await mountFooter()

    const icons = [...container.querySelectorAll("a[target='_blank'][aria-label]")]
    expect(icons.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Instagram',
      'TikTok',
      'Snapchat',
    ])
    expect(icons.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.instagram.com/maisonbinato',
      'https://www.tiktok.com/@maisonbinato',
      'https://www.snapchat.com/add/maisonbinato',
    ])
    // Each is drawn: a link that held no glyph would be an empty button.
    for (const icon of icons) expect(icon.querySelector('svg')).not.toBeNull()
  })

  test('shows none for a site that configured none', async () => {
    const container = await mountFooter()

    expect(container.querySelector("a[aria-label='TikTok']")).toBeNull()
    expect(container.querySelector("a[aria-label='Snapchat']")).toBeNull()
  })
})
