/**
 * CMS SEO Metadata Helper
 *
 * Generates Next.js Metadata from CMS seo block data.
 * Used by generateMetadata() in storefront pages.
 */

import "server-only"
import type { Metadata } from "next"
import { getStorePageData } from "@/lib/convex-server"
import { buildSeoMetadata } from "@/lib/seo"
import type { RobotsDirective } from "@/lib/crawler-policy"
import { getStorefrontSeoContext } from "@/lib/structured-data"
import { resolveCmsRequest } from "./request"

interface SeoOptions {
  pageSlug: string
  fallbackTitle: string
  fallbackDescription?: string
  /**
   * The page's own path, for the canonical URL and `og:url`. Omitting it costs
   * the page its canonical, so pass it.
   */
  pathname?: string
  /**
   * Forces the robots directive, whatever the CMS holds. Private and
   * transactional pages pass `PRIVATE_PAGE`; a page an owner may legitimately
   * hide or publish leaves this alone.
   */
  robots?: RobotsDirective
}

/**
 * Generate Metadata from CMS seo block.
 *
 * Two faults used to stop this reaching the `<head>` at all, and both are
 * fixed — verified by execution, not by reading this paragraph. It required a
 * `storeSlug` cookie that nothing writes, a leftover of the removed
 * `/s/[storeSlug]` routing, so every page fell through to its hard-coded
 * fallback title; it now resolves the establishment itself. And it read the
 * locale from a cookie named `locale` while the app writes `beid_locale`, so
 * the metadata came back in the source language whatever the visitor had
 * picked. `tests/ssr/locale-cookie.test.ts` holds both.
 *
 * A third fault outlived that comment: the robots directive was read with
 * `robots.includes("index")`, and `"noindex"` contains `"index"`. Every page an
 * owner had marked "do not index" was published to Google with
 * `{ index: true, follow: true }`. The parse now lives in `parseRobotsDirective`
 * and is by token; `tests/ssr/seo-metadata.test.ts` holds it.
 */
export async function generateCmsMetadata(options: SeoOptions): Promise<Metadata> {
  const {
    pageSlug,
    fallbackTitle,
    fallbackDescription,
    pathname = "/",
    robots,
  } = options

  const fallback = { fallbackTitle, fallbackDescription, pathname, robots }

  try {
    // Which establishment and language, asked of the same function the page
    // body asks (`getCmsInitialData`): the `<head>` and the text under it come
    // from one fetch and cannot describe two restaurants.
    const { storeSlug, locale } = await resolveCmsRequest()
    if (!storeSlug) return buildSeoMetadata(fallback)

    const { store, cms } = await getStorePageData(storeSlug, pageSlug, locale)
    if (!store || !cms) return buildSeoMetadata(fallback)

    return buildSeoMetadata({
      ...fallback,
      cms,
      siteName: typeof store.name === "string" ? store.name : undefined,
      ...(locale ? { ogLocale: locale } : {}),
    })
  } catch {
    return buildSeoMetadata(fallback)
  }
}

/**
 * Metadata for a page the CMS holds no SEO block for.
 *
 * The basket, the checkout, the account and the order pages have no `seo` block
 * to read — they are not pages an owner writes meta titles for — but they are
 * still pages a crawler will find a link to, and they still need a title that
 * is not the engine's own name. Their robots directive is fixed here rather
 * than left editable.
 *
 * The establishment's name comes from the same memoised lookup the storefront
 * layout already performs on every page, so this costs no extra round trip.
 */
export async function generateStaticPageMetadata(options: {
  title: string
  description?: string
  pathname: string
  robots?: RobotsDirective
}): Promise<Metadata> {
  const { brandName } = await getStorefrontSeoContext()

  return buildSeoMetadata({
    fallbackTitle: options.title,
    fallbackDescription: options.description,
    pathname: options.pathname,
    robots: options.robots,
    ...(brandName ? { siteName: brandName } : {}),
  })
}
