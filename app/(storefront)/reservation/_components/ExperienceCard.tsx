'use client'

/**
 * One event on the booking page: a title, a time, a price and how many seats are left.
 *
 * The tone is neutral on purpose, and a test reads this file to keep it so. The seats left
 * are a plain number in the card's ordinary text colour — no « plus que », no badge in an
 * alarm colour, no clock, no count of people looking. « Complet » is a fact stated once.
 * What a guest needs to decide is on the card; nothing on it tries to decide for them.
 */

import type { FunctionReturnType } from 'convex/server'
import { Button } from '@be-yours/ui'
import type { api } from '@/convex/_generated/api'
import {
  eventWhenText,
  salesOpenText,
  seatPriceText,
  seatsLeftText,
} from './reservation-experiences'

export type PublicExperience = FunctionReturnType<
  typeof api.reservationExperiences.listPublic
>[number]

export type CardMode = 'buy' | 'alert'

export function ExperienceCard({
  card,
  timezone,
  openMode,
  onOpen,
  children,
}: {
  card: PublicExperience
  timezone: string
  /** Which form is open under this card, if any. */
  openMode: CardMode | null
  onOpen: (mode: CardMode | null) => void
  /** The open form. */
  children?: React.ReactNode
}) {
  const titleId = `experience-${card.id}-title`
  const formId = `experience-${card.id}-form`
  return (
    <article aria-labelledby={titleId} className="overflow-hidden rounded-2xl bg-card">
      {card.imageUrl && (
        // An event's picture may come from any address the owner pasted: `next/image` refuses a
        // host that is not in `remotePatterns`, and the page would fail instead of showing it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.imageUrl}
          alt={card.title}
          loading="lazy"
          className="h-48 w-full object-cover"
        />
      )}
      <div className="space-y-3 p-5">
        <h3 id={titleId} className="text-xl font-semibold text-foreground">
          {card.title}
        </h3>
        <p className="text-foreground">{eventWhenText(card, timezone)}</p>
        {card.description && (
          <p className="whitespace-pre-line text-sm text-muted-foreground">{card.description}</p>
        )}
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-foreground">
          <span className="font-semibold">{seatPriceText(card)}</span>
          {card.state === 'sold_out' ? (
            <span className="rounded-md border border-border px-2 py-0.5 text-sm font-medium">
              Complet
            </span>
          ) : card.state === 'on_sale' ? (
            <span className="text-sm">{seatsLeftText(card.seatsLeft)}</span>
          ) : null}
        </p>
        <p className="text-sm text-muted-foreground">
          Annulation possible jusqu&apos;à {card.cancellationCutoffHours} h avant le début.
        </p>

        {card.state === 'upcoming' && card.salesOpensAt !== null && (
          <p className="text-sm text-foreground">{salesOpenText(card.salesOpensAt, timezone)}</p>
        )}

        {card.state === 'on_sale' && openMode === null && (
          <Button
            type="button"
            className="h-11 rounded-xl"
            aria-expanded={false}
            aria-controls={formId}
            onClick={() => onOpen('buy')}
          >
            Réserver
            <span className="sr-only"> : {card.title}</span>
          </Button>
        )}
        {card.state === 'sold_out' && openMode === null && (
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-xl"
            aria-expanded={false}
            aria-controls={formId}
            onClick={() => onOpen('alert')}
          >
            Me prévenir
            <span className="sr-only"> si des places se libèrent : {card.title}</span>
          </Button>
        )}

        <div id={formId}>{openMode !== null && children}</div>
      </div>
    </article>
  )
}
