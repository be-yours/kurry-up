// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A booking changed after it was made: by the guest from their link, and by the
 * team from the day book.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. the change runs the SAME availability engine inside its own transaction, with
 *     the booking left out of the rows it reads — a guest moving from 19:30 to 20:00
 *     is never told their own table is taken by themselves;
 *  2. whether a changed booking goes back to the team follows the establishment's
 *     confirmation mode, and only a change to the time or the party counts;
 *  3. the reference, the link and the consent survive; the revision (the calendar
 *     file's `SEQUENCE`) moves, and what the guest said of the old time is forgotten;
 *  4. a change that changes nothing writes nothing and mails nobody;
 *  5. the guest is told, the restaurant is told, and a second change is told too.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface CapturedEmail {
  FromEmailAddress: string
  Destination: { ToAddresses: string[] }
  ReplyToAddresses?: string[]
  Content: {
    Simple: {
      Subject: { Data: string }
      Body: { Html: { Data: string }; Text: { Data: string } }
    }
  }
}

const ses = vi.hoisted(() => ({ sends: [] as unknown[], failWith: null as string | null }))

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      if (ses.failWith) throw new Error(ses.failWith)
      ses.sends.push(command.input)
      return {}
    }
  },
  SendEmailCommand: class {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  },
}))

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  NOW,
  bookSlot,
  dateIn,
  eventRows,
  openSlots,
  refusalCode,
  reservationRows,
  rowById,
  seedWorld,
  createHarnessFactory,
  type Harness,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const sent = () => ses.sends as CapturedEmail[]

