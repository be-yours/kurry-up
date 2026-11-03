import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import AddressesContent from "./_components/AddressesContent"

export const metadata: Metadata = {
  title: "Mes adresses",
  description: "Gérez vos adresses de livraison.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function AddressesPage() {
  return <AddressesContent />
}
