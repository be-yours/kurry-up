/**
 * The decisions behind the server's copy of a CMS page, one at a time.
 *
 * `cms-first-paint.test.tsx` and `cms-hydration.test.tsx` prove the behaviour
 * end to end. This file holds the rules they rest on where they can be read
 * as a table: how a field resolves, when the server's copy still applies, which
 * language it is read in, and what the server helper hands over when it has
 * nothing to hand over.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OTHER_STORE,
  STORE,
  cleared,
  cmsPage,
  emptyCmsPage,
  image,
  text,
  withTranslations,
} from './cms-fixtures'

const cookieJar = new Map<string, string>()

vi.mock('server-only', () => ({}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
}))

const getStorePageData = vi.fn()
vi.mock('@/lib/convex-server', () => ({
  getStorePageData: (...args: unknown[]) => getStorePageData(...args),
  fetchCmsPageData: vi.fn(),
}))

const resolveDefaultStoreSlug = vi.fn()
vi.mock('@/lib/resolve-default-store', () => ({
  resolveDefaultStoreSlug: () => resolveDefaultStoreSlug(),
}))

const { initialDataFor, localeFor, resolveCmsBlock } = await import('@/lib/cms/page-data')
const { getCmsInitialData } = await import('@/lib/cms/initial-data')

type PageData = Parameters<typeof resolveCmsBlock>[0]

/** `cms.getPageBlocks` answers are the fixtures' shape; the resolver types it. */
const asPage = (page: unknown) => page as PageData

beforeEach(() => {
  cookieJar.clear()
  vi.clearAllMocks()
  resolveDefaultStoreSlug.mockResolvedValue(STORE.slug)
})

// ---------------------------------------------------------------------------
// Reading a field
// ---------------------------------------------------------------------------

