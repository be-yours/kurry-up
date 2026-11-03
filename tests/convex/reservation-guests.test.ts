// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The guest book: one profile per address, written as bookings happen, and what it
 * must never hold.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. a booking opens or updates ONE profile per (establishment, folded address);
 *     a walk-in, which has no address, opens none;
 *  2. the counters follow the booking's life: a completed sitting, a no-show (given
 *     back when the party turns up after all), the guest's own cancellation — and
 *     not the restaurant's;
 *  3. booking subscribes nobody: the marketing box is unchecked by default, ticking
 *     it only STARTS the double opt-in, and its wording version is recorded;
 *  4. allergies are never in a profile, and the note that carries them is erased a
 *     few days after the sitting;
 *  5. merging two profiles is a manager's act, keeps one row per person, and a later
 *     booking under the absorbed address lands on the kept profile;
 *  6. only a manager exports the book.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const ses = vi.hoisted(() => ({ sends: [] as unknown[] }))

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
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

import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  bookSlot,
  dateIn,
  guest,
  openSlots,
  refusalCode,
  reservationRows,
  seedWorld,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()

beforeEach(() => {
  ses.sends.length = 0
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

const profiles = (t: Harness) => t.run((ctx) => ctx.db.query('guestProfiles').collect())
const profileOf = async (t: Harness, email: string) =>
  (await profiles(t)).find((p) => p.email === email)!

/** The nth open slot of a date, for a guest who books more than once. */
async function book(
  t: Harness,
  world: Pick<World, 'storeId'>,
  extra: Parameters<typeof bookSlot>[3] = {},
  slotIndex = 0,
) {
  const slots = await openSlots(t, world.storeId, extra.partySize ?? 2, { date: extra.date })
  const slot = slots[slotIndex]
  if (!slot) throw new Error('no open slot')
  const result = await bookSlot(t, world, slot, extra)
  const row = (await reservationRows(t)).find((r) => r.reference === result.reference)!
  return { result, row }
}

/** Put a booking in the past, where only a no-show or a completed sitting can be recorded. */
async function inThePast(t: Harness, id: Id<'reservations'>) {
  await t.run((ctx) =>
    ctx.db.patch(id, { startsAt: Date.now() - 3 * 60 * 60_000, endsAt: Date.now() - 60 * 60_000 }),
  )
}

describe('opening and updating a profile', () => {
  test('a booking opens one profile, folded by address, with what the guest gave', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await book(t, world, { email: '  Marie@Example.com ', name: 'Marie D.' })

    const [profile] = await profiles(t)
    expect(profile).toMatchObject({
      email: 'marie@example.com',
      name: 'Marie D.',
      phone: guest.phone,
      bookings: 1,
      visits: 0,
      noShows: 0,
      cancellations: 0,
      tags: [],
    })
    expect(profile!.firstSeenAt).toBeTypeOf('number')
  })

  test('a second booking, however the address is typed, updates the same profile and keeps its name', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await book(t, world, { email: 'marie@example.com', name: 'Marie' })
    await book(t, world, { email: 'MARIE@example.com', name: 'Marie Dupont', date: dateIn(11) })

    const rows = await profiles(t)
    expect(rows).toHaveLength(1)
    // A booking made anonymously may fill what the profile lacks, never rewrite what it holds.
    expect(rows[0]).toMatchObject({ bookings: 2, name: 'Marie' })
  })

  test('a booking the team types in opens one too; a walk-in, which has no address, none', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    await world.waiter.mutation(api.reservations.createByStaff, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot!.serviceId as Id<'reservationServices'>,
      startsAt: slot!.startsAt,
      partySize: 2,
      guest: { name: 'Phone Guest', email: 'phone@example.com', phone: '0600000000' },
    })
    expect((await profiles(t)).map((p) => p.email)).toEqual(['phone@example.com'])

    // A walk-in: no profile, whatever the label.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() - (Date.now() % DAY) + 19.5 * 60 * 60_000))
    try {
      await world.waiter.mutation(api.reservations.seatWalkIn, {
        storeId: world.storeId,
        partySize: 2,
        label: 'Table du fond',
      })
    } finally {
      vi.useRealTimers()
    }
    expect(await profiles(t)).toHaveLength(1)
  })

  test('the area a guest asked for becomes their preferred one', async () => {
    const t = newHarness()
    const world = await seedWorld(t, {
      rooms: [
        { name: 'Salle', tables: 2 },
        { name: 'Terrasse', tables: 2 },
      ],
    })
    await book(t, world, { roomPreference: world.rooms.Terrasse })
    expect((await profiles(t))[0]!.preferredRoomId).toBe(world.rooms.Terrasse)
  })
})

