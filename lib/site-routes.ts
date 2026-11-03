/**
 * The pages a site adds to the storefront, and the one file that declares them.
 *
 * A page outside the product — an events landing page, a catering menu — is a
 * new route file under `app/(storefront)/`. That is the one engine-zone edit the
 * contract tolerates, because a brand-new file cannot conflict with an update.
 * It used to stop there, and three things then went wrong at once:
 * `tests/seo/sitemap-robots.test.ts` failed on any page absent from
 * `PUBLIC_STOREFRONT_ROUTES`, which a site may not edit; the page never reached
 * `sitemap.xml`; and neither the header nor the footer had a place to link it.
 *
 * `site/routes.ts` is that place. It is client zone, empty as shipped and never
 * overwritten, and three readers take their answer from it:
 * `lib/crawler-policy.ts` (the public inventory the sitemap and the route-tree
 * test are built from), `storefront-header.tsx` and `storefront-footer.tsx`.
 *
 * Deliberately free of `server-only` and of Zod. The header and the footer are
 * client components and read this module too, so it has to load in a browser
 * bundle without dragging a validation library behind it.
 *
 * NOTHING HERE THROWS. `crawler-policy` sits behind every private page and every
 * page's metadata, so a typo in a client file must not take the checkout down
 * with it. A malformed entry is dropped instead and reported twice: in the
 * console of `next dev`, and by `tests/seo/site-routes.test.ts`, which is the
 * one that fails the build.
 *
 * ADDITIVE ONLY. An update never rewrites a client's `site/routes.ts`, so the
 * file already out in the field keeps meaning what it meant. A field added to the
 * types below has to be optional, and one removed has to be ignored rather than
 * refused.
 */

import { sitePublicRoutes } from '@/site/routes'

// ---------------------------------------------------------------------------
// The contract a site writes against
// ---------------------------------------------------------------------------

/**
 * The values the sitemap protocol admits for `<changefreq>`.
 *
 * Declared here, the leaf of the import graph, so the registry can be checked at
 * runtime and `lib/crawler-policy.ts` can re-export the type without either
 * module importing the other.
 */
export const CHANGE_FREQUENCIES = [
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
] as const

export type ChangeFrequency = (typeof CHANGE_FREQUENCIES)[number]

/** Where a link goes. The header is the default: it is where a diner looks first. */
export type SiteNavPlacement = 'header' | 'footer'

export interface SiteRouteNav {
  /**
   * The text of the link, in the language of the site. Not translated: the
   * engine's own links follow the language switch and this one does not.
   */
  label: string
  /**
   * Where the link sits among the others of the same placement. The engine's
   * links count 10, 20, 30… in reading order, so `45` falls between the fourth
   * and the fifth. Left out, the link comes after all of them.
   */
  order?: number
  /**
   * `"header"` when left out. A footer link joins the defaults of the « Liens
   * utiles » column, which the owner can replace with links of their own in the
   * admin (« Pied de page ») or hide, and then it goes with them.
   */
  placement?: SiteNavPlacement
}

export interface SitePublicRoute {
  /**
   * The URL path, as the route tree resolves it: `/evenements` for
   * `app/(storefront)/evenements/page.tsx`. A fixed path — a dynamic segment
   * such as `[slug]` cannot be listed without the data that fills it.
   */
  path: string
  /** What the sitemap says about how often the page changes. */
  changeFrequency: ChangeFrequency
  /** What the sitemap says, from 0 to 1, about the page's weight on this site. */
  priority: number
  /** Present, the page is linked. Absent, it is indexed and linked from nowhere. */
  nav?: SiteRouteNav
}

// ---------------------------------------------------------------------------
// Reading the registry
// ---------------------------------------------------------------------------

/** A route as the engine reads it: checked, and with its defaults filled in. */
export interface ResolvedSiteRoute {
  path: string
  changeFrequency: ChangeFrequency
  priority: number
  nav?: { label: string; placement: SiteNavPlacement; order?: number }
}

export interface SiteRoutesResolution {
  /** The entries that can be listed, in the order the site declared them. */
  routes: ResolvedSiteRoute[]
  /** One sentence per thing wrong, naming the entry. Empty when nothing is. */
  problems: string[]
}

/**
 * A URL path segment: the unreserved characters of RFC 3986 and nothing a router
 * or a sitemap could read as syntax — no query, no fragment, no brackets, no
 * space, no accent.
 */
const SEGMENT = /^[A-Za-z0-9._~-]+$/

function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string') return 'path must be a string'
  if (path === '/') return 'the path "/" is the home page, which the engine owns'
  if (!path.startsWith('/')) return `path "${path}" must start with "/"`
  if (path.endsWith('/')) return `path "${path}" must not end with "/"`
  if (/[[\]]/.test(path)) {
    return `path "${path}" has a dynamic segment, which a sitemap cannot list without the data that fills it`
  }
  const segments = path.slice(1).split('/')
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    return `path "${path}" must be made of letters, digits, "-", "_", "." and "~", separated by single slashes`
  }
  return null
}

function isChangeFrequency(value: unknown): value is ChangeFrequency {
  return CHANGE_FREQUENCIES.some((known) => known === value)
}

function isPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * The link half of an entry. A bad one costs the page its link and nothing else:
 * the page is still public, so it stays in the sitemap.
 */
function resolveNav(nav: unknown, where: string, problems: string[]): ResolvedSiteRoute['nav'] {
  if (nav === undefined) return undefined

  const refuse = (reason: string): undefined => {
    problems.push(`${where}.nav: ${reason}; the page stays public but is not linked`)
    return undefined
  }

  if (typeof nav !== 'object' || nav === null) return refuse('must be an object')

  const { label, order, placement } = nav as Record<string, unknown>
  const text = typeof label === 'string' ? label.trim() : ''
  if (text === '') return refuse('label must be a non-empty string')
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    return refuse('order must be a finite number')
  }
  if (placement !== undefined && placement !== 'header' && placement !== 'footer') {
    return refuse('placement must be "header" or "footer"')
  }

  return {
    label: text,
    placement: placement ?? 'header',
    ...(order === undefined ? {} : { order }),
  }
}

