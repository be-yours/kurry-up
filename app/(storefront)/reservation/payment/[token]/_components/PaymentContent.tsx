'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useAction, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { CheckCircle2, Clock, CreditCard, Hourglass, XCircle } from 'lucide-react'
import {
  PROVIDER_CAPABILITIES,
  formatMoney,
  paymentStateLabel,
  type PaymentPurpose,
  type PaymentState,
} from '@be-yours/convex-schema'
import { Button, Checkbox, Label, Skeleton } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import { convexErrorPayload } from '@/lib/convex-error'
import { TICKET_STATUS_COPY, placesWord } from '../../../_components/reservation-experiences'
import { formatReservationInstant, STATUS_COPY } from '../../../_components/reservation-format'
import {
  VERIFY_PATIENCE_MS,
  formatCountdown,
  holdAnnouncement,
  paymentErrorFallback,
  paymentView,
  people,
  type PaymentReturn,
} from '../../../_components/reservation-payment'
import { useNow } from '../../../_components/use-now'

type PaymentPage = NonNullable<FunctionReturnType<typeof api.reservationPayments.getPaymentPage>>
type ProviderId = PaymentPage['providers'][number]['provider']

/**
 * The guest's payment page.
 *
 * Eight things can be true of a booking that owes something, and the page says which, in
 * words: it is waiting for the payment (and how long the table is held), the guest came
 * back from the provider and the server has not confirmed yet, it is still unconfirmed
 * after a while, the guest cancelled at the provider, the last attempt failed, the hold ran
 * out, the booking is taken, or it ended some other way.
 *
 * The page never decides that money moved. The provider's redirect only makes it ask the
 * server — once — to read the payment back; what it shows afterwards is what the server's
 * reactive answer says, whichever of the provider's webhook, the sweep or that call got
 * there first. A guest who reloads a `?return=success` link next week sees the booking,
 * not a spinner.
 */
