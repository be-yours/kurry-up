import { redirect } from "next/navigation"

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params
  redirect(`/dashboard/products/${productId}`)
}
