'use client'

/**
 * The screen a guest lands on once a group request is in.
 *
 * It does not say « confirmé ». It says what is true: the request is sent, the establishment
 * has not answered, the room is held for it until a stated moment, and the answer comes by
 * e-mail and on the guest's own link.
 */

import Link from 'next/link'
import { Hourglass } from 'lucide-react'
import type { SentGroupRequest } from './GroupRequestPanel'
import { formatReservationInstant } from './reservation-format'
import { peopleWord } from './reservation-groups'

export function GroupRequestSentScreen({
  sent,
  storeName,
  timezone,
}: {
  sent: SentGroupRequest
  storeName: string
  timezone: string
}) {
  const name = storeName.trim() || 'le restaurant'
  return (
    <div role="status" className="rounded-2xl bg-card p-8">
      <Hourglass className="mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
      <h1 className="mb-2 text-3xl font-bold text-foreground">Demande envoyée</h1>
      <p className="mb-4 font-semibold text-foreground">
        Votre réservation n&apos;est pas encore confirmée.
      </p>
      <p className="mb-2 text-muted-foreground">
        {name} doit accepter votre demande pour {peopleWord(sent.partySize)},{' '}
        {formatReservationInstant(sent.startsAt, timezone)}. Vous recevrez sa réponse par e-mail, et
        sur le lien ci-dessous.
      </p>
      <p className="mb-6 text-muted-foreground">
        {sent.reviewExpiresAt !== null
          ? `La place est gardée pour votre groupe jusqu'au ${formatReservationInstant(sent.reviewExpiresAt, timezone)}. Sans réponse avant, la demande expire et la place est libérée.`
          : 'La place est gardée pour votre groupe pendant que le restaurant lit votre demande.'}
      </p>
      <p className="mb-1 text-sm text-muted-foreground">Numéro de demande</p>
      <p className="mb-6 font-mono text-xl font-bold text-foreground">{sent.reference}</p>
      {sent.marketingAsked && (
        <p className="mb-6 text-sm text-muted-foreground">
          Vous avez demandé à recevoir nos nouvelles : un e-mail vous demande de confirmer votre
          inscription. Sans confirmation, rien ne vous sera envoyé.
        </p>
      )}
      <Link
        href={`/reservation/manage/${sent.manageToken}`}
        className="font-semibold text-foreground underline underline-offset-4"
      >
        Suivre ou retirer ma demande
      </Link>
    </div>
  )
}
