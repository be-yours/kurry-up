import { EditProductPage } from "@be-yours/admin"

export default function Page({
  params,
}: {
  params: Promise<{ productId: string }>
}) {
  return <EditProductPage params={params} />
}
