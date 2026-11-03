import { BlogArticleEditor } from "@/components/admin/blog/BlogArticleEditor"

export default async function Page({
  params,
}: {
  params: Promise<{ articleId: string }>
}) {
  const { articleId } = await params
  return <BlogArticleEditor articleId={articleId} />
}
