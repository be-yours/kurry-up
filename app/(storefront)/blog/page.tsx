import { Suspense } from "react"
import type { Metadata } from "next"
import { generateCmsMetadata } from "@/lib/cms/seo"
import { getCmsInitialData } from "@/lib/cms/initial-data"
import BlogPage from "./_components/BlogContent"

export async function generateMetadata(): Promise<Metadata> {
  return generateCmsMetadata({
    pageSlug: "blog",
    pathname: "/blog",
    fallbackTitle: "Blog — Actualités et recettes",
    fallbackDescription: "Nos dernières actualités, recettes et conseils culinaires.",
  })
}

export default async function Blog() {
  // The owner's copy, read here so the first HTML says it. See `getCmsInitialData`.
  const initialData = await getCmsInitialData("blog")

  return (
    <Suspense>
      <BlogPage initialData={initialData} />
    </Suspense>
  )
}
