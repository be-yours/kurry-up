"use client"

import { useParams } from "next/navigation"
import { PrizeTicket } from "@be-yours/admin/game"
import { api } from "@/convex/_generated/api"

/**
 * The page behind the QR code on the reward screen and in the win email.
 * Thin on purpose — see the note in the sibling game route's GameContent.
 */
export default function PrizeTicketContent() {
  const params = useParams<{ code: string }>()

  return (
    <PrizeTicket
      code={params.code?.toUpperCase() ?? ""}
      api={{
        getRedemptionByCode: api.gamePlay.getRedemptionByCode,
        canRedeem: api.prizeRedemptions.canRedeem,
        redeemByCode: api.prizeRedemptions.redeemByCode,
      }}
    />
  )
}
