/**
 * Server-side CMS Page Helper
 *
 * Equivalent of useCmsPage() but for Server Components.
 * Uses ConvexHttpClient instead of React hooks.
 */

import "server-only"
import { cookies } from "next/headers"
import { LOCALE_COOKIE_NAME, normalizeStoredLocale } from "@be-yours/core"
import { fetchCmsPageData } from "@/lib/convex-server"
import {
  resolveCmsBlock,
  type CmsBlockAccessor,
  type CmsFieldAccessor,
  type CmsPageData,
} from "./page-data"
import type { Id } from "@/convex/_generated/dataModel"

// ---------------------------------------------------------------------------
// Types (same interface as useCmsPage for consistency)
// ---------------------------------------------------------------------------

/** The same accessors the hook returns - one resolver reads both (`page-data`). */
export type ServerCmsFieldAccessor = CmsFieldAccessor
export type ServerCmsBlockAccessor = CmsBlockAccessor

export interface ServerCmsPageResult {
  block: (blockKey: string) => ServerCmsBlockAccessor
  /**
   * What the public query says about the page, which is deliberately little.
   *
   * `hasUnpublishedChanges`, `draftUpdatedAt` and `updatedBy` left in #97: they
   * are editorial state and a staff user id, and this query is anonymous. The
   * admin editor reads them from `getAdminPageBlocks`, which is guarded. Nothing
   * on the storefront ever read one.
   */
  pageMeta: {
    hasPublished: boolean
    publishedAt?: number
  } | null
  /**
   * The query's answer as plain JSON, for a Server Component to hand to a
   * Client Component as a prop (`getCmsInitialData`). The accessors above close
   * over functions and cannot cross that boundary; this can. `null` when the
   * query answered nothing.
   */
  data: CmsPageData | null
  /**
   * The language `block()` resolved translations in: the `locale` argument, or
   * else the `beid_locale` cookie. `null` is the source language. It travels
   * with `data` because whoever renders it again, in the browser, has to
   * resolve the same way.
   */
  locale: string | null
}

// ---------------------------------------------------------------------------
// Empty defaults
// ---------------------------------------------------------------------------

const EMPTY_PAGE: ServerCmsPageResult = {
  block: (blockKey) => resolveCmsBlock(null, blockKey, null),
  pageMeta: null,
  data: null,
  locale: null,
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Fetch CMS page data server-side.
 *
 * Rule: if locale is provided → use it directly (don't read cookies).
 *       if locale is absent → fall back to the locale cookie.
 *
 * The cookie is `beid_locale`, which is what `setLocale` writes and what
 * `app/layout.tsx` reads. This function read a cookie called `locale`, which
 * nothing has ever written, so `resolvedLocale` was always null and every
 * server-rendered CMS string came back in the source language.
 */
export async function fetchCmsPage(
  storeId: Id<"stores">,
  pageSlug: string,
  locale?: string,
): Promise<ServerCmsPageResult> {
  // Resolve locale: explicit param > cookie > null
  const resolvedLocale =
    locale ??
    normalizeStoredLocale((await cookies()).get(LOCALE_COOKIE_NAME)?.value)

  const data = (await fetchCmsPageData(storeId, pageSlug)) as CmsPageData | null
  if (!data) return { ...EMPTY_PAGE, locale: resolvedLocale }

  return {
    block: (blockKey: string) => resolveCmsBlock(data, blockKey, resolvedLocale),
    pageMeta: data.pageMeta ?? null,
    data,
    locale: resolvedLocale,
  }
}
