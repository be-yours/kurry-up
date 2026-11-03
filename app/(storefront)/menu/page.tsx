import type { Metadata } from "next"
import { generateCmsMetadata } from "@/lib/cms/seo"
import { JsonLd, buildBreadcrumbSchema } from "@/lib/json-ld"
import { getMenuJsonLd, getStorefrontSeoContext } from "@/lib/structured-data"
import MenuPageContent from "./_components/MenuContent"

/**
 * The carte — the storefront's highest-intent page, and the one an owner is
 * most likely to have written an SEO block for.
 *
 * It was a client component, so it could carry no metadata at all: no title, no
 * description, no canonical, and the SEO block the CMS offers for this page had
 * no reader. The interactive half is unchanged and lives in `_components`; this
 * server shell is what puts the page in `<head>` and in a rich result.
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: "menu",
    pathname: "/menu",
    fallbackTitle: "Menu — Nos plats",
    fallbackDescription:
      "Découvrez notre carte : entrées, plats et desserts préparés chaque jour, à commander en ligne.",
  })
}

export default async function MenuPage() {
  const [menu, { baseUrl }] = await Promise.all([
    getMenuJsonLd(),
    getStorefrontSeoContext(),
  ])

  const breadcrumbs = buildBreadcrumbSchema(
    [
      { name: "Accueil", path: "/" },
      { name: "Menu", path: "/menu" },
    ],
    baseUrl,
  )

  return (
    <>
      <JsonLd data={menu} />
      <JsonLd data={breadcrumbs} />
      <MenuPageContent />
    </>
  )
}
