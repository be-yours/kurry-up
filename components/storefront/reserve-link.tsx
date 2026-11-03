'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import type { ReservationEntry } from '@be-yours/convex-schema'

/**
 * The anchor behind every « Réserver » control.
 *
 * It owns the one decision that differs between the two modes — the engine's
 * own page is routed client-side, the owner's tool leaves the site in a new
 * tab — and nothing else. The caller passes the classes, as `FooterLinkItem`
 * does: the contrast sweep resolves a text colour's ground from the JSX it
 * sits in, so a colour hidden in this helper would have none.
 */
export function ReserveLink({
  entry,
  className,
  children,
}: {
  entry: ReservationEntry
  className?: string
  children: ReactNode
}) {
  if (entry.kind === 'native') {
    return (
      <Link href={entry.href} className={className}>
        {children}
      </Link>
    )
  }
  return (
    <a href={entry.href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  )
}
