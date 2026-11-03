import { CmsPageEditor } from "@/components/admin/cms/CmsPageEditor"

export default async function Page({
  params,
}: {
  params: Promise<{ pageSlug: string }>
}) {
  const { pageSlug } = await params
  return <CmsPageEditor pageSlug={pageSlug} />
}
