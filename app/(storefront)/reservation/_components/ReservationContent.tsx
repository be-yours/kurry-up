'use client'

/**
 * The booking form.
 *
 * Four steps on one page — party size and date, a time, who is coming, then
 * the agreement — because a diner booking from a phone should never lose what
 * they typed to a page change. The slots come from the server's own
 * `computeSlots`, so what is offered here is what `create` will accept; `create`
 * still recomputes, and a slot taken in the meantime comes back as
 * `slot_unavailable`, which this page answers by re-reading the day.
 *
 * When the establishment has more than one room that can seat an online booking,
 * a fifth, optional choice appears: which area the diner would like. It never
 * narrows what is offered. A full area is not a refusal — its slots are shown with
 * the other area named, and picking one says so in the recap before the diner
 * agrees to it.
 *
 * The party size decides which form a guest meets (`routeFor`, the server's own `routeParty`
 * read from `getPublicConfig`): up to `directMax` the ordinary booking below; from the group
 * band a REQUEST the host must accept (`GroupRequestPanel`), said plainly to be unconfirmed;
 * above it a « contactez-nous » card. The selector ends on « plus de N personnes », so a
 * guest with a larger party reaches the card instead of a list that stops short.
 *
 * When the establishment asks for a deposit or a card guarantee for the chosen slot, the
 * server's quote is drawn BEFORE the guest submits: the amount, the terms in words, how
 * long the table is held and a required box that records the agreement. Submitting then
 * creates the booking awaiting its payment and sends the guest to the payment page, where
 * they choose how to pay — the form never touches a provider.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { CheckCircle2, Clock, MapPin, Users } from 'lucide-react'
import { reservationMarketingNotice, reservationPrivacyNotice } from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label, Skeleton, Textarea } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { useStoreId } from '@/lib/hooks/use-store-id'
import { convexErrorPayload } from '@/lib/convex-error'
import { ContactCard } from './ContactCard'
import { GroupRequestPanel, type SentGroupRequest } from './GroupRequestPanel'
import { GroupRequestSentScreen } from './GroupRequestSent'
import { PaymentQuoteBox } from './PaymentQuoteBox'
import {
  formatReservationInstant,
  isoDateInZone,
  listInFrench,
  missingForBooking,
  STATUS_COPY,
} from './reservation-format'
import { partyOptions, peopleWord, routeFor } from './reservation-groups'
import { WaitlistRequest } from './WaitlistRequest'

/**
 * One key per form: a double tap or a retried request is the same booking.
 *
 * `crypto.randomUUID` exists only in a secure context, so on a plain-HTTP
 * preview it is `undefined` while `crypto` itself is not — the guard has to ask
 * for the function.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const slotKeyOf = (slot: { serviceId: string; startsAt: number }) =>
  `${slot.serviceId}:${slot.startsAt}`

interface Confirmation {
  reference: string
  manageToken: string
  status: keyof typeof STATUS_COPY
  /** The guest ticked the marketing box: an e-mail asks them to confirm. */
  marketingAsked: boolean
}

/** What the page quotes in its notices when the server sent no figures (an older deployment). */
const DEFAULT_PRIVACY = { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 }

