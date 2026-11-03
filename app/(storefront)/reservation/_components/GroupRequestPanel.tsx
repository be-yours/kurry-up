'use client'

/**
 * « Demande de groupe » — what a guest fills in when their party is large enough that the
 * host has to say yes.
 *
 * It sits BESIDE the booking form, not inside it (a form cannot hold a form), and appears once
 * a time is chosen. It says, before and after it is sent, what a request is NOT: confirmed,
 * or paid. The room is held while the host reads it, for the window the owner set, and a
 * request nobody answers expires and lets the room go.
 *
 * It asks the same things as the booking form — the same versioned privacy notice, the same
 * optional marketing box, an idempotency key so a double tap is one request — plus the three
 * things a large table needs the host to know: the occasion, what the group would like to eat
 * or spend, and a free message. No payment step: the host may attach one when answering, and
 * the guest agrees to it then, on the payment page.
 */

import { useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { Users } from 'lucide-react'
import { reservationMarketingNotice, reservationPrivacyNotice } from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label, Textarea } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { convexErrorPayload } from '@/lib/convex-error'
import { formatReservationInstant } from './reservation-format'
import { peopleWord, requestIntro } from './reservation-groups'
import { refusalSentence } from './reservation-refusals'

type PublicConfig = NonNullable<FunctionReturnType<typeof api.reservations.getPublicConfig>>

/** What the confirmation screen needs once the request is in. */
export interface SentGroupRequest {
  reference: string
  manageToken: string
  reviewExpiresAt: number | null
  partySize: number
  startsAt: number
  /** The guest ticked the marketing box: an e-mail asks them to confirm. */
  marketingAsked: boolean
}

export interface GroupRequestPanelProps {
  storeId: string
  config: PublicConfig
  date: string
  partySize: number
  slot: { serviceId: string; startsAt: number; time: string }
  idempotencyKey: string
  onSent: (sent: SentGroupRequest) => void
  /** The slot was taken in the meantime: the page drops its choice and keeps the reason. */
  onSlotLost: (reason: string) => void
}

/** What the server will not take longer than (`GROUP_LIMITS`), repeated here for `maxLength`. */
const LIMITS = { occasion: 120, budget: 300, message: 1000, note: 500 } as const

const DEFAULT_PRIVACY = { retentionDays: 1095, noteDays: 3, waitlistKeptDays: 7 }

