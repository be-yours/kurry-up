'use client'

/**
 * The guest changing their own booking: date, time, party size, what they asked
 * for, and the area they would like.
 *
 * The slots are the ones the booking page offers, computed by the same engine with
 * the booking itself left out — so the table the guest holds now is offered back to
 * them, and moving from 19:30 to 20:00 is never refused because of themselves. The
 * server re-runs the engine when the form is sent; a slot taken in the meantime
 * comes back as `slot_unavailable` and this panel re-reads the day.
 *
 * What the change costs is said before it is sent: in a house that validates by
 * hand, a new date, time or party size sends a confirmed booking back to the team.
 * A reworded note does not, and the panel says nothing about it then.
 *
 * A booking that carries a deposit or a card guarantee cannot change its party size online:
 * the amount was worked out for that group, so the field is shown but read-only, with the
 * reason, and the server refuses it too (`payment_party_locked`). Date, time, note and area
 * stay editable.
 */

import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { Clock, MapPin, Users } from 'lucide-react'
import { Button, Input, Label, Skeleton, Textarea } from '@be-yours/ui'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { convexErrorPayload } from '@/lib/convex-error'
import { formatReservationInstant, isoDateInZone } from '../../../_components/reservation-format'

/** What this panel needs of the booking: the public view, nothing more. */
export interface ChangeableBooking {
  timezone: string
  serviceId: string
  startsAt: number
  partySize: number
  guestNote: string | null
  maxPartySize: number | null
  maxHorizonDays: number | null
  changeNeedsValidation: boolean
  rooms: Array<{ id: string; name: string }>
  roomPreference: string | null
  /** The booking's payment terms, when it carries any: the party size is then locked. */
  payment?: { kind: string } | null
}

const DAY_MS = 24 * 60 * 60_000

