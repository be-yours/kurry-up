// @vitest-environment node
/// <reference types="vite/client" />

/**
 * The first HTML of a CMS-driven page already holds the owner's words.
 *
 * THE DEFECT. `/`, `/about`, `/contact` and `/blog` are client components that
 * read their blocks through a Convex `useQuery`, and a query has no answer
 * during a server render. So the HTML they were sent in said "Bienvenue Chez
 * Nous", "Une passion pour la cuisine" and "On est là pour vous" — the code's
 * sample copy — and the owner's words only arrived once a browser had loaded
 * the bundle, opened a socket and heard back. A crawler or an answer engine that
 * runs no JavaScript never got further than the sample copy, while the page's
 * `<title>`, its Restaurant JSON-LD and the blog articles were already read on
 * the server.
 *
 * WHAT THIS PINS. Not that a helper was called: that the HTML `renderToString`
 * produces from the real page — the real server fetch, the real accessors, the
 * real component — contains the CMS text and does not contain the sample copy.
 * Only the network edge is replaced (`ConvexHttpClient`, the cookie jar) and the
 * browser-only hooks, which have no answer on a server either.
 *
 * The other half of the contract, that this HTML hydrates without a mismatch
 * and that the live query takes over afterwards, is in `cms-hydration.test.tsx`.
 */

import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// ---------------------------------------------------------------------------
// The server, as far as these pages can tell
// ---------------------------------------------------------------------------

const cookieJar = new Map<string, string>()

/** What the fake Convex deployment answers. Reset before every test. */
const backend = vi.hoisted(() => ({
  stores: [] as Array<Record<string, unknown>>,
  /** `getPageBlocks` answers, keyed `<storeId>:<pageSlug>`. */
  pages: new Map<string, unknown>(),
  /** Make every query throw, as an unreachable deployment does. */
  down: false,
  /** `<functionName> <json args>` for every query sent, in order. */
  calls: [] as string[],
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

/**
 * The network edge, and the only place this file stands in for the backend.
 * Everything between `getStorePageData` and the rendered markup is real.
 */
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    async query(reference: never, args: Record<string, unknown>) {
      const name = getFunctionName(reference)
      backend.calls.push(`${name} ${JSON.stringify(args)}`)
      if (backend.down) throw new Error('fetch failed')

      switch (name) {
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

// A server render has no live query: `useQuery` answers `undefined` until a
// socket exists, which is the very thing that left the sample copy in the HTML.
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({}),
}))

let searchParams = ''

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParams),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {} }),
  usePathname: () => '/',
  useParams: () => ({}),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The text a visitor with no JavaScript would read out of this HTML. */
