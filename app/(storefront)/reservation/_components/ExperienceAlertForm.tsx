'use client'

/**
 * « Me prévenir » on a sold-out event.
 *
 * Not a booking, and the page says so in as many words, before and after: nothing is held for
 * the guest. If seats come back, ONE e-mail is sent; the seats go to whoever buys first. The
 * consent box is the server's own notice (`reservationExperienceAlertNotice`), recorded with
 * its version.
 */

import { useState } from 'react'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { BellRing, CheckCircle2 } from 'lucide-react'
import {
  reservationExperienceAlertNotice,
  RESERVATION_EXPERIENCE_ALERT_NOTICE_VERSION,
} from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { convexErrorPayload } from '@/lib/convex-error'
import type { PublicExperience } from './ExperienceCard'
import { ALERT_PARTY_CEILING, placesWord } from './reservation-experiences'
import { refusalSentence } from './reservation-refusals'

type PublicConfig = NonNullable<FunctionReturnType<typeof api.reservations.getPublicConfig>>

/** The server's sentence for an `invalid_input` that names nothing in particular. */
const isStockInvalidInput = (message: string | undefined) =>
  !message || message.startsWith('Les informations de la réservation')

export function ExperienceAlertForm({
  card,
  config,
  onClose,
}: {
  card: PublicExperience
  config: PublicConfig
  onClose: () => void
}) {
  const joinAlert = useMutation(api.reservationExperiences.joinAlert)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [partySize, setPartySize] = useState(1)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)

  const notice = reservationExperienceAlertNotice({
    storeName: config.storeName,
    keptDays: config.privacy?.waitlistKeptDays ?? 7,
  })
  // The choice runs to what one booking may take at this establishment; a card from an older
  // server does not say, so it runs to the event's size (and a sane ceiling) and the server
  // refuses what the event does not allow.
  const choices = Array.from(
    {
      length: Math.max(
        1,
        card.maxSeatsPerBookingLimit ?? Math.min(card.seats, ALERT_PARTY_CEILING),
      ),
    },
    (_, i) => i + 1,
  )
  const ready =
    name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && consent && !busy

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await joinAlert({
        experienceId: card.id as Id<'reservationExperiences'>,
        guest: { name: name.trim(), email: email.trim() },
        partySize,
        noticeVersion: RESERVATION_EXPERIENCE_ALERT_NOTICE_VERSION,
      })
      setJoined(true)
    } catch (failure) {
      const payload = convexErrorPayload(failure)
      // `invalid_input` carries a stock sentence when nothing more precise is known; here the
      // likely cause is a party larger than one purchase may hold, which the card cannot say.
      const stock = payload?.code === 'invalid_input' && isStockInvalidInput(payload.message)
      setError(
        stock
          ? "Vérifiez votre nom, votre e-mail et le nombre de places : il dépasse peut-être ce qu'une réservation peut contenir pour cet événement."
          : refusalSentence(
              payload,
              "Votre demande n'a pas pu être enregistrée. Veuillez réessayer.",
            ),
      )
    } finally {
      setBusy(false)
    }
  }

  const fid = (suffix: string) => `alert-${card.id}-${suffix}`

  if (joined) {
    return (
      <div role="status" className="mt-2 space-y-3 border-t border-border pt-5">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          C&apos;est noté, vous serez prévenu(e)
        </p>
        <p className="text-sm text-muted-foreground">
          Aucune place n&apos;est gardée pour vous. Si des places se libèrent, vous recevrez un seul
          e-mail : elles sont vendues à qui réserve en premier, et rien ne garantit qu&apos;il y en
          aura.
        </p>
        <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={onClose}>
          Fermer
        </Button>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Me prévenir : ${card.title}`}
      className="mt-2 space-y-4 border-t border-border pt-5"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <BellRing className="h-4 w-4" aria-hidden="true" />
        Ce n&apos;est pas une réservation : aucune place n&apos;est gardée.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
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
          <Label htmlFor={fid('party')}>Nombre de places souhaité</Label>
          <select
            id={fid('party')}
            value={partySize}
            onChange={(e) => setPartySize(Number(e.target.value))}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground"
          >
            {choices.map((n) => (
              <option key={n} value={n}>
                {placesWord(n)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-2 text-sm text-muted-foreground">
        {notice.detail.map((paragraph) => (
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
          {notice.label}
        </Label>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!ready} className="h-12 flex-1 rounded-xl">
          {busy ? 'Envoi…' : 'Me prévenir'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-12 rounded-xl"
          disabled={busy}
          onClick={onClose}
        >
          Fermer
        </Button>
      </div>
    </form>
  )
}
