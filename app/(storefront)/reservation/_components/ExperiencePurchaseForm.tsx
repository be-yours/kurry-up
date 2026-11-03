'use client'

/**
 * « Réserver » on an event: how many seats, who is coming, what it costs and the agreement.
 *
 * Seats are not a table: the form asks for a number of places, shows what they cost and the
 * terms in words BEFORE the guest submits — the server's own quote, drawn from `getPurchaseQuote`
 * — and records one required box that agrees to them. Submitting buys the seats: a free event
 * is confirmed at once and the guest is sent to their ticket; a paid one is held for the time
 * the quote says and the guest is sent to the payment page, where they choose how to pay. The
 * form never touches a provider.
 */

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { CreditCard } from 'lucide-react'
import {
  formatMoney,
  reservationMarketingNotice,
  reservationPrivacyNotice,
} from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label, Skeleton, Textarea } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { convexErrorPayload } from '@/lib/convex-error'
import type { PublicExperience } from './ExperienceCard'
import { placesWord, purchaseDestination } from './reservation-experiences'
import { refusalSentence } from './reservation-refusals'

type PublicConfig = NonNullable<FunctionReturnType<typeof api.reservations.getPublicConfig>>

const DEFAULT_PRIVACY = { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 }

/** One key per form: a double tap or a retried request is the same purchase. */
function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function ExperiencePurchaseForm({
  card,
  config,
  onClose,
}: {
  card: PublicExperience
  config: PublicConfig
  onClose: () => void
}) {
  const router = useRouter()
  const buy = useMutation(api.reservationExperiences.buy)
  const [seats, setSeats] = useState(1)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [consent, setConsent] = useState(false)
  // Unchecked, and never ticked for the guest: buying subscribes nobody.
  const [marketing, setMarketing] = useState(false)
  // The wording of the payment terms the guest ticked: other seats, other sentence, new tick.
  const [acceptedPayment, setAcceptedPayment] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef('')
  if (!key.current) key.current = newKey()

  const quote = useQuery(api.reservationExperiences.getPurchaseQuote, {
    experienceId: card.id as Id<'reservationExperiences'>,
    seats,
  })

  const privacy = config.privacy ?? DEFAULT_PRIVACY
  const privacyNotice = reservationPrivacyNotice({
    storeName: config.storeName,
    retentionDays: privacy.retentionDays,
    noteDays: privacy.noteDays,
  })
  const marketingNotice = reservationMarketingNotice({ storeName: config.storeName })
  const seatChoices = Array.from({ length: Math.max(1, card.maxSeatsPerBooking) }, (_, i) => i + 1)

  const paid = quote !== undefined && !quote.free
  const paymentConsent = paid && acceptedPayment === quote.consentLabel
  // Until the quote has arrived the form cannot know what it is agreeing to; once it has, a
  // refused quote blocks, and a paid one needs a payable provider AND the guest's tick.
  const quoteOk =
    quote !== undefined &&
    quote.refusal === null &&
    (quote.free || (quote.payable && paymentConsent))
  const ready =
    quoteOk &&
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    phone.trim().length >= 3 &&
    consent &&
    !busy &&
    !redirecting

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await buy({
        experienceId: card.id as Id<'reservationExperiences'>,
        seats,
        guest: { name: name.trim(), email: email.trim(), phone: phone.trim() },
        ...(note.trim() ? { note: note.trim() } : {}),
        consentNoticeVersion: config.noticeVersion,
        privacyNoticeVersion: privacyNotice.version,
        ...(marketing ? { marketingOptInVersion: marketingNotice.version } : {}),
        ...(paid ? { paymentConsent: true } : {}),
        idempotencyKey: key.current,
      })
      // Either way the guest leaves this page: stay disabled until it has gone, so a second
      // tap cannot buy a second set of seats.
      setRedirecting(true)
      router.push(purchaseDestination(result.status, result.manageToken))
    } catch (failure) {
      setError(
        refusalSentence(
          convexErrorPayload(failure),
          "Vos places n'ont pas pu être réservées. Veuillez réessayer.",
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const fid = (suffix: string) => `exp-${card.id}-${suffix}`

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Réserver des places : ${card.title}`}
      className="mt-2 space-y-5 border-t border-border pt-5"
    >
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor={fid('seats')}>Nombre de places</Label>
        <select
          id={fid('seats')}
          value={seats}
          onChange={(e) => {
            setSeats(Number(e.target.value))
            setAcceptedPayment(null)
          }}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground"
        >
          {seatChoices.map((n) => (
            <option key={n} value={n}>
              {placesWord(n)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={fid('name')}>Nom</Label>
        <Input
          id={fid('name')}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={fid('email')}>E-mail</Label>
          <Input
            id={fid('email')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={fid('phone')}>Téléphone</Label>
          <Input
            id={fid('phone')}
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={fid('note')}>Allergies et régimes alimentaires (facultatif)</Label>
        <Textarea
          id={fid('note')}
          maxLength={500}
          placeholder="Sans gluten, végétarien, allergie aux arachides…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {quote === undefined && (
        <div role="status" aria-busy="true">
          <span className="sr-only">Calcul du prix de vos places…</span>
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      )}

      {quote !== undefined && quote.refusal !== null && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-3 text-sm font-medium text-destructive"
        >
          {quote.refusal}
        </p>
      )}

      {quote !== undefined && quote.free && quote.refusal === null && (
        <p role="status" className="rounded-xl bg-background p-4 text-sm text-foreground">
          Cet événement est gratuit : vos {placesWord(seats)} sont confirmées dès que vous envoyez
          le formulaire.
        </p>
      )}

      {quote !== undefined && !quote.free && (
        <section
          aria-labelledby={fid('payment-title')}
          data-testid="experience-payment-box"
          className="space-y-4 rounded-2xl border border-border bg-background p-5"
        >
          <h4
            id={fid('payment-title')}
            className="flex items-center gap-2 text-lg font-semibold text-foreground"
          >
            <CreditCard className="h-5 w-5" aria-hidden="true" />
            Règlement des places
          </h4>
          <p className="text-foreground">
            <span className="block text-3xl font-bold">
              {formatMoney(quote.totalCents, quote.currency)}
            </span>
            <span className="text-sm text-muted-foreground">
              pour {placesWord(seats)}, à régler en ligne maintenant pour les confirmer.
            </span>
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {quote.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-sm text-foreground">
            Vos places vous sont gardées {quote.holdMinutes} minutes pour payer. Passé ce délai,
            elles sont remises en vente.
          </p>
          {quote.payable ? (
            <>
              <p className="text-sm text-muted-foreground">
                Vous choisirez le moyen de paiement à l&apos;étape suivante
                {quote.providers.length > 0
                  ? ` : ${quote.providers.map((provider) => provider.label).join(', ')}`
                  : ''}
                .
              </p>
              <div className="flex items-start gap-3">
                <Checkbox
                  id={fid('payment-consent')}
                  checked={paymentConsent}
                  onCheckedChange={(value) =>
                    setAcceptedPayment(value === true ? quote.consentLabel : null)
                  }
                />
                <Label htmlFor={fid('payment-consent')} className="text-sm leading-snug">
                  {quote.consentLabel}
                </Label>
              </div>
            </>
          ) : (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 p-3 text-sm font-medium text-destructive"
            >
              Le paiement en ligne n&apos;est pas disponible en ce moment : ces places ne peuvent
              pas être réservées ici pour l&apos;instant. Réessayez plus tard ou contactez
              directement l&apos;établissement.
            </p>
          )}
        </section>
      )}

      <div className="space-y-4">
        <div className="space-y-2 text-sm text-muted-foreground">
          {privacyNotice.detail.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id={fid('consent')}
            checked={consent}
            onCheckedChange={(value) => setConsent(value === true)}
          />
          <Label htmlFor={fid('consent')} className="text-sm leading-snug">
            {privacyNotice.label}
          </Label>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id={fid('marketing')}
            checked={marketing}
            onCheckedChange={(value) => setMarketing(value === true)}
          />
          <div className="space-y-1">
            <Label htmlFor={fid('marketing')} className="text-sm leading-snug">
              {marketingNotice.label}
            </Label>
            {marketingNotice.detail.map((paragraph) => (
              <p key={paragraph} className="text-sm text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!ready} className="h-12 flex-1 rounded-xl">
          {busy || redirecting
            ? paid
              ? 'Redirection…'
              : 'Envoi…'
            : paid
              ? 'Continuer vers le paiement'
              : 'Confirmer mes places'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-12 rounded-xl"
          disabled={busy || redirecting}
          onClick={onClose}
        >
          Fermer
        </Button>
      </div>
    </form>
  )
}
