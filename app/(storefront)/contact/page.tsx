import { Suspense } from "react"
import type { Metadata } from "next"
import { generateCmsMetadata } from "@/lib/cms/seo"
import { getCmsInitialData } from "@/lib/cms/initial-data"
import ContactPage from "./_components/ContactContent"

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: "contact",
    pathname: "/contact",
    fallbackTitle: "Contact — Nous contacter",
    fallbackDescription: "Contactez-nous pour toute question ou réservation.",
  })
}

export default async function Contact() {
  // The owner's copy, read here so the first HTML says it. See `getCmsInitialData`.
  const initialData = await getCmsInitialData("contact")

  return (
    <Suspense>
      <ContactPage initialData={initialData} />
    </Suspense>
  )
}
