'use client'

/**
 * A group request on the guest's own page: where it stands, in words, and what they can do.
 *
 * Seven things can be true and the page says which: the host has not answered (and until when
 * the place is held), the host proposed another time (what was asked, what is proposed, the
 * payment it carries — with the two buttons that answer it), the proposal lapsed, the request
 * was accepted and awaits its payment, it is confirmed, it was declined, or it expired. A
 * request that cannot go on online ends with the establishment's contact card, never a bare
 * sentence.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { Button } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import { convexErrorPayload } from '@/lib/convex-error'
import { ContactCard } from '../../../_components/ContactCard'
import { formatReservationInstant } from '../../../_components/reservation-format'
import {
  GROUP_HEADLINES,
  groupNeedsWayOn,
  groupStateCopy,
  proposalPaymentSentence,
  type GroupFacts,
} from '../../../_components/reservation-groups'
import { refusalSentence } from '../../../_components/reservation-refusals'

type Booking = NonNullable<FunctionReturnType<typeof api.reservations.getByToken>>

export function GroupRequestBlock({
  token,
  booking,
  group,
}: {
  token: string
  booking: Booking
  group: NonNullable<Booking['group']>
}) {
  const facts: GroupFacts = group
  const copy = groupStateCopy(facts, { storeName: booking.storeName, timezone: booking.timezone })
  return (
    <div className="mb-8 space-y-4">
      <section aria-labelledby="group-state" className="space-y-2 rounded-2xl bg-card p-6">
        <h2 id="group-state" className="text-lg font-semibold text-foreground">
          {GROUP_HEADLINES[group.state]}
        </h2>
        <p role="status" className="text-foreground">
          {copy}
        </p>
        {group.hostMessage && (
          <div className="rounded-xl bg-background p-4">
            <p className="text-sm font-semibold text-foreground">
              Message de {booking.storeName || 'le restaurant'}
            </p>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{group.hostMessage}</p>
          </div>
        )}
      </section>

      {group.state === 'proposal' && group.proposal && (
        <ProposalCard token={token} booking={booking} group={group} proposal={group.proposal} />
      )}

      {groupNeedsWayOn(group.state) && (
        <>
          <ContactCard
            storeName={booking.storeName}
            phone={booking.storePhone}
            email={booking.storeEmail}
            lead="Le plus simple pour la suite : en parler directement avec l'établissement."
            subject={`Demande de groupe ${booking.reference}`}
          />
          <p>
            <Link
              href="/reservation"
              className="font-semibold text-foreground underline underline-offset-4"
            >
              Faire une nouvelle demande
            </Link>
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The host's counter-proposal: what was asked beside what is proposed, the host's note, the
 * payment it carries in words, and the two answers. Refusing releases the place, so it asks
 * once more; accepting a proposal that carries a payment sends the guest to the payment page.
 */
function ProposalCard({
  token,
  booking,
  group,
  proposal,
}: {
  token: string
  booking: Booking
  group: NonNullable<Booking['group']>
  proposal: NonNullable<NonNullable<Booking['group']>['proposal']>
}) {
  const router = useRouter()
  const respond = useMutation(api.reservationGroups.respondToProposal)
  const [refusing, setRefusing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const at = (instant: number) => formatReservationInstant(instant, booking.timezone)
  const payment = proposalPaymentSentence(proposal.terms)

  async function answer(accept: boolean) {
    setBusy(true)
    setError(null)
    try {
      const result = await respond({ token, accept })
      if (accept && result.status === 'pending_payment') {
        router.push(`/reservation/payment/${token}`)
        return
      }
      setRefusing(false)
    } catch (failure) {
      setError(
        refusalSentence(
          convexErrorPayload(failure),
          "Votre réponse n'a pas pu être enregistrée. Veuillez réessayer.",
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="group-proposal"
      data-testid="group-proposal"
      className="space-y-4 rounded-2xl border border-border bg-card p-6"
    >
      <h2 id="group-proposal" className="text-lg font-semibold text-foreground">
        Proposition du restaurant
      </h2>
      <dl className="space-y-3">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
          <dt className="text-sm text-muted-foreground">Ce que vous aviez demandé</dt>
          <dd className="font-medium text-foreground sm:text-right">
            {at(group.requestedStartsAt)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
          <dt className="text-sm text-muted-foreground">Ce qui est proposé</dt>
          <dd className="font-medium text-foreground sm:text-right">{at(proposal.startsAt)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
          <dt className="text-sm text-muted-foreground">Proposition ouverte jusqu&apos;au</dt>
          <dd className="font-medium text-foreground sm:text-right">{at(proposal.expiresAt)}</dd>
        </div>
      </dl>
      {proposal.note && (
        <div className="rounded-xl bg-background p-4">
          <p className="text-sm font-semibold text-foreground">Note du restaurant</p>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{proposal.note}</p>
        </div>
      )}
      {payment && proposal.terms && (
        <div className="space-y-2">
          <p className="text-sm text-foreground">{payment}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {proposal.terms.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {!payment && (
        <p className="text-sm text-muted-foreground">
          Aucun paiement n&apos;est demandé : accepter confirme votre réservation à ce nouvel
          horaire.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      {refusing ? (
        <div className="space-y-3">
          <p className="font-semibold text-foreground">Refuser cette proposition ?</p>
          <p className="text-sm text-muted-foreground">
            Votre demande sera annulée et la place gardée pour votre groupe sera libérée.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button className="h-11 rounded-xl" disabled={busy} onClick={() => answer(false)}>
              {busy ? 'Envoi…' : 'Oui, refuser'}
            </Button>
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              disabled={busy}
              onClick={() => setRefusing(false)}
            >
              Non, revenir
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button className="h-12 rounded-xl" disabled={busy} onClick={() => answer(true)}>
            {busy ? 'Envoi…' : 'Accepter cette proposition'}
          </Button>
          <Button
            variant="outline"
            className="h-12 rounded-xl"
            disabled={busy}
            onClick={() => setRefusing(true)}
          >
            Refuser
          </Button>
        </div>
      )}
    </section>
  )
}