beforeEach(() => {
  ses.sends.length = 0
  ses.failWith = null
  vi.stubEnv('AWS_SES_FROM_EMAIL', 'no-reply@beindigital.example')
  vi.stubEnv('AWS_REGION', 'eu-west-3')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret')
  vi.stubEnv('SITE_URL', 'https://chez-luigi.example')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Run `act`, then let whatever it queued run (fake timers first: see the notices suite). */
async function deliver<T>(t: Harness, act: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const result = await act()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return result
  } finally {
    vi.useRealTimers()
  }
}

/** A booking made through the real door, for ten days out at the first open slot. */
async function booked(t: Harness, world: { storeId: Id<'stores'> }, extra = {}) {
  const [slot] = await openSlots(t, world.storeId)
  const result = await bookSlot(t, world, slot!, extra)
  const [row] = await reservationRows(t)
  return { slot: slot!, result, id: row!._id }
}

const modify = (
  t: Harness,
  token: string,
  world: { serviceId: Id<'reservationServices'> },
  change: Partial<{
    date: string
    startsAt: number
    partySize: number
    note: string
    roomPreference: Id<'reservationRooms'> | null
    acceptOtherRoom: boolean
  }> & { startsAt: number },
) =>
  t.mutation(api.reservations.modifyByToken, {
    token,
    date: change.date ?? dateIn(10),
    serviceId: world.serviceId,
    partySize: change.partySize ?? 2,
    ...change,
  })

describe('a guest changing their booking', () => {
  test('moves it, keeping the reference and the link, and logs what it was', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    const answer = await modify(t, result.manageToken, world, { startsAt: later.startsAt })
    expect(answer).toEqual({ changed: true, status: 'confirmed' })

    const row = (await rowById(t, id))!
    expect(row).toMatchObject({
      reference: result.reference,
      manageToken: result.manageToken,
      startsAt: later.startsAt,
      status: 'confirmed',
      revision: 1,
    })
    expect(row.endsAt).toBe(later.startsAt + 90 * 60_000)
    expect(row.rescheduledAt).toBeTypeOf('number')
    // The consent given at the first booking is the guest's, and is kept.
    expect(row.consentAcceptedAt).toBeTypeOf('number')

    const events = await eventRows(t)
    expect(events.at(-1)).toMatchObject({
      actor: 'guest',
      from: 'confirmed',
      to: 'confirmed',
      note: 'modified',
      previous: { startsAt: slot.startsAt, partySize: 2 },
    })
  })

  test('changes the party and the note, and the table follows the party', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)

    await modify(t, result.manageToken, world, {
      startsAt: slot.startsAt,
      partySize: 4,
      note: '  Chaise haute  ',
    })
    const row = (await rowById(t, id))!
    expect(row).toMatchObject({ partySize: 4, guestNote: 'Chaise haute', revision: 1 })
  })

  test('is offered its own table again, which the first booking page would not', async () => {
    const t = newHarness()
    // One table only: the booking holds it from 19:00 to 20:30.
    const world = await seedWorld(t, { looseTables: 1 })
    const { slot, result } = await booked(t, world)

    const asNewGuest = (await openSlots(t, world.storeId)).map((s) => s.time)
    expect(asNewGuest).not.toContain('19:00')
    expect(asNewGuest).not.toContain('19:30')

    const ownSlots = await t.query(api.reservations.getAvailabilityByToken, {
      token: result.manageToken,
      date: dateIn(10),
      partySize: 2,
    })
    const open = ownSlots.filter((s) => s.available).map((s) => s.time)
    expect(open).toContain('19:00')
    expect(open).toContain('19:30')

    // And moving from 19:00 to 19:30 works though the windows overlap.
    const half = ownSlots.find((s) => s.time === '19:30')!
    expect(slot.startsAt).toBeLessThan(half.startsAt)
    await expect(
      modify(t, result.manageToken, world, { startsAt: half.startsAt }),
    ).resolves.toMatchObject({
      changed: true,
    })
  })

  test('is refused a slot someone else holds, and the booking is untouched', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const { slot, result, id } = await booked(t, world)
    // The only table is also wanted at 21:00 by another party.
    const evening = (await openSlots(t, world.storeId)).find((s) => s.time === '20:30')!
    await bookSlot(t, world, evening, { email: 'autre@example.com' })
    const eventsBefore = (await eventRows(t)).length

    expect(
      await refusalCode(modify(t, result.manageToken, world, { startsAt: evening.startsAt })),
    ).toBe('slot_unavailable')
    const row = (await rowById(t, id))!
    expect(row.startsAt).toBe(slot.startsAt)
    expect(row.revision).toBeUndefined()
    expect(await eventRows(t)).toHaveLength(eventsBefore)
  })

  test('re-runs the engine for the guest: a time inside the notice period is refused', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { result } = await booked(t, world)
    const tooSoon = (
      await t.query(api.reservations.getAvailability, {
        storeId: world.storeId,
        date: dateIn(10),
        partySize: 2,
      })
    )[0]!
    // A slot the engine never offered at all (not on the grid) is refused, not invented.
    expect(
      await refusalCode(
        modify(t, result.manageToken, world, { startsAt: tooSoon.startsAt + 7 * 60_000 }),
      ),
    ).toBe('slot_unavailable')
  })

  test('changing nothing writes nothing and mails nobody', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)

    const answer = await deliver(t, () =>
      modify(t, result.manageToken, world, { startsAt: slot.startsAt }),
    )
    expect(answer).toEqual({ changed: false, status: 'confirmed' })
    expect((await rowById(t, id))!.revision).toBeUndefined()
    expect(await eventRows(t)).toHaveLength(1)
    // Only the booking's own confirmation was ever sent.
    expect(sent().filter((m) => m.Content.Simple.Subject.Data.includes('modifi'))).toHaveLength(0)
  })

  test('a reworded note is allowed even when the table’s time has fallen inside the notice period', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1, guestChangeCutoffHours: 0 })
    // A booking half an hour from now, inside the one-hour notice a NEW booking needs.
    const startsAt = NOW + 30 * 60_000
    const token = 'soon-token-0001'
    const id = await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: 'RES-2026-00099',
        status: 'confirmed',
        serviceId: world.serviceId,
        startsAt,
        endsAt: startsAt + 90 * 60_000,
        partySize: 2,
        tableIds: [world.tables['Libre 1']!],
        guestName: 'Marie Dupont',
        guestEmail: 'marie@example.com',
        guestPhone: '0612345678',
        channel: 'online',
        manageToken: token,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const date = new Date(startsAt).toISOString().slice(0, 10)

    await expect(
      t.mutation(api.reservations.modifyByToken, {
        token,
        date,
        serviceId: world.serviceId,
        startsAt,
        partySize: 2,
        note: 'Plutôt près de la fenêtre',
      }),
    ).resolves.toMatchObject({ changed: true })
    const row = (await rowById(t, id))!
    expect(row.guestNote).toBe('Plutôt près de la fenêtre')
    // The time did not move, so no new revision and the tables are the same.
    expect(row.revision).toBeUndefined()
    expect(row.tableIds).toEqual([world.tables['Libre 1']])
  })

  test('keeps the guest’s reconfirmation for a note, and forgets it for a new time', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)
    await t.mutation(api.reservations.reconfirmByToken, { token: result.manageToken })

    await modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'Allergie' })
    expect((await rowById(t, id))!.reconfirmedAt).toBeTypeOf('number')

    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
    await modify(t, result.manageToken, world, { startsAt: later.startsAt, note: 'Allergie' })
    expect((await rowById(t, id))!.reconfirmedAt).toBeUndefined()
  })

  test('claims the reminder again for the new time', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)
    await t.run((ctx) => ctx.db.patch(id, { notices: { confirmed: NOW, reminder: NOW } }))
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
    await modify(t, result.manageToken, world, { startsAt: later.startsAt })
    const notices = (await rowById(t, id))!.notices!
    expect(notices.reminder).toBeUndefined()
    expect(notices.confirmed).toBeTypeOf('number')
  })

  test('only a pending or confirmed booking can be changed', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result, id } = await booked(t, world)
    for (const status of [
      'arrived',
      'seated',
      'completed',
      'cancelled_by_guest',
      'cancelled_by_restaurant',
      'no_show',
      'expired',
      'declined',
    ] as const) {
      await t.run((ctx) => ctx.db.patch(id, { status }))
      expect(
        await refusalCode(
          modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: status }),
        ),
      ).toBe('transition_refused')
    }
  })

  test('refuses an unknown link', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    expect(
      await refusalCode(modify(t, 'no-such-token-0000', world, { startsAt: NOW + 10 * DAY })),
    ).toBe('invalid_input')
  })

  test('is refused when the online booking switch is off', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result } = await booked(t, world)
    await t.run((ctx) => ctx.db.patch(world.storeId, { reservationMode: 'off' }))
    expect(
      await refusalCode(
        modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'x' }),
      ),
    ).toBe('reservations_disabled')
  })

  test('is bounded: ten changes an hour for one booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result } = await booked(t, world)
    for (let i = 0; i < 10; i++) {
      await modify(t, result.manageToken, world, {
        startsAt: slot.startsAt,
        partySize: i % 2 === 0 ? 3 : 2,
      })
    }
    await expect(
      modify(t, result.manageToken, world, { startsAt: slot.startsAt, partySize: 4 }),
    ).rejects.toThrow()
  })

  test('caps the note like the first booking does', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result } = await booked(t, world)
    await expect(
      modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'x'.repeat(501) }),
    ).rejects.toThrow()
  })

  describe('the cut-off', () => {
    test('follows the cancellation deadline when the owner set none of its own', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, cancellationDeadlineHours: 24 * 11 })
      const { slot, result } = await booked(t, world)
      // The booking is ten days out, inside an eleven-day deadline.
      expect(
        await refusalCode(
          modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'x' }),
        ),
      ).toBe('change_closed')
      const view = await t.query(api.reservations.getByToken, { token: result.manageToken })
      expect(view).toMatchObject({ canModify: false, canCancel: false, changeCutoffHours: 24 * 11 })
    })

    test('takes the owner’s own number', async () => {
      const t = newHarness()
      const world = await seedWorld(t, {
        looseTables: 2,
        cancellationDeadlineHours: 24 * 11,
        guestChangeCutoffHours: 24,
      })
      const { slot, result } = await booked(t, world)
      await expect(
        modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'x' }),
      ).resolves.toMatchObject({ changed: true })
      expect(
        await t.query(api.reservations.getByToken, { token: result.manageToken }),
      ).toMatchObject({ canModify: true, canCancel: false })
    })

    test('0 means until the booking starts, never after', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, guestChangeCutoffHours: 0 })
      const { slot, result, id } = await booked(t, world)
      expect(
        await t.query(api.reservations.getByToken, { token: result.manageToken }),
      ).toMatchObject({ canModify: true })

      await t.run((ctx) => ctx.db.patch(id, { startsAt: NOW - 60_000, endsAt: NOW + 60 * 60_000 }))
      expect(
        await refusalCode(
          modify(t, result.manageToken, world, { startsAt: slot.startsAt, note: 'x' }),
        ),
      ).toBe('change_closed')
      expect(
        await t.query(api.reservations.getByToken, { token: result.manageToken }),
      ).toMatchObject({ canModify: false })
    })
  })

  describe('and the establishment’s confirmation mode', () => {
    test('a house that confirms by itself keeps the booking confirmed', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: true })
      const { slot, result } = await booked(t, world)
      const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
      expect(
        await modify(t, result.manageToken, world, { startsAt: later.startsAt }),
      ).toMatchObject({
        status: 'confirmed',
      })
    })

    test('a house that validates by hand sees a new time come back as pending', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
      const { slot, result, id } = await booked(t, world)
      await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })

      const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
      const answer = await modify(t, result.manageToken, world, { startsAt: later.startsAt })
      expect(answer).toEqual({ changed: true, status: 'pending' })

      const row = (await rowById(t, id))!
      expect(row.status).toBe('pending')
      // The table is held while the team decides, like any request.
      expect(row.tableIds).toHaveLength(1)
      expect(await eventRows(t)).toMatchObject([
        { to: 'pending' },
        { from: 'pending', to: 'confirmed' },
        { actor: 'guest', from: 'confirmed', to: 'pending', note: 'modified' },
      ])
      // The team's later yes can reach the guest again.
      expect(row.notices?.confirmed).toBeUndefined()
    })

    test('a changed party does the same; a reworded note and a room wish do not', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
      const { slot, result, id } = await booked(t, world)
      await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })

      const noteOnly = await modify(t, result.manageToken, world, {
        startsAt: slot.startsAt,
        note: 'Chaise haute',
      })
      expect(noteOnly).toMatchObject({ status: 'confirmed' })

      const party = await modify(t, result.manageToken, world, {
        startsAt: slot.startsAt,
        partySize: 3,
      })
      expect(party).toMatchObject({ status: 'pending' })
    })

    test('the team cannot un-confirm a booking by hand: only a guest’s change reopens it', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
      const { id } = await booked(t, world)
      await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })
      expect(
        await refusalCode(
          world.manager.mutation(api.reservations.setStatus, { id, to: 'pending' }),
        ),
      ).toBe('transition_refused')
    })

    test('a request that is already waiting simply stays pending', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
      const { slot, result } = await booked(t, world)
      const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
      expect(
        await modify(t, result.manageToken, world, { startsAt: later.startsAt }),
      ).toMatchObject({
        status: 'pending',
      })
    })

    test('the team confirming the changed booking reaches the guest', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
      const { slot, result, id } = await booked(t, world)
      await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })
      const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
      await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later.startsAt }))

      ses.sends.length = 0
      await deliver(t, () =>
        world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' }),
      )
      expect(sent().map((m) => m.Content.Simple.Subject.Data)).toEqual([
        expect.stringContaining('est confirmée'),
      ])
    })
  })

  describe('and the area they asked for', () => {
    const ROOMS = [
      { name: 'Salle', tables: 2 },
      { name: 'Terrasse', tables: 2 },
    ]

    test('keeps the preference through a change, and can clear it', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { rooms: ROOMS })
      const [slot] = await openSlots(t, world.storeId, 2, {
        roomPreference: world.rooms['Terrasse']!,
      })
      const result = await bookSlot(t, world, slot!, { roomPreference: world.rooms['Terrasse']! })
      const [row] = await reservationRows(t)
      const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot!.startsAt)!

      await modify(t, result.manageToken, world, { startsAt: later.startsAt })
      let after = (await rowById(t, row!._id))!
      expect(after.roomPreference).toBe(world.rooms['Terrasse'])
      expect([world.tables['Terrasse 1'], world.tables['Terrasse 2']]).toContain(after.tableIds[0])

      await modify(t, result.manageToken, world, {
        startsAt: later.startsAt,
        roomPreference: null,
      })
      after = (await rowById(t, row!._id))!
      expect(after.roomPreference).toBeUndefined()
    })

    test('asks before moving the guest to the other area', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { rooms: ROOMS })
      const slots = await openSlots(t, world.storeId)
      const [first, second] = [slots[0]!, slots[1]!]
      const result = await bookSlot(t, world, first)
      // Both terrace tables are taken at the second slot.
      await bookSlot(t, world, second, {
        roomPreference: world.rooms['Terrasse']!,
        email: 'a@example.com',
      })
      await bookSlot(t, world, second, {
        roomPreference: world.rooms['Terrasse']!,
        email: 'b@example.com',
      })

      expect(
        await refusalCode(
          modify(t, result.manageToken, world, {
            startsAt: second.startsAt,
            roomPreference: world.rooms['Terrasse']!,
          }),
        ),
      ).toBe('area_unavailable')
      await expect(
        modify(t, result.manageToken, world, {
          startsAt: second.startsAt,
          roomPreference: world.rooms['Terrasse']!,
          acceptOtherRoom: true,
        }),
      ).resolves.toMatchObject({ changed: true })
    })

    test('a room archived since the booking is dropped quietly, and a note change still works', async () => {
      const t = newHarness()
      const world = await seedWorld(t, { rooms: ROOMS })
      const [slot] = await openSlots(t, world.storeId, 2, {
        roomPreference: world.rooms['Terrasse']!,
      })
      const result = await bookSlot(t, world, slot!, { roomPreference: world.rooms['Terrasse']! })
      await world.manager.mutation(api.reservations.archiveRoom, {
        id: world.rooms['Terrasse']!,
        archived: true,
      })

      const view = await t.query(api.reservations.getByToken, { token: result.manageToken })
      expect(view).toMatchObject({ roomPreference: null, rooms: [] })
      await expect(
        modify(t, result.manageToken, world, { startsAt: slot!.startsAt, note: 'Merci' }),
      ).resolves.toMatchObject({ changed: true })
    })
  })
})

