import { Suspense } from "react"
import type { Metadata } from "next"
import { generateCmsMetadata } from "@/lib/cms/seo"
import { getCmsInitialData } from "@/lib/cms/initial-data"
import LandingPage from "./_components/HomepageContent"

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: "homepage",
    pathname: "/",
    fallbackTitle: "Restaurant — Commandez en ligne",
    fallbackDescription: "Découvrez notre menu et commandez vos plats préférés en ligne.",
  })
}

export default async function HomePage() {
  // The owner's copy, read here so the first HTML says it. See `getCmsInitialData`.
  const initialData = await getCmsInitialData("homepage")

  return (
    <Suspense>
      <LandingPage initialData={initialData} />
    </Suspense>
  )
}