describe('the counters', () => {
  test('a completed sitting counts, with its covers, and the day it ended', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world, { partySize: 3 })
    for (const to of ['arrived', 'seated', 'completed'] as const) {
      await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to })
    }
    const profile = await profileOf(t, guest.email)
    expect(profile).toMatchObject({ visits: 1, covers: 3, noShows: 0 })
    expect(profile.lastVisitAt).toBeTypeOf('number')
  })

  test('a no-show counts, and is given back if the party turns up after all', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world)
    await inThePast(t, row._id)
    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'no_show' })
    expect((await profileOf(t, guest.email)).noShows).toBe(1)

    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'arrived' })
    expect((await profileOf(t, guest.email)).noShows).toBe(0)
  })

  test('the guest’s own cancellation counts against the guest; the restaurant’s does not', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, cancellationDeadlineHours: 0 })
    const own = await book(t, world, { email: 'own@example.com' })
    await t.mutation(api.reservations.cancelByToken, { token: own.row.manageToken })
    expect((await profileOf(t, 'own@example.com')).cancellations).toBe(1)

    const theirs = await book(t, world, { email: 'theirs@example.com' })
    await world.manager.mutation(api.reservations.setStatus, {
      id: theirs.row._id,
      to: 'cancelled_by_restaurant',
    })
    expect((await profileOf(t, 'theirs@example.com')).cancellations).toBe(0)
  })

  test('a booking that predates the guest book opens a profile when it first moves', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world)
    // As if the booking were made before profiles existed.
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query('guestProfiles').collect()) await ctx.db.delete(p._id)
    })
    await inThePast(t, row._id)
    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'no_show' })
    expect(await profiles(t)).toHaveLength(1)
    expect((await profileOf(t, guest.email)).noShows).toBe(1)
  })
})

describe('marketing', () => {
  const subscribers = (t: Harness) => t.run((ctx) => ctx.db.query('emailSubscribers').collect())

  test('booking subscribes nobody: the box is unchecked by default', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await book(t, world)
    expect(await subscribers(t)).toHaveLength(0)
    expect((await profiles(t))[0]!.marketingOptInAt).toBeUndefined()
  })

  test('ticking it starts the double opt-in: a PENDING subscriber, and the wording recorded', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    vi.useFakeTimers()
    try {
      await t.mutation(api.reservations.create, {
        storeId: world.storeId,
        date: dateIn(10),
        serviceId: slot!.serviceId as Id<'reservationServices'>,
        startsAt: slot!.startsAt,
        partySize: 2,
        guest,
        consentNoticeVersion: 'v1',
        privacyNoticeVersion: 'fr-2026-10',
        marketingOptInVersion: 'fr-2026-10',
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }
    const [subscriber] = await subscribers(t)
    expect(subscriber).toMatchObject({
      email: guest.email,
      status: 'pending',
      source: 'storefront_form',
      tags: ['reservation'],
    })
    expect(subscriber!.consentSource).toContain('fr-2026-10')
    const profile = await profileOf(t, guest.email)
    expect(profile.marketingOptInVersion).toBe('fr-2026-10')
    expect(profile.marketingOptInAt).toBeTypeOf('number')
    // The booking records which privacy wording the guest saw.
    expect((await reservationRows(t))[0]!.privacyNoticeVersion).toBe('fr-2026-10')
  })

  test('an address already on the list never stops the booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run((ctx) =>
      ctx.db.insert('emailSubscribers', {
        storeId: world.storeId,
        email: guest.email,
        status: 'active' as const,
        source: 'manual' as const,
        tags: [],
        consentAt: Date.now(),
        consentSource: 'manual',
        bounceCount: 0,
        metadata: {
          totalOrders: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          favoriteProducts: [],
          orderTypes: [],
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    const [slot] = await openSlots(t, world.storeId)
    const result = await t.mutation(api.reservations.create, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot!.serviceId as Id<'reservationServices'>,
      startsAt: slot!.startsAt,
      partySize: 2,
      guest,
      consentNoticeVersion: 'v1',
      marketingOptInVersion: 'fr-2026-10',
    })
    expect(result.reference).toMatch(/^RES-/)
    expect(await subscribers(t)).toHaveLength(1)
  })

  test('a wording version the engine does not know is refused', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    const attempt = (extra: object) =>
      t.mutation(api.reservations.create, {
        storeId: world.storeId,
        date: dateIn(10),
        serviceId: slot!.serviceId as Id<'reservationServices'>,
        startsAt: slot!.startsAt,
        partySize: 2,
        guest,
        consentNoticeVersion: 'v1',
        ...extra,
      })
    expect(await refusalCode(attempt({ marketingOptInVersion: 'invented' }))).toBe(
      'consent_required',
    )
    expect(await refusalCode(attempt({ privacyNoticeVersion: 'invented' }))).toBe(
      'consent_required',
    )
    expect(await reservationRows(t)).toHaveLength(0)
  })
})

