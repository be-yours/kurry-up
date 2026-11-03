'use client'

/**
 * « Événements » — the limited-seat evenings an establishment sells on its booking page.
 *
 * The section renders NOTHING while there is no event to show: no heading, no empty box. When
 * there is one, each card says what it is, when, what a seat costs and how many are left (a
 * plain number — see `ExperienceCard`), and offers the one thing that fits its state: buy
 * seats, ask to be told if seats come back, or the moment sales open. `#events` is the
 * anchor the « places disponibles » e-mail links to, so the page scrolls to it once the list
 * has arrived (a client-rendered list is not there yet when the browser looks for the anchor).
 */

import { useEffect, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { useStoreId } from '@/lib/hooks/use-store-id'
import { ExperienceAlertForm } from './ExperienceAlertForm'
import { ExperienceCard, type CardMode } from './ExperienceCard'
import { ExperiencePurchaseForm } from './ExperiencePurchaseForm'

export const EXPERIENCES_ANCHOR = 'events'

export default function ExperiencesSection() {
  const { storeId } = useStoreId()
  const config = useQuery(
    api.reservations.getPublicConfig,
    storeId ? { storeId: storeId as Id<'stores'> } : 'skip',
  )
  const cards = useQuery(
    api.reservationExperiences.listPublic,
    storeId ? { storeId: storeId as Id<'stores'> } : 'skip',
  )
  // One form open at a time: which card, and which of its two forms.
  const [open, setOpen] = useState<{ id: string; mode: CardMode } | null>(null)

  const present = cards !== undefined && cards.length > 0 && !!config
  useEffect(() => {
    if (present && window.location.hash === `#${EXPERIENCES_ANCHOR}`) {
      document.getElementById(EXPERIENCES_ANCHOR)?.scrollIntoView()
    }
  }, [present])

  if (!present || !config || !cards) return null

  return (
    <section
      id={EXPERIENCES_ANCHOR}
      aria-labelledby="experiences-title"
      className="mt-16 scroll-mt-8 space-y-6 border-t border-border pt-10"
    >
      <div className="space-y-1">
        <h2 id="experiences-title" className="text-2xl font-bold text-foreground">
          Événements
        </h2>
        <p className="text-muted-foreground">
          Des soirées et des repas à places comptées, réservés à l&apos;avance.
        </p>
      </div>
      <ul className="space-y-6">
        {cards.map((card) => {
          // A form only stays open while the card is still in the state it was opened for:
          // seats that sell out under a guest's hands turn the card back into « Complet ».
          const mode =
            open?.id === card.id &&
            ((open.mode === 'buy' && card.state === 'on_sale') ||
              (open.mode === 'alert' && card.state === 'sold_out'))
              ? open.mode
              : null
          const close = () => setOpen(null)
          return (
            <li key={card.id}>
              <ExperienceCard
                card={card}
                timezone={config.timezone}
                openMode={mode}
                onOpen={(next) => setOpen(next ? { id: card.id, mode: next } : null)}
              >
                {mode === 'buy' && (
                  <ExperiencePurchaseForm card={card} config={config} onClose={close} />
                )}
                {mode === 'alert' && (
                  <ExperienceAlertForm card={card} config={config} onClose={close} />
                )}
              </ExperienceCard>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
