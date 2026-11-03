/**
 * What a crawler may read, and what each page tells it.
 *
 * Two statements that have to agree and did not. `sitemap.ts` advertised
 * `/s/{slug}` — a routing scheme that was removed, so every URL in it answered
 * 404 — while `robots.txt` left the basket, the checkout and a signed-in
 * customer's account wide open. Both read this module now, and the sitemap
 * filters every candidate through `isDisallowedPath`, so the contradiction
 * cannot come back.
 *
 * The robots directive lives here too, beside the paths, because it answers the
 * same question one page at a time. Deliberately free of `server-only`: a
 * private page needs the directive and nothing else, and should not have to
 * reach a Convex client to say "do not index me".
 *
 * The public inventory has two authors. The engine's own pages are listed below,
 * in engine zone, where a site may not edit them; the pages a site adds are
 * listed in its own `site/routes.ts` and read through `lib/site-routes.ts`. Both
 * end up in `PUBLIC_STOREFRONT_ROUTES`, which is what `sitemap.ts` and
 * `tests/seo/sitemap-robots.test.ts` read.
 */

import { z } from "zod"
import {
  siteRoutes,
  type ChangeFrequency,
  type ResolvedSiteRoute,
} from "@/lib/site-routes"

// ---------------------------------------------------------------------------
// Robots directives
// ---------------------------------------------------------------------------

export interface RobotsDirective {
  index: boolean
  follow: boolean
}

/** What a page gets when nothing says otherwise. */
export const INDEXABLE: RobotsDirective = { index: true, follow: true }

/**
 * Baskets, checkouts, accounts, order confirmations, tracking links.
 *
 * Not "unimportant pages" — pages that hold one customer's order. A tracking
 * token in a search result is a stranger reading someone's dinner.
 */
export const PRIVATE_PAGE: RobotsDirective = { index: false, follow: false }

/**
 * The same refusal in the shape Next.js writes into `<head>`.
 *
 * A private page exports this directly rather than going through the CMS
 * metadata builder: it has no canonical worth publishing, no Open Graph card
 * anyone should share, and no reason to ask Convex for the establishment's
 * name. What it needs is a title that is the restaurant's rather than the
 * engine's, and this.
 */
export const PRIVATE_PAGE_METADATA = {
  index: false,
  follow: false,
  googleBot: { index: false, follow: false },
} as const

/**
 * The words a robots directive is allowed to contain.
 *
 * The CMS offers four combinations (`packages/cms/src/registry/blocks/seoBlock.ts`)
 * and stores the directive itself — `"noindex, nofollow"` — not the French
 * label beside it. Older rows, an import, or an owner who typed into the field
 * before it became a select can still hold `none`, `all`, a single word, or the
 * label form `"Noindex, Nofollow (par défaut)"`, so all of them are read.
 */
const robotsToken = z.enum(["all", "index", "follow", "none", "noindex", "nofollow"])

/** The value as stored: any string, or nothing at all. */
const robotsField = z.string().nullish()

/**
 * Reads a robots directive the way a crawler does.
 *
 * `robots.includes("index")` was the previous implementation, and `"noindex"`
 * contains `"index"` — so `"noindex, nofollow"` parsed to
 * `{ index: true, follow: true }` and every page an owner had marked "do not
 * index" was advertised to Google with a positive directive. The parse is by
 * token now, not by substring.
 *
 * Splitting on non-letters covers every separator the field has ever held:
 * `,`, `;`, whitespace, and the parentheses of a human label. Unknown words are
 * dropped rather than guessed at, and the most restrictive directive wins when
 * a value contradicts itself, which is what Google does with `index, noindex`.
 */
export function parseRobotsDirective(
  value: unknown,
  fallback: RobotsDirective = INDEXABLE,
): RobotsDirective {
  const parsed = robotsField.safeParse(value)
  if (!parsed.success || !parsed.data) return fallback

  const tokens = new Set(
    parsed.data
      .toLowerCase()
      .split(/[^a-z]+/)
      .map((word) => robotsToken.safeParse(word))
      .filter((result) => result.success)
      .map((result) => result.data),
  )

  if (tokens.size === 0) return fallback

  const denied = tokens.has("none")
  const index = denied || tokens.has("noindex")
    ? false
    : tokens.has("index") || tokens.has("all")
      ? true
      : fallback.index
  const follow = denied || tokens.has("nofollow")
    ? false
    : tokens.has("follow") || tokens.has("all")
      ? true
      : fallback.follow

  return { index, follow }
}

// ---------------------------------------------------------------------------
// Route inventory
// ---------------------------------------------------------------------------

/**
 * Declared in `lib/site-routes.ts`, where a site's registry is checked against
 * it, and re-exported so this module keeps answering for the sitemap's terms.
 */
export type { ChangeFrequency }

export interface StorefrontRoute {
  /** App Router path, exactly as the route tree resolves it. */
  path: string
  changeFrequency: ChangeFrequency
  priority: number
}

/**
 * Every fixed public page the ENGINE ships, and nothing else.
 *
 * The storefront has no store segment in its paths: one deployment serves one
 * establishment (or one owner's establishments, chosen in the browser), so
 * these are the real URLs. Per-product and per-article URLs are dynamic and are
 * added by the sitemap from the catalogue.
 *
 * A site's own pages are not here: this is engine zone, and a site may not edit
 * it. They are declared in `site/routes.ts`, and `PUBLIC_STOREFRONT_ROUTES`
 * below is the two lists joined.
 */
