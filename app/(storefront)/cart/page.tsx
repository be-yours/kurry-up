import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import CartContent from "./_components/CartContent"

/**
 * The basket.
 *
 * A client component could carry no metadata, so the page inherited the
 * engine's own title. It is one customer's basket and belongs in no index —
 * `robots.ts` disallows the path and this says the same thing in the page
 * itself, for the crawler that arrives from a shared link rather than from
 * `robots.txt`. Static rather than generated: a page nobody may index has no
 * canonical worth publishing and no reason to ask Convex anything.
 */
export const metadata: Metadata = {
  title: "Votre panier",
  description: "Vérifiez votre commande avant de passer au paiement.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function CartPage() {
  return <CartContent />
}
