'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { BellRing, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { reservationMarketingNotice, reservationPrivacyNotice } from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label, Skeleton } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import { convexErrorPayload } from '@/lib/convex-error'
import {
  formatCalendarDate,
  formatClock,
  formatReservationInstant,
} from '../../../_components/reservation-format'
import { PaymentQuoteBox } from '../../../_components/PaymentQuoteBox'

/** How often the countdown looks at the clock. */
const TICK_MS = 15_000

const DEFAULT_PRIVACY = { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 }

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

const people = (n: number) => `${n} ${n === 1 ? 'personne' : 'personnes'}`

/**
 * The guest's waitlist page.
 *
 * Five things can be true of an entry and the page says which, in words: still
 * waiting, offered a table (with the time it is kept until), the offer ran out, the
 * table was booked, or the request was withdrawn. It never promises more than the
 * server holds: an offer is shown only while the server says it stands, and what
 * the guest agrees to is the conditions of the booking, on this page, before the
 * table is theirs.
 *
 * A table taken from the waitlist owes what any booking of its size owes. When the
 * server's quote says a deposit or a card guarantee applies, its terms and the required
 * box are drawn here before « Réserver cette table »; the claim then creates the booking
 * awaiting its payment and the guest is sent to the payment page.
 */
export default function WaitlistContent() {
  const { token } = useParams<{ token: string }>()
  const entry = useQuery(api.reservationWaitlist.getByToken, { token })
  const claim = useMutation(api.reservationWaitlist.claim)
  const leave = useMutation(api.reservationWaitlist.leave)
  const now = useNow()
  const router = useRouter()

  const [consent, setConsent] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The table could not be given after all: told here, since the entry is closed.
  const [lost, setLost] = useState(false)
  const [left, setLeft] = useState(false)
  // The wording of the payment terms the guest ticked: new terms, new sentence, new tick.
  const [acceptedPaymentLabel, setAcceptedPaymentLabel] = useState<string | null>(null)
  // The table is claimed and the guest is on their way to pay for it.
  const [redirecting, setRedirecting] = useState(false)

  if (entry === undefined) {
    return (
      <Shell>
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </Shell>
    )
  }

  if (entry === null) {
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Demande introuvable</h1>
        <p className="mb-8 text-muted-foreground">
          Ce lien n&apos;est plus valide : la demande a pu être supprimée.
        </p>
        <Link href="/" className="font-semibold text-foreground underline underline-offset-4">
          Retour à l&apos;accueil
        </Link>
      </Shell>
    )
  }

  const privacy = entry.privacy ?? DEFAULT_PRIVACY
  const privacyNotice = reservationPrivacyNotice({
    storeName: entry.storeName,
    retentionDays: privacy.retentionDays,
    noteDays: privacy.noteDays,
  })
  const marketingNotice = reservationMarketingNotice({ storeName: entry.storeName })

  // The client's clock only decides when to STOP showing the offer; the server
  // decides whether it still stands, and refuses a late claim.
  const live = entry.offer !== null && entry.offer.expiresAt > now
  const minutesLeft = entry.offer
    ? Math.max(0, Math.ceil((entry.offer.expiresAt - now) / 60_000))
    : 0
  const phoneOk = !entry.needsPhone || phone.trim().length >= 3
  const owes = entry.payment?.required === true ? entry.payment : null
  const paymentConsent = owes !== null && acceptedPaymentLabel === owes.consentLabel
  const paymentOk = owes === null || (owes.payable && paymentConsent)
  const ready =
    live && consent && phoneOk && paymentOk && !busy && !redirecting && entry.noticeVersion !== null

  async function take() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await claim({
        token,
        consentNoticeVersion: entry!.noticeVersion as string,
        privacyNoticeVersion: privacyNotice.version,
        ...(marketing ? { marketingOptInVersion: marketingNotice.version } : {}),
        ...(entry!.needsPhone ? { phone: phone.trim() } : {}),
        ...(owes ? { paymentConsent: true } : {}),
      })
      if (!result.claimed) {
        setLost(true)
      } else if (result.booking.status === 'pending_payment') {
        // Held, not yet booked: the guest pays on the next page.
        setRedirecting(true)
        router.push(`/reservation/payment/${result.booking.manageToken}`)
      }
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "La table n'a pas pu être réservée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  async function decline() {
    setBusy(true)
    setError(null)
    try {
      await leave({ token })
      setLeft(true)
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "Votre demande n'a pas pu être retirée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  if (redirecting) {
    return (
      <Shell>
        <div role="status" aria-busy="true" className="rounded-2xl bg-card p-8 text-center">
          <h1 className="mb-2 text-2xl font-bold text-foreground">Redirection vers le paiement…</h1>
          <p className="text-muted-foreground">
            Votre table est gardée pour vous le temps de payer.
          </p>
        </div>
      </Shell>
    )
  }

  if (entry.status === 'booked') {
    return (
      <Shell>
        <div role="status" className="rounded-2xl bg-card p-8 text-center">
          <CheckCircle2 className="mx-auto mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
          <h1 className="mb-2 text-3xl font-bold text-foreground">Table réservée</h1>
          <p className="mb-6 text-muted-foreground">
            {entry.bookingStatus === 'pending_payment'
              ? "Votre table vous est gardée le temps de régler l'acompte ou d'enregistrer votre carte."
              : entry.autoConfirm
                ? 'Votre table est confirmée. À bientôt !'
                : "Le restaurant doit valider votre demande avant qu'elle soit confirmée."}
          </p>
          {entry.reservationRef && (
            <>
              <p className="mb-1 text-sm text-muted-foreground">Numéro de réservation</p>
              <p className="mb-8 font-mono text-xl font-bold text-foreground">
                {entry.reservationRef}
              </p>
            </>
          )}
          {entry.manageToken && entry.bookingStatus === 'pending_payment' && (
            <Link
              href={`/reservation/payment/${entry.manageToken}`}
              className="mb-4 block font-semibold text-foreground underline underline-offset-4"
            >
              Payer pour confirmer ma table
            </Link>
          )}
          {entry.manageToken && (
            <Link
              href={`/reservation/manage/${entry.manageToken}`}
              className="font-semibold text-foreground underline underline-offset-4"
            >
              Voir ou annuler ma réservation
            </Link>
          )}
        </div>
      </Shell>
    )
  }

  if (entry.status === 'removed' || left) {
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Demande retirée</h1>
        <p className="mb-8 text-muted-foreground">
          Vous ne recevrez plus d&apos;e-mail pour cette demande. Votre nom et vos coordonnées sont
          supprimés {privacy.waitlistKeptDays} jours après la date souhaitée.
        </p>
        <Link
          href="/reservation"
          className="font-semibold text-foreground underline underline-offset-4"
        >
          Chercher une autre date
        </Link>
      </Shell>
    )
  }

  if (entry.status === 'expired' || entry.lapsed || (entry.status === 'offered' && !live) || lost) {
    return (
      <Shell>
        <Clock className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">
          {lost ? "La table n'est plus disponible" : 'La proposition a expiré'}
        </h1>
        <p className="mb-8 text-muted-foreground">
          {lost
            ? "Cette table n'a pas pu vous être attribuée. Vous pouvez chercher un autre horaire ou refaire une demande."
            : `La table n'est plus gardée pour vous : le délai est passé. Vous pouvez chercher un autre horaire ou refaire une demande pour le ${formatCalendarDate(entry.date)}.`}
        </p>
        <Link
          href="/reservation"
          className="font-semibold text-foreground underline underline-offset-4"
        >
          Réserver une table
        </Link>
      </Shell>
    )
  }

  if (entry.status === 'offered' && entry.offer) {
    return (
      <Shell>
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {entry.storeName}
        </p>
        <h1 className="mb-2 flex items-center gap-2 text-3xl font-bold text-foreground">
          <BellRing className="h-7 w-7" aria-hidden="true" />
          Une table s&apos;est libérée
        </h1>
        <p className="mb-6 text-foreground">
          {people(entry.partySize)} ·{' '}
          {formatReservationInstant(entry.offer.startsAt, entry.timezone)}
          {entry.offer.roomName ? ` · zone « ${entry.offer.roomName} »` : ''}
        </p>
        <p
          role="timer"
          aria-live="off"
          className="mb-8 rounded-xl bg-card p-4 text-sm font-medium text-foreground"
        >
          Cette table vous est gardée jusqu&apos;à{' '}
          {formatClock(entry.offer.expiresAt, entry.timezone)}
          {minutesLeft > 0 ? ` (encore ${minutesLeft} min)` : ''}. Passé ce délai, elle est proposée
          à la personne suivante.
        </p>

        {error && (
          <p
            role="alert"
            className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
          >
            {error}
          </p>
        )}

        <section className="space-y-4 rounded-2xl bg-card p-5" aria-labelledby="claim-title">
          <h2 id="claim-title" className="text-lg font-semibold text-foreground">
            Réserver cette table
          </h2>
          {entry.needsPhone && (
            <div className="space-y-2">
              <Label htmlFor="phone">Téléphone</Label>
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Le restaurant peut vous joindre à ce numéro au sujet de votre réservation.
              </p>
            </div>
          )}
          {entry.policyText && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">{entry.policyText}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {owes
              ? entry.autoConfirm
                ? 'Votre réservation est confirmée dès que votre paiement est reçu.'
                : "Une fois votre paiement reçu, le restaurant doit valider votre demande avant qu'elle soit confirmée."
              : entry.autoConfirm
                ? 'Votre réservation est confirmée immédiatement.'
                : "Le restaurant doit valider votre demande avant qu'elle soit confirmée."}
            {!owes &&
              entry.cancellationDeadlineHours !== null &&
              ` Annulation en ligne possible jusqu'à ${entry.cancellationDeadlineHours} h avant.`}
          </p>
          <div className="space-y-2 text-sm text-muted-foreground">
            {privacyNotice.detail.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="consent"
              checked={consent}
              onCheckedChange={(value) => setConsent(value === true)}
            />
            <Label htmlFor="consent" className="text-sm leading-snug">
              {privacyNotice.label}
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="marketing"
              checked={marketing}
              onCheckedChange={(value) => setMarketing(value === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="marketing" className="text-sm leading-snug">
                {marketingNotice.label}
              </Label>
              {marketingNotice.detail.map((paragraph) => (
                <p key={paragraph} className="text-sm text-muted-foreground">
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        </section>

        {owes && (
          <div className="mt-6">
            <PaymentQuoteBox
              quote={owes}
              consent={paymentConsent}
              onConsentChange={(value) => setAcceptedPaymentLabel(value ? owes.consentLabel : null)}
            />
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <Button className="h-12 rounded-xl" disabled={!ready} onClick={take}>
            {busy ? 'Réservation…' : owes ? 'Continuer vers le paiement' : 'Réserver cette table'}
          </Button>
          <Button variant="outline" className="h-12 rounded-xl" disabled={busy} onClick={decline}>
            Non merci
          </Button>
        </div>
      </Shell>
    )
  }

  // Waiting: nothing is held, and the page says what will happen.
  return (
    <Shell>
      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {entry.storeName}
      </p>
      <h1 className="mb-6 text-3xl font-bold text-foreground">Ma liste d&apos;attente</h1>
      <dl className="mb-6 space-y-3 rounded-2xl bg-card p-6">
        <Row label="Date souhaitée" value={formatCalendarDate(entry.date)} />
        <Row label="Convives" value={people(entry.partySize)} />
        <Row
          label="Horaires"
          value={
            entry.earliest && entry.latest
              ? entry.earliest === entry.latest
                ? entry.earliest
                : `de ${entry.earliest} à ${entry.latest}`
              : 'Peu importe'
          }
        />
      </dl>
      <p role="status" className="mb-8 text-foreground">
        Aucune table n&apos;est gardée pour vous pour le moment. Si une table qui vous convient se
        libère, vous recevrez un e-mail avec un lien pour la réserver.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <Button variant="outline" className="h-12 rounded-xl" disabled={busy} onClick={decline}>
        {busy ? 'Retrait…' : 'Retirer ma demande'}
      </Button>
    </Shell>
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