describe('resolveCmsBlock', () => {
  const page = asPage(
    cmsPage(
      {
        hero: {
          title: text('Une cuisine de quartier'),
          badge: cleared('Effacé'),
          image: image('/api/files/hero.webp', 'Une pizza'),
        },
      },
      withTranslations({ hero: { title: { en: 'A neighbourhood kitchen' } } }),
    ),
  )

  it('reads a field in the source language when there is no locale', () => {
    expect(resolveCmsBlock(page, 'hero', null).field('title').text).toBe('Une cuisine de quartier')
  })

  it('reads the translation when there is one for the locale', () => {
    expect(resolveCmsBlock(page, 'hero', 'en').field('title').text).toBe('A neighbourhood kitchen')
  })

  it('keeps the source text when the locale has no translation of the field', () => {
    expect(resolveCmsBlock(page, 'hero', 'es').field('title').text).toBe('Une cuisine de quartier')
  })

  it("reads a cleared field as empty, so the code's default applies", () => {
    const badge = resolveCmsBlock(page, 'hero', 'en').field('badge')

    expect(badge.text).toBeNull()
    expect(badge.raw).toBeUndefined()
  })

  it('reads a field that was never written as empty', () => {
    expect(resolveCmsBlock(page, 'hero', 'en').field('subtitle').text).toBeNull()
  })

  it("reads an image's url, media and alt text", () => {
    const hero = resolveCmsBlock(page, 'hero', null).field('image')

    expect(hero.mediaUrl).toBe('/api/files/hero.webp')
    expect(hero.altText).toBe('Une pizza')
    expect(hero.media?.mimeType).toBe('image/webp')
  })

  it('reads a block the page does not have as empty', () => {
    const block = resolveCmsBlock(page, 'footer', 'en')

    expect(block.values).toEqual({})
    expect(block.field('anything').text).toBeNull()
  })

  it('reads no page at all as empty', () => {
    expect(resolveCmsBlock(null, 'hero', 'en').field('title').text).toBeNull()
    expect(resolveCmsBlock(undefined, 'hero', 'en').field('title').text).toBeNull()
  })

  it('reads a page the CMS holds nothing for as empty', () => {
    expect(resolveCmsBlock(asPage(emptyCmsPage()), 'hero', 'en').field('title').text).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Whether the server's copy applies
// ---------------------------------------------------------------------------

describe('initialDataFor', () => {
  const initial = { storeId: STORE._id, locale: null, data: asPage(emptyCmsPage())! }

  it('applies while the browser has not settled on an establishment', () => {
    expect(initialDataFor(initial, undefined)).toBe(initial)
    expect(initialDataFor(initial, null)).toBe(initial)
  })

  it('applies to the establishment it was read for', () => {
    expect(initialDataFor(initial, STORE._id)).toBe(initial)
  })

  it('is dropped for any other establishment', () => {
    expect(initialDataFor(initial, OTHER_STORE._id)).toBeNull()
  })

  it('is nothing when the server sent nothing', () => {
    expect(initialDataFor(null, STORE._id)).toBeNull()
    expect(initialDataFor(undefined, undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Which language
// ---------------------------------------------------------------------------

describe('localeFor', () => {
  const initial = (locale: string | null) => ({
    storeId: STORE._id,
    locale,
    data: asPage(emptyCmsPage())!,
  })

  it("keeps the server's language until the language store is ready", () => {
    expect(localeFor(initial('en'), 'fr', false)).toBe('en')
  })

  it("keeps the server's source language too, rather than the store's default", () => {
    // `null` is "no translation" on the server. The store's literal `"fr"`
    // could be a language the page has a translation for.
    expect(localeFor(initial(null), 'fr', false)).toBeNull()
  })

  it('follows the language store once it is ready', () => {
    expect(localeFor(initial('en'), 'fr', true)).toBe('fr')
    expect(localeFor(initial(null), 'es', true)).toBe('es')
  })

  it('has nothing to agree with when the server sent nothing', () => {
    expect(localeFor(null, 'fr', false)).toBe('fr')
    expect(localeFor(null, 'en', true)).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// What the server hands over
// ---------------------------------------------------------------------------

describe('getCmsInitialData', () => {
  const answer = (cms: unknown) => ({
    store: { _id: STORE._id, slug: STORE.slug, name: STORE.name },
    cms,
  })

  it('hands over the page, the establishment and the language it was read in', async () => {
    const data = cmsPage({ hero: { title: text('Une cuisine de quartier') } })
    getStorePageData.mockResolvedValue(answer({ data, locale: 'en' }))
    cookieJar.set('beid_locale', 'en')

    const initial = await getCmsInitialData('about')

    expect(initial).toEqual({ storeId: STORE._id, locale: 'en', data })
    expect(getStorePageData).toHaveBeenCalledWith(STORE.slug, 'about', 'en')
  })

  it('asks for the establishment the `storeSlug` cookie names', async () => {
    getStorePageData.mockResolvedValue(answer({ data: emptyCmsPage(), locale: null }))
    cookieJar.set('storeSlug', OTHER_STORE.slug)

    await getCmsInitialData('about')

    expect(getStorePageData).toHaveBeenCalledWith(OTHER_STORE.slug, 'about', null)
    expect(resolveDefaultStoreSlug).not.toHaveBeenCalled()
  })

  it('is null when there is no establishment to read', async () => {
    resolveDefaultStoreSlug.mockResolvedValue(null)

    expect(await getCmsInitialData('about')).toBeNull()
    expect(getStorePageData).not.toHaveBeenCalled()
  })

  it('is null when the establishment is not published', async () => {
    getStorePageData.mockResolvedValue({ store: null, cms: null })

    expect(await getCmsInitialData('about')).toBeNull()
  })

  it('is null when the backend answered nothing for the page', async () => {
    getStorePageData.mockResolvedValue(answer({ data: null, locale: null }))

    expect(await getCmsInitialData('about')).toBeNull()
  })

  it('is null, and does not throw, when the backend fails', async () => {
    getStorePageData.mockRejectedValue(new Error('fetch failed'))

    await expect(getCmsInitialData('about')).resolves.toBeNull()
  })

  it('is null, and does not throw, when the lookup of the establishment fails', async () => {
    resolveDefaultStoreSlug.mockRejectedValue(new Error('fetch failed'))

    await expect(getCmsInitialData('about')).resolves.toBeNull()
  })
})
