/**
 * Convex Server-Side Client
 *
 * Request-scoped ConvexHttpClient + memoized helpers for SSR.
 * NOT a global singleton — cache() scopes to a single React render (one request).
 */

import "server-only"
import { cache } from "react"
import { cookies } from "next/headers"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

// ---------------------------------------------------------------------------
// Request-scoped client factory
// ---------------------------------------------------------------------------

/**
 * Returns a ConvexHttpClient scoped to the current React server render.
 * cache() deduplicates within a single request — GC'd after.
 */
const getConvexClient = cache(() => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is required")
  return new ConvexHttpClient(url)
})

// ---------------------------------------------------------------------------
// Low-level fetchers (thin wrappers around Convex queries)
// ---------------------------------------------------------------------------

export async function fetchStore(slug: string) {
  return getConvexClient().query(api.stores.getBySlug, { slug })
}

export async function fetchCmsPageData(
  storeId: Id<"stores">,
  pageSlug: string,
) {
  return getConvexClient().query(api.cms.getPageBlocks, { storeId, pageSlug })
}

// ---------------------------------------------------------------------------
// Memoized helpers (avoid double fetch between generateMetadata + page)
// ---------------------------------------------------------------------------

/**
 * Resolve a store by slug — used by layout (no pageSlug needed).
 * Memoized per request.
 */
export const getStoreBySlug = cache(async (storeSlug: string) => {
  return fetchStore(storeSlug)
})

/**
 * Resolve store + CMS page data — used by generateMetadata() + Server Component.
 * Locale is part of the cache key because SEO fields are translatable.
 */
export const getStorePageData = cache(
  async (storeSlug: string, pageSlug: string, locale: string | null) => {
    const store = await getStoreBySlug(storeSlug)
    if (!store) return { store: null, cms: null }

    const { fetchCmsPage } = await import("@/lib/cms/server")
    const cms = await fetchCmsPage(store._id as Id<"stores">, pageSlug, locale ?? undefined)
    return { store, cms }
  },
)

/**
 * The establishment a server render is serving.
 *
 * A server render has none of the selection `useStoreId` makes in the browser:
 * that reads a persisted choice, then geolocation, then falls back to the first
 * published establishment. The `storeSlug` cookie is the only part of it the
 * browser sends back, so it wins here; a crawler arrives without one and lands
 * on the same first published establishment the client would settle on. The two
 * ends therefore agree on a single-establishment deployment, which is what a
 * client site is.
 *
 * Memoized per request: `generateMetadata` and the page body both need it, and
 * one render must not resolve it twice.
 */
export const resolveStorefrontStore = cache(async () => {
  const cookieStore = await cookies()
  const storeSlug = cookieStore.get("storeSlug")?.value
  if (storeSlug) {
    const store = await getStoreBySlug(storeSlug)
    if (store) return store
  }
  const stores = await getConvexClient().query(api.stores.list, {})
  return stores?.[0] ?? null
})
