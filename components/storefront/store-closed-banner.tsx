"use client"

import { AlertTriangle } from "lucide-react"

interface StoreClosedBannerProps {
  nextOpenTime?: string | null
}

export function StoreClosedBanner({ nextOpenTime }: StoreClosedBannerProps) {
  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-10 bg-destructive/5 border-b border-destructive/20 px-4 flex items-center">
      <div className="max-w-7xl mx-auto flex items-center justify-center gap-2 text-xs font-black uppercase tracking-widest text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>Restaurant actuellement fermé</span>
        {nextOpenTime && (
          <span className="font-bold normal-case tracking-normal text-destructive">
            — Réouverture à {nextOpenTime}
          </span>
        )}
      </div>
    </div>
  )
}
