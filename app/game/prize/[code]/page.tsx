import { Suspense } from "react"
import PrizeTicketContent from "./_components/PrizeTicketContent"

export default function PrizeTicketPage() {
  return (
    <Suspense>
      <PrizeTicketContent />
    </Suspense>
  )
}
