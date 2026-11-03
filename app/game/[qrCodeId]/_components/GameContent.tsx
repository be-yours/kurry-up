"use client"

import { useParams } from "next/navigation"
import { GamePlayerFlow } from "@be-yours/admin/game"
import { api } from "@/convex/_generated/api"
import { useCmsPage } from "@/lib/cms"

/**
 * The player flow itself lives in `@be-yours/admin/game` so that the
 * bench and the client template render the same screens instead of drifting
 * apart — which is what happened while the template shipped a placeholder.
 *
 * What stays here is what is genuinely per-app: the generated Convex API, the
 * CMS hook (bound to this app's api and store selection), and the route shape.
 */
export default function GamePageContent() {
  const params = useParams<{ qrCodeId: string }>()

  const { block } = useCmsPage("game")
  const hero = block("hero")
  const results = block("results")

  return (
    <GamePlayerFlow
      qrCode={params.qrCodeId}
      api={{
        getSession: api.gamePlay.getSession,
        recordScan: api.gamePlay.recordScan,
        play: api.gamePlay.play,
        claim: api.gamePlay.claim,
        ensureReferralCode: api.gamePlay.ensureReferralCode,
      }}
      copy={{
        heroTitle: hero.field("title").text,
        heroSubtitle: hero.field("subtitle").text,
        winTitle: results.field("winTitle").text,
        winDescription: results.field("winDescription").text,
        loseTitle: results.field("loseTitle").text,
        loseDescription: results.field("loseDescription").text,
      }}
    />
  )
}
