import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import FavoritesContent from "./_components/FavoritesContent"

export const metadata: Metadata = {
  title: "Mes favoris",
  description: "Vos plats préférés, prêts à recommander.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function FavoritesPage() {
  return <FavoritesContent />
}