export const ENGINE_STOREFRONT_ROUTES: readonly StorefrontRoute[] = [
  { path: "/", changeFrequency: "daily", priority: 1 },
  { path: "/menu", changeFrequency: "daily", priority: 0.9 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.7 },
  { path: "/about", changeFrequency: "monthly", priority: 0.6 },
  { path: "/contact", changeFrequency: "monthly", priority: 0.6 },
  { path: "/store-selector", changeFrequency: "monthly", priority: 0.5 },
  // The engine-owned legal pages. Public by law, and a diner may search for
  // them, so they are listed rather than hidden.
  { path: "/mentions-legales", changeFrequency: "yearly", priority: 0.2 },
  { path: "/cgv", changeFrequency: "yearly", priority: 0.2 },
  { path: "/confidentialite", changeFrequency: "yearly", priority: 0.2 },
]

/**
 * The engine's pages followed by the site's.
 *
 * The engine's come first and win a clash: a site that registers `/about` does
 * not get to change its priority, the entry is ignored, and
 * `tests/seo/site-routes.test.ts` says so. `site` defaults to the registry
 * itself; it is a parameter so a test can hand over a different one.
 */
export function withSiteRoutes(
  engine: readonly StorefrontRoute[],
  site: readonly ResolvedSiteRoute[] = siteRoutes(),
): StorefrontRoute[] {
  const owned = new Set(engine.map((route) => route.path))

  return [
    ...engine,
    ...site
      .filter((route) => !owned.has(route.path))
      .map(({ path, changeFrequency, priority }) => ({ path, changeFrequency, priority })),
  ]
}

/**
 * Every fixed public page of the storefront: the engine's, then the ones this
 * site registered in `site/routes.ts`.
 *
 * This is the inventory. The sitemap lists it, and the route-tree test treats a
 * page as public only if it is here — so a page a site adds but does not
 * register fails the suite, which is the point of the registry rather than a
 * hole in it.
 */
export const PUBLIC_STOREFRONT_ROUTES: readonly StorefrontRoute[] =
  withSiteRoutes(ENGINE_STOREFRONT_ROUTES)

/**
 * Path prefixes no crawler is invited into, in `robots.txt` order.
 *
 * Three kinds sit here. What belongs to one customer (`/account`, `/cart`,
 * `/checkout`, `/order/`, `/track/`); what belongs to the staff (`/dashboard`,
 * the admin screens, `/display/`, `/preview/`, the auth pages); and what is not
 * a page at all (`/api/`). A game QR code is printed on one table and is
 * worthless in a search result, so it joins them.
 *
 * Most of this list is admin, and that is the correction. A route GROUP adds no
 * URL segment, so every page under `app/(admin)` also resolves at its bare
 * top-level path: `/products`, `/orders`, `/settings`, `/team`, `/stores` and
 * the rest answer exactly as `/dashboard/products` does. Only `/dashboard/` was
 * listed, and the admin layout gates client-side — the server still returns 200
 * with an HTML shell — so a crawler indexed the back office of every
 * deployment through the front door nobody had thought to close.
 *
 * Trailing slashes are deliberate, not decorative. `robots.txt` matches by
 * prefix, so `/dashboard/` does NOT match `/dashboard`, and the dashboard index
 * itself was reachable under the old list for the same reason. A rule carries a
 * trailing slash only where the segment has no page of its own (`/api/`,
 * `/display/`, `/game/`, `/invite/`, `/order/`, `/preview/`, `/track/`).
 *
 * Nothing here may swallow a public page, and three pairs sit one character
 * apart: `/contact` against `/content`, `/product/[id]` against `/products`,
 * `/store-selector` against `/stores`. `tests/seo/sitemap-robots.test.ts` walks
 * the real route tree and checks both directions, which is the only reason it
 * is safe to keep these rules this short.
 *
 * A page a site registers is held to the same standard. One named
 * `/products-promo` or `/stores-locator` is swallowed by `/products` or
 * `/stores`: the test names it, and the fix is to rename the route, because this
 * list is not the site's to edit.
 */
export const CRAWLER_DISALLOWED_PATHS: readonly string[] = [
  "/account",
  "/address-test",
  "/api/",
  "/cart",
  "/categories",
  "/checkout",
  "/content",
  "/customers",
  "/dashboard",
  "/display/",
  "/email",
  "/forgot-password",
  "/game/",
  "/games",
  "/inventory",
  "/invite/",
  "/languages",
  "/order/",
  "/orders",
  "/preview/",
  "/products",
  "/promotions",
  "/reservation/manage/",
  "/reservation/payment/",
  "/reservation/waitlist/",
  "/reservation/feedback/",
  "/reset-password",
  "/settings",
  "/setup",
  "/sign-in",
  "/sign-up",
  "/stores",
  "/subscription",
  "/system",
  "/team",
  "/track/",
]

/**
 * Answer engines, named rather than lumped into `*`.
 *
 * A restaurant is exactly the kind of question these are asked — "is it open
 * on Sunday", "do they deliver" — and the same pages that are good for Google
 * are the ones that answer it. They get the same rules as everybody else;
 * naming them is what gives an owner one obvious place to withdraw the
 * invitation, and what stops a future edit tightening `*` without noticing it
 * has also cut the site out of every assistant.
 */
export const ANSWER_ENGINE_USER_AGENTS: readonly string[] = [
  "Applebot-Extended",
  "ChatGPT-User",
  "ClaudeBot",
  "GPTBot",
  "Google-Extended",
  "OAI-SearchBot",
  "PerplexityBot",
]

/**
 * `robots.txt` prefix semantics: a rule matches any path that starts with it.
 */
export function isDisallowedPath(path: string): boolean {
  return CRAWLER_DISALLOWED_PATHS.some((rule) => path.startsWith(rule))
}
