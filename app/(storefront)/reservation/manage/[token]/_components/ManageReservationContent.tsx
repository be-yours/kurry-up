'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { CalendarPlus, CheckCircle2, Pencil, XCircle } from 'lucide-react'
import {
  formatMoney,
  paymentStateLabel,
  reservationManagePrivacyBlock,
  type PaymentPurpose,
  type PaymentState,
} from '@be-yours/convex-schema'
import { Button, Skeleton } from '@be-yours/ui'
import { renderReservationIcs } from '@be-yours/core/aws/ses/reservation-notice'
import { api } from '@/convex/_generated/api'
import { convexErrorPayload } from '@/lib/convex-error'
import { ContactCard } from '../../../_components/ContactCard'
import { formatReservationInstant, STATUS_COPY } from '../../../_components/reservation-format'
import {
  TICKET_STATUS_COPY,
  cancelledEventCopy,
  placesWord,
  renderTicketIcs,
  ticketCancelConsequence,
  ticketCancellationClosed,
} from '../../../_components/reservation-experiences'
import {
  cancelConsequence,
  cancellationClosedReason,
  formatCountdown,
} from '../../../_components/reservation-payment'
import { useNow } from '../../../_components/use-now'
import { ChangeReservationPanel } from './ChangeReservationPanel'
import { GroupRequestBlock } from './GroupRequestBlock'

/** How long the calendar file's object URL stays valid after the click. */
const CALENDAR_URL_LIFETIME_MS = 1000

