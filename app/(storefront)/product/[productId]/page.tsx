import type { Metadata } from "next"
import { getStorePageData } from "@/lib/convex-server"
import { cookies } from "next/headers"
import { fetchQuery } from "convex/nextjs"
import {
  LOCALE_COOKIE_NAME,
  localizeDocument,
  normalizeStoredLocale,
} from "@be-yours/core"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { buildSeoMetadata } from "@/lib/seo"
import { PRIVATE_PAGE } from "@/lib/crawler-policy"
import { JsonLd, buildBreadcrumbSchema, buildProductSchema } from "@/lib/json-ld"
import { getStorefrontSeoContext } from "@/lib/structured-data"
import { ProductDetailClientPage } from "./client"

interface Props {
  params: Promise<{ productId: string }>
}

/**
 * The locale this request should be answered in.
 *
 * `beid_locale` is the cookie `setLocale` writes and `app/layout.tsx` reads.
 * Server rendering has to read the same one or the page ships a French title
 * to a visitor who asked for Spanish — which is what a crawler sees, and a
 * crawler never runs the client half that would have fixed it.
 */
async function requestLocale(): Promise<string | null> {
  const cookieStore = await cookies()
  return normalizeStoredLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value)
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { productId } = await params
  const pathname = `/product/${productId}`

  try {
    const [product, locale, { brandName, storeSlug }] = await Promise.all([
      fetchQuery(api.products.getById, { id: productId as Id<"products"> }),
      requestLocale(),
      getStorefrontSeoContext(),
    ])

    if (!product) {
      // A page that does not exist must not invite a crawler to keep it.
      return buildSeoMetadata({
        fallbackTitle: "Produit introuvable",
        pathname,
        robots: PRIVATE_PAGE,
      })
    }

    const { name, description } = localizeDocument(product, locale)
    const image = Array.isArray(product.images) ? product.images[0] : undefined

    /* THE `seo` BLOCK, WHICH THIS PAGE IGNORED (#630). `buildSeoMetadata` reads
       `cms.block("seo")` when it is given one, and this call passed none — so
       an owner setting « Noindex, nofollow » on product pages stayed indexed,
       and their meta title and description were never used. Five of the eight
       pages that emit a `seoBlock` did read it; this was one of the two that
       did not. */
    const { cms } = storeSlug
      ? await getStorePageData(storeSlug, "product-detail", locale)
      : { cms: null }

    return buildSeoMetadata({
      fallbackTitle: name,
      fallbackDescription: description ?? `Commandez ${name} en ligne`,
      ...(typeof image === "string" ? { fallbackOgImage: image } : {}),
      pathname,
      cms,
      ...(brandName ? { siteName: brandName } : {}),
      ...(locale ? { ogLocale: locale } : {}),
    })
  } catch {
    return buildSeoMetadata({ fallbackTitle: "Produit", pathname })
  }
}

export default async function ProductDetailPage({ params }: Props) {
  const { productId } = await params

  let product = null
  try {
    product = await fetchQuery(api.products.getById, {
      id: productId as Id<"products">,
    })
  } catch {
    // Product not found
  }

  if (!product) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">Produit introuvable</h1>
        <p className="mt-2 text-muted-foreground">
          Ce produit n&apos;existe pas ou a été supprimé.
        </p>
        <a href="/menu" className="mt-4 inline-block text-accent-foreground hover:underline">
          Retour au menu
        </a>
      </div>
    )
  }

  // Localised on the server too, not only in the client component below: the
  // first paint is what a crawler indexes and what a slow connection shows
  // for a second, and both used to be the source language whatever the
  // visitor had chosen.
  const locale = await requestLocale()
  const { name, description } = localizeDocument(product, locale)

  // A priced dish, attached to the establishment that sells it. This is what
  // puts the price and the availability under the result rather than a bare
  // blue link.
  const { store, baseUrl } = await getStorefrontSeoContext()
  const image = Array.isArray(product.images) ? product.images[0] : undefined

  const dish = buildProductSchema(
    {
      id: productId,
      name,
      description: description ?? null,
      price: typeof product.price === "number" ? product.price : 0,
      imageUrl: typeof image === "string" ? image : null,
      available: product.isActive !== false,
    },
    { baseUrl, ...(store ? { store } : {}) },
  )

  const breadcrumbs = buildBreadcrumbSchema(
    [
      { name: "Accueil", path: "/" },
      { name: "Menu", path: "/menu" },
      { name, path: `/product/${productId}` },
    ],
    baseUrl,
  )

  return (
    <>
      <JsonLd data={dish} />
      <JsonLd data={breadcrumbs} />
      <ProductDetailClientPage
        product={{
          ...product,
          name,
          ...(description === undefined ? {} : { description }),
        }}
      />
    </>
  )
}
