/**
 * Dynamic sitemap.xml
 *
 * Every URL here is a route the app actually serves. It used to emit
 * `/s/{slug}` and `/s/{slug}/menu` — a routing scheme that was removed — so a
 * crawler that read the sitemap was handed a list of 404s and nothing else.
 *
 * The storefront has no store segment in its paths: one deployment serves one
 * owner's establishments and the choice is made in the browser. So the fixed
 * pages appear once, and the catalogue contributes `/product/{id}` and
 * `/blog/{slug}` across every open establishment.
 *
 * The fixed pages are `PUBLIC_STOREFRONT_ROUTES`: the engine's own, then the
 * ones the site registered in `site/routes.ts`. A page a site adds reaches this
 * file by being registered there and by no other way, and leaves it the moment
 * its entry is removed.
 *
 * Nothing `robots.ts` disallows can appear here: both read
 * `lib/crawler-policy`, and every candidate passes through
 * `isDisallowedPath` before it is emitted.
 *
 * Revalidated every hour (ISR) since it uses ConvexHttpClient, not fetch().
 */

import type { MetadataRoute } from "next"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { resolveReservationMode } from "@be-yours/convex-schema"
import { siteBaseUrlFromEnv } from "@/lib/seo"
import { PUBLIC_STOREFRONT_ROUTES, isDisallowedPath } from "@/lib/crawler-policy"

export const revalidate = 3600 // 1 hour

/** Sitemap generation runs without a request, so only configuration can answer. */
function getBaseUrl(): string {
  return siteBaseUrlFromEnv() ?? "http://localhost:3000"
}

interface StoreRow {
  _id: string
  status?: string
  updatedAt?: number
  reservationMode?: "off" | "native" | "external"
  reservationUrl?: string
}

interface ProductRow {
  _id: string
  isActive?: boolean
  updatedAt?: number
}

interface ArticleRow {
  slug?: string
  publishedAt?: number
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  const baseUrl = getBaseUrl()

  /** One entry per path, deduplicated — several establishments share the fixed pages. */
  const entries = new Map<string, MetadataRoute.Sitemap[number]>()

  const add = (
    path: string,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"],
    priority: number,
    lastModified: Date,
  ) => {
    if (isDisallowedPath(path)) return
    if (entries.has(path)) return
    entries.set(path, {
      url: `${baseUrl}${path}`,
      lastModified,
      changeFrequency,
      priority,
    })
  }

  const now = new Date()
  for (const route of PUBLIC_STOREFRONT_ROUTES) {
    add(route.path, route.changeFrequency, route.priority, now)
  }

  // The fixed pages stand on their own. A deployment with no Convex URL — a
  // preview build, a fresh clone — still publishes a sitemap that resolves,
  // rather than an empty one.
  if (!convexUrl) return [...entries.values()]

  const client = new ConvexHttpClient(convexUrl)

  try {
    const stores = (await client.query(api.stores.list, {})) as StoreRow[] | null
    const openStores = (stores ?? []).filter((store) => store.status === "open")

    for (const store of openStores) {
      const storeId = store._id as Id<"stores">

      // The booking page exists only while an establishment's switch is on
      // `native`, and a crawler (no cookie) is served the first OPEN
      // establishment — `resolveDefaultStoreSlug`'s fallback. So the page is
      // listed for that one only: advertising it because a second establishment
      // is native would hand a crawler a 404.
      if (store === openStores[0] && resolveReservationMode(store) === "native") {
        add("/reservation", "weekly", 0.7, store.updatedAt ? new Date(store.updatedAt) : now)
      }

      const [products, articles] = await Promise.all([
        client
          .query(api.products.list, { storeId })
          .catch(() => [] as ProductRow[]) as Promise<ProductRow[]>,
        client
          .query(api.blog.listPublishedArticles, { storeId })
          .catch(() => [] as ArticleRow[]) as Promise<ArticleRow[]>,
      ])

      for (const product of products ?? []) {
        if (product.isActive === false) continue
        add(
          `/product/${product._id}`,
          "weekly",
          0.8,
          product.updatedAt ? new Date(product.updatedAt) : now,
        )
      }

      for (const article of articles ?? []) {
        if (!article.slug) continue
        add(
          `/blog/${article.slug}`,
          "monthly",
          0.6,
          article.publishedAt ? new Date(article.publishedAt) : now,
        )
      }
    }
  } catch (error) {
    console.error("[sitemap] Failed to generate sitemap:", error)
  }

  return [...entries.values()]
}
