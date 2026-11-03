/**
 * A site's own pages: declared once, read by everything that needs them.
 *
 * `docs/CUSTOMIZATION.md` tolerates a brand-new route under `app/(storefront)/`
 * for a page outside the product, and in practice that broke two things. The
 * route-tree test in `sitemap-robots.test.ts` failed on any page absent from the
 * engine's inventory — a file a site may not edit — and the page reached neither
 * `sitemap.xml` nor the navigation, whose links are fixed. `site/routes.ts` is the
 * client-zone registry that fixes all three, and this file holds what it promises.
 *
 * Three layers. The registry is checked first, because it is written by hand in a
 * file the engine does not own. The navigation merge comes next. Last, the
 * acceptance case: one page added to a throwaway route tree, with and without its
 * entry, followed through the guard, the sitemap and the links.
 *
 * What the real registry holds is NOT asserted. It is empty in the template and a
 * client fills it, and this file ships to the client's CI — a test that expected
 * it empty would go red on the first site that used it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DYNAMIC_PUBLIC_ROUTES, routeTree } from './route-tree'

vi.mock('server-only', () => ({}))

// No Convex URL is set below, so the sitemap lists the fixed pages alone and
// never asks for these — they only have to import.
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    async query() {
      return []
    }
  },
}))

vi.mock('@/convex/_generated/api', () => ({
  api: {
    stores: { list: 'stores.list' },
    products: { list: 'products.list' },
    blog: { listPublishedArticles: 'blog.listPublishedArticles' },
  },
}))

process.env.NEXT_PUBLIC_SITE_URL = 'https://chez-luigi.fr'
delete process.env.NEXT_PUBLIC_CONVEX_URL

// The registry as the site really wrote it, imported before any test swaps it.
const { sitePublicRoutes } = await import('@/site/routes')
const { ENGINE_NAV_STEP, mergeNavLinks, resolveSiteRoutes, siteNavLinks } =
  await import('@/lib/site-routes')
const { ENGINE_STOREFRONT_ROUTES, PUBLIC_STOREFRONT_ROUTES, isDisallowedPath, withSiteRoutes } =
  await import('@/lib/crawler-policy')
const realSitemap = (await import('@/app/sitemap')).default

const EVENTS = {
  path: '/evenements',
  changeFrequency: 'monthly',
  priority: 0.6,
  nav: { label: 'Événements', order: 45 },
} as const

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('resolveSiteRoutes', () => {
  it('keeps a complete entry, with the header as the default placement', () => {
    const { routes, problems } = resolveSiteRoutes([EVENTS])

    expect(problems).toEqual([])
    expect(routes).toEqual([
      {
        path: '/evenements',
        changeFrequency: 'monthly',
        priority: 0.6,
        nav: { label: 'Événements', order: 45, placement: 'header' },
      },
    ])
  })

  it('keeps an entry with no nav, which is indexed and linked from nowhere', () => {
    const { routes, problems } = resolveSiteRoutes([
      { path: '/traiteur', changeFrequency: 'yearly', priority: 0.4 },
    ])

    expect(problems).toEqual([])
    expect(routes).toEqual([{ path: '/traiteur', changeFrequency: 'yearly', priority: 0.4 }])
    expect(routes[0]).not.toHaveProperty('nav')
  })

  it('trims a label and keeps the footer placement', () => {
    const { routes } = resolveSiteRoutes([
      { ...EVENTS, nav: { label: '  Événements ', placement: 'footer' } },
    ])

    expect(routes[0]?.nav).toEqual({ label: 'Événements', placement: 'footer' })
  })

  it('keeps the entries in the order the site declared them', () => {
    const { routes } = resolveSiteRoutes([
      { path: '/b', changeFrequency: 'daily', priority: 0.5 },
      { path: '/a', changeFrequency: 'daily', priority: 0.5 },
    ])

    expect(routes.map((route) => route.path)).toEqual(['/b', '/a'])
  })

  it.each([
    ['evenements', 'must start with "/"'],
    ['/evenements/', 'must not end with "/"'],
    ['/evenements?page=2', 'must be made of letters'],
    ['/evenements#haut', 'must be made of letters'],
    ['/événements', 'must be made of letters'],
    ['/even ements', 'must be made of letters'],
    ['/a//b', 'must be made of letters'],
    ['/../secret', 'must be made of letters'],
    ['/blog/[slug]', 'dynamic segment'],
    ['/', 'home page'],
    ['', 'must start with "/"'],
  ])('refuses the path %j', (path, reason) => {
    const { routes, problems } = resolveSiteRoutes([
      { path, changeFrequency: 'monthly', priority: 0.5 },
    ])

    expect(routes).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('sitePublicRoutes[0]')
    expect(problems[0]).toContain(reason)
  })

  it('refuses a path that is not a string', () => {
    const { routes, problems } = resolveSiteRoutes([
      { path: 42, changeFrequency: 'monthly', priority: 0.5 },
    ])

    expect(routes).toEqual([])
    expect(problems).toEqual(['sitePublicRoutes[0]: path must be a string'])
  })

  it('refuses a change frequency the sitemap protocol does not know', () => {
    const { routes, problems } = resolveSiteRoutes([
      { path: '/a', changeFrequency: 'sometimes', priority: 0.5 },
    ])

    expect(routes).toEqual([])
    expect(problems[0]).toContain('changeFrequency must be one of always, hourly')
  })

  it.each([[-0.1], [1.1], [Number.NaN], [Number.POSITIVE_INFINITY], ['0.5'], [undefined]])(
    'refuses the priority %j',
    (priority) => {
      const { routes, problems } = resolveSiteRoutes([
        { path: '/a', changeFrequency: 'daily', priority },
      ])

      expect(routes).toEqual([])
      expect(problems).toEqual(['sitePublicRoutes[0]: priority must be a number from 0 to 1'])
    },
  )

  it('accepts the two ends of the priority range', () => {
    const { routes, problems } = resolveSiteRoutes([
      { path: '/low', changeFrequency: 'daily', priority: 0 },
      { path: '/high', changeFrequency: 'daily', priority: 1 },
    ])

    expect(problems).toEqual([])
    expect(routes).toHaveLength(2)
  })

  it('reports everything wrong with an entry, not only the first thing', () => {
    const { problems } = resolveSiteRoutes([
      { path: 'evenements', changeFrequency: 'sometimes', priority: 2 },
    ])

    expect(problems).toHaveLength(3)
  })

  it('names the entry a problem is about', () => {
    const { problems } = resolveSiteRoutes([
      EVENTS,
      { path: '/bad path', changeFrequency: 'daily', priority: 0.5 },
    ])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^sitePublicRoutes\[1\]:/)
  })

  it('keeps the first of two entries for the same path', () => {
    const { routes, problems } = resolveSiteRoutes([
      { path: '/traiteur', changeFrequency: 'daily', priority: 0.9 },
      { path: '/traiteur', changeFrequency: 'yearly', priority: 0.1 },
    ])

    expect(routes).toEqual([{ path: '/traiteur', changeFrequency: 'daily', priority: 0.9 }])
    expect(problems).toEqual([
      'sitePublicRoutes[1]: "/traiteur" is already registered; the first entry wins',
    ])
  })

  it.each([
    [{ label: '' }, 'label must be a non-empty string'],
    [{ label: '   ' }, 'label must be a non-empty string'],
    [{ label: 7 }, 'label must be a non-empty string'],
    [{ label: 'Événements', order: Number.NaN }, 'order must be a finite number'],
    [{ label: 'Événements', order: '45' }, 'order must be a finite number'],
    [{ label: 'Événements', placement: 'sidebar' }, 'placement must be "header" or "footer"'],
    ['Événements', 'must be an object'],
    [null, 'must be an object'],
  ])('keeps the page and drops only its link when nav is %j', (nav, reason) => {
    const { routes, problems } = resolveSiteRoutes([{ ...EVENTS, nav }])

    expect(routes).toHaveLength(1)
    expect(routes[0]).not.toHaveProperty('nav')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('sitePublicRoutes[0].nav')
    expect(problems[0]).toContain(reason)
    expect(problems[0]).toContain('the page stays public but is not linked')
  })

  it("accepts a negative order, which sorts before the engine's first link", () => {
    const { routes, problems } = resolveSiteRoutes([
      { ...EVENTS, nav: { label: 'Promo', order: -1 } },
    ])

    expect(problems).toEqual([])
    expect(routes[0]?.nav?.order).toBe(-1)
  })

  it('never throws, whatever it is handed', () => {
    for (const value of [undefined, null, 3, 'x', {}, [null, 3, 'x', [], {}]]) {
      expect(() => resolveSiteRoutes(value)).not.toThrow()
    }
    expect(resolveSiteRoutes(undefined).problems).toEqual(['sitePublicRoutes must be an array'])
  })
})

describe('the registry this site actually ships', () => {
  // Written by hand in a file the engine does not own, so it is checked here, in
  // the suite a client runs. A failure names the entry and says what is wrong
  // with it; the engine has already dropped the entry by then.
  it('is well formed', () => {
    const { problems } = resolveSiteRoutes(sitePublicRoutes)

    expect(problems, `site/routes.ts: ${problems.join('; ')}`).toEqual([])
  })

  it('claims no path the engine already owns', () => {
    const owned = new Set(ENGINE_STOREFRONT_ROUTES.map((route) => route.path))
    const clashes = sitePublicRoutes.map((route) => route.path).filter((path) => owned.has(path))

    expect(
      clashes,
      `site/routes.ts registers ${clashes.join(', ')}, which the engine ships and lists itself: remove the entry`,
    ).toEqual([])
  })

  it('reaches the public inventory and the sitemap, entry by entry', async () => {
    const { routes } = resolveSiteRoutes(sitePublicRoutes)
    const inventory = PUBLIC_STOREFRONT_ROUTES.map((route) => route.path)
    const urls = (await realSitemap()).map((entry) => entry.url)

    for (const { path } of routes) {
      expect(inventory, `${path} is registered but missing from the inventory`).toContain(path)
      // A path robots.txt swallows is left out of the sitemap on purpose, and
      // `sitemap-robots.test.ts` is the test that names it.
      if (!isDisallowedPath(path)) {
        expect(urls, `${path} is registered but missing from the sitemap`).toContain(
          `https://chez-luigi.fr${path}`,
        )
      }
    }
  })
})

describe('withSiteRoutes', () => {
  const engine = [{ path: '/about', changeFrequency: 'monthly', priority: 0.6 }] as const

  it("lists the engine's pages first, then the site's, without the nav", () => {
    const { routes } = resolveSiteRoutes([EVENTS])

    expect(withSiteRoutes(engine, routes)).toEqual([
      { path: '/about', changeFrequency: 'monthly', priority: 0.6 },
      { path: '/evenements', changeFrequency: 'monthly', priority: 0.6 },
    ])
  })

  it('lets the engine keep a path the site also registered', () => {
    const { routes } = resolveSiteRoutes([
      { path: '/about', changeFrequency: 'daily', priority: 1 },
    ])

    expect(withSiteRoutes(engine, routes)).toEqual([...engine])
  })

  it("is the engine's list alone when the site registered nothing", () => {
    expect(withSiteRoutes(engine, [])).toEqual([...engine])
  })
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('siteNavLinks', () => {
  const { routes } = resolveSiteRoutes([
    {
      path: '/evenements',
      changeFrequency: 'monthly',
      priority: 0.6,
      nav: { label: 'Événements' },
    },
    {
      path: '/traiteur',
      changeFrequency: 'monthly',
      priority: 0.6,
      nav: { label: 'Traiteur', placement: 'footer', order: 5 },
    },
    { path: '/discrete', changeFrequency: 'yearly', priority: 0.2 },
  ])

  it('lists the header links, which is where a link goes by default', () => {
    expect(siteNavLinks('header', routes)).toEqual([{ href: '/evenements', label: 'Événements' }])
  })

  it('lists the footer links, with their order', () => {
    expect(siteNavLinks('footer', routes)).toEqual([
      { href: '/traiteur', label: 'Traiteur', order: 5 },
    ])
  })

  it('lists nothing for a page registered without a nav', () => {
    const hrefs = [...siteNavLinks('header', routes), ...siteNavLinks('footer', routes)].map(
      (link) => link.href,
    )

    expect(hrefs).not.toContain('/discrete')
  })

  it('lists nothing at all when the site registered nothing', () => {
    expect(siteNavLinks('header', [])).toEqual([])
    expect(siteNavLinks('footer', [])).toEqual([])
  })
})

describe('mergeNavLinks', () => {
  const ENGINE = [
    { href: '/', label: 'Accueil' },
    { href: '/menu', label: 'Carte' },
    { href: '/about', label: 'À propos' },
    { href: '/blog', label: 'Journal' },
    { href: '/contact', label: 'Contact' },
  ]
  const labels = (links: readonly { label: string }[]) => links.map((link) => link.label)

  it("counts the engine's links 10, 20, 30…", () => {
    expect(ENGINE_NAV_STEP).toBe(10)
  })

  it("is the engine's links, untouched, when the site has none", () => {
    expect(mergeNavLinks(ENGINE, [])).toEqual(ENGINE)
  })

  it("puts a link with no order after all of the engine's", () => {
    const merged = mergeNavLinks(ENGINE, [{ href: '/evenements', label: 'Événements' }])

    expect(labels(merged)).toEqual([
      'Accueil',
      'Carte',
      'À propos',
      'Journal',
      'Contact',
      'Événements',
    ])
  })

  it("places a link by its order against the engine's 10, 20, 30, 40, 50", () => {
    const between = mergeNavLinks(ENGINE, [{ href: '/evenements', label: 'Événements', order: 45 }])
    const first = mergeNavLinks(ENGINE, [{ href: '/promo', label: 'Promo', order: 5 }])

    expect(labels(between)).toEqual([
      'Accueil',
      'Carte',
      'À propos',
      'Journal',
      'Événements',
      'Contact',
    ])
    expect(labels(first)[0]).toBe('Promo')
  })

  it("lets the engine's link go first on a tie", () => {
    const merged = mergeNavLinks(ENGINE, [{ href: '/evenements', label: 'Événements', order: 30 }])

    expect(labels(merged)).toEqual([
      'Accueil',
      'Carte',
      'À propos',
      'Événements',
      'Journal',
      'Contact',
    ])
  })

  it('keeps the declaration order among links with no order', () => {
    const merged = mergeNavLinks(ENGINE, [
      { href: '/b', label: 'B' },
      { href: '/a', label: 'A' },
    ])

    expect(labels(merged).slice(-2)).toEqual(['B', 'A'])
  })

  it("drops a site link to a page the engine already links, and keeps the engine's label", () => {
    const merged = mergeNavLinks(ENGINE, [{ href: '/about', label: 'Notre histoire', order: 1 }])

    expect(merged).toEqual(ENGINE)
  })

  it('hands back plain links, with no ranking leaking into them', () => {
    const merged = mergeNavLinks(ENGINE, [{ href: '/evenements', label: 'Événements', order: 45 }])

    for (const link of merged) {
      expect(Object.keys(link).sort()).toEqual(['href', 'label'])
    }
  })
})

// ---------------------------------------------------------------------------
// The acceptance case
// ---------------------------------------------------------------------------

describe('a page the site adds, followed end to end', () => {
  let appDir = ''

  beforeEach(() => {
    // The tree a site ends up with after adding one page: nothing of the
    // engine's, because only the new route is in question.
    appDir = mkdtempSync(join(tmpdir(), 'beyours-site-route-'))
    const page = join(appDir, '(storefront)', 'evenements')
    mkdirSync(page, { recursive: true })
    writeFileSync(
      join(page, 'page.tsx'),
      '// SITE-SPECIFIC\nexport default function Page() { return null }\n',
    )
  })

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true })
    vi.doUnmock('@/site/routes')
  })

  /**
   * The app as it behaves with `entries` in `site/routes.ts`.
   *
   * Modules are reloaded each time: the inventory is built when `crawler-policy`
   * is first imported, which is how a build sees it. The same four readers a
   * deployment has — the guard, the sitemap, robots.txt and the links — are
   * asked, and nothing is mocked but the registry itself.
   */
  async function appWith(entries: unknown[]) {
    vi.resetModules()
    vi.doMock('@/site/routes', () => ({ sitePublicRoutes: entries }))

    const [policy, sitemap, robots, links] = await Promise.all([
      import('@/lib/crawler-policy'),
      import('@/app/sitemap'),
      import('@/app/robots'),
      import('@/lib/site-routes'),
    ])

    const rules = robots.default().rules
    const disallowed = (Array.isArray(rules) ? rules : [rules]).flatMap((rule) =>
      Array.isArray(rule.disallow) ? rule.disallow : rule.disallow ? [rule.disallow] : [],
    )
    const blocked = (path: string) => disallowed.some((rule) => path.startsWith(rule))
    const inventory = new Set([
      ...policy.PUBLIC_STOREFRONT_ROUTES.map((route) => route.path),
      ...DYNAMIC_PUBLIC_ROUTES,
    ])
    const engineOwned = new Set(policy.ENGINE_STOREFRONT_ROUTES.map((route) => route.path))

    return {
      /** What `sitemap-robots.test.ts` would report as served to crawlers unguarded. */
      exposed: () =>
        routeTree(appDir)
          .filter((path) => !inventory.has(path))
          .filter((path) => !blocked(path)),
      /**
       * Pages the site registered that the route tree does not serve. The engine's
       * own pages are not asked about: this tree holds none of them.
       */
      stale: () =>
        [...inventory].filter(
          (path) =>
            !engineOwned.has(path) &&
            !DYNAMIC_PUBLIC_ROUTES.includes(path) &&
            !routeTree(appDir).includes(path),
        ),
      /** Public paths robots.txt would block anyway. */
      swallowed: () => [...inventory].filter(blocked),
      sitemapEntries: async () => sitemap.default(),
      sitemapUrls: async () => (await sitemap.default()).map((entry) => entry.url),
      headerLinks: () => links.siteNavLinks('header').map((link) => link.href),
      footerLinks: () => links.siteNavLinks('footer').map((link) => link.href),
    }
  }

  it('with its entry: the guard accepts it, the sitemap lists it, the header links it', async () => {
    const app = await appWith([EVENTS])

    expect(app.exposed()).toEqual([])
    expect(await app.sitemapUrls()).toContain('https://chez-luigi.fr/evenements')
    expect(app.headerLinks()).toEqual(['/evenements'])
  })

  it('without its entry: the guard fails on it, and the sitemap and the header do not know it', async () => {
    const app = await appWith([])

    expect(app.exposed()).toEqual(['/evenements'])
    expect(await app.sitemapUrls()).not.toContain('https://chez-luigi.fr/evenements')
    expect(app.headerLinks()).toEqual([])
    expect(app.footerLinks()).toEqual([])
  })

  it('lists the page with the sitemap hints the site gave it', async () => {
    const app = await appWith([{ ...EVENTS, changeFrequency: 'weekly', priority: 0.9 }])
    const entry = (await app.sitemapEntries()).find((item) => item.url.endsWith('/evenements'))

    expect(entry).toMatchObject({ changeFrequency: 'weekly', priority: 0.9 })
    expect(app.exposed()).toEqual([])
  })

  it('a footer link is in the footer and not in the header', async () => {
    const app = await appWith([{ ...EVENTS, nav: { label: 'Événements', placement: 'footer' } }])

    expect(app.exposed()).toEqual([])
    expect(app.footerLinks()).toEqual(['/evenements'])
    expect(app.headerLinks()).toEqual([])
  })

  it('an entry with no nav is public and linked from nowhere', async () => {
    const app = await appWith([{ path: '/evenements', changeFrequency: 'yearly', priority: 0.3 }])

    expect(app.exposed()).toEqual([])
    expect(await app.sitemapUrls()).toContain('https://chez-luigi.fr/evenements')
    expect(app.headerLinks()).toEqual([])
    expect(app.footerLinks()).toEqual([])
  })

  it("an entry whose page is gone is the inventory's stale row, so the suite says so", async () => {
    rmSync(join(appDir, '(storefront)'), { recursive: true })
    mkdirSync(join(appDir, '(storefront)'), { recursive: true })
    const app = await appWith([EVENTS])

    expect(app.stale()).toEqual(['/evenements'])
  })

  it('an invalid entry does not register the page: the guard still fails on it', async () => {
    const app = await appWith([{ ...EVENTS, path: 'evenements' }])

    expect(app.exposed()).toEqual(['/evenements'])
    expect(await app.sitemapUrls()).not.toContain('https://chez-luigi.fr/evenements')
    expect(app.headerLinks()).toEqual([])
  })

  it('a path that starts like a back-office route is swallowed by robots.txt, and named', async () => {
    // `/products` is a disallow rule for the admin screen; robots.txt matches by
    // prefix, so it takes `/products-promo` with it. The sitemap leaves the page
    // out, and the guard in `sitemap-robots.test.ts` reports it as public but
    // blocked — rename the route, since the rules are not the site's to edit.
    rmSync(join(appDir, '(storefront)'), { recursive: true })
    mkdirSync(join(appDir, '(storefront)', 'products-promo'), { recursive: true })
    writeFileSync(
      join(appDir, '(storefront)', 'products-promo', 'page.tsx'),
      'export default () => null\n',
    )
    const app = await appWith([
      { path: '/products-promo', changeFrequency: 'weekly', priority: 0.5 },
    ])

    expect(app.swallowed()).toEqual(['/products-promo'])
    expect(await app.sitemapUrls()).not.toContain('https://chez-luigi.fr/products-promo')
  })
})