export function ChangeReservationPanel({
  token,
  booking,
  onDone,
  onCancel,
}: {
  token: string
  booking: ChangeableBooking
  onDone: (result: { status: string; changed: boolean }) => void
  onCancel: () => void
}) {
  const modify = useMutation(api.reservations.modifyByToken)
  const partyLocked = Boolean(booking.payment)
  const [date, setDate] = useState(() => isoDateInZone(booking.startsAt, booking.timezone))
  const [partySize, setPartySize] = useState(booking.partySize)
  // The slot is a start time; its service comes with the slot the server offers.
  const [startsAt, setStartsAt] = useState<number | null>(booking.startsAt)
  const [note, setNote] = useState(booking.guestNote ?? '')
  const [roomPreference, setRoomPreference] = useState<string | null>(booking.roomPreference)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const initialStart = useRef(booking.startsAt).current

  const today = useMemo(() => isoDateInZone(Date.now(), booking.timezone), [booking.timezone])
  const lastDay = useMemo(
    () => isoDateInZone(Date.now() + (booking.maxHorizonDays ?? 60) * DAY_MS, booking.timezone),
    [booking.maxHorizonDays, booking.timezone],
  )

  const slots = useQuery(api.reservations.getAvailabilityByToken, {
    token,
    date,
    partySize,
    roomPreference: roomPreference as Id<'reservationRooms'> | null,
  })
  const open = (slots ?? []).filter((slot) => slot.available)
  const chosen = open.find((slot) => slot.startsAt === startsAt) ?? null
  const preferredName = booking.rooms.find((room) => room.id === roomPreference)?.name ?? null
  const elsewhere = open.filter((slot) => slot.preference === 'other')

  const moved = startsAt !== initialStart || partySize !== booking.partySize
  const roomKept = roomPreference === booking.roomPreference
  const unchanged = !moved && note.trim() === (booking.guestNote ?? '') && roomKept
  // Rewording the note moves nothing, so it must not wait on a slot: the hour the
  // guest already holds may since have fallen inside the notice period, and it is
  // still theirs. Anything that moves the table needs the engine's yes.
  const target =
    chosen ??
    (!moved && roomKept
      ? {
          serviceId: booking.serviceId,
          startsAt: booking.startsAt,
          preference: null as 'met' | 'other' | null,
        }
      : null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await modify({
        token,
        date,
        serviceId: target.serviceId as Id<'reservationServices'>,
        startsAt: target.startsAt,
        partySize,
        note: note.trim(),
        roomPreference: roomPreference as Id<'reservationRooms'> | null,
        ...(target.preference === 'other' ? { acceptOtherRoom: true } : {}),
      })
      onDone(result)
    } catch (failure) {
      const payload = convexErrorPayload(failure)
      setError(
        payload?.message ?? "La modification n'a pas pu être enregistrée. Veuillez réessayer.",
      )
      // The slot may have just been taken: the day is read live, so the list already
      // shows what is left. Drop the choice that no longer holds.
      if (payload?.code === 'slot_unavailable' || payload?.code === 'area_unavailable') {
        setStartsAt(null)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="change-title"
      className="mb-6 space-y-6 rounded-2xl bg-card p-6"
    >
      <h2 id="change-title" className="text-xl font-bold text-foreground">
        Modifier ma réservation
      </h2>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <fieldset className="space-y-4">
        <legend className="mb-2 flex items-center gap-2 font-semibold text-foreground">
          <Users className="h-5 w-5" aria-hidden="true" /> Convives et date
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="change-party">Nombre de convives</Label>
            <select
              id="change-party"
              value={partySize}
              disabled={partyLocked}
              aria-describedby={partyLocked ? 'change-party-locked' : undefined}
              onChange={(e) => {
                setPartySize(Number(e.target.value))
                setStartsAt(null)
              }}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground disabled:cursor-not-allowed disabled:opacity-70"
            >
              {Array.from(
                { length: Math.max(booking.maxPartySize ?? 8, booking.partySize) },
                (_, i) => i + 1,
              ).map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'personne' : 'personnes'}
                </option>
              ))}
            </select>
            {partyLocked && (
              <p id="change-party-locked" className="text-sm text-muted-foreground">
                Le nombre de convives ne peut pas être modifié en ligne : l&apos;acompte ou la
                garantie a été calculé pour ce groupe. Annulez et réservez de nouveau, ou contactez
                l&apos;établissement.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="change-date">Date</Label>
            <Input
              id="change-date"
              type="date"
              min={today}
              max={lastDay}
              value={date}
              onChange={(e) => {
                if (!e.target.value) return
                setDate(e.target.value)
                setStartsAt(null)
              }}
            />
          </div>
        </div>
      </fieldset>

      {booking.rooms.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="mb-2 flex items-center gap-2 font-semibold text-foreground">
            <MapPin className="h-5 w-5" aria-hidden="true" /> Zone souhaitée
          </legend>
          <div className="flex flex-wrap gap-2">
            {[{ id: null, name: 'Peu importe' }, ...booking.rooms].map((room) => (
              <label
                key={room.id ?? 'any'}
                htmlFor={`change-room-preference-${room.id ?? 'any'}`}
                className="cursor-pointer"
              >
                <input
                  id={`change-room-preference-${room.id ?? 'any'}`}
                  type="radio"
                  name="change-room-preference"
                  className="peer sr-only"
                  checked={roomPreference === room.id}
                  onChange={() => {
                    setRoomPreference(room.id)
                    setStartsAt(null)
                  }}
                />
                <span className="flex min-h-11 min-w-20 items-center justify-center rounded-xl border border-input bg-background px-4 font-semibold text-foreground transition-colors hover:bg-accent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {room.name}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <legend className="mb-2 flex items-center gap-2 font-semibold text-foreground">
          <Clock className="h-5 w-5" aria-hidden="true" /> Horaire
        </legend>
        {slots === undefined ? (
          <Skeleton className="h-12 w-full rounded-xl" />
        ) : slots.length === 0 ? (
          <p className="text-muted-foreground">
            Aucun service n&apos;est proposé ce jour-là. Essayez une autre date.
          </p>
        ) : open.length === 0 ? (
          <p className="text-muted-foreground">
            Ce jour est complet pour {partySize} {partySize === 1 ? 'personne' : 'personnes'}.
            Essayez une autre date.
          </p>
        ) : (
          <>
            {preferredName && elsewhere.length > 0 && (
              <p role="status" className="rounded-xl bg-background p-3 text-sm text-foreground">
                La zone « {preferredName} » est complète à certains horaires : ils sont proposés
                dans l&apos;autre zone, indiquée sous l&apos;heure.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {open.map((slot) => (
                <button
                  key={`${slot.serviceId}:${slot.startsAt}`}
                  type="button"
                  aria-pressed={slot.startsAt === startsAt}
                  onClick={() => {
                    setError(null)
                    setStartsAt(slot.startsAt)
                  }}
                  className={`min-h-11 min-w-20 rounded-xl border px-4 font-semibold transition-colors ${
                    slot.startsAt === startsAt
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

      <div className="space-y-2">
        <Label htmlFor="change-note">Une demande particulière ? (facultatif)</Label>
        <Textarea
          id="change-note"
          maxLength={500}
          placeholder="Allergie, chaise haute, anniversaire…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {chosen && moved && (
        <p className="text-foreground">
          Nouvelle réservation : {partySize} {partySize === 1 ? 'personne' : 'personnes'} ·{' '}
          {formatReservationInstant(chosen.startsAt, booking.timezone)}
          {chosen.preference === 'other' && chosen.roomName ? `, zone « ${chosen.roomName} »` : ''}
        </p>
      )}

      {moved && booking.changeNeedsValidation && (
        <p role="status" className="text-sm text-muted-foreground">
          Le restaurant valide les réservations à la main : avec ce changement d&apos;horaire ou de
          convives, votre réservation sera à valider de nouveau, et vous recevrez un e-mail dès sa
          réponse.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" className="h-11 rounded-xl" disabled={!target || busy || unchanged}>
          {busy ? 'Enregistrement…' : 'Enregistrer la modification'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-xl"
          disabled={busy}
          onClick={onCancel}
        >
          Garder ma réservation
        </Button>
      </div>
    </form>
  )
}
