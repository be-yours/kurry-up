import { StoreDetailPage } from "@be-yours/admin"

export default function Page({
  params,
}: {
  params: Promise<{ storeId: string }>
}) {
  return <StoreDetailPage params={params} />
}