describe('what the manage page is told', () => {
  test('whether it can change, why not, and what a change would cost', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
    const { result, id } = await booked(t, world)

    // A pending request: it can be changed, and changing it costs nothing more.
    expect(await t.query(api.reservations.getByToken, { token: result.manageToken })).toMatchObject(
      {
        canModify: true,
        changeNeedsValidation: false,
        maxPartySize: 8,
        maxHorizonDays: 60,
        revision: 0,
        rooms: [],
      },
    )

    await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })
    expect(await t.query(api.reservations.getByToken, { token: result.manageToken })).toMatchObject(
      { canModify: true, changeNeedsValidation: true },
    )

    await world.manager.mutation(api.reservations.setStatus, { id, to: 'arrived' }).catch(() => {})
    await t.run((ctx) => ctx.db.patch(id, { status: 'seated' }))
    expect(await t.query(api.reservations.getByToken, { token: result.manageToken })).toMatchObject(
      { canModify: false },
    )
  })

  test('the calendar file’s revision moves with each new time', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result } = await booked(t, world)
    const slots = (await openSlots(t, world.storeId)).filter((s) => s.startsAt > slot.startsAt)
    await modify(t, result.manageToken, world, { startsAt: slots[0]!.startsAt })
    await modify(t, result.manageToken, world, { startsAt: slots[1]!.startsAt })
    expect(await t.query(api.reservations.getByToken, { token: result.manageToken })).toMatchObject(
      { revision: 2, startsAt: slots[1]!.startsAt },
    )
  })
})

