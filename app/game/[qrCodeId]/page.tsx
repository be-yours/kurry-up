import { Suspense } from "react"
import GamePageContent from "./_components/GameContent"

export default function GamePage() {
  return (
    <Suspense>
      <GamePageContent />
    </Suspense>
  )
}
