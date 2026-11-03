/**
 * Resolve the default store slug for legacy redirects.
 *
 * Priority: cookie storeSlug > first published store from Convex.
 * Used only in legacy redirect pages (NOT in /s/[storeSlug]/ pages).
 */

import "server-only"
import { cache } from "react"
import { cookies } from "next/headers"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import { getStoreBySlug } from "@/lib/convex-server"
import { isPublishedStore } from "@be-yours/convex-schema"

/** Module-level cached Convex client (deduped across a single render pass) */
const getClient = cache(() => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is required")
  return new ConvexHttpClient(url)
})

/**
 * Returns the default store slug, or null if no store exists.
 *
 * Memoised per render: `generateCmsMetadata` now falls back to this on every
 * page whose visitor carries no `storeSlug` cookie — which is every visitor,
 * since nothing writes one — and the page body resolves the same store again.
 * Without `cache` that is two `stores.list` round trips per render.
 */
export const resolveDefaultStoreSlug = cache(async (): Promise<string | null> => {
  // 1. Try cookie-based store slug.
  //
  // `getBySlug` used to answer for a draft, and the note here said that was how
  // the admin opened one. It was not: the administration works in ids, from
  // `listAll`. The query is staff-only for drafts since #169, and this render
  // carries no identity, so a cookie can no longer resurrect an unpublished
  // place on its own. The check stays for the staff case — an owner following a
  // stale cookie belongs on the dashboard, not redirected into a storefront
  // that does not exist yet.
  const cookieSlug = (await cookies()).get("storeSlug")?.value
  if (cookieSlug) {
    const store = await getStoreBySlug(cookieSlug)
    if (store && isPublishedStore(store)) return store.slug
  }

  // 2. Fallback: the first published store. `stores.list` has already dropped
  // the drafts, so `stores[0]` is a real storefront and not a half-built one.
  const stores = await getClient().query(api.stores.list, {})
  if (!stores || stores.length === 0) return null

  // Find first open store, or first store
  const openStore = stores.find(
    (s: { status?: string }) => s.status === "open",
  )
  return (openStore ?? stores[0]).slug as string
})
