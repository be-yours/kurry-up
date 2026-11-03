import "@/lib/cms/init"
import type { Metadata } from "next"
import { buildBrandingCss } from "@be-yours/ui/branding"
import { StoreTheme, StorefrontShell } from "@/components/storefront"
import { STOREFRONT_SCOPES } from "@/components/storefront/store-theme"
import { TooltipProvider } from "@be-yours/ui"
import { JsonLd } from "@/lib/json-ld"
import { resolveStorefrontStore } from "@/lib/convex-server"
import { resolveSiteBaseUrl } from "@/lib/seo"
import { getRestaurantJsonLd, getStorefrontSeoContext } from "@/lib/structured-data"

/**
 * Site-wide metadata for the storefront.
 *
 * `metadataBase` is the piece every page depends on and none of them could set
 * for themselves: without it Next.js leaves a relative Open Graph image
 * relative, and a relative `og:image` is simply not fetched by the crawlers
 * that matter. Pages that build their own metadata set it too; this covers the
 * ones that do not.
 *
 * No title template. The establishment's name is already in `og:site_name` and
 * in the structured data, and appending it to a meta title the owner wrote
 * themselves is how a page ends up titled "Menu — Chez Luigi — Chez Luigi".
 */
export async function generateMetadata(): Promise<Metadata> {
  const [baseUrl, { brandName }] = await Promise.all([
    resolveSiteBaseUrl(),
    getStorefrontSeoContext(),
  ])

  return {
    metadataBase: new URL(baseUrl),
    ...(brandName ? { title: brandName } : {}),
    openGraph: {
      type: "website",
      ...(brandName ? { siteName: brandName } : {}),
    },
    twitter: { card: "summary_large_image" },
  }
}

export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // The establishment, once, for every storefront page: its address, opening
  // hours, telephone and price range are the same on all of them, and a search
  // engine that finds any one page should learn the whole entity from it.
  //
  // Its branding rides along: `resolveStorefrontStore` is memoised per render
  // and `getRestaurantJsonLd` has already called it, so the palette costs this
  // layout nothing and spares a returning visitor the flash of engine orange
  // before the client query lands.
  //
  // NEITHER MAY THROW. `getStorefrontSeoContext` states the invariant this
  // layout has to keep — "a storefront whose backend is briefly unreachable
  // drops its structured data, it does not fail to render" — and it holds only
  // for the call that swallows. Adding a bare `resolveStorefrontStore()` beside
  // it broke it: a layout that throws bubbles past `(storefront)/error.tsx` to
  // `app/error.tsx`, which renders outside every group layout, so a transient
  // Convex hiccup replaced every storefront page with a bare error screen
  // instead of costing it one `<style>` element. Losing the server's palette
  // costs a returning visitor one repaint after hydration; losing the page
  // costs them the page.
  const [restaurant, store] = await Promise.all([
    getRestaurantJsonLd(),
    resolveStorefrontStore().catch(() => null),
  ])

  return (
    <TooltipProvider>
      <JsonLd data={restaurant} />
      <StoreTheme
        initialCss={buildBrandingCss(store?.branding, { scopes: STOREFRONT_SCOPES })}
      />
      <StorefrontShell>{children}</StorefrontShell>
    </TooltipProvider>
  )
}