describe('allergies', () => {
  test('are never in the profile, and the note that carries them is erased after the sitting', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world, { note: 'allergie aux arachides' })
    expect(JSON.stringify(await profiles(t))).not.toMatch(/arachide/)

    expect(row.guestNote).toBe('allergie aux arachides')
    // Erased three days after the sitting's end, not before.
    expect(row.noteExpiresAt).toBe(row.endsAt + 3 * DAY)

    await t.mutation(internal.reservationGuests.purgeGuestNotes, { now: row.endsAt + 3 * DAY - 1 })
    expect((await reservationRows(t))[0]!.guestNote).toBe('allergie aux arachides')

    const result = await t.mutation(internal.reservationGuests.purgeGuestNotes, {
      now: row.endsAt + 3 * DAY,
    })
    expect(result.purged).toBe(1)
    const after = (await reservationRows(t))[0]!
    expect(after.guestNote).toBeUndefined()
    expect(after.noteExpiresAt).toBeUndefined()
    // The booking, its guest and its reference stay until the retention window.
    expect(after.guestName).toBe(guest.name)
  })

  test('a booking with no note has nothing to erase', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world)
    expect(row.noteExpiresAt).toBeUndefined()
    const result = await t.mutation(internal.reservationGuests.purgeGuestNotes, {
      now: Date.now() + 400 * DAY,
    })
    expect(result.purged).toBe(0)
  })

  test('a moved booking is erased after its NEW end, and a removed note stops the clock', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { row } = await book(t, world, { note: 'sans gluten' })
    const slots = await openSlots(t, world.storeId)
    const later = slots.find((s) => s.startsAt > row.startsAt)!
    await t.mutation(api.reservations.modifyByToken, {
      token: row.manageToken,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      partySize: 2,
    })
    const moved = (await reservationRows(t))[0]!
    expect(moved.noteExpiresAt).toBe(moved.endsAt + 3 * DAY)
    expect(moved.endsAt).toBeGreaterThan(row.endsAt)

    await t.mutation(api.reservations.modifyByToken, {
      token: row.manageToken,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      partySize: 2,
      note: '',
    })
    expect((await reservationRows(t))[0]!.noteExpiresAt).toBeUndefined()
  })
})