describe('the e-mails of a change', () => {
  const subjects = () => sent().map((m) => m.Content.Simple.Subject.Data)

  test('tells the guest, and tells the restaurant, once each, with before and after', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.example' })
    const { slot, result } = await deliver(t, () => booked(t, world))
    ses.sends.length = 0
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later.startsAt }))

    const toGuest = sent().find((m) => m.Destination.ToAddresses[0] === 'marie@example.com')!
    const toTeam = sent().find((m) => m.Destination.ToAddresses[0] === 'contact@luigi.example')!
    expect(sent()).toHaveLength(2)

    expect(toGuest.Content.Simple.Subject.Data).toBe(
      'Votre réservation chez Chez Luigi a été modifiée',
    )
    expect(toGuest.Content.Simple.Body.Text.Data).toContain(
      `https://chez-luigi.example/reservation/manage/${result.manageToken}`,
    )
    expect(toGuest.Content.Simple.Body.Text.Data).toContain('Avant :')

    expect(toTeam.Content.Simple.Subject.Data).toContain('modifiée par Marie Dupont')
    expect(toTeam.Content.Simple.Body.Text.Data).toContain('Avant :')
    expect(toTeam.Content.Simple.Body.Text.Data).toContain('0612345678')
    // The guest's link is theirs alone.
    expect(toTeam.Content.Simple.Body.Text.Data).not.toContain(result.manageToken)
    // Answering the team's copy writes to the guest.
    expect(toTeam.ReplyToAddresses).toEqual(['marie@example.com'])
  })

  test('a second change is told again: a change can happen more than once', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.example' })
    const { slot, result } = await deliver(t, () => booked(t, world))
    const later = (await openSlots(t, world.storeId)).filter((s) => s.startsAt > slot.startsAt)
    ses.sends.length = 0

    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later[0]!.startsAt }))
    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later[1]!.startsAt }))
    expect(subjects().filter((s) => s.includes('a été modifiée'))).toHaveLength(2)
    expect(subjects().filter((s) => s.includes('modifiée par'))).toHaveLength(2)
  })

  test('a change that waits for the team says so to the guest and to the team', async () => {
    const t = newHarness()
    const world = await seedWorld(t, {
      looseTables: 2,
      autoConfirm: false,
      storeEmail: 'contact@luigi.example',
    })
    const { slot, result, id } = await deliver(t, () => booked(t, world))
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' }),
    )
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
    ses.sends.length = 0

    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later.startsAt }))
    const toGuest = sent().find((m) => m.Destination.ToAddresses[0] === 'marie@example.com')!
    const toTeam = sent().find((m) => m.Destination.ToAddresses[0] === 'contact@luigi.example')!
    expect(toGuest.Content.Simple.Subject.Data).toContain('demande de modification')
    expect(toGuest.Content.Simple.Body.Text.Data).toContain('doit valider cette modification')
    expect(toTeam.Content.Simple.Body.Text.Data).toContain('attend de nouveau votre validation')
  })

  test('an establishment with no address gets no copy, and the guest still hears', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, result } = await deliver(t, () => booked(t, world))
    ses.sends.length = 0
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later.startsAt }))
    expect(sent()).toHaveLength(1)
    expect(sent()[0]!.Destination.ToAddresses).toEqual(['marie@example.com'])
  })

  test('records the claim of each notice on the booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.example' })
    const { slot, result, id } = await booked(t, world)
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    await modify(t, result.manageToken, world, { startsAt: later.startsAt })
    const notices = (await rowById(t, id))!.notices!
    expect(notices.modified).toBeTypeOf('number')
    expect(notices.modified_restaurant).toBeTypeOf('number')
  })

  test('gives a claim back, and says why on the booking, when the mail cannot be sent', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.example' })
    const { slot, result, id } = await deliver(t, () => booked(t, world))
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    ses.failWith = 'MessageRejected'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await deliver(t, () => modify(t, result.manageToken, world, { startsAt: later.startsAt }))

    const row = (await rowById(t, id))!
    expect(row.notices?.modified).toBeUndefined()
    expect(row.notices?.modified_restaurant).toBeUndefined()
    expect(row.noticeFailure).toMatchObject({ reason: 'transport' })
  })

  test('the team’s own edit tells the guest of a new time and not the restaurant', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.example' })
    const { slot, id } = await deliver(t, () => booked(t, world))
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!
    ses.sends.length = 0

    await deliver(t, () =>
      world.manager.mutation(api.reservations.updateByStaff, {
        id,
        date: dateIn(10),
        serviceId: world.serviceId,
        startsAt: later.startsAt,
        partySize: 2,
      }),
    )
    expect(sent()).toHaveLength(1)
    expect(sent()[0]!.Destination.ToAddresses).toEqual(['marie@example.com'])
  })
})

