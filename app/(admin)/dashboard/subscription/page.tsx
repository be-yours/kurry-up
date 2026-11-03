import { Suspense } from "react"
import { SubscriptionPage } from "@/components/admin/subscription/SubscriptionPage"
import { LoadingState } from "@/components/admin/LoadingState"

export default function Page() {
  return (
    <Suspense fallback={<LoadingState variant="cards" count={3} />}>
      <SubscriptionPage />
    </Suspense>
  )
}