function visibleText(html: string): string {
  const body = new JSDOM(html).window.document.body
  return (body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Run a route's page the way the server does, and return what it would say. */
async function render(load: () => Promise<{ default: () => unknown }>): Promise<string> {
  const { default: Page } = await load()
  const element = (await Page()) as ReactElement
  return visibleText(renderToString(element))
}

const home = () => render(() => import('@/app/(storefront)/page'))
const about = () => render(() => import('@/app/(storefront)/about/page'))
const contact = () => render(() => import('@/app/(storefront)/contact/page'))
const blog = () => render(() => import('@/app/(storefront)/blog/page'))

/** Publish a page of CMS content for an establishment. */
function publish(storeId: string, pageSlug: string, payload: unknown) {
  backend.pages.set(`${storeId}:${pageSlug}`, payload)
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://convex.test')
  cookieJar.clear()
  backend.stores = [STORE]
  backend.pages.clear()
  backend.down = false
  backend.calls.length = 0
  searchParams = ''
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// The four pages
// ---------------------------------------------------------------------------

describe("the owner's words are in the server HTML", () => {
  it('prints the homepage copy, and not the sample copy', async () => {
    publish(
      STORE._id,
      'homepage',
      cmsPage({
        hero: {
          badge: text('Pizzeria napolitaine'),
          title: text('Le feu de bois, {Chez Luigi}'),
          subtitle: text('Pâte levée 48 heures, four à 450 degrés.'),
          ctaLabel: text('Voir la carte'),
          image: image('/api/files/hero.webp', 'Une pizza sortie du four'),
        },
        features: {
          feature1Label: text('Retrait en quinze minutes'),
        },
        trendingMeals: { sectionTitle: text('Les pizzas du moment') },
        categories: {
          badge: text('La carte'),
          sectionTitle: text('Nos familles de pizzas'),
          description: text('Rouges, blanches, et la Luigi.'),
        },
        cta: {
          title: text('Une envie de {pizza} ?'),
          subtitle: text('Commandez avant 21 heures.'),
          buttonText: text('Je commande'),
        },
      }),
    )

    const html = await home()

    expect(html).toContain('Pizzeria napolitaine')
    expect(html).toContain('Le feu de bois, Chez Luigi')
    expect(html).toContain('Pâte levée 48 heures, four à 450 degrés.')
    expect(html).toContain('Voir la carte')
    expect(html).toContain('Retrait en quinze minutes')
    expect(html).toContain('Les pizzas du moment')
    expect(html).toContain('Nos familles de pizzas')
    expect(html).toContain('Une envie de pizza ?')

    expect(html).not.toContain('Bienvenue Chez')
    expect(html).not.toContain('Découvrez nos plats préparés')
    expect(html).not.toContain('Livraison ou retrait')
    expect(html).not.toContain('Nos plats du moment')
    expect(html).not.toContain('Prêt à')
  })

  it('prints the about copy, and not the sample copy', async () => {
    publish(
      STORE._id,
      'about',
      cmsPage({
        hero: {
          badge: text('Depuis 1987'),
          title: text('Trois générations de {pizzaiolos}'),
          subtitle: text('Une cuisine de quartier, rue des Martyrs.'),
        },
        story: {
          badge: text('Notre histoire'),
          title: text('Du four de Naples à la {rue}'),
          description: text('Luigi a ouvert le comptoir en 1987.'),
        },
        values: {
          badge: text('Ce qui compte'),
          title: text('Trois {promesses}'),
          value1Title: text('Farine italienne'),
          value1Description: text('Moulue à la pierre à Caputo.'),
          value2Title: text('Levain maison'),
          value2Description: text('Rafraîchi chaque matin à six heures.'),
          value3Title: text('Four à bois'),
          value3Description: text("Monté à 450 degrés avant l'ouverture."),
        },
        cta: {
          title: text('À table, {maintenant}'),
          subtitle: text('La carte est en ligne.'),
          buttonText: text('Voir la carte'),
        },
      }),
    )

    const html = await about()

    expect(html).toContain('Depuis 1987')
    expect(html).toContain('Trois générations de pizzaiolos')
    expect(html).toContain('Une cuisine de quartier, rue des Martyrs.')
    expect(html).toContain('Du four de Naples à la rue')
    expect(html).toContain('Luigi a ouvert le comptoir en 1987.')
    expect(html).toContain('Farine italienne')
    expect(html).toContain('Moulue à la pierre à Caputo.')
    expect(html).toContain('Levain maison')
    expect(html).toContain('Four à bois')
    expect(html).toContain('À table, maintenant')

    expect(html).not.toContain('Une passion pour la')
    expect(html).not.toContain('Ingrédients Frais')
    expect(html).not.toContain('Fait avec Amour')
    expect(html).not.toContain('Saveurs Authentiques')
    expect(html).not.toContain('De la passion à')
  })

  it('prints the contact copy, and not the sample copy', async () => {
    publish(
      STORE._id,
      'contact',
      cmsPage({
        hero: {
          badge: text('Écrivez-nous'),
          title: text('Une question pour {Luigi} ?'),
          subtitle: text('Nous répondons avant midi.'),
        },
        form: {
          heading: text('Votre message'),
          description: text('Dites-nous tout.'),
          submitLabel: text('Envoyer à Luigi'),
        },
        info: {
          addressTitle: text('Où nous trouver'),
          hoursTitle: text('Quand passer'),
          contactTitle: text('Nous joindre'),
        },
      }),
    )

    const html = await contact()

    expect(html).toContain('Écrivez-nous')
    expect(html).toContain('Une question pour Luigi ?')
    expect(html).toContain('Nous répondons avant midi.')
    expect(html).toContain('Votre message')
    expect(html).toContain('Envoyer à Luigi')
    expect(html).toContain('Où nous trouver')
    expect(html).toContain('Quand passer')
    expect(html).toContain('Nous joindre')

    expect(html).not.toContain('Contactez-nous')
    expect(html).not.toContain('On est là pour')
    expect(html).not.toContain('Envoyez-nous un message')
    expect(html).not.toContain('Envoyer le message')
  })

  it('prints the blog index copy, and not the sample copy', async () => {
    publish(
      STORE._id,
      'blog',
      cmsPage({
        hero: {
          badge: text('Le journal'),
          title: text('Pizza, farine et {saisons}'),
          subtitle: text('Ce qui se passe derrière le comptoir.'),
        },
      }),
    )

    const html = await blog()

    expect(html).toContain('Le journal')
    expect(html).toContain('Pizza, farine et saisons')
    expect(html).toContain('Ce qui se passe derrière le comptoir.')

    expect(html).not.toContain('Notre Blog')
    expect(html).not.toContain('Saveurs, conseils')
    expect(html).not.toContain('Restez informé des dernières nouvelles')
  })
})

// ---------------------------------------------------------------------------
// Which establishment, which language
// ---------------------------------------------------------------------------

describe('which copy the server picks', () => {
  const aboutPage = () =>
    cmsPage(
      {
        hero: {
          badge: text('Notre histoire'),
          title: text('Une cuisine de quartier'),
          subtitle: text('Rue des Martyrs.'),
        },
      },
      withTranslations({
        hero: {
          title: { en: 'A neighbourhood kitchen' },
          subtitle: { en: 'Rue des Martyrs, Paris.' },
        },
      }),
    )

  it('reads the `beid_locale` cookie, as the metadata does', async () => {
    publish(STORE._id, 'about', aboutPage())
    cookieJar.set('beid_locale', 'en')

    const html = await about()

    expect(html).toContain('A neighbourhood kitchen')
    expect(html).toContain('Rue des Martyrs, Paris.')
    expect(html).not.toContain('Une cuisine de quartier')
  })

  it('prints the source language when there is no locale cookie', async () => {
    publish(STORE._id, 'about', aboutPage())

    const html = await about()

    expect(html).toContain('Une cuisine de quartier')
    expect(html).not.toContain('A neighbourhood kitchen')
  })

  it('ignores a locale cookie that is not a locale', async () => {
    // The value reaches a translation lookup, and it is the visitor's.
    publish(STORE._id, 'about', aboutPage())
    cookieJar.set('beid_locale', "en'><script>alert(1)</script>")

    const html = await about()

    expect(html).toContain('Une cuisine de quartier')
    expect(html).not.toContain('alert(1)')
  })

  it('reads the establishment the `storeSlug` cookie names', async () => {
    backend.stores = [STORE, OTHER_STORE]
    publish(STORE._id, 'about', cmsPage({ hero: { title: text('Paris') } }))
    publish(OTHER_STORE._id, 'about', cmsPage({ hero: { title: text('Lyon') } }))
    cookieJar.set('storeSlug', OTHER_STORE.slug)

    const html = await about()

    expect(html).toContain('Lyon')
    expect(html).not.toContain('Paris')
  })

  it('reads the default establishment when the visitor has chosen none', async () => {
    backend.stores = [STORE, OTHER_STORE]
    publish(STORE._id, 'about', cmsPage({ hero: { title: text('Paris') } }))
    publish(OTHER_STORE._id, 'about', cmsPage({ hero: { title: text('Lyon') } }))

    const html = await about()

    expect(html).toContain('Paris')
    expect(html).not.toContain('Lyon')
  })

  it('falls back, field by field, where the owner has cleared a field', async () => {
    publish(
      STORE._id,
      'about',
      cmsPage({
        hero: {
          badge: cleared('Effacé'),
          title: text('Le titre de Luigi'),
        },
      }),
    )

    const html = await about()

    expect(html).toContain('Le titre de Luigi')
    // The cleared badge is the code's sample, not the stale text.
    expect(html).toContain('Notre Histoire')
    expect(html).not.toContain('Effacé')
  })

  it('does not read the draft: preview mode keeps the sample copy for the browser', async () => {
    // `?preview=true` renders the editor's draft, which is fetched behind a
    // login and only ever in the browser. The server holds the published page
    // and must not print it as if it were the draft.
    publish(STORE._id, 'about', cmsPage({ hero: { title: text('Le titre publié') } }))
    searchParams = 'preview=true'

    const html = await about()

    expect(html).not.toContain('Le titre publié')
    expect(html).toContain('Une passion pour la')
  })
})

// ---------------------------------------------------------------------------
// The sample copy is still there when there is nothing else
// ---------------------------------------------------------------------------

describe('the sample copy stays the fallback', () => {
  it('shows it when the page has no CMS content', async () => {
    publish(STORE._id, 'about', emptyCmsPage())

    const html = await about()

    expect(html).toContain('Une passion pour la')
    expect(html).toContain('Fait avec Amour')
  })

  it('shows it when the CMS has never heard of the page', async () => {
    // `getPageBlocks` answers a page with no rows with an empty page; a mocked
    // backend that answers `null` is the same thing seen from the other side.
    const html = await about()

    expect(html).toContain('Une passion pour la')
  })

  it('shows it, and does not throw, when there is no establishment', async () => {
    backend.stores = []

    const html = await about()

    expect(html).toContain('Une passion pour la')
  })

  it('shows it, and does not throw, when the backend is unreachable', async () => {
    // A transient hiccup costs the page its owner's copy until the browser's
    // own connection answers; it must not cost the visitor the page.
    publish(STORE._id, 'about', cmsPage({ hero: { title: text('Le titre de Luigi') } }))
    backend.down = true

    await expect(about()).resolves.toContain('Une passion pour la')
  })

  it('shows it for each of the four pages', async () => {
    // The assertions above name text; this one is the guard on the guard. If a
    // sample string is reworded, the `not.toContain` checks would pass for the
    // wrong reason, so each page's sample copy is pinned here as well.
    expect(await home()).toContain('Bienvenue Chez')
    expect(await about()).toContain('Une passion pour la')
    expect(await contact()).toContain('On est là pour')
    expect(await blog()).toContain('Notre Blog')
  })
})