export default function ManageReservationContent() {
  const { token } = useParams<{ token: string }>()
  const booking = useQuery(api.reservations.getByToken, { token })
  const cancel = useMutation(api.reservations.cancelByToken)
  const reconfirm = useMutation(api.reservations.reconfirmByToken)
  const [confirming, setConfirming] = useState(false)
  const [changing, setChanging] = useState(false)
  // What the guest was last told after a change, so the page says it stuck.
  const [changed, setChanged] = useState<{ status: string; changed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only ticks while a payment is awaited: the hold has a clock, nothing else here does.
  const now = useNow(booking?.payment?.awaiting === true)

  if (booking === undefined) {
    return (
      <Shell>
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </Shell>
    )
  }

  if (booking === null) {
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Réservation introuvable</h1>
        <p className="mb-8 text-muted-foreground">Ce lien n&apos;est plus valide.</p>
        <Link href="/" className="font-semibold text-foreground underline underline-offset-4">
          Retour à l&apos;accueil
        </Link>
      </Shell>
    )
  }

  /**
   * The booking as a file the guest's calendar opens.
   *
   * Built here, from what this page already holds, so there is no route to sign
   * and nothing a stranger could request: whoever has the link has the page.
   */
  function addToCalendar() {
    if (!booking) return
    const file = booking.experience
      ? // A ticket is an evening, not a table: the entry carries the event's own title.
        renderTicketIcs({
          reference: booking.reference,
          title: booking.experience.title,
          startsAt: booking.experience.startsAt,
          endsAt: booking.experience.endsAt,
          storeName: booking.storeName,
          location: booking.storeAddress ?? undefined,
          seats: booking.partySize,
          now: Date.now(),
          sequence: booking.revision,
        })
      : renderReservationIcs({
          reference: booking.reference,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          storeName: booking.storeName,
          location: booking.storeAddress ?? undefined,
          partySize: booking.partySize,
          now: Date.now(),
          // A changed booking replaces the entry the guest already saved, not doubles it.
          sequence: booking.revision,
        })
    const url = URL.createObjectURL(new Blob([file], { type: 'text/calendar;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `reservation-${booking.reference}.ics`
    link.click()
    // The browser reads the blob after the click returns; revoking at once can
    // cut the save short in some of them.
    setTimeout(() => URL.revokeObjectURL(url), CALENDAR_URL_LIFETIME_MS)
  }

  async function confirmCancel() {
    setBusy(true)
    setError(null)
    try {
      await cancel({ token })
      setConfirming(false)
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "L'annulation n'a pas pu être enregistrée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  async function confirmVisit() {
    setBusy(true)
    setError(null)
    try {
      await reconfirm({ token })
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "Votre confirmation n'a pas pu être enregistrée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  const group = booking.kind === 'group' ? booking.group : null
  const ticket = booking.kind === 'experience' ? booking.experience : null
  const purpose: PaymentPurpose = ticket ? 'experience' : group ? 'group' : 'booking'
  // What cancelling does to the money, said before the guest commits to it.
  const consequence = booking.payment
    ? ticket
      ? ticketCancelConsequence(booking.payment)
      : cancelConsequence(booking.payment)
    : null
  // A request still waiting for the host is withdrawn, not « cancelled »; a proposal is
  // answered by its own buttons.
  const withdrawing = group !== null && group.state === 'review'
  const cancelLabel = ticket
    ? 'Annuler mes places'
    : withdrawing
      ? 'Retirer ma demande'
      : 'Annuler ma réservation'
  const contact = (
    <ContactCard
      id="manage-contact"
      storeName={booking.storeName}
      phone={booking.storePhone}
      email={booking.storeEmail}
      lead="Pour toute question sur cette réservation, le plus simple est d'écrire ou d'appeler directement l'établissement."
      subject={`Réservation ${booking.reference}`}
    />
  )

  return (
    <Shell>
      {booking.storeName && (
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {booking.storeName}
        </p>
      )}
      <h1 className="mb-6 text-3xl font-bold text-foreground">
        {ticket ? 'Mes places' : group ? 'Ma demande de groupe' : 'Ma réservation'}
      </h1>

      {ticket?.imageUrl && (
        // An event's picture may come from any address the owner pasted: `next/image` refuses a
        // host that is not in `remotePatterns`, and the page would fail instead of showing it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ticket.imageUrl}
          alt={ticket.title}
          loading="lazy"
          className="mb-6 h-48 w-full rounded-2xl object-cover"
        />
      )}

      <dl className="mb-6 space-y-3 rounded-2xl bg-card p-6">
        <Row label="Numéro" value={<span className="font-mono">{booking.reference}</span>} />
        <Row label="Au nom de" value={booking.guestName} />
        {ticket && <Row label="Événement" value={ticket.title} />}
        <Row
          label={group && group.state.startsWith('proposal') ? 'Demandé pour' : 'Quand'}
          value={
            ticket
              ? formatReservationInstant(ticket.startsAt, booking.timezone)
              : formatReservationInstant(
                  group && group.state.startsWith('proposal')
                    ? group.requestedStartsAt
                    : booking.startsAt,
                  booking.timezone,
                )
          }
        />
        <Row
          label={ticket ? 'Places' : 'Convives'}
          value={
            ticket
              ? placesWord(booking.partySize)
              : `${booking.partySize} ${booking.partySize === 1 ? 'personne' : 'personnes'}`
          }
        />
        {group?.occasion && <Row label="Occasion" value={group.occasion} />}
        {group?.budget && <Row label="Menu ou budget souhaité" value={group.budget} />}
        {group?.message && <Row label="Votre message" value={group.message} />}
        {booking.roomPreference && (
          <Row
            label="Zone souhaitée"
            value={booking.rooms.find((room) => room.id === booking.roomPreference)?.name ?? ''}
          />
        )}
        {booking.guestNote && <Row label="Votre demande" value={booking.guestNote} />}
      </dl>

      {group && <GroupRequestBlock token={token} booking={booking} group={group} />}

      {ticket?.cancelled && (
        <section
          aria-labelledby="event-cancelled"
          className="mb-6 space-y-2 rounded-2xl border border-border bg-card p-6"
        >
          <h2 id="event-cancelled" className="text-lg font-semibold text-foreground">
            Cet événement est annulé
          </h2>
          {cancelledEventCopy({
            storeName: booking.storeName,
            cancelReason: ticket.cancelReason,
            payment: booking.payment,
          }).map((line) => (
            <p key={line} className="text-sm text-foreground">
              {line}
            </p>
          ))}
        </section>
      )}

      {booking.payment && (
        <PaymentBlock payment={booking.payment} token={token} now={now} purpose={purpose} />
      )}

      {changed && !changing && (
        <p role="status" className="mb-6 flex items-center gap-2 font-semibold text-foreground">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          {!changed.changed
            ? "Aucun changement : votre réservation est telle qu'avant."
            : changed.status === 'pending'
              ? 'Modification enregistrée : le restaurant doit la valider.'
              : 'Modification enregistrée.'}
        </p>
      )}

      {/* A request says where it stands in its own block above, in its own words. */}
      {!group && (
        <p role="status" className="mb-8 text-foreground">
          {ticket
            ? (TICKET_STATUS_COPY[booking.status] ?? STATUS_COPY[booking.status])
            : STATUS_COPY[booking.status]}
        </p>
      )}

      {booking.reconfirmedAt !== null && booking.status === 'confirmed' && (
        <p role="status" className="mb-8 flex items-center gap-2 font-semibold text-foreground">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          Merci, votre venue est confirmée.
        </p>
      )}

      {changing && (
        <ChangeReservationPanel
          token={token}
          booking={booking}
          onDone={(result) => {
            setChanged(result)
            setChanging(false)
          }}
          onCancel={() => setChanging(false)}
        />
      )}

      {booking.canReconfirm && booking.reconfirmedAt === null && !confirming && !changing && (
        <div className="mb-6">
          <Button className="h-12 rounded-xl" disabled={busy} onClick={confirmVisit}>
            {busy ? 'Enregistrement…' : 'Je serai là'}
          </Button>
          {error && (
            <p role="alert" className="mt-3 text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
      )}

      {booking.canModify && !confirming && !changing && (
        <div className="mb-6">
          <Button
            variant="outline"
            className="h-12 rounded-xl"
            onClick={() => {
              setChanged(null)
              setChanging(true)
            }}
          >
            <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
            Modifier ma réservation
          </Button>
        </div>
      )}

      {booking.canAddToCalendar && !confirming && !changing && (
        <div className="mb-6">
          <Button variant="outline" className="h-12 rounded-xl" onClick={addToCalendar}>
            <CalendarPlus className="mr-2 h-4 w-4" aria-hidden="true" />
            Ajouter à mon agenda
          </Button>
        </div>
      )}

      {booking.canCancel && !(group && group.state === 'proposal') && !confirming && !changing && (
        <Button variant="outline" className="h-12 rounded-xl" onClick={() => setConfirming(true)}>
          {consequence ? `Annuler : ${consequence}` : cancelLabel}
        </Button>
      )}

      {confirming && (
        <div className="space-y-4 rounded-2xl bg-card p-6">
          <p className="font-semibold text-foreground">
            {ticket
              ? 'Annuler ces places ?'
              : withdrawing
                ? 'Retirer cette demande ?'
                : 'Annuler cette réservation ?'}
          </p>
          <p className="text-sm text-muted-foreground">
            {ticket
              ? 'Les places seront libérées.'
              : withdrawing
                ? 'La place gardée pour votre groupe sera libérée.'
                : "La table sera libérée pour d'autres convives."}
            {consequence ? ` En annulant, ${consequence}.` : ''}
          </p>
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <Button className="h-11 rounded-xl" disabled={busy} onClick={confirmCancel}>
              {busy ? 'Annulation…' : withdrawing ? 'Oui, retirer' : 'Oui, annuler'}
            </Button>
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Non, garder
            </Button>
          </div>
        </div>
      )}

      {((booking.policyText && !ticket) || booking.payment) && (
        <section aria-labelledby="booking-policy" className="mt-8 space-y-2">
          <h2 id="booking-policy" className="text-sm font-semibold text-foreground">
            Conditions de réservation
          </h2>
          {booking.policyText && !ticket && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {booking.policyText}
            </p>
          )}
          {/* The deposit or the card guarantee, generated from the terms THIS booking
              agreed to — not from the policy as it stands today. */}
          {booking.payment && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {booking.payment.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(booking.status === 'confirmed' || booking.status === 'pending') &&
        !changing &&
        !group &&
        (ticket
          ? !booking.canCancel && !ticket.cancelled
          : !booking.canCancel || !booking.canModify) && (
          <p className="text-sm text-muted-foreground">
            {ticket
              ? ticketCancellationClosed({
                  cutoffHours: ticket.cancellationCutoffHours,
                  paid: booking.payment !== null && booking.payment.heldCents > 0,
                })
              : !booking.canCancel && booking.payment
                ? cancellationClosedReason(booking.payment)
                : !booking.canCancel && !booking.canModify
                  ? "Les délais de modification et d'annulation en ligne sont dépassés : contactez directement le restaurant."
                  : !booking.canModify
                    ? 'Le délai de modification en ligne est dépassé : vous pouvez encore annuler, ou contacter directement le restaurant.'
                    : "Le délai d'annulation en ligne est dépassé : contactez directement le restaurant."}
          </p>
        )}
      {ticket?.cancelled && contact}
      <PersonalData booking={booking} />
    </Shell>
  )
}

/**
 * « Paiement »: what this booking owes or holds, in words — the state, the amounts, what
 * was refunded — and, while a payment is awaited, the way back to the payment page with
 * the clock on the hold. Read from the server's own summary of the payment rows; nothing
 * here is inferred from the status alone.
 */
function PaymentBlock({
  payment,
  token,
  now,
  purpose,
}: {
  payment: NonNullable<
    NonNullable<FunctionReturnType<typeof api.reservations.getByToken>>['payment']
  >
  token: string
  now: number
  purpose: PaymentPurpose
}) {
  const money = (cents: number) => formatMoney(cents, payment.currency)
  const label = paymentStateLabel(payment.state as PaymentState, purpose)
  const tickets = purpose === 'experience'
  const left = payment.holdExpiresAt === null ? 0 : Math.max(0, payment.holdExpiresAt - now)
  const paid = payment.heldCents + payment.refundedCents
  const lapsed = payment.awaiting && left <= 0
  return (
    <section aria-labelledby="booking-payment" className="mb-6 space-y-3 rounded-2xl bg-card p-6">
      <h2 id="booking-payment" className="text-lg font-semibold text-foreground">
        Paiement
      </h2>
      <dl className="space-y-2">
        {label && <Row label="État" value={label} />}
        {payment.kind === 'deposit' ? (
          <Row
            label={tickets ? 'Prix des places' : 'Acompte demandé'}
            value={money(payment.depositCents)}
          />
        ) : (
          <Row label="Frais d'absence, au plus" value={money(payment.noShowFeeCents)} />
        )}
        {payment.kind === 'deposit' && paid > 0 && <Row label="Payé" value={money(paid)} />}
        {payment.refundedCents > 0 && (
          <Row label="Remboursé" value={money(payment.refundedCents)} />
        )}
        {payment.feeChargedCents > 0 && (
          <Row label="Frais d'absence débités" value={money(payment.feeChargedCents)} />
        )}
      </dl>
      {payment.state === 'secured' && (
        <p className="text-sm text-muted-foreground">
          Votre carte est enregistrée, sans débit. Elle ne peut être débitée qu&apos;en cas
          d&apos;absence, jusqu&apos;au montant indiqué ci-dessus.
        </p>
      )}
      {(payment.state === 'refunded' || payment.state === 'partially_refunded') && (
        <p className="text-sm text-muted-foreground">
          Le remboursement a été effectué : le délai de réception dépend de votre banque.
        </p>
      )}
      {payment.state === 'released' && (
        <p className="text-sm text-muted-foreground">
          La garantie est libérée : votre carte ne sera pas débitée.
        </p>
      )}
      {payment.awaiting && !lapsed && (
        <div className="space-y-3">
          <p role="timer" aria-live="off" className="text-sm text-foreground">
            {tickets ? 'Vos places vous sont gardées encore' : 'La table vous est gardée encore'}{' '}
            <span className="font-mono font-bold tabular-nums">{formatCountdown(left)}</span>.
          </p>
          <Link
            href={`/reservation/payment/${token}`}
            className="inline-flex h-12 items-center rounded-xl bg-primary px-6 font-semibold text-primary-foreground"
          >
            {payment.kind === 'deposit' ? 'Payer maintenant' : 'Enregistrer ma carte'}
          </Link>
        </div>
      )}
      {lapsed && (
        <p className="text-sm text-muted-foreground">
          {tickets
            ? 'Le délai pour payer est dépassé : les places sont libérées.'
            : 'Le délai pour payer est dépassé : la table est libérée.'}
        </p>
      )}
    </section>
  )
}

/**
 * « Données personnelles »: what the restaurant keeps about this booking, for how
 * long, and how to ask for a copy or an erasure. There is no self-service button on
 * purpose — the restaurant is the controller and answers by name, with the booking
 * number — but the way to ask is on the page the guest is already reading.
 */
function PersonalData({
  booking,
}: {
  booking: NonNullable<FunctionReturnType<typeof api.reservations.getByToken>>
}) {
  const block = reservationManagePrivacyBlock({
    storeName: booking.storeName,
    retentionDays: booking.retentionDays,
    noteDays: booking.noteDays,
    acceptedVersion: booking.privacyNoticeVersion,
  })
  const contact = [booking.storePhone, booking.storeEmail].filter(Boolean)
  return (
    <section
      aria-labelledby="personal-data"
      className="mt-10 space-y-2 border-t border-border pt-6"
    >
      <h2 id="personal-data" className="text-sm font-semibold text-foreground">
        {block.heading}
      </h2>
      {block.paragraphs.map((paragraph) => (
        <p key={paragraph} className="text-sm text-muted-foreground">
          {paragraph}
        </p>
      ))}
      {contact.length > 0 && (
        <p className="text-sm text-muted-foreground">Pour les joindre : {contact.join(' · ')}</p>
      )}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground sm:text-right">{value}</dd>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-xl px-4 pb-12 pt-32 sm:pb-16">{children}</div>
}
