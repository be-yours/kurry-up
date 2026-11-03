import { redirect } from "next/navigation"

export default async function Page({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params
  redirect(`/dashboard/content/blog/${articleId}`)
}