/**
 * Checks what a site wrote in `site/routes.ts`.
 *
 * Takes `unknown` on purpose. The type says what a TypeScript file cannot get
 * wrong; this is for everything else — a JavaScript copy, a value computed from
 * somewhere, an entry pasted in half. An entry that cannot be listed is dropped
 * with a sentence saying why. A second entry for the same path is dropped too:
 * the first one wins, as it does in the sitemap.
 */
export function resolveSiteRoutes(entries: unknown): SiteRoutesResolution {
  const routes: ResolvedSiteRoute[] = []
  const problems: string[] = []

  if (!Array.isArray(entries)) {
    return { routes, problems: ['sitePublicRoutes must be an array'] }
  }

  const seen = new Set<string>()

  entries.forEach((entry: unknown, index) => {
    const where = `sitePublicRoutes[${index}]`

    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${where} must be an object`)
      return
    }

    const { path, changeFrequency, priority, nav } = entry as Record<string, unknown>

    // Every refusal of an entry is reported, not the first: a client fixing
    // three things should learn of three, not run the suite three times.
    const issues: string[] = []
    const pathIssue = pathProblem(path)
    if (pathIssue) issues.push(pathIssue)
    if (!isChangeFrequency(changeFrequency)) {
      issues.push(`changeFrequency must be one of ${CHANGE_FREQUENCIES.join(', ')}`)
    }
    if (!isPriority(priority)) issues.push('priority must be a number from 0 to 1')

    if (issues.length > 0) {
      problems.push(...issues.map((issue) => `${where}: ${issue}`))
      return
    }

    // Narrowed by the checks above; TypeScript cannot follow `issues`.
    const url = path as string
    if (seen.has(url)) {
      problems.push(`${where}: "${url}" is already registered; the first entry wins`)
      return
    }
    seen.add(url)

    const resolvedNav = resolveNav(nav, where, problems)
    routes.push({
      path: url,
      changeFrequency: changeFrequency as ChangeFrequency,
      priority: priority as number,
      ...(resolvedNav ? { nav: resolvedNav } : {}),
    })
  })

  return { routes, problems }
}

/**
 * The routes this site registered, checked.
 *
 * Resolved on every call rather than once at import. The registry is a handful of
 * entries, and a test can swap it without reloading the module graph — which
 * would give React two copies in a component test.
 */
export function siteRoutes(): ResolvedSiteRoute[] {
  return resolveSiteRoutes(sitePublicRoutes).routes
}

// A mistake in `site/routes.ts` drops an entry silently, so say so where the
// person who made it is looking. Once, at load, and never in production: the
// suite is what refuses a build, and a visitor's console is not the place.
const registered = resolveSiteRoutes(sitePublicRoutes)
if (registered.problems.length > 0 && process.env.NODE_ENV !== 'production') {
  console.warn(
    `[site/routes.ts] ${registered.problems.length} problem(s); the entries concerned are ignored:\n` +
      registered.problems.map((problem) => `  - ${problem}`).join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavLink {
  href: string
  label: string
}

export interface SiteNavLink extends NavLink {
  order?: number
}

/**
 * What an engine link counts for: 10, 20, 30… in reading order.
 *
 * A site picks its own `order` against these numbers, so they are part of the
 * contract: `45` means "between the fourth and the fifth". Spaced by ten so that
 * a link can be slotted between two without renumbering anything.
 */
export const ENGINE_NAV_STEP = 10

/** A link with no `order` sorts after every link that has one. */
const AFTER_EVERYTHING = Number.MAX_SAFE_INTEGER

/** The links the site registered for one placement, in declaration order. */
export function siteNavLinks(
  placement: SiteNavPlacement,
  routes: readonly ResolvedSiteRoute[] = siteRoutes(),
): SiteNavLink[] {
  return routes.flatMap((route) =>
    route.nav && route.nav.placement === placement
      ? [
          {
            href: route.path,
            label: route.nav.label,
            ...(route.nav.order === undefined ? {} : { order: route.nav.order }),
          },
        ]
      : [],
  )
}

/**
 * The engine's links and the site's, in one list.
 *
 * The engine's keep their order and count 10, 20, 30… ({@link ENGINE_NAV_STEP});
 * a site link lands where its `order` puts it, and after all of them without
 * one. On a tie the engine's link comes first. A site link to a path the engine
 * already links is dropped — the engine's label wins, and a diner is not shown
 * the same destination twice.
 *
 * An engine link comes back as it went in, whatever else it carries: the footer's
 * links know where they lead (`kind`), and a merge that rebuilt them would lose it.
 */
export function mergeNavLinks<T extends NavLink>(
  engine: readonly T[],
  site: readonly SiteNavLink[],
): Array<T | NavLink> {
  const taken = new Set(engine.map((link) => link.href))

  const ranked: Array<{ link: T | NavLink; rank: number }> = [
    ...engine.map((link, index) => ({ link, rank: (index + 1) * ENGINE_NAV_STEP })),
    ...site
      .filter((link) => !taken.has(link.href))
      .map((link) => ({
        link: { href: link.href, label: link.label },
        rank: link.order ?? AFTER_EVERYTHING,
      })),
  ]

  // `sort` is stable, which is what makes "the engine first on a tie" true.
  return ranked.sort((a, b) => a.rank - b.rank).map(({ link }) => link)
}
