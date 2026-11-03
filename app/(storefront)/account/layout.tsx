import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"

/**
 * The customer's own area.
 *
 * Metadata sits in the layout rather than in each page so that `/account`
 * itself is covered without the page having to stop being a client component —
 * and so that a page added under `/account` later inherits `noindex` by
 * default rather than by remembering to ask for it. `robots.ts` disallows the
 * whole prefix as well; this is what a crawler sees if it follows a link
 * anyway.
 */
export const metadata: Metadata = {
  title: "Mon compte",
  description: "Vos commandes, vos adresses de livraison et vos favoris.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
