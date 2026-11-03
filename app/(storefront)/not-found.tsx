/**
 * The storefront's 404 — the one a diner actually meets.
 *
 * `blog/[slug]/page.tsx` calls `notFound()` by design, so a link shared to an
 * article the owner has since deleted lands here; so does a product or a
 * category that has gone. Placed inside the route group, the establishment's
 * header, language switcher, cart and footer stay on screen, and the visitor
 * is one click from the carte — which is the difference between a dead end and
 * a diner who orders something else.
 *
 * The root `app/not-found.tsx` renders outside this layout and is the backstop
 * for addresses that match no route at all.
 */

import Link from "next/link"
import { ErrorScreen, primaryAction, secondaryAction } from "@/lib/error-boundary"

export default function StorefrontNotFound() {
  return (
    <ErrorScreen
      surface="storefront"
      title="Cette page n'existe pas"
      description="Elle a peut-être été retirée, ou l'adresse a changé. Le reste du site est toujours là."
      testId="storefront-not-found"
      actions={
        <>
          <Link href="/menu" className={primaryAction.storefront}>
            Voir la carte
          </Link>
          <Link href="/" className={secondaryAction.storefront}>
            Retour à l&apos;accueil
          </Link>
        </>
      }
    />
  )
}