describe('reading and editing', () => {
  async function seedGuests(t: Harness) {
    const world = await seedWorld(t, { looseTables: 4 })
    await book(t, world, { email: 'alice@example.com', name: 'Alice Martin' })
    await book(t, world, { email: 'bob@example.com', name: 'Bob Durand' })
    await book(t, world, { email: 'carla@example.com', name: 'Carla Petit' })
    return world
  }
  const listIds = async (
    world: World,
    args: { search?: string; filter?: 'all' | 'vip' | 'repeat_no_show' | 'upcoming' } = {},
  ) =>
    (await world.waiter.query(api.reservationGuests.list, { storeId: world.storeId, ...args }))
      .guests

  test('lists most recently seen first, and searches by name, address and phone digits', async () => {
    const t = newHarness()
    const world = await seedGuests(t)
    expect((await listIds(world)).map((g) => g.name)).toEqual([
      'Carla Petit',
      'Bob Durand',
      'Alice Martin',
    ])
    expect((await listIds(world, { search: 'durand' })).map((g) => g.name)).toEqual(['Bob Durand'])
    expect((await listIds(world, { search: 'ALICE@' })).map((g) => g.name)).toEqual([
      'Alice Martin',
    ])
    expect(await listIds(world, { search: '06 12 34' })).toHaveLength(3)
    expect(await listIds(world, { search: 'nobody' })).toEqual([])
  })

  test('filters VIP, repeat no-shows and guests with a table coming up', async () => {
    const t = newHarness()
    const world = await seedGuests(t)
    const alice = (await profileOf(t, 'alice@example.com'))._id
    const bob = (await profileOf(t, 'bob@example.com'))._id
    await world.waiter.mutation(api.reservationGuests.update, { id: alice, tags: ['vip'] })
    await t.run((ctx) => ctx.db.patch(bob, { noShows: 2 }))

    expect((await listIds(world, { filter: 'vip' })).map((g) => g.name)).toEqual(['Alice Martin'])
    expect((await listIds(world, { filter: 'repeat_no_show' })).map((g) => g.name)).toEqual([
      'Bob Durand',
    ])
    // All three booked ten days out.
    expect(await listIds(world, { filter: 'upcoming' })).toHaveLength(3)
    const [first] = await listIds(world, { search: 'Alice' })
    expect(first).toMatchObject({ vip: true, repeatNoShow: false })
    expect(first!.nextVisitAt).toBeTypeOf('number')
  })

  test('the drawer: the profile with its bookings, newest first', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await book(t, world, { email: 'marie@example.com' })
    await book(t, world, { email: 'marie@example.com', date: dateIn(12) })
    const id = (await profileOf(t, 'marie@example.com'))._id
    const detail = await world.waiter.query(api.reservationGuests.get, { id })
    expect(detail?.history).toHaveLength(2)
    expect(detail!.history[0]!.startsAt).toBeGreaterThan(detail!.history[1]!.startsAt)
    expect(detail?.nextVisitAt).toBeTypeOf('number')
  })

  test('edits the host’s notes, tags and area, within limits', async () => {
    const t = newHarness()
    const world = await seedWorld(t, {
      rooms: [
        { name: 'Salle', tables: 2 },
        { name: 'Terrasse', tables: 2 },
      ],
    })
    await book(t, world)
    const id = (await profiles(t))[0]!._id

    await world.waiter.mutation(api.reservationGuests.update, {
      id,
      hostNotes: '  Table 12 préférée  ',
      tags: ['VIP', 'vip', ' Habitué ', 'a', 'b', 'c', 'd', 'e', 'f'],
      preferredRoomId: world.rooms.Salle,
    })
    expect((await profiles(t))[0]).toMatchObject({
      hostNotes: 'Table 12 préférée',
      // Deduplicated without case, trimmed, and cut at six.
      tags: ['VIP', 'Habitué', 'a', 'b', 'c', 'd'],
      preferredRoomId: world.rooms.Salle,
    })

    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGuests.update, { id, hostNotes: 'x'.repeat(501) }),
      ),
    ).toBe('invalid_input')
    await world.waiter.mutation(api.reservationGuests.update, { id, preferredRoomId: null })
    expect((await profiles(t))[0]!.preferredRoomId).toBeUndefined()
  })

  test('refuses a room from another establishment', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const other = await seedWorld(t, { rooms: [{ name: 'Ailleurs', tables: 1 }], profiles: false })
    await book(t, world)
    const id = (await profiles(t))[0]!._id
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGuests.update, {
          id,
          preferredRoomId: other.rooms.Ailleurs,
        }),
      ),
    ).toBe('invalid_input')
  })

  test('the day book is told of repeat no-shows and VIPs, and of nobody else', async () => {
    const t = newHarness()
    const world = await seedGuests(t)
    const bob = (await profileOf(t, 'bob@example.com'))._id
    const alice = (await profileOf(t, 'alice@example.com'))._id
    await t.run((ctx) => ctx.db.patch(bob, { noShows: 3 }))
    await world.waiter.mutation(api.reservationGuests.update, { id: alice, tags: ['VIP'] })

    const rows = await reservationRows(t)
    const flags = await world.waiter.query(api.reservationGuests.flags, {
      storeId: world.storeId,
      from: Math.min(...rows.map((r) => r.startsAt)) - 1,
      to: Math.max(...rows.map((r) => r.startsAt)) + 1,
    })
    expect(flags).toEqual({
      'bob@example.com': { noShows: 3, vip: false },
      'alice@example.com': { noShows: 0, vip: true },
    })
  })
})

