/**
 * The admin's 404.
 *
 * Its own, inside the group, for the same reason the group has its own error
 * boundary: the sidebar and the store switcher stay on screen, so a member of
 * staff who followed a stale bookmark is one click from the dashboard rather
 * than looking at an unstyled English page on the tablet by the pass.
 */

import Link from "next/link"
import { ErrorScreen, primaryAction, secondaryAction } from "@/lib/error-boundary"

export default function AdminNotFound() {
  return (
    <ErrorScreen
      surface="app"
      title="Cette page n'existe pas"
      description="L'adresse demandée n'existe pas, ou l'écran a été déplacé."
      testId="admin-not-found"
      actions={
        <>
          <Link href="/dashboard" className={primaryAction.app}>
            Retour au tableau de bord
          </Link>
          <Link href="/" className={secondaryAction.app}>
            Voir le site
          </Link>
        </>
      }
    />
  )
}
