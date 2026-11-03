import { Suspense } from "react"
import type { Metadata } from "next"
import { generateCmsMetadata } from "@/lib/cms/seo"
import { getCmsInitialData } from "@/lib/cms/initial-data"
import AboutPage from "./_components/AboutContent"

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: "about",
    pathname: "/about",
    fallbackTitle: "À propos — Notre histoire",
    fallbackDescription: "Découvrez notre histoire, nos valeurs et notre passion pour la cuisine.",
  })
}

export default async function About() {
  // The owner's copy, read here so the first HTML says it. See `getCmsInitialData`.
  const initialData = await getCmsInitialData("about")

  return (
    <Suspense>
      <AboutPage initialData={initialData} />
    </Suspense>
  )
}
