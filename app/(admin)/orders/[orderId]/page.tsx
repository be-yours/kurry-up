import { redirect } from "next/navigation"

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  redirect(`/dashboard/orders/${orderId}`)
}
