import { redirect } from "next/navigation"

export default async function Page({ params }: { params: Promise<{ pageSlug: string }> }) {
  const { pageSlug } = await params
  redirect(`/dashboard/content/pages/${pageSlug}`)
}