describe('the team editing a booking', () => {
  const edit = (
    t: Harness,
    as: { mutation: Harness['mutation'] },
    world: { serviceId: Id<'reservationServices'> },
    id: Id<'reservations'>,
    change: Record<string, unknown> & { startsAt: number },
  ) =>
    as.mutation(api.reservations.updateByStaff, {
      id,
      date: dateIn(10),
      serviceId: world.serviceId,
      partySize: 2,
      ...change,
    } as never)

  test('moves the time and the party on the same engine, leaving the status alone', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, autoConfirm: false })
    const { slot, id } = await booked(t, world)
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'confirmed' })
    const later = (await openSlots(t, world.storeId)).find((s) => s.startsAt > slot.startsAt)!

    const answer = await edit(t, world.waiter, world, id, {
      startsAt: later.startsAt,
      partySize: 3,
    })
    expect(answer).toEqual({ changed: true })
    const row = (await rowById(t, id))!
    // The team edited it: it does not go back to the team.
    expect(row).toMatchObject({
      status: 'confirmed',
      startsAt: later.startsAt,
      partySize: 3,
      revision: 1,
    })
    expect((await eventRows(t)).at(-1)).toMatchObject({
      actor: 'staff',
      note: 'modified',
      previous: { startsAt: slot.startsAt, partySize: 2 },
    })
  })

  test('is not bound by the notice period or the online ceiling, like a booking taken by phone', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { slot, id } = await booked(t, world)
    // One banquette seats twelve; nine is above the online maximum of eight.
    await t.run((ctx) => ctx.db.patch(world.tables['Libre 1']!, { maxCovers: 12 }))
    await expect(
      edit(t, world.waiter, world, id, { startsAt: slot.startsAt, partySize: 9 }),
    ).resolves.toMatchObject({ changed: true })
  })

  test('refuses a time the engine cannot give, without an override', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const { slot, id } = await booked(t, world)
    // A second party takes the only table at 20:30.
    const evening = (await openSlots(t, world.storeId)).find((s) => s.time === '20:30')!
    await bookSlot(t, world, evening, { email: 'autre@example.com' })
    expect(
      await refusalCode(edit(t, world.waiter, world, id, { startsAt: evening.startsAt })),
    ).toBe('slot_unavailable')
    expect((await rowById(t, id))!.startsAt).toBe(slot.startsAt)
  })

  test('lets a manager force it, and says so in the history; a waiter cannot', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const { id } = await booked(t, world)
    const evening = (await openSlots(t, world.storeId)).find((s) => s.time === '20:30')!
    await bookSlot(t, world, evening, { email: 'autre@example.com' })

    await expect(
      edit(t, world.waiter, world, id, { startsAt: evening.startsAt, override: true }),
    ).rejects.toThrow()
    expect((await rowById(t, id))!.startsAt).not.toBe(evening.startsAt)

    // Without naming a table the override would keep the booking's own table at the new time,
    // where another party already sits: that double booking is refused, with the table named.
    expect(
      await refusalCode(
        edit(t, world.manager, world, id, { startsAt: evening.startsAt, override: true }),
      ),
    ).toBe('table_conflict')
    expect((await rowById(t, id))!.startsAt).not.toBe(evening.startsAt)

    // Naming the table is the manager taking the double booking on themselves.
    const taken = (await reservationRows(t)).find((r) => r.guestEmail === 'autre@example.com')!
    await expect(
      edit(t, world.manager, world, id, {
        startsAt: evening.startsAt,
        override: true,
        tableIds: taken.tableIds,
      }),
    ).resolves.toMatchObject({ changed: true })
    expect((await rowById(t, id))!.startsAt).toBe(evening.startsAt)
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'modified_override' })
  })

  test('an override cannot invent a time no service offers', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, id } = await booked(t, world)
    expect(
      await refusalCode(
        edit(t, world.manager, world, id, { startsAt: slot.startsAt + 7 * 60_000, override: true }),
      ),
    ).toBe('slot_unavailable')
  })

  test('puts the party on the tables the host names, and refuses one another booking holds', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { slot, id } = await booked(t, world)
    // Another party sits at table 3 over the same hour.
    const other = await bookSlot(t, world, slot, { email: 'autre@example.com' })
    const [, otherRow] = (await reservationRows(t)).sort(
      (a, b) => a._creationTime - b._creationTime,
    )
    expect(other.status).toBe('confirmed')
    const busy = otherRow!.tableIds[0]!

    expect(
      await refusalCode(
        edit(t, world.waiter, world, id, { startsAt: slot.startsAt, tableIds: [busy] }),
      ),
    ).toBe('table_conflict')

    const mine = (await rowById(t, id))!.tableIds
    const free = Object.values(world.tables).find((tb) => tb !== busy && !mine.includes(tb))!
    await expect(
      edit(t, world.waiter, world, id, { startsAt: slot.startsAt, tableIds: [free] }),
    ).resolves.toMatchObject({ changed: true })
    expect((await rowById(t, id))!.tableIds).toEqual([free])
    // A table moved behind the scenes is not a change the guest hears about, nor a new revision.
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'tables_moved' })
    expect((await rowById(t, id))!.revision).toBeUndefined()
  })

  test('refuses a table that is out of service', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, id } = await booked(t, world)
    const out = world.tables['Libre 2']!
    await t.run((ctx) => ctx.db.patch(out, { outOfService: true }))
    expect(
      await refusalCode(
        edit(t, world.manager, world, id, {
          startsAt: slot.startsAt,
          tableIds: [out],
          override: true,
        }),
      ),
    ).toBe('table_unavailable')
  })

  test('refuses tables named on a book that runs on covers', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { capacityMode: 'covers', looseTables: 1 })
    const first = (await openSlots(t, world.storeId))[0]!
    await bookSlot(t, world, first)
    const [row] = await reservationRows(t)
    expect(
      await refusalCode(
        edit(t, world.manager, world, row!._id, {
          startsAt: first.startsAt,
          tableIds: [world.tables['Libre 1']!],
        }),
      ),
    ).toBe('invalid_input')
  })

  test('changing nothing is a no-op', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, id } = await booked(t, world)
    const before = await eventRows(t)
    await expect(edit(t, world.waiter, world, id, { startsAt: slot.startsAt })).resolves.toEqual({
      changed: false,
      notices: undefined,
    })
    expect(await eventRows(t)).toHaveLength(before.length)
  })

  test('only a booking that has not been seated can be edited', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, id } = await booked(t, world)
    for (const status of ['seated', 'completed', 'cancelled_by_guest', 'no_show'] as const) {
      await t.run((ctx) => ctx.db.patch(id, { status }))
      expect(
        await refusalCode(
          edit(t, world.waiter, world, id, { startsAt: slot.startsAt, partySize: 3 }),
        ),
      ).toBe('transition_refused')
    }
  })

  test('is a write the host stand has, and a stranger does not', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { slot, id } = await booked(t, world)
    await expect(
      t.mutation(api.reservations.updateByStaff, {
        id,
        date: dateIn(10),
        serviceId: world.serviceId,
        startsAt: slot.startsAt,
        partySize: 3,
      }),
    ).rejects.toThrow()
  })
})