export function GroupRequestPanel({
  storeId,
  config,
  date,
  partySize,
  slot,
  idempotencyKey,
  onSent,
  onSlotLost,
}: GroupRequestPanelProps) {
  const requestGroup = useMutation(api.reservationGroups.requestGroup)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [occasion, setOccasion] = useState('')
  const [note, setNote] = useState('')
  const [budget, setBudget] = useState('')
  const [message, setMessage] = useState('')
  const [consent, setConsent] = useState(false)
  // Unchecked, and never ticked for the guest: asking subscribes nobody.
  const [marketing, setMarketing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A double tap on « Envoyer » must not send two requests; the server is idempotent too.
  const sending = useRef(false)

  const privacy = config.privacy ?? DEFAULT_PRIVACY
  const privacyNotice = reservationPrivacyNotice({
    storeName: config.storeName,
    retentionDays: privacy.retentionDays,
    noteDays: privacy.noteDays,
  })
  const marketingNotice = reservationMarketingNotice({ storeName: config.storeName })
  const reviewHours = config.groups?.reviewHours ?? 48

  const ready =
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    phone.trim().length >= 3 &&
    consent &&
    !busy

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await requestGroup({
        storeId: storeId as Id<'stores'>,
        date,
        serviceId: slot.serviceId as Id<'reservationServices'>,
        startsAt: slot.startsAt,
        partySize,
        guest: { name: name.trim(), email: email.trim(), phone: phone.trim() },
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(occasion.trim() ? { occasion: occasion.trim() } : {}),
        ...(budget.trim() ? { budget: budget.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        consentNoticeVersion: config.noticeVersion,
        // The wording on screen, recorded with the request: what they agreed to is what they read.
        privacyNoticeVersion: privacyNotice.version,
        ...(marketing ? { marketingOptInVersion: marketingNotice.version } : {}),
        idempotencyKey,
      })
      onSent({
        reference: result.reference,
        manageToken: result.manageToken,
        reviewExpiresAt: result.reviewExpiresAt ?? null,
        partySize,
        startsAt: slot.startsAt,
        marketingAsked: marketing,
      })
    } catch (failure) {
      const payload = convexErrorPayload(failure)
      const reason = refusalSentence(
        payload,
        "Votre demande n'a pas pu être envoyée. Veuillez réessayer.",
      )
      setError(reason)
      // The panel goes with the choice it was made for: the page shows the reason instead.
      if (payload?.code === 'slot_unavailable') onSlotLost(reason)
      sending.current = false
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="group-request-title"
      className="mt-8 space-y-6"
    >
      <div className="space-y-3 rounded-2xl bg-card p-5">
        <h2
          id="group-request-title"
          className="flex items-center gap-2 text-lg font-semibold text-foreground"
        >
          <Users className="h-5 w-5" aria-hidden="true" />
          Demande de groupe
        </h2>
        <p className="text-foreground">
          {peopleWord(partySize)} · {formatReservationInstant(slot.startsAt, config.timezone)}
        </p>
        {requestIntro({ storeName: config.storeName, partySize, reviewHours }).map((paragraph) => (
          <p key={paragraph} className="text-sm text-muted-foreground">
            {paragraph}
          </p>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <fieldset className="space-y-4">
        <legend className="mb-2 text-lg font-semibold text-foreground">Vos coordonnées</legend>
        <div className="space-y-2">
          <Label htmlFor="gr-name">Nom</Label>
          <Input
            id="gr-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="gr-email">E-mail</Label>
            <Input
              id="gr-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gr-phone">Téléphone</Label>
            <Input
              id="gr-phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-lg font-semibold text-foreground">Votre groupe</legend>
        <div className="space-y-2">
          <Label htmlFor="gr-occasion">Occasion (facultatif)</Label>
          <Input
            id="gr-occasion"
            maxLength={LIMITS.occasion}
            placeholder="Anniversaire, repas d'équipe, mariage…"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gr-note">Allergies et régimes alimentaires (facultatif)</Label>
          <Textarea
            id="gr-note"
            maxLength={LIMITS.note}
            placeholder="Sans gluten, végétarien, allergie aux arachides…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gr-budget">Menu ou budget souhaité (facultatif)</Label>
          <Textarea
            id="gr-budget"
            maxLength={LIMITS.budget}
            placeholder="Menu unique, formule, budget par personne…"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gr-message">Un message pour le restaurant (facultatif)</Label>
          <Textarea
            id="gr-message"
            maxLength={LIMITS.message}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
      </fieldset>

      <section className="space-y-4 rounded-2xl bg-card p-5" aria-labelledby="gr-agreement">
        <h2 id="gr-agreement" className="text-lg font-semibold text-foreground">
          Avant d&apos;envoyer
        </h2>
        <div className="space-y-2 text-sm text-muted-foreground">
          {privacyNotice.detail.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id="gr-consent"
            checked={consent}
            onCheckedChange={(value) => setConsent(value === true)}
          />
          <Label htmlFor="gr-consent" className="text-sm leading-snug">
            {privacyNotice.label}
          </Label>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id="gr-marketing"
            checked={marketing}
            onCheckedChange={(value) => setMarketing(value === true)}
          />
          <div className="space-y-1">
            <Label htmlFor="gr-marketing" className="text-sm leading-snug">
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

      <Button type="submit" disabled={!ready} className="h-12 w-full rounded-xl">
        {busy ? 'Envoi…' : 'Envoyer ma demande'}
      </Button>
      <p className="text-sm text-muted-foreground">
        Envoyer la demande ne confirme rien et ne débite rien.
      </p>
    </form>
  )
}
