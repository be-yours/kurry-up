/**
 * The establishment, as a crawler should see it.
 *
 * `lib/json-ld.tsx` knows how to *shape* schema.org documents; this module is
 * what feeds them the real store, the real opening hours and the real
 * catalogue. Both halves existed before — the builders had no caller and no
 * `application/ld+json` was emitted anywhere in `app/`, so a restaurant theme
 * shipped without the one piece of markup that produces opening hours, an
 * address and a price range in a rich result.
 *
 * Every read is memoised per render: the layout asks for the establishment on
 * every storefront page, and the menu asks for it again beside its catalogue.
 */

import { resolveBrandName } from "./cms/brand-name"
import "server-only"
import { cache } from "react"
import { cookies } from "next/headers"
import { ConvexHttpClient } from "convex/browser"
import { LOCALE_COOKIE_NAME, normalizeStoredLocale } from "@be-yours/core"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { getStorePageData, resolveStorefrontStore } from "@/lib/convex-server"
import { resolveSiteBaseUrl } from "@/lib/seo"
import {
  buildMenuSchema,
  buildRestaurantSchema,
  derivePriceRange,
  type JsonLdDocument,
  type MenuItemLike,
  type MenuSectionLike,
  type StoreLike,
} from "@/lib/json-ld"

// ---------------------------------------------------------------------------
// Convex row shapes (the shared handlers are untyped, so they are named here)
// ---------------------------------------------------------------------------

interface StoreRow {
  _id: string
  name?: unknown
  slug?: unknown
  description?: unknown
  phone?: unknown
  email?: unknown
  address?: unknown
  hours?: unknown
}

interface CategoryRow {
  _id: string
  slug?: unknown
  name?: unknown
  description?: unknown
  isActive?: unknown
}

interface ProductRow {
  _id: string
  name?: unknown
  description?: unknown
  price?: unknown
  images?: unknown
  categoryId?: unknown
  isActive?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The stored store document, narrowed to the fields structured data uses. */
function toStoreLike(row: StoreRow): StoreLike | null {
  const name = str(row.name)
  if (!name) return null

  const address =
    row.address && typeof row.address === "object"
      ? (row.address as Record<string, unknown>)
      : null

  const hours = Array.isArray(row.hours)
    ? row.hours
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object",
        )
        .map((entry) => ({
          day: num(entry.day) ?? -1,
          open: str(entry.open) ?? "",
          close: str(entry.close) ?? "",
          isClosed: entry.isClosed === true,
        }))
    : null

  return {
    name,
    description: str(row.description) ?? null,
    phone: str(row.phone) ?? null,
    email: str(row.email) ?? null,
    address: address
      ? {
          street: str(address.street),
          city: str(address.city),
          postalCode: str(address.postalCode),
          country: str(address.country),
          latitude: num(address.latitude),
          longitude: num(address.longitude),
        }
      : null,
    hours,
  }
}

// ---------------------------------------------------------------------------
// The establishment behind the current render
// ---------------------------------------------------------------------------

export interface StorefrontSeoContext {
  baseUrl: string
  storeId: Id<"stores"> | null
  store: StoreLike | null
  /** The brand logo from the CMS layout page, used as the entity's image. */
  logoUrl: string | null
  /** The establishment's own name, for `og:site_name` and the page title. */
  brandName: string | null
  /**
   * The establishment's slug, for a page that needs its own CMS blocks (#630).
   *
   * The product detail page has a `productId` and no store slug of its own, and
   * `getStorePageData` is keyed by slug — which is why its `seo` block was
   * never read and an owner's « Noindex, nofollow » on product pages did
   * nothing.
   */
  storeSlug: string | null
}

const getClient = cache(() => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) return null
  return new ConvexHttpClient(url)
})

/**
 * Resolves the establishment, its branding and the site's base URL once per
 * render. Never throws: a storefront whose backend is briefly unreachable drops
 * its structured data, it does not fail to render.
 */