export default function ReservationContent({
  afterForm,
}: {
  /** Rendered under the form, inside the page: the events section, which a server page passes in. */
  afterForm?: React.ReactNode
}) {
  const { storeId, isLoading: storeLoading } = useStoreId()
  const config = useQuery(
    api.reservations.getPublicConfig,
    storeId ? { storeId: storeId as Id<'stores'> } : 'skip',
  )
  const create = useMutation(api.reservations.create)
  const router = useRouter()

  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState('')
  // The area the diner would like. `null`: no preference, which is the default.
  const [roomPreference, setRoomPreference] = useState<string | null>(null)
  // A slot is a service AND a start: two services may open at the same minute.
  const [slotKey, setSlotKey] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [consent, setConsent] = useState(false)
  // Unchecked, and never ticked for the guest: booking subscribes nobody.
  const [marketing, setMarketing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Confirmation | null>(null)
  // A group request that was sent: a different screen, because nothing is confirmed.
  const [requested, setRequested] = useState<SentGroupRequest | null>(null)
  // The wording of the payment terms the guest ticked. A different slot or party has
  // different terms and a different sentence, so the tick never carries over to them.
  const [acceptedPaymentLabel, setAcceptedPaymentLabel] = useState<string | null>(null)
  // The booking is made and the guest is on their way to the payment page.
  const [redirecting, setRedirecting] = useState(false)
  // One key per form: a double tap or a retried request is the same booking.
  const idempotencyKey = useRef<string>('')
  if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey()
  // A request is a different booking from an ordinary one: it gets its own key.
  const groupKey = useRef<string>('')
  if (!groupKey.current) groupKey.current = newIdempotencyKey()

  // Where this party goes: the ordinary form, a request, or the contact card.
  const route = config ? routeFor(partySize, config) : 'direct'

  const slots = useQuery(
    api.reservations.getAvailability,
    // A party above every band has no slot to look for: it is sent to the contact card.
    storeId && config && date && route !== 'contact'
      ? {
          storeId: storeId as Id<'stores'>,
          date,
          partySize,
          // The area is a wish of the ordinary form; a request is seated by the host.
          ...(roomPreference && route === 'direct'
            ? { roomPreference: roomPreference as Id<'reservationRooms'> }
            : {}),
        }
      : 'skip',
  )

  const openSlots = (slots ?? []).filter((slot) => slot.available)
  const chosen = openSlots.find((slot) => slotKeyOf(slot) === slotKey) ?? null

  // What the chosen slot would owe: nothing, a deposit or a card guarantee.
  const quote = useQuery(
    api.reservationPayments.getPaymentQuote,
    // A request carries no payment until the host attaches one when answering.
    storeId && chosen && route === 'direct'
      ? {
          storeId: storeId as Id<'stores'>,
          serviceId: chosen.serviceId as Id<'reservationServices'>,
          partySize,
          startsAt: chosen.startsAt,
        }
      : 'skip',
  )

  const today = useMemo(() => (config ? isoDateInZone(Date.now(), config.timezone) : ''), [config])
  const lastDay = useMemo(
    () =>
      config
        ? isoDateInZone(Date.now() + config.maxHorizonDays * 24 * 60 * 60_000, config.timezone)
        : '',
    [config],
  )

  if (storeLoading || config === undefined) {
    return (
      <Shell>
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </Shell>
    )
  }

  if (config === null) {
    return (
      <Shell>
        <h1 className="mb-3 text-3xl font-bold text-foreground">Réservation indisponible</h1>
        <p className="text-muted-foreground">
          Les réservations en ligne ne sont pas ouvertes pour le moment.
        </p>
      </Shell>
    )
  }

  if (requested) {
    return (
      <Shell>
        <GroupRequestSentScreen
          sent={requested}
          storeName={config.storeName}
          timezone={config.timezone}
        />
      </Shell>
    )
  }

  if (done) {
    return (
      <Shell>
        <div role="status" className="rounded-2xl bg-card p-8 text-center">
          <CheckCircle2 className="mx-auto mb-4 h-10 w-10 text-foreground" aria-hidden="true" />
          <h1 className="mb-2 text-3xl font-bold text-foreground">
            {done.status === 'confirmed' ? 'Réservation confirmée' : 'Demande envoyée'}
          </h1>
          <p className="mb-6 text-muted-foreground">{STATUS_COPY[done.status]}</p>
          <p className="mb-1 text-sm text-muted-foreground">Numéro de réservation</p>
          <p className="mb-6 font-mono text-xl font-bold text-foreground">{done.reference}</p>
          {done.marketingAsked && (
            <p className="mb-6 text-sm text-muted-foreground">
              Vous avez demandé à recevoir nos nouvelles : un e-mail vous demande de confirmer votre
              inscription. Sans confirmation, rien ne vous sera envoyé.
            </p>
          )}
          <Link
            href={`/reservation/manage/${done.manageToken}`}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            Voir ou annuler ma réservation
          </Link>
        </div>
      </Shell>
    )
  }

  const rooms = config.rooms ?? []
  const party = partyOptions(config)
  const privacy = config.privacy ?? DEFAULT_PRIVACY
  const privacyNotice = reservationPrivacyNotice({
    storeName: config.storeName,
    retentionDays: privacy.retentionDays,
    noteDays: privacy.noteDays,
  })
  const marketingNotice = reservationMarketingNotice({ storeName: config.storeName })
  const preferredName = rooms.find((room) => room.id === roomPreference)?.name ?? null
  // Slots that would seat the party in the other area, named so it is never a surprise.
  const elsewhere = openSlots.filter((slot) => slot.preference === 'other')
  // A full day with services on it: the one case where « Me prévenir » can help.
  const dayIsFull = date !== '' && slots !== undefined && slots.length > 0 && openSlots.length === 0
  const showWaitlist =
    route === 'direct' && dayIsFull && config.waitlistEnabled === true && storeId !== null
  const everythingElsewhere = openSlots.length > 0 && elsewhere.length === openSlots.length
  const owes = quote?.required === true ? quote : null
  const paymentConsent = owes !== null && acceptedPaymentLabel === owes.consentLabel
  // Until the quote has arrived the form cannot know what it is agreeing to; once it
  // has, something owed needs a payable provider AND the guest's tick.
  const paymentOk = quote !== undefined && (owes === null || (owes.payable && paymentConsent))
  const ready =
    route === 'direct' &&
    chosen !== null &&
    paymentOk &&
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    phone.trim().length >= 3 &&
    consent &&
    !busy &&
    !redirecting

  const missing = missingForBooking({
    name,
    email,
    phone,
    consent,
    owes: owes !== null,
    paymentConsent,
    unpayable: owes !== null && !owes.payable,
    checking: quote === undefined,
  })
  // Said only while the form is idle: during a send the button is off for another reason.
  const hint =
    route === 'direct' && chosen !== null && !busy && !redirecting && missing.length > 0
      ? `Pour continuer, il manque : ${listInFrench(missing)}.`
      : null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || !chosen || !storeId) return
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        storeId: storeId as Id<'stores'>,
        date,
        serviceId: chosen.serviceId as Id<'reservationServices'>,
        startsAt: chosen.startsAt,
        partySize,
        guest: { name: name.trim(), email: email.trim(), phone: phone.trim() },
        note: note.trim() || undefined,
        consentNoticeVersion: config?.noticeVersion,
        // The wording on screen, recorded with the booking: what they agreed to is
        // what they read, whatever the server's current text says later.
        privacyNoticeVersion: privacyNotice.version,
        ...(marketing ? { marketingOptInVersion: marketingNotice.version } : {}),
        idempotencyKey: idempotencyKey.current || undefined,
        ...(roomPreference ? { roomPreference: roomPreference as Id<'reservationRooms'> } : {}),
        // Picking a slot that is in the other area IS agreeing to it: the recap said so.
        ...(chosen.preference === 'other' ? { acceptOtherRoom: true } : {}),
        ...(owes ? { paymentConsent: true } : {}),
      })
      if (result.status === 'pending_payment') {
        // The table is held, not yet booked: the guest pays on the next page. Stay
        // disabled until it opens, so a second tap cannot make a second booking.
        setRedirecting(true)
        router.push(`/reservation/payment/${result.manageToken}`)
        return
      }
      setDone({ ...result, marketingAsked: marketing })
    } catch (failure) {
      const payload = convexErrorPayload(failure)
      setError(
        payload?.message ?? "La réservation n'a pas pu être enregistrée. Veuillez réessayer.",
      )
      // The slot may have just been taken: the day is re-read live, so the
      // picker already shows what is left. Drop the choice that no longer holds.
      if (payload?.code === 'slot_unavailable' || payload?.code === 'area_unavailable') {
        setSlotKey(null)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <h1 className="mb-2 text-3xl font-bold text-foreground">Réserver une table</h1>
      {config.introText && <p className="mb-8 text-muted-foreground">{config.introText}</p>}

      {error && (
        <p
          role="alert"
          className="mb-6 rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <form onSubmit={submit} className="space-y-8" noValidate>
        <fieldset className="space-y-4">
          <legend className="mb-2 flex items-center gap-2 text-lg font-semibold text-foreground">
            <Users className="h-5 w-5" aria-hidden="true" /> Convives et date
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="party">Nombre de convives</Label>
              <select
                id="party"
                value={partySize}
                onChange={(e) => {
                  setPartySize(Number(e.target.value))
                  setSlotKey(null)
                }}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground"
              >
                {party.sizes.map((n) => (
                  <option key={n} value={n}>
                    {peopleWord(n)}
                  </option>
                ))}
                {/* « Plus de N » leads to the contact card: a larger party is never refused
                    by a list that simply stops. */}
                <option value={party.overflow}>Plus de {party.overflow - 1} personnes</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input
                className="h-11"
                id="date"
                type="date"
                min={today}
                max={lastDay}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value)
                  setSlotKey(null)
                }}
              />
            </div>
          </div>
        </fieldset>

        {route === 'contact' && (
          <ContactCard
            storeName={config.storeName}
            phone={config.contact?.phone ?? null}
            email={config.contact?.email ?? null}
            lead={
              partySize > party.overflow - 1
                ? `Pour un groupe de plus de ${party.overflow - 1} personnes, la réservation se fait directement avec l'établissement.`
                : `Pour ${peopleWord(partySize)}, la réservation se fait directement avec l'établissement.`
            }
            subject={`Réservation pour ${peopleWord(partySize)}`}
          />
        )}

        {route === 'group' && (
          <p role="status" className="rounded-xl bg-card p-4 text-sm text-foreground">
            Pour {peopleWord(partySize)}, c&apos;est une demande : le restaurant doit
            l&apos;accepter avant qu&apos;elle soit confirmée. Rien n&apos;est confirmé ni payé à
            l&apos;envoi.
          </p>
        )}

        {route === 'direct' && rooms.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="mb-2 flex items-center gap-2 text-lg font-semibold text-foreground">
              <MapPin className="h-5 w-5" aria-hidden="true" /> Zone souhaitée
            </legend>
            <div className="flex flex-wrap gap-2">
              {[{ id: null, name: 'Peu importe' }, ...rooms].map((room) => (
                <label
                  key={room.id ?? 'any'}
                  htmlFor={`room-preference-${room.id ?? 'any'}`}
                  className="cursor-pointer"
                >
                  <input
                    id={`room-preference-${room.id ?? 'any'}`}
                    type="radio"
                    name="room-preference"
                    className="peer sr-only"
                    checked={roomPreference === room.id}
                    onChange={() => {
                      setRoomPreference(room.id)
                      setSlotKey(null)
                    }}
                  />
                  <span className="flex min-h-11 min-w-20 items-center justify-center rounded-xl border border-input bg-background px-4 font-semibold text-foreground transition-colors hover:bg-accent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                    {room.name}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              C&apos;est un souhait : si la zone est complète à l&apos;heure choisie, nous vous
              proposons l&apos;autre zone et vous décidez.
            </p>
          </fieldset>
        )}

        {date && route !== 'contact' && (
          <fieldset className="space-y-3">
            <legend className="mb-2 flex items-center gap-2 text-lg font-semibold text-foreground">
              <Clock className="h-5 w-5" aria-hidden="true" /> Horaire
            </legend>
            {slots === undefined ? (
              <Skeleton className="h-12 w-full rounded-xl" />
            ) : slots.length === 0 ? (
              <p className="text-muted-foreground">
                Aucun service n&apos;est proposé ce jour-là. Essayez une autre date.
              </p>
            ) : openSlots.length === 0 ? (
              <p className="text-muted-foreground">
                {route === 'group'
                  ? `Aucun horaire n'est ouvert aux demandes pour ${peopleWord(partySize)} ce jour-là. Essayez une autre date, ou contactez directement l'établissement.`
                  : `Ce jour est complet pour ${peopleWord(partySize)}. Essayez une autre date.`}
              </p>
            ) : (
              <>
                {preferredName && elsewhere.length > 0 && (
                  <p role="status" className="rounded-xl bg-card p-3 text-sm text-foreground">
                    {everythingElsewhere
                      ? `La zone « ${preferredName} » est complète à ces horaires. Les tables libres sont dans l'autre zone, indiquée sur chaque horaire.`
                      : `La zone « ${preferredName} » est complète à certains horaires : ils sont proposés dans l'autre zone, indiquée sous l'heure.`}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {openSlots.map((slot) => (
                    <button
                      key={slotKeyOf(slot)}
                      type="button"
                      aria-pressed={slotKeyOf(slot) === slotKey}
                      onClick={() => {
                        setError(null)
                        setSlotKey(slotKeyOf(slot))
                      }}
                      className={`min-h-11 min-w-20 rounded-xl border px-4 font-semibold transition-colors ${
                        slotKeyOf(slot) === slotKey
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background text-foreground hover:bg-accent'
                      }`}
                    >
                      {slot.time}
                      {slot.preference === 'other' && slot.roomName && (
                        <span className="block text-xs font-normal">zone « {slot.roomName} »</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </fieldset>
        )}

        {chosen && route === 'direct' && (
          <>
            <fieldset className="space-y-4">
              <legend className="mb-2 text-lg font-semibold text-foreground">
                Vos coordonnées
              </legend>
              <div className="space-y-2">
                <Label htmlFor="name">Nom</Label>
                <Input
                  className="h-11"
                  id="name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="email">E-mail</Label>
                  <Input
                    className="h-11"
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Téléphone</Label>
                  <Input
                    className="h-11"
                    id="phone"
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="note">Une demande particulière ? (facultatif)</Label>
                <Textarea
                  id="note"
                  maxLength={500}
                  placeholder="Allergie, chaise haute, anniversaire…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </fieldset>

            <section className="space-y-4 rounded-2xl bg-card p-5" aria-labelledby="recap">
              <h2 id="recap" className="text-lg font-semibold text-foreground">
                Récapitulatif
              </h2>
              <p className="text-foreground">
                {partySize} {partySize === 1 ? 'personne' : 'personnes'} ·{' '}
                {formatReservationInstant(chosen.startsAt, config.timezone)}
              </p>
              {chosen.preference === 'met' && chosen.roomName && (
                <p className="text-foreground">Zone : « {chosen.roomName} »</p>
              )}
              {chosen.preference === 'other' && chosen.roomName && (
                <p role="status" className="font-medium text-foreground">
                  La zone « {preferredName} » est complète à cette heure : votre table est dans la
                  zone « {chosen.roomName} ».
                </p>
              )}
              {config.policyText && (
                <p className="whitespace-pre-line text-sm text-muted-foreground">
                  {config.policyText}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {owes
                  ? config.autoConfirm
                    ? 'Votre réservation est confirmée dès que votre paiement est reçu.'
                    : "Une fois votre paiement reçu, le restaurant doit valider votre demande avant qu'elle soit confirmée."
                  : config.autoConfirm
                    ? 'Votre réservation est confirmée immédiatement.'
                    : "Le restaurant doit valider votre demande avant qu'elle soit confirmée."}
                {/* A booking that carries a payment follows ITS cancellation terms, written
                    in the payment box below: the generic delay would contradict them. */}
                {!owes &&
                  ` Annulation en ligne possible jusqu'à ${config.cancellationDeadlineHours} h avant.`}
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

            {quote === undefined && (
              <div role="status" aria-busy="true">
                <span className="sr-only">Vérification des conditions de paiement…</span>
                <Skeleton className="h-24 w-full rounded-2xl" />
              </div>
            )}
            {owes && (
              <PaymentQuoteBox
                quote={owes}
                consent={paymentConsent}
                onConsentChange={(value) =>
                  setAcceptedPaymentLabel(value ? owes.consentLabel : null)
                }
              />
            )}

            {/* On a phone the primary action stays in reach while the long recap scrolls. */}
            <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
              {hint && (
                <p
                  id="booking-submit-hint"
                  data-testid="booking-submit-hint"
                  className="mb-2 text-sm text-muted-foreground"
                >
                  {hint}
                </p>
              )}
              <Button
                type="submit"
                disabled={!ready}
                aria-describedby={hint ? 'booking-submit-hint' : undefined}
                className="h-12 w-full rounded-xl"
              >
                {busy || redirecting
                  ? owes
                    ? 'Redirection…'
                    : 'Envoi…'
                  : owes
                    ? 'Continuer vers le paiement'
                    : config.autoConfirm
                      ? 'Confirmer la réservation'
                      : 'Envoyer la demande'}
              </Button>
            </div>
          </>
        )}
      </form>

      {route === 'group' && chosen && storeId && (
        <GroupRequestPanel
          storeId={storeId}
          config={config}
          date={date}
          partySize={partySize}
          slot={chosen}
          idempotencyKey={groupKey.current}
          onSent={setRequested}
          onSlotLost={(reason) => {
            setError(reason)
            setSlotKey(null)
          }}
        />
      )}

      {route === 'group' && date && slots !== undefined && openSlots.length === 0 && (
        <div className="mt-8">
          <ContactCard
            id="group-contact"
            storeName={config.storeName}
            phone={config.contact?.phone ?? null}
            email={config.contact?.email ?? null}
            lead="Aucun horaire n'est ouvert aux demandes ce jour-là : le restaurant peut parfois s'arranger directement."
            subject={`Demande pour ${peopleWord(partySize)}`}
          />
        </div>
      )}

      {showWaitlist && storeId && (
        <WaitlistRequest
          // A new day or a new party is a new request: the form starts again.
          key={`${date}:${partySize}:${roomPreference ?? ''}`}
          storeId={storeId}
          storeName={config.storeName}
          date={date}
          partySize={partySize}
          roomPreference={roomPreference}
          times={(slots ?? []).map((slot) => slot.time)}
          keptDays={privacy.waitlistKeptDays}
        />
      )}

      {afterForm}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-2xl px-4 pb-12 pt-32 sm:pb-16">{children}</div>
}