export default function PaymentContent({ returned }: { returned: PaymentReturn | null }) {
  const { token } = useParams<{ token: string }>()
  const page = useQuery(api.reservationPayments.getPaymentPage, { token })
  const start = useAction(api.reservationPaymentActions.startReservationPayment)
  const verify = useAction(api.reservationPaymentActions.verifyReservationPayment)
  // The event's own title, for a ticket: the payment page does not carry it.
  const ticket = useQuery(
    api.reservations.getByToken,
    page?.purpose === 'experience' ? { token } : 'skip',
  )

  const [choice, setChoice] = useState<ProviderId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gaveUp, setGaveUp] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  // The guest's tick on terms set after their request (a group accepted with a deposit).
  const [agreed, setAgreed] = useState(false)
  // A double tap must not start two attempts; the server is idempotent as well, and this is
  // what keeps the button honest in the meantime.
  const starting = useRef(false)
  // Back from the provider: ask the server to read the payment back, once.
  const verified = useRef(false)

  const holdCounts = page != null && page.status === 'pending_payment'
  // The hold is the SERVER's to lapse: the page counts down on the server's clock, read
  // when the page answers, so a device clock that runs ahead cannot release the table early.
  const [skew, setSkew] = useState(0)
  const serverNow = page?.serverNow
  useEffect(() => {
    if (typeof serverNow === 'number') setSkew(serverNow - Date.now())
  }, [serverNow])
  const now = useNow(holdCounts) + skew

  useEffect(() => {
    if (returned !== 'success' || verified.current) return
    verified.current = true
    verify({ token }).catch(() => {
      // The webhook or the sweep settles it as well; the page keeps waiting for the server.
    })
  }, [returned, token, verify])

  useEffect(() => {
    if (returned !== 'success') return
    const timer = setTimeout(() => setGaveUp(true), VERIFY_PATIENCE_MS)
    return () => clearTimeout(timer)
  }, [returned])

  // The browser's back button restores this page from its cache with the button still
  // spinning; the guest who came back should be able to try again.
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      starting.current = false
      setBusy(false)
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [])

  if (page === undefined) {
    return (
      <Shell>
        <div role="status" aria-busy="true">
          <span className="sr-only">Chargement de votre paiement…</span>
          <Skeleton className="mb-4 h-10 w-64" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </Shell>
    )
  }

  if (page === null || page.payment === null) {
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">Réservation introuvable</h1>
        <p className="mb-8 text-muted-foreground">
          Ce lien n&apos;est plus valide, ou cette réservation n&apos;a pas de paiement à régler.
        </p>
        <Link href="/" className="font-semibold text-foreground underline underline-offset-4">
          Retour à l&apos;accueil
        </Link>
      </Shell>
    )
  }

  const { payment } = page
  const money = (cents: number) => formatMoney(cents, payment.currency)
  const isDeposit = payment.kind === 'deposit'
  const purpose: PaymentPurpose = page.purpose ?? 'booking'
  const forTickets = purpose === 'experience'
  const forGroup = purpose === 'group'
  // A group the host accepted and seats at an event are confirmed by the payment itself,
  // whatever the house's usual confirmation mode.
  const confirmsOnPayment = page.autoConfirm || forTickets || forGroup
  // Terms set after the guest's request must be agreed to here, before any provider.
  const consentLabel = typeof page.consentLabel === 'string' ? page.consentLabel : null
  const termLines = page.termLines ?? payment.lines
  const statusCopy = (status: string): string | undefined =>
    forTickets ? TICKET_STATUS_COPY[status] : STATUS_COPY[status as keyof typeof STATUS_COPY]
  const holdWords = forTickets
    ? 'Vos places vous sont gardées encore'
    : 'La table vous est gardée encore'
  const view = paymentView(
    { status: page.status, payment },
    { now, returned, verifyGaveUp: gaveUp },
  )
  const manageHref = `/reservation/manage/${page.manageToken}`
  const selected: ProviderId | null =
    page.providers.find((provider) => provider.provider === choice)?.provider ??
    page.defaultProvider ??
    page.providers[0]?.provider ??
    null
  const selectedLabel = page.providers.find((provider) => provider.provider === selected)?.label

  async function pay() {
    if (starting.current || !selected) return
    // Pressing Enter submits a form whose button is disabled: the tick is checked here too.
    if (consentLabel && !agreed) return
    starting.current = true
    setBusy(true)
    setError(null)
    try {
      const { redirectUrl } = await start({
        token,
        provider: selected,
        returnOrigin: window.location.origin,
        ...(consentLabel ? { consent: true } : {}),
      })
      // The page is left for the provider's: stay busy until the browser has gone.
      window.location.assign(redirectUrl)
    } catch (failure) {
      const payload = convexErrorPayload(failure)
      setError(payload?.message ?? paymentErrorFallback(payload?.code))
      starting.current = false
      setBusy(false)
    }
  }

  async function recheck() {
    setRechecking(true)
    try {
      await verify({ token })
    } catch {
      // Nothing to add: the page still says what the server holds.
    } finally {
      setRechecking(false)
    }
  }

  const summary = (
    <dl className="mb-6 space-y-3 rounded-2xl bg-card p-6">
      <Row label="Numéro" value={<span className="font-mono">{page.reference}</span>} />
      {forTickets && ticket?.experience && (
        <Row label="Événement" value={ticket.experience.title} />
      )}
      <Row label="Quand" value={formatReservationInstant(page.startsAt, page.timezone)} />
      <Row
        label={forTickets ? 'Places' : 'Convives'}
        value={forTickets ? placesWord(page.partySize) : people(page.partySize)}
      />
    </dl>
  )

  const terms = (
    <section aria-labelledby="payment-terms" className="mb-6 space-y-2">
      <h2 id="payment-terms" className="text-sm font-semibold text-foreground">
        Conditions de remboursement
      </h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {termLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )

  if (view === 'settled') {
    const pending = page.status === 'pending'
    const paidLine = settledLine(payment, money, purpose)
    // A booking the team confirmed without waiting for the money has no payment to describe.
    const moneyTaken = !['awaiting', 'none', 'failed'].includes(payment.state)
    return (
      <Shell>
        <div role="status" className="rounded-2xl bg-card p-8">
          <CheckCircle2 className="mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
          <h1 className="mb-2 text-3xl font-bold text-foreground">
            {pending
              ? "Demande reçue — l'établissement doit la valider"
              : forTickets
                ? 'Places confirmées'
                : 'Réservation confirmée'}
          </h1>
          <p className="mb-2 text-foreground">{paidLine}</p>
          <p className="mb-6 text-muted-foreground">
            {pending
              ? "Le restaurant doit valider votre demande avant qu'elle soit confirmée. Vous recevrez sa réponse par e-mail et sur le lien de votre réservation."
              : statusCopy('confirmed')}
          </p>
          <dl className="mb-6 space-y-3">
            <Row label="Numéro" value={<span className="font-mono">{page.reference}</span>} />
            {forTickets && ticket?.experience && (
              <Row label="Événement" value={ticket.experience.title} />
            )}
            <Row label="Quand" value={formatReservationInstant(page.startsAt, page.timezone)} />
            <Row
              label={forTickets ? 'Places' : 'Convives'}
              value={forTickets ? placesWord(page.partySize) : people(page.partySize)}
            />
            {moneyTaken && paymentStateLabel(payment.state as PaymentState, purpose) && (
              <Row
                label="Paiement"
                value={paymentStateLabel(payment.state as PaymentState, purpose)}
              />
            )}
          </dl>
          {moneyTaken && terms}
          <Link
            href={manageHref}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            {forTickets ? 'Voir mes places' : 'Voir ma réservation'}
          </Link>
        </div>
      </Shell>
    )
  }

  if (view === 'ended') {
    const copy = statusCopy(page.status)
    return (
      <Shell>
        <XCircle className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">
          {forTickets ? 'Ces places ne sont plus à régler' : 'Cette réservation est terminée'}
        </h1>
        <p className="mb-4 text-muted-foreground">
          {copy ?? "Cette réservation n'attend plus de paiement."}
        </p>
        {payment.refundedCents > 0 && (
          <p className="mb-4 text-foreground">
            Remboursement de {money(payment.refundedCents)} effectué : le délai de réception dépend
            de votre banque.
          </p>
        )}
        <div className="flex flex-wrap gap-4">
          <Link
            href={forTickets ? '/reservation#events' : '/reservation'}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            {forTickets ? 'Voir les événements' : 'Réserver une table'}
          </Link>
          <Link
            href={manageHref}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            {forTickets ? 'Voir mes places' : 'Voir ma réservation'}
          </Link>
        </div>
      </Shell>
    )
  }

  if (view === 'lapsed') {
    return (
      <Shell>
        <Clock className="mb-6 h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-3 text-3xl font-bold text-foreground">
          {forTickets
            ? 'Le délai est dépassé, les places ont été libérées'
            : 'Le délai est dépassé, la table a été libérée'}
        </h1>
        <p className="mb-4 text-muted-foreground">
          {forTickets
            ? "Les places ne sont plus gardées pour vous : le paiement n'a pas été reçu à temps. S'il en reste, vous pouvez les réserver à nouveau."
            : "La table n'est plus gardée pour vous : le paiement n'a pas été reçu à temps. Vous pouvez chercher un autre horaire et refaire une réservation."}
        </p>
        {returned === 'success' && (
          <p role="status" className="mb-4 text-foreground">
            Si un paiement a malgré tout été reçu après la fin du délai, il vous est remboursé en
            totalité ; le remboursement est demandé automatiquement.
          </p>
        )}
        <Link
          href={forTickets ? '/reservation#events' : '/reservation'}
          className="font-semibold text-foreground underline underline-offset-4"
        >
          {forTickets ? 'Voir les événements' : 'Réserver à nouveau'}
        </Link>
      </Shell>
    )
  }

  if (view === 'verifying' || view === 'unconfirmed') {
    return (
      <Shell>
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {page.storeName}
        </p>
        {view === 'verifying' ? (
          <div role="status" aria-busy="true" className="rounded-2xl bg-card p-8">
            <Hourglass className="mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
            <h1 className="mb-2 text-3xl font-bold text-foreground">
              Nous vérifions votre paiement…
            </h1>
            <p className="text-muted-foreground">
              Cette page se met à jour toute seule. Dès que le paiement est confirmé,{' '}
              {forTickets ? 'vos places sont' : 'votre réservation est'}{' '}
              {confirmsOnPayment ? 'confirmée' : "transmise à l'établissement, qui doit la valider"}
              {forTickets && confirmsOnPayment ? 's' : ''}.
            </p>
          </div>
        ) : (
          <div role="status" className="rounded-2xl bg-card p-8">
            <Hourglass className="mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
            <h1 className="mb-2 text-3xl font-bold text-foreground">
              Votre paiement n&apos;est pas encore confirmé
            </h1>
            <p className="mb-4 text-muted-foreground">
              Nous n&apos;avons pas encore reçu la confirmation de votre paiement. Elle vous sera
              envoyée par e-mail, et vous pouvez fermer cette page et la rouvrir plus tard : elle
              affichera où en est {forTickets ? 'vos places' : 'votre réservation'}. Le temps de
              garde {forTickets ? 'des places' : 'de la table'} continue de s&apos;écouler
              jusqu&apos;à la confirmation.
            </p>
            <HoldClock expiresAt={payment.holdExpiresAt} now={now} words={holdWords} />
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <Button
                variant="outline"
                className="h-11 rounded-xl"
                disabled={rechecking}
                onClick={recheck}
              >
                {rechecking ? 'Vérification…' : 'Vérifier à nouveau'}
              </Button>
              <Link
                href={manageHref}
                className="font-semibold text-foreground underline underline-offset-4"
              >
                {forTickets ? 'Voir mes places' : 'Voir ma réservation'}
              </Link>
            </div>
          </div>
        )}
      </Shell>
    )
  }

  // awaiting, cancelled, failed: the way to pay.
  const providers = page.providers
  const canStart = page.canPay && selected !== null && !busy && (!consentLabel || agreed)
  const retry = view === 'cancelled' || view === 'failed'
  const buttonLabel = busy
    ? 'Redirection vers le paiement…'
    : retry
      ? 'Réessayer le paiement'
      : isDeposit
        ? `Payer ${money(page.amountDueCents)}`
        : 'Enregistrer ma carte'

  return (
    <Shell>
      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {page.storeName}
      </p>
      <h1 className="mb-2 flex items-center gap-2 text-3xl font-bold text-foreground">
        <CreditCard className="h-7 w-7" aria-hidden="true" />
        {forTickets
          ? 'Régler vos places'
          : forGroup && isDeposit
            ? "Régler l'acompte de votre groupe"
            : isDeposit
              ? 'Régler votre acompte'
              : 'Enregistrer votre carte'}
      </h1>
      <p className="mb-6 text-muted-foreground">
        {forTickets
          ? 'Vos places sont confirmées dès que le paiement est reçu.'
          : confirmsOnPayment
            ? 'Votre réservation est confirmée dès que le paiement est reçu.'
            : "Une fois le paiement reçu, le restaurant doit valider votre demande avant qu'elle soit confirmée."}
      </p>

      {view === 'cancelled' && (
        <p role="status" className="mb-6 rounded-xl bg-card p-4 font-medium text-foreground">
          Paiement annulé, rien n&apos;a été débité.{' '}
          <span className="font-normal text-muted-foreground">
            Vous pouvez réessayer tant que la table vous est gardée.
          </span>
        </p>
      )}
      {view === 'failed' && (
        <p
          role="alert"
          className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          Votre dernier essai de paiement n&apos;a pas abouti. Vous pouvez réessayer
          {providers.length > 1 ? ', ou choisir un autre moyen de paiement' : ''}.
        </p>
      )}

      {summary}

      <div className="mb-6 rounded-2xl bg-card p-6">
        {isDeposit ? (
          <p className="text-foreground">
            <span className="block text-3xl font-bold">{money(page.amountDueCents)}</span>
            <span className="text-sm text-muted-foreground">
              {forTickets
                ? `pour ${placesWord(page.partySize)}, à régler maintenant pour les confirmer.`
                : "d'acompte, à régler maintenant pour confirmer votre réservation."}
            </span>
          </p>
        ) : (
          <p className="text-foreground">
            <span className="block text-2xl font-bold">Aucun débit maintenant</span>
            <span className="text-sm text-muted-foreground">
              Votre carte est seulement enregistrée. En cas d&apos;absence, l&apos;établissement
              peut débiter des frais allant jusqu&apos;à{' '}
              <strong className="text-foreground">{money(payment.noShowFeeCents)}</strong>.
            </span>
          </p>
        )}
        <div className="mt-4">
          <HoldClock expiresAt={payment.holdExpiresAt} now={now} words={holdWords} />
        </div>
      </div>

      {terms}

      {error && (
        <p
          role="alert"
          className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      {providers.length === 0 ? (
        <p
          role="alert"
          className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          Le paiement en ligne n&apos;est pas disponible en ce moment. Votre table reste gardée
          jusqu&apos;à la fin du compte à rebours : réessayez dans quelques instants, ou contactez
          directement l&apos;établissement.
        </p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            void pay()
          }}
        >
          {consentLabel && (
            <div className="flex items-start gap-3 rounded-xl bg-card p-4">
              <Checkbox
                id="payment-agreement"
                checked={agreed}
                disabled={busy}
                onCheckedChange={(value) => setAgreed(value === true)}
              />
              <Label htmlFor="payment-agreement" className="text-sm leading-snug">
                {consentLabel}
              </Label>
            </div>
          )}

          {providers.length > 1 ? (
            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-semibold text-foreground">
                Comment souhaitez-vous payer ?
              </legend>
              {providers.map((provider) => {
                const id = `payment-provider-${provider.provider}`
                const checked = selected === provider.provider
                return (
                  <label key={provider.provider} htmlFor={id} className="block cursor-pointer">
                    <input
                      id={id}
                      type="radio"
                      name="payment-provider"
                      className="peer sr-only"
                      checked={checked}
                      disabled={busy}
                      onChange={() => setChoice(provider.provider)}
                    />
                    <span className="flex items-start justify-between gap-3 rounded-xl border-2 border-border bg-background p-4 transition-colors hover:border-foreground peer-checked:border-foreground peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring">
                      <span className="space-y-1">
                        <span className="block font-semibold text-foreground">
                          {provider.label}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {PROVIDER_CAPABILITIES[provider.provider].notes[payment.kind]}
                        </span>
                      </span>
                      {checked && (
                        <CheckCircle2
                          className="mt-0.5 h-5 w-5 shrink-0 text-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  </label>
                )
              })}
            </fieldset>
          ) : (
            <p className="text-sm text-foreground">
              Paiement par <strong>{providers[0]?.label}</strong>.{' '}
              <span className="text-muted-foreground">
                {providers[0]
                  ? PROVIDER_CAPABILITIES[providers[0].provider].notes[payment.kind]
                  : ''}
              </span>
            </p>
          )}

          <div className="space-y-3">
            <Button type="submit" className="h-12 w-full rounded-xl" disabled={!canStart}>
              {buttonLabel}
            </Button>
            <p className="text-sm text-muted-foreground">
              Vous allez être redirigé(e) vers la page de paiement
              {selectedLabel ? ` de ${selectedLabel}` : ''}. Votre banque peut vous demander de
              confirmer l&apos;opération. Aucun numéro de carte n&apos;est saisi ni conservé sur
              cette page.
            </p>
          </div>
        </form>
      )}

      <p className="mt-8 text-sm">
        <Link
          href={manageHref}
          className="font-semibold text-foreground underline underline-offset-4"
        >
          {forTickets ? 'Voir mes places' : 'Voir ma réservation'}
        </Link>
        <span className="text-muted-foreground">
          {' '}
          — vous pouvez aussi y annuler {forTickets ? 'ces places' : 'cette demande'}.
        </span>
      </p>
    </Shell>
  )
}

/** What the guest is told they paid or secured, from what the server holds. */
function settledLine(
  payment: NonNullable<PaymentPage['payment']>,
  money: (cents: number) => string,
  purpose: PaymentPurpose,
): string {
  switch (payment.state) {
    case 'paid':
      return purpose === 'experience'
        ? `Vos places sont payées : ${money(payment.heldCents)}.`
        : `Votre acompte de ${money(payment.heldCents)} est payé.`
    case 'secured':
      return `Votre carte est enregistrée : aucun débit pour l'instant, et des frais d'absence de ${money(payment.noShowFeeCents)} au plus peuvent être débités en cas d'absence.`
    case 'refunded':
    case 'partially_refunded':
      return `${money(payment.refundedCents)} vous ont été remboursés.`
    case 'released':
      return 'La garantie par carte est libérée : votre carte ne sera pas débitée.'
    case 'fee_charged':
    case 'fee_pending':
    case 'fee_failed':
      return paymentStateLabel(payment.state as PaymentState, purpose)
    default:
      // Confirmed by the team without waiting for the money: nothing more is expected.
      return "L'établissement a pris votre réservation : aucun paiement n'est plus attendu."
  }
}

/**
 * The hold, as a clock and as a sentence.
 *
 * The clock is a `timer` with no live region, so nothing reads it out every second; the
 * sentence beside it is the only live part and changes in five coarse steps. The seconds
 * are information, not animation: nothing here moves, so there is nothing for
 * `prefers-reduced-motion` to switch off.
 */
function HoldClock({
  expiresAt,
  now,
  words,
}: {
  expiresAt: number | null
  now: number
  /** « La table vous est gardée encore » — or the seats' version of it. */
  words: string
}) {
  if (expiresAt === null) return null
  const left = Math.max(0, expiresAt - now)
  return (
    <div>
      <p role="timer" aria-live="off" className="text-sm font-medium text-foreground">
        {words}{' '}
        <span className="font-mono text-lg font-bold tabular-nums">{formatCountdown(left)}</span>
      </p>
      <p role="status" className="sr-only">
        {holdAnnouncement(left)}
      </p>
    </div>
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
