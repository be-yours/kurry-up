import { redirect } from "next/navigation"

export default async function Page({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params
  redirect(`/dashboard/stores/${storeId}`)
}
