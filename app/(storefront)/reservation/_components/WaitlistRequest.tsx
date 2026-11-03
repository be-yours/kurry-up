'use client'

/**
 * « Me prévenir si une table se libère » — what a guest is offered when the day
 * they asked for is full.
 *
 * It is not a booking and says so: nothing is held, and the establishment writes
 * ONE e-mail if a table that suits comes free. It sits beside the booking form,
 * not inside it (a form cannot hold a form), and only appears when the owner
 * turned the waitlist on and the day really is full — the server refuses a request
 * a free table could answer.
 */

import { useState } from 'react'
import { useMutation } from 'convex/react'
import { BellRing, CheckCircle2 } from 'lucide-react'
import { reservationWaitlistNotice } from '@be-yours/convex-schema'
import { Button, Checkbox, Input, Label } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { convexErrorPayload } from '@/lib/convex-error'

export interface WaitlistRequestProps {
  storeId: string
  storeName?: string
  date: string
  partySize: number
  roomPreference: string | null
  /** The times of the day's slots, to offer as the window the guest could make. */
  times: string[]
  /** Days an entry is kept after the date asked for, quoted in the notice. */
  keptDays: number
}

export function WaitlistRequest({
  storeId,
  storeName,
  date,
  partySize,
  roomPreference,
  times,
  keptDays,
}: WaitlistRequestProps) {
  const join = useMutation(api.reservationWaitlist.join)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const notice = reservationWaitlistNotice({ storeName, keptDays })
  const sorted = [...new Set(times)].sort()
  // A window needs both ends, in order; one end alone means the other end of the day.
  const earliest = from || (to ? (sorted[0] ?? '') : '')
  const latest = to || (from ? (sorted[sorted.length - 1] ?? '') : '')
  const windowOk = !earliest || !latest || earliest <= latest
  const ready =
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (phone.trim() === '' || phone.trim().length >= 3) &&
    windowOk &&
    consent &&
    !busy

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await join({
        storeId: storeId as Id<'stores'>,
        guest: {
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        },
        partySize,
        date,
        ...(earliest && latest ? { earliest, latest } : {}),
        ...(roomPreference ? { roomPreference: roomPreference as Id<'reservationRooms'> } : {}),
        privacyNoticeVersion: notice.version,
      })
      setDone(true)
    } catch (failure) {
      setError(
        convexErrorPayload(failure)?.message ??
          "Votre demande n'a pas pu être enregistrée. Veuillez réessayer.",
      )
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section
        aria-labelledby="waitlist-done"
        role="status"
        className="mt-8 rounded-2xl bg-card p-6 text-foreground"
      >
        <h2 id="waitlist-done" className="mb-2 flex items-center gap-2 text-lg font-semibold">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          Vous êtes sur la liste d&apos;attente
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Aucune table n&apos;est réservée pour le moment. Si une table qui vous convient se libère,
          vous recevrez un e-mail avec un lien pour la réserver.
        </p>
        <p className="text-sm text-muted-foreground">
          Le lien pour suivre ou retirer votre demande est envoyé à l&apos;adresse indiquée : pensez
          à regarder vos courriers indésirables.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="waitlist-title" className="mt-8 rounded-2xl bg-card p-6">
      <h2
        id="waitlist-title"
        className="mb-1 flex items-center gap-2 text-lg font-semibold text-foreground"
      >
        <BellRing className="h-5 w-5" aria-hidden="true" />
        Me prévenir si une table se libère
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Ce n&apos;est pas une réservation : aucune table n&apos;est gardée tant qu&apos;aucune ne se
        libère.
      </p>

      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-xl"
          onClick={() => setOpen(true)}
        >
          Demander à être prévenu
        </Button>
      ) : (
        <div className="space-y-4" role="group" aria-labelledby="waitlist-title">
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 p-3 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="wl-name">Nom</Label>
            <Input
              id="wl-name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="wl-email">E-mail</Label>
              <Input
                id="wl-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wl-phone">Téléphone (facultatif)</Label>
              <Input
                id="wl-phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          {sorted.length > 1 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">
                Horaires qui vous conviennent
              </legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="wl-from">À partir de</Label>
                  <select
                    id="wl-from"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground"
                  >
                    <option value="">Peu importe</option>
                    {sorted.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-to">Jusqu&apos;à</Label>
                  <select
                    id="wl-to"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground"
                  >
                    <option value="">Peu importe</option>
                    {sorted.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {!windowOk && (
                <p role="alert" className="text-sm text-destructive">
                  L&apos;heure de fin doit être après l&apos;heure de début.
                </p>
              )}
            </fieldset>
          )}

          <div className="space-y-2 text-sm text-muted-foreground">
            {notice.detail.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="wl-consent"
              checked={consent}
              onCheckedChange={(value) => setConsent(value === true)}
            />
            <Label htmlFor="wl-consent" className="text-sm leading-snug">
              {notice.label}
            </Label>
          </div>
          <Button
            type="button"
            className="h-12 w-full rounded-xl"
            disabled={!ready}
            onClick={submit}
          >
            {busy ? 'Envoi…' : 'Me prévenir'}
          </Button>
        </div>
      )}
    </section>
  )
}
