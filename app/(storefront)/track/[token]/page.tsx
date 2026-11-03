import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import TrackOrderContent from "./_components/TrackOrderContent"

/**
 * Public order tracking by opaque token.
 *
 * The token is the whole authorisation, which is exactly why the page must not
 * be indexed: a tracking link in a search result hands a stranger the state of
 * someone else's order. The path is disallowed in `robots.txt` and the page
 * repeats it here, so a crawler that follows a shared link is told directly.
 */
export const metadata: Metadata = {
  title: "Suivi de commande",
  description: "Suivez la préparation de votre commande en temps réel.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function TrackOrderPage() {
  return <TrackOrderContent />
}
