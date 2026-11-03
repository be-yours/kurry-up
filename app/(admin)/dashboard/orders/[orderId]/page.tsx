import { OrderDetailPage } from "@be-yours/admin"

export default function Page({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  return <OrderDetailPage params={params} />
}
