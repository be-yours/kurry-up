import type { Metadata } from "next"
import { generateStaticPageMetadata } from "@/lib/cms/seo"
import StoreSelectorContent from "./_components/StoreSelectorContent"

/**
 * The list of establishments.
 *
 * Public and worth indexing — it is the page that answers "where are you?" for
 * an owner who runs several restaurants — and until now it carried no title,
 * no description and no canonical because it was a client component.
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateStaticPageMetadata({
    title: "Nos restaurants",
    description:
      "Choisissez le restaurant où vous souhaitez commander : adresse, horaires et disponibilité.",
    pathname: "/store-selector",
  })
}

export default function StoreSelectorPage() {
  return <StoreSelectorContent />
}
