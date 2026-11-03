"use client"

/**
 * Storefront error boundary.
 *
 * Without this file a crash on any storefront page bubbled all the way to
 * `app/error.tsx`, which renders *outside* `(storefront)/layout.tsx` — so the
 * header, the menu link, the language switcher, the footer and the cart all
 * disappeared along with the page that broke. The only affordance left was
 * "Réessayer", which re-runs the render that just failed: a visitor who hit it
 * on `/contact` had no way back to the menu except the browser's back button.
 *
 * Placed here, the same crash degrades instead: the establishment's chrome
 * stays on screen, and the visitor is one click from the carte — which is the
 * commercial difference between a bad moment and a lost order.
 */

import Link from "next/link"
import {
  ErrorScreen,
  primaryAction,
  secondaryAction,
  useErrorBoundaryReport,
} from "@/lib/error-boundary"

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const denialMessage = useErrorBoundaryReport(error)

  if (denialMessage) {
    return (
      <ErrorScreen
        surface="storefront"
        title="Accès refusé"
        description={denialMessage}
        testId="access-denied"
        actions={
          <Link href="/menu" className={primaryAction.storefront}>
            Voir la carte
          </Link>
        }
      />
    )
  }

  return (
    <ErrorScreen
      surface="storefront"
      title="Cette page n'a pas pu s'afficher"
      description="Le problème vient de chez nous, pas de vous. Il nous a été signalé, et la carte reste accessible en attendant."
      digest={error.digest}
      actions={
        <>
          <button type="button" onClick={reset} className={primaryAction.storefront}>
            Réessayer
          </button>
          <Link href="/menu" className={secondaryAction.storefront}>
            Voir la carte
          </Link>
        </>
      }
    />
  )
}
