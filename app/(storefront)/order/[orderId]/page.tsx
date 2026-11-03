import type { Metadata } from "next"
import { PRIVATE_PAGE_METADATA } from "@/lib/crawler-policy"
import OrderConfirmationScreen from "./_components/OrderConfirmationContent"

/**
 * One customer's order confirmation.
 *
 * Never indexed, never followed: the page is reached from a link mailed to the
 * person who ordered, and everything on it — what they ate, what they paid,
 * where it went — is theirs. The directive is fixed in code, not read from the
 * CMS, so no dropdown can publish it by accident.
 */
export const metadata: Metadata = {
  title: "Votre commande",
  description: "Suivez l'avancement de votre commande.",
  robots: PRIVATE_PAGE_METADATA,
}

export default function OrderConfirmationPage() {
  return <OrderConfirmationScreen />
}
