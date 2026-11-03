'use client'

/**
 * What a booking would cost, said before the guest commits.
 *
 * Shared by the booking form and the waitlist claim page: both read the same quote from
 * the server and both owe the guest the same things — the amount (or the absence of one),
 * what it is for, the refund terms in words, how long the table is held while they pay,
 * and one required box, worded by the server, that records they agreed. The box is not
 * pre-ticked and nothing is sent without it; the server refuses without it too.
 *
 * When the establishment asks for money it cannot currently take, the box says so and
 * offers no way to agree: there is no booking without paying what the house requires.
 */

import { CreditCard } from 'lucide-react'
import { formatMoney } from '@be-yours/convex-schema'
import { Checkbox, Label } from '@be-yours/ui'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '@/convex/_generated/api'

/** The quote when something is owed: the shape `getPaymentQuote` and the waitlist page share. */
export type RequiredPaymentQuote = Extract<
  FunctionReturnType<typeof api.reservationPayments.getPaymentQuote>,
  { required: true }
>

export function PaymentQuoteBox({
  quote,
  consent,
  onConsentChange,
  idPrefix = 'payment',
}: {
  quote: RequiredPaymentQuote
  consent: boolean
  onConsentChange: (value: boolean) => void
  idPrefix?: string
}) {
  const titleId = `${idPrefix}-title`
  const consentId = `${idPrefix}-consent`
  const money = (cents: number) => formatMoney(cents, quote.currency)
  const isDeposit = quote.kind === 'deposit'

  return (
    <section
      aria-labelledby={titleId}
      data-testid="payment-box"
      className="space-y-4 rounded-2xl border border-border bg-card p-5"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <CreditCard className="h-5 w-5" aria-hidden="true" />
        {isDeposit ? 'Un acompte est demandé' : 'Une garantie par carte est demandée'}
      </h2>

      {isDeposit ? (
        <p className="text-foreground">
          <span className="block text-3xl font-bold">{money(quote.depositCents)}</span>
          <span className="text-sm text-muted-foreground">
            à régler en ligne maintenant pour confirmer votre réservation.
          </span>
        </p>
      ) : (
        <p className="text-foreground">
          <span className="block text-2xl font-bold">Aucun débit maintenant</span>
          <span className="text-sm text-muted-foreground">
            Votre carte est seulement enregistrée. En cas d&apos;absence, l&apos;établissement peut
            débiter des frais allant jusqu&apos;à{' '}
            <strong className="text-foreground">{money(quote.noShowFeeCents)}</strong>.
          </span>
        </p>
      )}

      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {quote.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <p className="text-sm text-foreground">
        La table vous est gardée {quote.holdMinutes} minutes pour payer. Passé ce délai, elle est
        libérée.
      </p>

      {quote.payable ? (
        <div className="flex items-start gap-3">
          <Checkbox
            id={consentId}
            checked={consent}
            onCheckedChange={(value) => onConsentChange(value === true)}
          />
          <Label htmlFor={consentId} className="text-sm leading-snug">
            {quote.consentLabel}
          </Label>
        </div>
      ) : (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {isDeposit
            ? "Le paiement en ligne n'est pas disponible en ce moment, et cet établissement demande un acompte pour cette réservation : elle ne peut pas être prise ici pour l'instant. Réessayez plus tard ou contactez directement l'établissement."
            : "L'enregistrement de carte n'est pas disponible en ce moment, et cet établissement demande une garantie par carte pour cette réservation : elle ne peut pas être prise ici pour l'instant. Réessayez plus tard ou contactez directement l'établissement."}
        </p>
      )}
    </section>
  )
}