describe('merging', () => {
  async function twoProfiles(t: Harness) {
    const world = await seedWorld(t, { looseTables: 4 })
    await book(t, world, { email: 'marie@example.com', name: 'Marie' })
    await book(t, world, { email: 'm.dupont@work.example', name: 'M. Dupont', date: dateIn(11) })
    const keep = await profileOf(t, 'marie@example.com')
    const drop = await profileOf(t, 'm.dupont@work.example')
    await t.run(async (ctx) => {
      await ctx.db.patch(keep._id, {
        visits: 2,
        covers: 4,
        noShows: 1,
        tags: ['VIP'],
        hostNotes: 'Aime la fenêtre',
      })
      await ctx.db.patch(drop._id, {
        visits: 1,
        covers: 2,
        noShows: 1,
        tags: ['Presse'],
        hostNotes: 'Allergique aux noix',
      })
    })
    return { world, keep, drop }
  }

  test('is a manager’s act: a waiter is refused', async () => {
    const t = newHarness()
    const { world, keep, drop } = await twoProfiles(t)
    await expect(
      world.waiter.mutation(api.reservationGuests.merge, { keepId: keep._id, dropId: drop._id }),
    ).rejects.toThrow()
    expect(await profiles(t)).toHaveLength(2)
    expect((await profiles(t)).every((p) => !p.mergedInto)).toBe(true)
  })

  test('adds the counters, unites tags and notes, and leaves one row in the list', async () => {
    const t = newHarness()
    const { world, keep, drop } = await twoProfiles(t)
    await world.manager.mutation(api.reservationGuests.merge, {
      keepId: keep._id,
      dropId: drop._id,
    })

    const merged = await t.run((ctx) => ctx.db.get(keep._id))
    expect(merged).toMatchObject({ bookings: 2, visits: 3, covers: 6, noShows: 2 })
    expect(merged!.tags).toEqual(['VIP', 'Presse'])
    expect(merged!.hostNotes).toBe('Aime la fenêtre\nAllergique aux noix')

    // The absorbed profile is a redirect holding an address and nothing else.
    const redirect = await t.run((ctx) => ctx.db.get(drop._id))
    expect(redirect).toMatchObject({
      mergedInto: keep._id,
      name: '',
      phone: '',
      visits: 0,
      tags: [],
    })
    expect(redirect!.hostNotes).toBeUndefined()

    const shown = await world.waiter.query(api.reservationGuests.list, { storeId: world.storeId })
    expect(shown.guests.map((g) => g.email)).toEqual(['marie@example.com'])
    // And the drawer shows the history of both addresses.
    const detail = await world.waiter.query(api.reservationGuests.get, { id: keep._id })
    expect(detail?.history).toHaveLength(2)
    expect(detail?.mergedAddresses).toEqual(['m.dupont@work.example'])
  })

  test('does not undo itself: a later booking under the absorbed address lands on the kept profile', async () => {
    const t = newHarness()
    const { world, keep, drop } = await twoProfiles(t)
    await world.manager.mutation(api.reservationGuests.merge, {
      keepId: keep._id,
      dropId: drop._id,
    })
    await book(t, world, { email: 'm.dupont@work.example', date: dateIn(13) })

    const rows = await profiles(t)
    expect(rows).toHaveLength(2)
    expect((await t.run((ctx) => ctx.db.get(keep._id)))!.bookings).toBe(3)
  })

  test('refuses itself, a merged profile, and a profile of another establishment', async () => {
    const t = newHarness()
    const { world, keep, drop } = await twoProfiles(t)
    const merge = (keepId: Id<'guestProfiles'>, dropId: Id<'guestProfiles'>) =>
      refusalCode(world.manager.mutation(api.reservationGuests.merge, { keepId, dropId }))
    expect(await merge(keep._id, keep._id)).toBe('invalid_input')
    await world.manager.mutation(api.reservationGuests.merge, {
      keepId: keep._id,
      dropId: drop._id,
    })
    expect(await merge(keep._id, drop._id)).toBe('invalid_input')

    const other = await seedWorld(t, { looseTables: 2, profiles: false })
    const stranger = await t.run((ctx) =>
      ctx.db.insert('guestProfiles', {
        storeId: other.storeId,
        email: 'z@example.com',
        name: 'Z',
        phone: '0600000000',
        firstSeenAt: 1,
        lastSeenAt: 1,
        bookings: 1,
        visits: 0,
        covers: 0,
        noShows: 0,
        cancellations: 0,
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    expect(await merge(keep._id, stranger)).toBe('invalid_input')
  })
})

describe('exporting', () => {
  test('is a manager’s: a waiter is refused, a manager gets every guest', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await book(t, world, { name: '=HYPERLINK("x")' })
    await expect(
      world.waiter.query(api.reservationGuests.exportAll, { storeId: world.storeId }),
    ).rejects.toThrow()

    const answer = await world.manager.query(api.reservationGuests.exportAll, {
      storeId: world.storeId,
    })
    expect(answer.truncated).toBe(false)
    expect(answer.guests).toHaveLength(1)
    expect(answer.timezone).toBe('Europe/Paris')
    // The sheet never carries what the guest typed about their health, nor the host's notes.
    expect(Object.keys(answer.guests[0]!)).not.toContain('hostNotes')
  })
})

describe('deleting an establishment', () => {
  test('takes its waitlist, its guest book and its bookings with it, and leaves the other house alone', async () => {
    const t = newHarness()
    const napoli = await seedWorld(t, { looseTables: 2 })
    const roma = await seedWorld(t, { looseTables: 2, profiles: false })
    for (const world of [napoli, roma]) {
      await book(t, world, { email: 'marie@example.com' })
      await t.run((ctx) =>
        ctx.db.insert('waitlistEntries', {
          storeId: world.storeId,
          source: 'online' as const,
          status: 'waiting' as const,
          guestName: 'Marie Dupont',
          guestEmail: 'marie@example.com',
          guestPhone: '0612345678',
          partySize: 2,
          date: dateIn(10),
          token: `token-${world.storeId}`,
          createdAt: 1,
          updatedAt: 1,
        }),
      )
    }
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'owner',
        role: 'super_admin' as const,
        storeIds: [napoli.storeId, roma.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    const owner = t.withIdentity({ subject: 'owner' })

    await owner.mutation(api.stores.remove, { id: napoli.storeId })

    const left = async (
      table: 'reservations' | 'reservationEvents' | 'waitlistEntries' | 'guestProfiles',
    ) => (await t.run((ctx) => ctx.db.query(table).collect())).map((row) => row.storeId)
    for (const table of [
      'reservations',
      'reservationEvents',
      'waitlistEntries',
      'guestProfiles',
    ] as const) {
      expect(await left(table), `${table} kept a row of the deleted establishment`).not.toContain(
        napoli.storeId,
      )
      expect(await left(table), `${table} lost a row of the surviving establishment`).toContain(
        roma.storeId,
      )
    }
  })
})
