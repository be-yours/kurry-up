/**
 * A CMS page, read on the server, to hand to the Client Component that draws it.
 *
 * The storefront's CMS-driven pages (`/`, `/about`, `/contact`, `/blog`) are
 * Client Components that read their blocks through `useCmsPage`, a Convex
 * subscription. A subscription has no answer during a server render, so the
 * HTML they produced held the sample copy written in the code ("Bienvenue Chez
 * Nous"), and the owner's words arrived only after a browser had loaded the
 * bundle and opened a socket. The `<title>`, the JSON-LD and the blog articles
 * were already read on the server; the page's own text was the part that was
 * not, and it is the part a crawler or an answer engine reads.
 *
 * The page component calls this, awaits it, and passes the result down as
 * `initialData`. `useCmsPage` renders from it until its own query answers.
 */

import 'server-only'
import { getStorePageData } from '@/lib/convex-server'
import type { CmsInitialData } from './page-data'
import { resolveCmsRequest } from './request'

/**
 * The published copy of `pageSlug` for the establishment and language of this
 * request, or `null` when there is none to give.
 *
 * `null` is not an error. It is what a page with no establishment yet gets, and
 * what any failure gets: the page then renders the sample copy written in the
 * code and the browser fills the owner's words in, exactly as it did before this
 * existed. NEVER THROWS, for the reason `getStorefrontSeoContext` states — a
 * storefront whose backend is briefly unreachable loses some of its words, it
 * does not lose the page.
 *
 * It shares `getStorePageData` with `generateCmsMetadata`, and asks the same
 * `resolveCmsRequest`, so a page's `<head>` and body come from one fetch and one
 * establishment per render.
 */
export async function getCmsInitialData(pageSlug: string): Promise<CmsInitialData | null> {
  try {
    const { storeSlug, locale } = await resolveCmsRequest()
    if (!storeSlug) return null

    const { store, cms } = await getStorePageData(storeSlug, pageSlug, locale)
    if (!store || !cms?.data) return null

    return { storeId: String(store._id), locale: cms.locale, data: cms.data }
  } catch {
    return null
  }
}
