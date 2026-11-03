/**
 * The 404 page, at the root — the one Next.js reaches for an address that
 * matches no route at all.
 *
 * WITHOUT THIS FILE, and there was no such file anywhere in any of the three
 * applications, every 404 on a French restaurant's own domain rendered Next's
 * built-in default: a black page reading "404 — This page could not be found."
 * in English, with no header, no footer and no link back. A visitor following
 * a stale link, a mistyped address or a QR code printed with an old path
 * reached a dead end that did not look like the establishment's site at all.
 *
 * Deliberately a server component with no client state: a not-found page that
 * needs JavaScript to render its way out is a worse version of the same
 * problem.
 *
 * There is a second one inside `(storefront)` and a third inside `(admin)`.
 * This one is the backstop and renders with no group chrome around it, so its
 * way out is a plain link rather than a nav item.
 */

import Link from "next/link"
import { ErrorScreen, primaryAction, secondaryAction } from "@/lib/error-boundary"

export default function RootNotFound() {
  return (
    <ErrorScreen
      surface="storefront"
      title="Cette page n'existe pas"
      description="L'adresse demandée n'existe pas ou n'existe plus. Le lien a peut-être changé."
      testId="root-not-found"
      actions={
        <>
          <Link href="/" className={primaryAction.storefront}>
            Retour à l&apos;accueil
          </Link>
          <Link href="/menu" className={secondaryAction.storefront}>
            Voir la carte
          </Link>
        </>
      }
    />
  )
}
