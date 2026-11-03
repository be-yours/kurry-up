"use client"

/**
 * The shared half of every `error.tsx` in this app.
 *
 * There are boundaries at the root and one per route group, and they have to
 * agree on two things that are easy to get subtly wrong once the code is
 * copied: a refused query must not be filed as a crash, and a crash must
 * always reach Sentry. Duplicating eighty lines three times is how one of them
 * quietly stops reporting.
 *
 * What legitimately differs between them is the way out. The root boundary
 * renders with no chrome around it. A group boundary renders inside its own
 * layout, so the header, the footer and the cart are still on screen — which
 * is the difference between a crash that degrades and one that takes the whole
 * page down.
 */

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"
import { convexErrorPayload } from "@/lib/convex-error"

/** Copy for the refusals a page can hit mid-render. */
const DENIALS: Record<string, string> = {
  not_authenticated: "Votre session a expiré. Reconnectez-vous pour continuer.",
  no_profile:
    "Aucun rôle n'est attribué à ce compte. Demandez une invitation, ou désignez le premier administrateur du déploiement.",
  store_not_granted: "Vous n'avez pas accès à cet établissement.",
  permission_denied: "Votre rôle ne vous permet pas d'ouvrir cette page.",
  module_denied: "Ce module ne vous a pas été accordé.",
  staff_only: "Cet espace est réservé à l'équipe.",
}

/**
 * Is this a refusal or a crash, and what should the visitor read?
 *
 * A refused query rethrows during render and arrives at a boundary exactly like
 * a crash. Telling the two apart is the whole reason this exists: a staff
 * member opening a page above their permission used to be shown "Une erreur est
 * survenue" and filed as a Sentry incident, for a system working precisely as
 * designed. Filing authorisation as an incident buries the real ones.
 *
 * Kept pure and separate from the hook below so the decision can be tested
 * without a renderer — an effect does not run under `renderToStaticMarkup`, so
 * a test that only rendered the boundary would assert nothing about reporting,
 * which is the half that silently rots.
 */
export function classifyBoundaryError(error: Error): {
  /** The refusal to display, or `null` when this was a genuine crash. */
  denialMessage: string | null
  /** Whether Sentry should hear about it. */
  shouldReport: boolean
} {
  const denial = convexErrorPayload(error)
  // `?? null` rather than letting `undefined` through: `DENIALS[code]` and
  // `payload.message` are both optional, so a refusal carrying an unknown code
  // and no message of its own has nothing to display. That case is reported and
  // shown as a crash — which is honest, since nothing here can say what it was.
  const denialMessage = denial ? (DENIALS[denial.code] ?? denial.message ?? null) : null

  // A refusal is an answer, not an incident.
  return { denialMessage, shouldReport: denialMessage === null }
}

/**
 * Report the error unless it is a refusal, and return the refusal to display.
 */
export function useErrorBoundaryReport(error: Error): string | null {
  const { denialMessage, shouldReport } = classifyBoundaryError(error)

  useEffect(() => {
    if (shouldReport) Sentry.captureException(error)
  }, [error, shouldReport])

  return denialMessage
}

/** Which surface the boundary is rendering on, and therefore how it looks. */
export type ErrorSurface = "app" | "storefront"

const SURFACE = {
  app: {
    frame: "flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center",
    title: "text-2xl font-semibold text-foreground",
    body: "max-w-md text-sm text-muted-foreground",
    digest: "font-mono text-xs text-muted-foreground",
  },
  storefront: {
    frame: "flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-24 text-center",
    title: "text-3xl font-black tracking-tight text-zinc-900 dark:text-zinc-50",
    body: "max-w-md text-sm font-medium leading-relaxed text-zinc-600 dark:text-zinc-300",
    digest: "font-mono text-xs text-zinc-500 dark:text-zinc-400",
  },
} as const satisfies Record<ErrorSurface, Record<string, string>>

export function ErrorScreen({
  surface,
  title,
  description,
  digest,
  actions,
  testId,
}: {
  surface: ErrorSurface
  title: string
  description: string
  /**
   * Next's error digest. It is the only handle a restaurant owner can quote to
   * support, and the same value Sentry files the event under.
   */
  digest?: string
  actions: React.ReactNode
  testId?: string
}) {
  const style = SURFACE[surface]

  return (
    <div className={style.frame} data-testid={testId}>
      <h1 className={style.title}>{title}</h1>
      <p className={style.body}>{description}</p>
      {digest && <p className={style.digest}>Référence : {digest}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">{actions}</div>
    </div>
  )
}

/** The primary action, styled for the surface it sits on. */
export const primaryAction = {
  app: "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90",
  storefront:
    "rounded-full bg-[#0D5C3F] px-6 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D5C3F]",
} as const satisfies Record<ErrorSurface, string>

/** The way out, for a visitor who does not want to retry. */
export const secondaryAction = {
  app: "rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted",
  storefront:
    "rounded-full border border-zinc-200 px-6 py-3 text-sm font-bold text-zinc-800 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D5C3F] dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800",
} as const satisfies Record<ErrorSurface, string>
