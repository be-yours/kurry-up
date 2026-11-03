"use client"

/**
 * Admin error boundary.
 *
 * The admin is where a refusal is most likely to be mistaken for a crash: every
 * page behind `AuthGuard` and `StoreGuard` can rethrow a refused query during
 * render. Without a boundary in this group those landed on `app/error.tsx`,
 * which renders outside `(admin)/layout.tsx` — so a staff member who opened a
 * page above their permission lost the sidebar, the store selector and their
 * session context, and had nothing to click but "Réessayer".
 *
 * Here the sidebar survives, so the answer to "you cannot open this page" is a
 * page they *can* open, one click away.
 */

import Link from "next/link"
import {
  ErrorScreen,
  primaryAction,
  secondaryAction,
  useErrorBoundaryReport,
} from "@/lib/error-boundary"

export default function AdminError({
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
        surface="app"
        title="Accès refusé"
        description={denialMessage}
        testId="access-denied"
        actions={
          <Link href="/dashboard" className={primaryAction.app}>
            Retour au tableau de bord
          </Link>
        }
      />
    )
  }

  return (
    <ErrorScreen
      surface="app"
      title="Une erreur est survenue"
      description="Cette page n'a pas pu s'afficher. L'incident a été signalé automatiquement."
      digest={error.digest}
      actions={
        <>
          <button type="button" onClick={reset} className={primaryAction.app}>
            Réessayer
          </button>
          <Link href="/dashboard" className={secondaryAction.app}>
            Retour au tableau de bord
          </Link>
        </>
      }
    />
  )
}