export const getStorefrontSeoContext = cache(
  async (): Promise<StorefrontSeoContext> => {
    const baseUrl = await resolveSiteBaseUrl()

    try {
      const row = (await resolveStorefrontStore()) as StoreRow | null
      if (!row) {
        return {
          baseUrl,
          storeId: null,
          store: null,
          logoUrl: null,
          brandName: null,
          storeSlug: null,
        }
      }

      const store = toStoreLike(row)
      const slug = str(row.slug)

      let logoUrl: string | null = null
      let brandName: string | null = store?.name ?? null

      if (slug) {
        const locale = normalizeStoredLocale(
          (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
        )
        const { cms } = await getStorePageData(slug, "storefront-layout", locale)
        if (cms) {
          const branding = cms.block("branding")
          logoUrl = branding.field("logo").mediaUrl
          /* Same chain as the header (#613). This file already fell back to
             `store.name` and so never printed the vendor — it is here to read
             `header.brandName`, the field the seed actually writes, so the
             JSON-LD and the header agree on a site seeded before the fix. */
          brandName = resolveBrandName({
            branding: branding.field("brandName").text,
            legacyHeader: cms.block("header").field("brandName").text,
            storeName: brandName,
          })
        }
      }

      return {
        baseUrl,
        storeId: row._id as Id<"stores">,
        store,
        logoUrl,
        brandName,
        storeSlug: slug ?? null,
      }
    } catch {
      return {
        baseUrl,
        storeId: null,
        store: null,
        logoUrl: null,
        brandName: null,
        storeSlug: null,
      }
    }
  },
)

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * `Restaurant` for the establishment, priced from its own catalogue.
 *
 * The price range is measured, not declared: the median dish decides the band,
 * so a site that never fills in a marketing field still says something true.
 */
export const getRestaurantJsonLd = cache(
  async (): Promise<JsonLdDocument | undefined> => {
    const { store, storeId, baseUrl, logoUrl } = await getStorefrontSeoContext()
    if (!store) return undefined

    let priceRange: string | undefined
    if (storeId) {
      const products = await listProducts(storeId)
      priceRange = derivePriceRange(
        products.map((product) => num(product.price) ?? 0),
      )
    }

    return buildRestaurantSchema(store, {
      baseUrl,
      image: logoUrl,
      priceRange,
    })
  },
)

/** `Menu` → `MenuSection` → `MenuItem` for the carte. */
export const getMenuJsonLd = cache(
  async (): Promise<JsonLdDocument | undefined> => {
    const { store, storeId, baseUrl } = await getStorefrontSeoContext()
    if (!store || !storeId) return undefined

    const [categories, products] = await Promise.all([
      listCategories(storeId),
      listProducts(storeId),
    ])

    const sections: MenuSectionLike[] = categories
      .filter((category) => category.isActive !== false)
      .map((category) => ({
        id: category._id,
        slug: str(category.slug) ?? category._id,
        name: str(category.name) ?? "",
        description: str(category.description) ?? null,
      }))
      .filter((section) => section.name.length > 0)

    const items: MenuItemLike[] = products
      .filter((product) => product.isActive !== false)
      .map((product) => ({
        id: product._id,
        name: str(product.name) ?? "",
        description: str(product.description) ?? null,
        price: num(product.price) ?? 0,
        imageUrl: Array.isArray(product.images) ? str(product.images[0]) ?? null : null,
        sectionId: str(product.categoryId) ?? null,
      }))
      .filter((item) => item.name.length > 0)

    if (items.length === 0) return undefined

    return buildMenuSchema(store, sections, items, { baseUrl })
  },
)

// ---------------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------------

const listProducts = cache(async (storeId: Id<"stores">): Promise<ProductRow[]> => {
  const client = getClient()
  if (!client) return []
  try {
    return ((await client.query(api.products.list, { storeId })) ?? []) as ProductRow[]
  } catch {
    return []
  }
})

const listCategories = cache(async (storeId: Id<"stores">): Promise<CategoryRow[]> => {
  const client = getClient()
  if (!client) return []
  try {
    return ((await client.query(api.categories.list, { storeId })) ?? []) as CategoryRow[]
  } catch {
    return []
  }
})
