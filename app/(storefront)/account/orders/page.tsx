import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import AccountOrdersContent from "./_components/AccountOrdersContent"

export const metadata: Metadata = {
  title: "Mes commandes",
  description: "Retrouvez l'historique de vos commandes et leur suivi.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function AccountOrdersPage() {
  return <AccountOrdersContent />
}
