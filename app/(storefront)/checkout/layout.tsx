import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"

/**
 * Payment.
 *
 * Every page under `/checkout` is a client component — a payment form has to
 * be — so none of them can export metadata of their own. The layout gives the
 * whole branch a title that is the restaurant's rather than the engine's, and
 * the `noindex, nofollow` a payment page must never be without.
 */
export const metadata: Metadata = {
  title: "Paiement",
  description: "Finalisez votre commande en toute sécurité.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function CheckoutLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
