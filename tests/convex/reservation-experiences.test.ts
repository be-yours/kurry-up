// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Limited-seat experiences.
 *
 * What is proved here is everything the SERVER decides: what an event may be and when it can
 * be published, that publishing holds the room and regular availability drops by exactly what
 * it holds, that seats are counted from the tickets' own rows so a later purchase sees the
 * earlier ones, what the money does (a full refund when the event is cancelled, the cut-off
 * for a guest), how a sold-out event tells a waiting guest once, and what an erasure and the
 * statistics do with a ticket. `convex-test` runs mutations one after the other and cannot
 * execute OCC, so the no-overselling argument is stated in the header of
 * `reservationExperiences.ts` and the tests prove the recomputation: a purchase made after
 * another sees its seats gone.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { wallClockToInstant } from '@be-yours/convex-schema'
import {
  DAY,
  NOW,
  bookSlot,
  createHarnessFactory,
  dateIn,
  eventRows,
  guest,
  openSlots,
  refusalCode,
  refusalMessage,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'
import {
  bookingByToken,
  dispatches,
  eraseFully,
  noticeKinds,
  payBooking,
  paymentRows,
  scheduled,
  seatAlertJobs,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const HOUR = 60 * 60_000

beforeEach(stubPaymentWorld)
afterEach(unstubPaymentWorld)

const instant = (days: number, time: string) =>
  wallClockToInstant(dateIn(days), time, 'Europe/Paris')!.at

/** Six tables of four in one room and a terrace of two, taking cards. */
async function experienceWorld(
  t: Harness,
  options: { capacityMode?: 'covers' | 'tables'; autoConfirm?: boolean } = {},
): Promise<World> {
  await setupGlobalSettings(t)
  return await seedWorld(t, {
    capacityMode: options.capacityMode ?? 'tables',
    autoConfirm: options.autoConfirm ?? true,
    rooms: [
      { name: 'Salle', tables: 6 },
      { name: 'Terrasse', tables: 2 },
    ],
  })
}

/** The fields of an event: a Saturday-evening tasting, after the first sitting is over. */
function fields(world: World, over: Record<string, unknown> = {}) {
  return {
    storeId: world.storeId,
    title: 'Soirée dégustation',
    description: 'Six vins, six assiettes.',
    startsAt: instant(14, '21:00'),
    endsAt: instant(14, '23:00'),
    seats: 12,
    priceCents: 6500,
    cancellationCutoffHours: 48,
    maxSeatsPerBooking: 6,
    ...over,
  }
}

async function createEvent(world: World, over: Record<string, unknown> = {}) {
  const { id } = await world.manager.mutation(
    api.reservationExperiences.saveExperience,
    fields(world, over) as never,
  )
  return id as Id<'reservationExperiences'>
}

async function publishedEvent(world: World, over: Record<string, unknown> = {}) {
  const id = await createEvent(world, over)
  await world.manager.mutation(api.reservationExperiences.publishExperience, { id })
  return id
}

const eventOf = (t: Harness, id: Id<'reservationExperiences'>) => t.run((ctx) => ctx.db.get(id))

async function buy(
  t: Harness,
  experienceId: Id<'reservationExperiences'>,
  extra: {
    seats?: number
    email?: string
    note?: string
    consent?: boolean
    idempotencyKey?: string
  } = {},
) {
  return await t.mutation(api.reservationExperiences.buy, {
    experienceId,
    seats: extra.seats ?? 2,
    guest: { ...guest, email: extra.email ?? guest.email },
    note: extra.note,
    consentNoticeVersion: 'v1',
    ...(extra.consent === false ? {} : { paymentConsent: true }),
    idempotencyKey: extra.idempotencyKey,
  })
}

async function ticketOf(t: Harness, token: string) {
  return (await bookingByToken(t, token))!
}

const tickets = (t: Harness) =>
  t.run((ctx) =>
    ctx.db
      .query('reservations')
      .collect()
      .then((rows) => rows.filter((row) => row.kind === 'experience')),
  )

const listed = (world: World) =>
  world.waiter.query(api.reservationExperiences.listExperiences, { storeId: world.storeId })

const publicList = (t: Harness, world: World) =>
  t.query(api.reservationExperiences.listPublic, { storeId: world.storeId })

/** A ticket for `seats`, paid, through the whole path a guest takes. */
async function paidTicket(
  t: Harness,
  experienceId: Id<'reservationExperiences'>,
  extra: Parameters<typeof buy>[2] = {},
) {
  const bought = await buy(t, experienceId, extra)
  await payBooking(t, bought.manageToken)
  return { ...bought, row: await ticketOf(t, bought.manageToken) }
}

/** Free tickets inserted directly, for the suites that need many. */
async function seedTickets(
  t: Harness,
  experience: Doc<'reservationExperiences'>,
  count: number,
  status: Doc<'reservations'>['status'] = 'confirmed',
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('reservations', {
        storeId: experience.storeId,
        reference: `RES-SEED-EXP-${i}`,
        status,
        startsAt: experience.startsAt,
        endsAt: experience.endsAt,
        partySize: 1,
        tableIds: [],
        kind: 'experience',
        experienceId: experience._id,
        guestName: `Invité ${i}`,
        guestEmail: `invite${i}@example.com`,
        guestPhone: '0600000000',
        channel: 'online',
        manageToken: `seed-exp-token-${String(i).padStart(6, '0')}`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/* Writing an event                                                    */
/* ------------------------------------------------------------------ */

describe('writing an event', () => {
  test('a draft is saved by the manager, holds nothing and is on sale for nobody', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await createEvent(world)
    const row = (await eventOf(t, id))!
    expect(row).toMatchObject({
      status: 'draft',
      holdTableIds: [],
      title: 'Soirée dégustation',
      seats: 12,
    })
    expect(await publicList(t, world)).toEqual([])
    // A draft takes nothing from regular availability.
    expect(await openSlots(t, world.storeId, 4, { date: dateIn(14) })).toHaveLength(4)
    const all = await listed(world)
    expect(all.experiences[0]).toMatchObject({
      status: 'draft',
      state: 'draft',
      seatsSold: 0,
      seatsLeft: 12,
    })
  })

  test('needs reservations:manage to write, and a waiter reads the list', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    await expect(
      world.waiter.mutation(api.reservationExperiences.saveExperience, fields(world) as never),
    ).rejects.toThrow()
    const id = await createEvent(world)
    await expect(
      world.waiter.mutation(api.reservationExperiences.publishExperience, { id }),
    ).rejects.toThrow()
    expect((await listed(world)).experiences).toHaveLength(1)
  })

  test('is refused, per field and with the sentence, when a figure is out of its bounds', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    expect(
      await refusalMessage(
        world.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(world, { title: '  ' }) as never,
        ),
      ),
    ).toMatch(/Donnez un nom/)
    expect(
      await refusalMessage(
        world.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(world, { seats: 0 }) as never,
        ),
      ),
    ).toMatch(/nombre de places/)
    expect(
      await refusalMessage(
        world.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(world, { priceCents: 60_000 }) as never,
        ),
      ),
    ).toMatch(/500 €/)
    expect(
      await refusalMessage(
        world.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(world, { endsAt: instant(14, '20:00') }) as never,
        ),
      ),
    ).toMatch(/après l'heure de début/)
    expect(
      await refusalMessage(
        world.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(world, { imageUrl: 'javascript:alert(1)' }) as never,
        ),
      ),
    ).toMatch(/adresse valide/)
    // Nothing the refusals above rejected was written.
    expect(await t.run((ctx) => ctx.db.query('reservationExperiences').collect())).toHaveLength(0)
    // A room is only for a deployment that draws its tables.
    const covers = newHarness()
    const coversWorld = await experienceWorld(covers, { capacityMode: 'covers' })
    expect(
      await refusalMessage(
        coversWorld.manager.mutation(
          api.reservationExperiences.saveExperience,
          fields(coversWorld, { roomId: coversWorld.rooms.Salle }) as never,
        ),
      ),
    ).toMatch(/plan de tables/)
  })

  test('is checked live, field by field, without saving anything', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const problems = await world.manager.query(api.reservationExperiences.checkExperience, {
      ...fields(world, { seats: 0, priceCents: -5 }),
    } as never)
    expect(problems.map((p) => p.field).sort()).toEqual(
      ['maxSeatsPerBooking', 'priceCents', 'seats'].sort(),
    )
    expect(await t.run((ctx) => ctx.db.query('reservationExperiences').collect())).toHaveLength(0)
    expect(
      await world.manager.query(api.reservationExperiences.checkExperience, fields(world) as never),
    ).toEqual([])
  })

  test('is edited in place, and an event of another establishment cannot be touched', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await createEvent(world)
    await world.manager.mutation(api.reservationExperiences.saveExperience, {
      ...fields(world, { title: 'Autre nom' }),
      id,
    } as never)
    expect((await eventOf(t, id))!.title).toBe('Autre nom')
    expect(await t.run((ctx) => ctx.db.query('reservationExperiences').collect())).toHaveLength(1)
    const other = await seedWorld(t, { looseTables: 2, profiles: false })
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'stranger',
        role: 'client_admin',
        storeIds: [other.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const stranger = t.withIdentity({ subject: 'stranger' })
    await expect(
      stranger.mutation(api.reservationExperiences.publishExperience, { id }),
    ).rejects.toThrow()
    await expect(
      stranger.mutation(api.reservationExperiences.saveExperience, {
        ...fields(world, { title: 'Pirate' }),
        id,
      } as never),
    ).rejects.toThrow()
    expect((await eventOf(t, id))!.title).toBe('Autre nom')
  })

  test('a draft that was never on sale is deleted; one that was is not', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const draft = await createEvent(world)
    await world.manager.mutation(api.reservationExperiences.removeExperience, { id: draft })
    expect(await eventOf(t, draft)).toBeNull()
    const live = await publishedEvent(world)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.removeExperience, { id: live }),
      ),
    ).toMatch(/Seul un brouillon/)
  })
})

/* ------------------------------------------------------------------ */
/* Publishing holds the room                                           */
/* ------------------------------------------------------------------ */

describe('publishing an event', () => {
  test('holds the tables that seat it, and regular availability drops by exactly that', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 12 })
    const row = (await eventOf(t, id))!
    expect(row.status).toBe('published')
    expect(row.holdTableIds).toHaveLength(3)

    // Eight tables of four, three of them held for the event: five can still be booked at
    // 20:30 (a sitting that runs into it) and the sixth party is refused.
    const slot = (await openSlots(t, world.storeId, 4, { date: dateIn(14) })).find(
      (s) => s.time === '20:30',
    )!
    let booked = 0
    for (let i = 0; i < 6; i++) {
      try {
        await t.mutation(api.reservations.create, {
          storeId: world.storeId,
          date: dateIn(14),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
          partySize: 4,
          guest: { ...guest, email: `p${i}@example.com` },
          consentNoticeVersion: 'v1',
        })
        booked += 1
      } catch (error) {
        expect(await refusalCode(Promise.reject(error))).toBe('slot_unavailable')
        break
      }
    }
    expect(booked).toBe(5)
    // The sitting that ended before the event began is untouched: all eight tables are open.
    const early = (await openSlots(t, world.storeId, 4, { date: dateIn(14) })).find(
      (s) => s.time === '19:00',
    )!
    expect(early).toBeDefined()
    // The held tables went to nobody else.
    const held = new Set(row.holdTableIds.map(String))
    const rows = await t.run((ctx) => ctx.db.query('reservations').collect())
    for (const booking of rows)
      expect(booking.tableIds.some((id) => held.has(String(id)))).toBe(false)
  })

  test('gives the room back when the event is taken off sale or cancelled', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const fill = async () =>
      (await openSlots(t, world.storeId, 4, { date: dateIn(14) })).find((s) => s.time === '20:30')
    const id = await publishedEvent(world, { seats: 24 })
    // 24 seats = six tables of the eight: only two remain.
    const slot = (await fill())!
    for (const email of ['a@example.com', 'b@example.com']) {
      await bookSlot(t, world, slot, { partySize: 4, date: dateIn(14), email })
    }
    expect(
      await refusalCode(
        bookSlot(t, world, slot, { partySize: 4, date: dateIn(14), email: 'c@example.com' }),
      ),
    ).toBe('slot_unavailable')
    await world.manager.mutation(api.reservationExperiences.unpublishExperience, { id })
    expect((await eventOf(t, id))!.holdTableIds).toEqual([])
    await expect(
      bookSlot(t, world, slot, { partySize: 4, date: dateIn(14), email: 'c@example.com' }),
    ).resolves.toBeDefined()
  })

  test('holds a whole room when the event has its own area, and refuses when a booking is in it', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const terrasse = await publishedEvent(world, { seats: 8, roomId: world.rooms.Terrasse })
    expect(new Set((await eventOf(t, terrasse))!.holdTableIds.map(String))).toEqual(
      new Set([String(world.tables['Terrasse 1']), String(world.tables['Terrasse 2'])]),
    )
    // A second event in the same area at the same time cannot hold it again.
    const second = await createEvent(world, {
      title: 'Autre',
      seats: 8,
      roomId: world.rooms.Terrasse,
    })
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationExperiences.publishExperience, { id: second }),
      ),
    ).toBe('experience_room_unavailable')

    // A booking in the room stops a new event there, and is named.
    const t2 = newHarness()
    const world2 = await experienceWorld(t2)
    const slot = (
      await openSlots(t2, world2.storeId, 2, {
        date: dateIn(14),
        roomPreference: world2.rooms.Terrasse,
      })
    ).find((s) => s.time === '20:30')!
    const booking = await bookSlot(t2, world2, slot, {
      partySize: 2,
      date: dateIn(14),
      roomPreference: world2.rooms.Terrasse,
    })
    const row = (await ticketOf(t2, booking.manageToken))!
    const id = await createEvent(world2, { seats: 8, roomId: world2.rooms.Terrasse })
    const message = await refusalMessage(
      world2.manager.mutation(api.reservationExperiences.publishExperience, { id }),
    )
    expect(message).toMatch(/Des réservations occupent déjà une table de cette salle/)
    expect(message).toContain(row.reference)
    expect((await eventOf(t2, id))!.status).toBe('draft')
  })

  test('refuses what the room cannot give, without moving a booking', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    // Seven of the eight tables are in use at 21:15 by bookings.
    const slot = (await openSlots(t, world.storeId, 4, { date: dateIn(14) })).find(
      (s) => s.time === '20:30',
    )!
    for (let i = 0; i < 7; i++) {
      await bookSlot(t, world, slot, { partySize: 4, date: dateIn(14), email: `p${i}@example.com` })
    }
    const before = await t.run((ctx) => ctx.db.query('reservations').collect())
    const id = await createEvent(world, { seats: 12 })
    const message = await refusalMessage(
      world.manager.mutation(api.reservationExperiences.publishExperience, { id }),
    )
    expect(message).toMatch(/ne suffisent pas/)
    expect(message).toMatch(/Réservations proches : RES-/)
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toEqual(before)
    expect((await eventOf(t, id))!.status).toBe('draft')
  })

  test('in covers mode holds seats under the ceiling, and drops what the public can book', async () => {
    const t = newHarness()
    const world = await experienceWorld(t, { capacityMode: 'covers' })
    const id = await publishedEvent(world, { seats: 14 })
    expect((await eventOf(t, id))!.holdTableIds).toEqual([])
    // The ceiling is 20 covers; 14 are held from 21:00, so 8 cannot sit from 20:30.
    const slots = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(14),
      partySize: 8,
    })
    expect(slots.find((s) => s.time === '20:30')).toMatchObject({
      available: false,
      reason: 'capacity',
    })
    expect(slots.find((s) => s.time === '19:00')!.available).toBe(true)
    const six = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(14),
      partySize: 6,
    })
    expect(six.find((s) => s.time === '20:30')!.available).toBe(true)
    // A booking made before the event, more than the ceiling leaves, refuses the event.
    const t2 = newHarness()
    const world2 = await experienceWorld(t2, { capacityMode: 'covers' })
    const slot = (await openSlots(t2, world2.storeId, 8, { date: dateIn(14) })).find(
      (s) => s.time === '20:30',
    )!
    await bookSlot(t2, world2, slot, { partySize: 8, date: dateIn(14) })
    const big = await createEvent(world2, { seats: 14 })
    expect(
      await refusalMessage(
        world2.manager.mutation(api.reservationExperiences.publishExperience, { id: big }),
      ),
    ).toMatch(/couverts libres/)
  })

  test('is not sellable without a way to be paid, unless it is free', async () => {
    const t = newHarness()
    await setupGlobalSettings(t, { cardProvider: 'none', paypal: false })
    const world = await seedWorld(t, { looseTables: 8 })
    const paid = await createEvent(world)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.publishExperience, { id: paid }),
      ),
    ).toMatch(/ne pas accepter les cartes/)
    const free = await createEvent(world, { title: 'Dégustation offerte', priceCents: 0 })
    await expect(
      world.manager.mutation(api.reservationExperiences.publishExperience, { id: free }),
    ).resolves.toBeDefined()
    expect((await eventOf(t, free))!.status).toBe('published')
  })

  test('is refused for a date already past, and cannot be published twice or after it was cancelled', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const past = await createEvent(world, {
      startsAt: NOW - 3 * DAY,
      endsAt: NOW - 3 * DAY + 2 * HOUR,
    })
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.publishExperience, { id: past }),
      ),
    ).toMatch(/déjà terminé/)
    const id = await publishedEvent(world)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.publishExperience, { id }),
      ),
    ).toMatch(/déjà en vente/)
    await world.manager.mutation(api.reservationExperiences.cancelExperience, { id })
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.publishExperience, { id }),
      ),
    ).toMatch(/annulé/)
  })

  test('a move of a booking onto a table the event holds is refused, naming the event', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 12 })
    const held = (await eventOf(t, id))!.holdTableIds[0]!
    const slot = (await openSlots(t, world.storeId, 2, { date: dateIn(14) })).find(
      (s) => s.time === '20:30',
    )!
    const booked = await bookSlot(t, world, slot, { partySize: 2, date: dateIn(14) })
    const row = (await ticketOf(t, booked.manageToken))!
    const message = await refusalMessage(
      world.waiter.mutation(api.reservations.moveTables, { id: row._id, tableIds: [held] }),
    )
    expect(message).toMatch(/Soirée dégustation/)
  })
})

/* ------------------------------------------------------------------ */
/* What the guest sees                                                 */
/* ------------------------------------------------------------------ */

describe('what the booking page lists', () => {
  test('is the published events with their seats left as a plain number', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await createEvent(world, { title: 'Brouillon' })
    const cards = await publicList(t, world)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: String(id),
      title: 'Soirée dégustation',
      seats: 12,
      seatsLeft: 12,
      priceCents: 6500,
      free: false,
      currency: 'EUR',
      state: 'on_sale',
      maxSeatsPerBooking: 6,
    })
    // Nothing of who bought, nothing of the room it holds.
    expect(JSON.stringify(cards)).not.toMatch(/holdTableIds|guest|email|token/i)
  })

  test('says sold out when no seat is left, and the seats a guest may still ask for are what is left', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 5, maxSeatsPerBooking: 4 })
    // Paid: seats waiting for a payment are capped per event, and this test is about sold seats.
    await paidTicket(t, id, { seats: 3 })
    let [card] = await publicList(t, world)
    expect(card).toMatchObject({ seatsLeft: 2, state: 'on_sale', maxSeatsPerBooking: 2 })
    await paidTicket(t, id, { seats: 2, email: 'b@example.com' })
    ;[card] = await publicList(t, world)
    expect(card).toMatchObject({ seatsLeft: 0, state: 'sold_out', maxSeatsPerBookingLimit: 4 })
  })

  test('shows an event whose sales have not opened, and hides one that is closed, past or cancelled', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    await publishedEvent(world, {
      title: 'Bientôt',
      salesOpensAt: NOW + 2 * DAY,
      salesClosesAt: instant(13, '12:00'),
    })
    const closed = await publishedEvent(world, {
      title: 'Fermé',
      startsAt: instant(20, '21:00'),
      endsAt: instant(20, '23:00'),
    })
    await t.run((ctx) => ctx.db.patch(closed, { salesClosesAt: NOW - HOUR }))
    const cancelled = await publishedEvent(world, {
      title: 'Annulé',
      startsAt: instant(22, '21:00'),
      endsAt: instant(22, '23:00'),
    })
    await world.manager.mutation(api.reservationExperiences.cancelExperience, { id: cancelled })
    const titles = (await publicList(t, world)).map((c) => `${c.title}:${c.state}`)
    expect(titles).toEqual(['Bientôt:upcoming'])
  })

  test('is empty while online booking is off', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    await publishedEvent(world)
    await t.run((ctx) => ctx.db.patch(world.storeId, { reservationMode: 'off' }))
    expect(await publicList(t, world)).toEqual([])
  })

  test('quotes the price in words and the ways to pay, before anything is submitted', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const quote = await t.query(api.reservationExperiences.getPurchaseQuote, {
      experienceId: id,
      seats: 3,
    })
    expect(quote).toMatchObject({
      free: false,
      totalCents: 19_500,
      currency: 'EUR',
      payable: true,
      refusal: null,
    })
    if (quote.free) throw new Error('expected a paid quote')
    expect(quote.lines[0]).toMatch(/prix de vos places/)
    expect(quote.consentLabel).toMatch(/prix de mes places/)
    expect(quote.providers.map((p) => p.provider)).toEqual(['stripe'])
    expect(
      (await t.query(api.reservationExperiences.getPurchaseQuote, { experienceId: id, seats: 7 }))
        .refusal,
    ).toMatch(/pas réserver autant/)
    const free = await publishedEvent(world, {
      title: 'Offert',
      priceCents: 0,
      startsAt: instant(15, '21:00'),
      endsAt: instant(15, '23:00'),
    })
    expect(
      await t.query(api.reservationExperiences.getPurchaseQuote, { experienceId: free, seats: 2 }),
    ).toMatchObject({ free: true, totalCents: 0 })
  })
})

/* ------------------------------------------------------------------ */
/* Buying                                                              */
/* ------------------------------------------------------------------ */

describe('buying seats', () => {
  test('a paid ticket is held awaiting its payment, with the whole price as terms, and takes no table', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const before = await openSlots(t, world.storeId, 4, { date: dateIn(14) })
    const bought = await buy(t, id, { seats: 3, note: 'Allergie aux noix' })
    expect(bought.status).toBe('pending_payment')
    expect(bought.holdExpiresAt).toBeGreaterThan(Date.now())
    const row = await ticketOf(t, bought.manageToken)
    expect(row).toMatchObject({
      kind: 'experience',
      experienceId: id,
      partySize: 3,
      startsAt: (await eventOf(t, id))!.startsAt,
      endsAt: (await eventOf(t, id))!.endsAt,
      tableIds: [],
      guestNote: 'Allergie aux noix',
      channel: 'online',
      status: 'pending_payment',
    })
    expect(row.serviceId).toBeUndefined()
    expect(row.paymentTerms).toMatchObject({
      kind: 'deposit',
      depositCents: 19_500,
      freeCancellationHours: 48,
      currency: 'EUR',
      purpose: 'experience',
    })
    expect(row.paymentTerms!.consentedAt).toBeGreaterThan(0)
    // The ticket holds no capacity of its own: what the public can book did not move.
    expect(await openSlots(t, world.storeId, 4, { date: dateIn(14) })).toEqual(before)
    // Nothing is said until it is paid.
    expect(await noticeKinds(t)).toEqual([])
    expect((await eventRows(t)).map((e) => e.note)).toContain('experience_purchased')
  })

  test('is confirmed by the provider’s word alone, whatever the house’s confirmation mode, and is mailed', async () => {
    const t = newHarness()
    const world = await experienceWorld(t, { autoConfirm: false })
    const id = await publishedEvent(world)
    const bought = await buy(t, id, { seats: 2 })
    const paid = await payBooking(t, bought.manageToken)
    expect(paid).toMatchObject({ kind: 'deposit', amount: 13_000, status: 'succeeded' })
    const row = await ticketOf(t, bought.manageToken)
    expect(row.status).toBe('confirmed')
    expect(row.paymentCollectedAt).toBeGreaterThan(0)
    expect(await noticeKinds(t)).toEqual(['confirmed'])
    const view = (await t.query(api.reservations.getByToken, { token: bought.manageToken }))!
    expect(view.kind).toBe('experience')
    expect(view.experience).toMatchObject({ title: 'Soirée dégustation', cancelled: false })
    expect(view.partySize).toBe(2)
    expect(view.canModify).toBe(false)
  })

  test('a free event is confirmed on the spot, with no terms and no payment', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { priceCents: 0 })
    const bought = await buy(t, id, { seats: 4, consent: false })
    expect(bought.status).toBe('confirmed')
    const row = await ticketOf(t, bought.manageToken)
    expect(row.paymentTerms).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['confirmed'])
    expect(await paymentRows(t)).toHaveLength(0)
  })

  test('counts the seats from the tickets in this transaction, so a later purchase sees the earlier ones', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 5, maxSeatsPerBooking: 4 })
    await paidTicket(t, id, { seats: 4 })
    // One seat left: two are refused, one is sold, and the next is sold out.
    expect(await refusalCode(buy(t, id, { seats: 2, email: 'b@example.com' }))).toBe(
      'experience_sold_out',
    )
    await buy(t, id, { seats: 1, email: 'c@example.com' })
    expect(await refusalCode(buy(t, id, { seats: 1, email: 'd@example.com' }))).toBe(
      'experience_sold_out',
    )
    expect(await refusalMessage(buy(t, id, { seats: 1, email: 'd@example.com' }))).toMatch(
      /complet/,
    )
    expect((await tickets(t)).reduce((sum, row) => sum + row.partySize, 0)).toBe(5)
  })

  test('gives seats back when an unpaid hold lapses, a guest cancels, or the host cancels a ticket', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    const first = await buy(t, id, { seats: 4 })
    expect(await refusalCode(buy(t, id, { seats: 1, email: 'b@example.com' }))).toBe(
      'experience_sold_out',
    )
    // The hold runs out: the sweep expires the ticket and the seats go back on sale.
    const row = await ticketOf(t, first.manageToken)
    await t.run((ctx) => ctx.db.patch(row._id, { paymentHoldExpiresAt: Date.now() - 1 }))
    const lapsed = await t.query(internal.reservationPayments.lapsedHolds, {})
    await t.mutation(internal.reservationPayments.expireLapsed, {
      reservationIds: lapsed.map((l) => l.reservationId as Id<'reservations'>),
    })
    expect((await ticketOf(t, first.manageToken)).status).toBe('expired')
    const second = await buy(t, id, { seats: 4, email: 'b@example.com' })
    await payBooking(t, second.manageToken)
    expect(await refusalCode(buy(t, id, { seats: 1, email: 'c@example.com' }))).toBe(
      'experience_sold_out',
    )
    // The guest cancels in time: seats back.
    await t.mutation(api.reservations.cancelByToken, { token: second.manageToken })
    await expect(buy(t, id, { seats: 1, email: 'c@example.com' })).resolves.toBeDefined()
  })

  test('is refused before the sales open, after they close, for a draft, and for a cancelled event', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const soon = await publishedEvent(world, { salesOpensAt: NOW + 2 * DAY })
    expect(await refusalCode(buy(t, soon))).toBe('experience_unavailable')
    const closed = await publishedEvent(world, {
      title: 'Fermé',
      startsAt: instant(20, '21:00'),
      endsAt: instant(20, '23:00'),
    })
    await t.run((ctx) => ctx.db.patch(closed, { salesClosesAt: NOW - HOUR }))
    expect(await refusalCode(buy(t, closed))).toBe('experience_unavailable')
    const draft = await createEvent(world, {
      title: 'Brouillon',
      startsAt: instant(21, '21:00'),
      endsAt: instant(21, '23:00'),
    })
    expect(await refusalCode(buy(t, draft))).toBe('experience_unavailable')
    const open = await publishedEvent(world, {
      title: 'Ouvert',
      startsAt: instant(22, '21:00'),
      endsAt: instant(22, '23:00'),
    })
    await world.manager.mutation(api.reservationExperiences.cancelExperience, { id: open })
    expect(await refusalCode(buy(t, open))).toBe('experience_unavailable')
    expect(await tickets(t)).toHaveLength(0)
  })

  test('is bounded: seats per booking, a whole number of seats, the consent, the field caps and the rate', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { maxSeatsPerBooking: 3 })
    expect(await refusalCode(buy(t, id, { seats: 4 }))).toBe('invalid_input')
    expect(await refusalCode(buy(t, id, { seats: 0 }))).toBe('invalid_input')
    expect(await refusalCode(buy(t, id, { seats: 1.5 }))).toBe('invalid_input')
    // The price is not agreed to: nothing is written.
    expect(await refusalCode(buy(t, id, { consent: false }))).toBe('payment_consent_required')
    expect(
      await refusalCode(
        t.mutation(api.reservationExperiences.buy, {
          experienceId: id,
          seats: 1,
          guest,
          consentNoticeVersion: 'v0',
          paymentConsent: true,
        }),
      ),
    ).toBe('consent_required')
    await expect(buy(t, id, { note: 'x'.repeat(501), email: 'z@example.com' })).rejects.toThrow()
    expect(await refusalCode(buy(t, id, { email: 'pas-une-adresse' }))).toBe('invalid_input')
    expect(await tickets(t)).toHaveLength(0)
    // Five an hour for one address.
    for (let i = 0; i < 5; i++) await buy(t, id, { seats: 1, email: 'same@example.com' })
    await expect(buy(t, id, { seats: 1, email: 'same@example.com' })).rejects.toThrow()
  })

  test('refuses a paid ticket when no provider can take the payment, and the same key is the same ticket', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const first = await buy(t, id, { idempotencyKey: 'k1' })
    const again = await buy(t, id, { idempotencyKey: 'k1' })
    expect(again.manageToken).toBe(first.manageToken)
    expect(await tickets(t)).toHaveLength(1)
    // The provider disappears after publication: the purchase is refused, not taken.
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(await refusalCode(buy(t, id, { email: 'late@example.com' }))).toBe('payment_unavailable')
  })

  test('opens the payment through the booking machinery and settles it once, in any order', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const bought = await buy(t, id, { seats: 2 })
    const page = (await t.query(api.reservationPayments.getPaymentPage, {
      token: bought.manageToken,
    }))!
    expect(page).toMatchObject({
      kind: 'experience',
      purpose: 'experience',
      canPay: true,
      amountDueCents: 13_000,
    })
    // The terms were agreed on the purchase form: no second agreement is asked.
    expect(page.consentLabel).toBeNull()
    const paid = await payBooking(t, bought.manageToken)
    expect(paid.status).toBe('succeeded')
    expect(await paymentRows(t)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* Cancelling                                                          */
/* ------------------------------------------------------------------ */

describe('cancelling a ticket', () => {
  test('before the event’s own cut-off a guest is refunded in full, automatically', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { cancellationCutoffHours: 48 })
    const { manageToken } = await paidTicket(t, id, { seats: 2 })
    const view = (await t.query(api.reservations.getByToken, { token: manageToken }))!
    expect(view.canCancel).toBe(true)
    const result = await t.mutation(api.reservations.cancelByToken, { token: manageToken })
    expect(result.status).toBe('cancelled_by_guest')
    expect((await dispatches(t)).filter((d) => d.type === 'refund')).toEqual([
      expect.objectContaining({ amount: 13_000 }),
    ])
  })

  test('after the cut-off a guest can no longer cancel online, and the price is kept', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { cancellationCutoffHours: 48 })
    const { manageToken, row } = await paidTicket(t, id, { seats: 2 })
    // The event is now a day away.
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { startsAt: Date.now() + 24 * HOUR, endsAt: Date.now() + 27 * HOUR })
      await ctx.db.patch(row._id, {
        startsAt: Date.now() + 24 * HOUR,
        endsAt: Date.now() + 27 * HOUR,
      })
    })
    const view = (await t.query(api.reservations.getByToken, { token: manageToken }))!
    expect(view.canCancel).toBe(false)
    expect(
      await refusalCode(t.mutation(api.reservations.cancelByToken, { token: manageToken })),
    ).toBe('cancellation_closed')
    // A cancellation the team records as the guest's keeps the money.
    await world.waiter.mutation(api.reservations.setStatus, {
      id: row._id,
      to: 'cancelled_by_guest',
    })
    expect(await dispatches(t)).toEqual([])
  })

  test('a free ticket follows the event’s cut-off, not the house’s general deadline', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { priceCents: 0, cancellationCutoffHours: 72 })
    const bought = await buy(t, id, { seats: 2, consent: false })
    let view = (await t.query(api.reservations.getByToken, { token: bought.manageToken }))!
    expect(view.canCancel).toBe(true)
    const row = await ticketOf(t, bought.manageToken)
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { startsAt: Date.now() + 60 * HOUR, endsAt: Date.now() + 63 * HOUR })
      await ctx.db.patch(row._id, {
        startsAt: Date.now() + 60 * HOUR,
        endsAt: Date.now() + 63 * HOUR,
      })
    })
    view = (await t.query(api.reservations.getByToken, { token: bought.manageToken }))!
    expect(view.canCancel).toBe(false)
  })

  test('is never an edit: a ticket cannot be modified from its link', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const { manageToken } = await paidTicket(t, id)
    const slot = (await openSlots(t, world.storeId, 2, { date: dateIn(14) }))[0]!
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token: manageToken,
          date: dateIn(14),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
          partySize: 3,
        }),
      ),
    ).toBe('change_closed')
  })
})

describe('cancelling the whole event', () => {
  test('cancels every ticket as the establishment’s, refunds every paid one in full and mails each guest', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const free = await buy(t, id, { seats: 1, email: 'unpaid@example.com' })
    const first = await paidTicket(t, id, { seats: 2, email: 'a@example.com' })
    await paidTicket(t, id, { seats: 3, email: 'b@example.com' })
    const result = await world.manager.mutation(api.reservationExperiences.cancelExperience, {
      id,
      reason: 'Le chef est souffrant.',
    })
    expect(result).toMatchObject({ cancelled: 3, hasMore: false })
    const event = (await eventOf(t, id))!
    expect(event).toMatchObject({
      status: 'cancelled',
      holdTableIds: [],
      cancelReason: 'Le chef est souffrant.',
    })
    for (const row of await tickets(t)) expect(row.status).toBe('cancelled_by_restaurant')
    // Both paid tickets are refunded in full; the unpaid one only closes its open page.
    const refunds = (await dispatches(t))
      .filter((d) => d.type === 'refund')
      .map((d) => d.amount)
      .sort()
    expect(refunds).toEqual([13_000, 19_500])
    expect(
      (await noticeKinds(t)).filter((kind) => kind === 'cancelled_by_restaurant'),
    ).toHaveLength(3)
    expect((await ticketOf(t, free.manageToken)).status).toBe('cancelled_by_restaurant')
    const view = (await t.query(api.reservations.getByToken, { token: first.manageToken }))!
    expect(view.experience).toMatchObject({
      cancelled: true,
      cancelReason: 'Le chef est souffrant.',
    })
    // The room is the public's again.
    const slot = (await openSlots(t, world.storeId, 4, { date: dateIn(14) })).find(
      (s) => s.time === '20:30',
    )!
    for (let i = 0; i < 8; i++) {
      await bookSlot(t, world, slot, { partySize: 4, date: dateIn(14), email: `p${i}@example.com` })
    }
  })

  test('tells the guests why, and nothing is kept: a refund follows a refusal of the provider, not a guess', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await paidTicket(t, id, { seats: 2 })
    await world.manager.mutation(api.reservationExperiences.cancelExperience, {
      id,
      reason: 'Imprévu',
    })
    // Nothing is `refunded` until the provider confirms: only the request is made.
    const rows = await paymentRows(t)
    expect(rows.filter((row) => row.kind === 'refund')).toHaveLength(0)
    expect((await dispatches(t)).filter((d) => d.type === 'refund')).toHaveLength(1)
  })

  test('takes a large event in batches, so one transaction never writes them all', async () => {
    const t = newHarness()
    const world = await experienceWorld(t, { capacityMode: 'covers' })
    const id = await publishedEvent(world, { seats: 20, maxSeatsPerBooking: 6 })
    // A large event: more seats than the room's own ceiling, as a hall would sell.
    await t.run((ctx) => ctx.db.patch(id, { seats: 200 }))
    await seedTickets(t, (await eventOf(t, id))!, 130)
    const first = await world.manager.mutation(api.reservationExperiences.cancelExperience, { id })
    expect(first).toMatchObject({ cancelled: 60, hasMore: true })
    // The app schedules the rest, a second on.
    expect(
      (await scheduled(t)).filter((job) =>
        job.name.endsWith('reservationExperiences:cancelTickets'),
      ),
    ).toHaveLength(1)
    const second = await t.mutation(internal.reservationExperiences.cancelTickets, { id })
    expect(second).toMatchObject({ cancelled: 60 })
    const third = await t.mutation(internal.reservationExperiences.cancelTickets, { id })
    expect(third).toMatchObject({ cancelled: 10 })
    const rest = await t.mutation(internal.reservationExperiences.cancelTickets, { id })
    expect(rest).toMatchObject({ cancelled: 0 })
    for (const row of await tickets(t)) expect(row.status).toBe('cancelled_by_restaurant')
  })

  test('leaves a party already seated alone, refuses a draft, an event that is over, and a stranger', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const draft = await createEvent(world, {
      title: 'Brouillon',
      startsAt: instant(30, '21:00'),
      endsAt: instant(30, '23:00'),
    })
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.cancelExperience, { id: draft }),
      ),
    ).toMatch(/supprimez-le/)
    const seated = await paidTicket(t, id, { seats: 2 })
    await t.run((ctx) => ctx.db.patch(seated.row._id, { status: 'seated' }))
    const result = await world.manager.mutation(api.reservationExperiences.cancelExperience, { id })
    expect(result.cancelled).toBe(0)
    expect((await ticketOf(t, seated.manageToken)).status).toBe('seated')
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.cancelExperience, { id }),
      ),
    ).toMatch(/déjà annulé/)
    await expect(
      world.waiter.mutation(api.reservationExperiences.cancelExperience, { id: draft }),
    ).rejects.toThrow()
  })

  test('cannot be unpublished once a seat is sold, but can be before', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await buy(t, id, { seats: 1 })
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationExperiences.unpublishExperience, { id }),
      ),
    ).toMatch(/Annulez-le/)
    const empty = await publishedEvent(world, {
      title: 'Vide',
      startsAt: instant(20, '21:00'),
      endsAt: instant(20, '23:00'),
    })
    await world.manager.mutation(api.reservationExperiences.unpublishExperience, { id: empty })
    expect((await eventOf(t, empty))!.status).toBe('draft')
  })
})

/* ------------------------------------------------------------------ */
/* Editing a live event                                                */
/* ------------------------------------------------------------------ */

describe('editing an event that is on sale', () => {
  test('cannot rewrite what guests have bought: the price, the time, fewer seats than sold', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await buy(t, id, { seats: 4 })
    const save = (over: Record<string, unknown>) =>
      world.manager.mutation(api.reservationExperiences.saveExperience, {
        ...fields(world, over),
        id,
      } as never)
    expect(await refusalMessage(save({ priceCents: 5000 }))).toMatch(/le prix ne peut plus changer/)
    expect(await refusalMessage(save({ startsAt: instant(14, '21:30') }))).toMatch(/horaire/)
    expect(await refusalMessage(save({ seats: 3 }))).toMatch(/4 places sont déjà vendues/)
    // The words, the image and the cut-off stay editable.
    await save({ title: 'Nouveau nom', description: 'Autre texte', cancellationCutoffHours: 24 })
    expect(await eventOf(t, id)).toMatchObject({
      title: 'Nouveau nom',
      cancellationCutoffHours: 24,
    })
  })

  test('an edit that empties an optional field removes the stored value', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await createEvent(world, {
      imageUrl: 'https://cdn.example/x.webp',
      salesOpensAt: NOW + DAY,
      salesClosesAt: instant(13, '12:00'),
      roomId: world.rooms.Terrasse,
      seats: 8,
    })
    expect(await eventOf(t, id)).toMatchObject({ imageUrl: 'https://cdn.example/x.webp' })
    await world.manager.mutation(api.reservationExperiences.saveExperience, {
      ...fields(world, { seats: 8 }),
      id,
    } as never)
    const row = (await eventOf(t, id))!
    expect(row.imageUrl).toBeUndefined()
    expect(row.salesOpensAt).toBeUndefined()
    expect(row.salesClosesAt).toBeUndefined()
    expect(row.roomId).toBeUndefined()
  })

  test('re-plans the hold when the seats change, and refuses when the room cannot give more', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    expect((await eventOf(t, id))!.holdTableIds).toHaveLength(1)
    await world.manager.mutation(api.reservationExperiences.saveExperience, {
      ...fields(world, { seats: 12 }),
      id,
    } as never)
    expect((await eventOf(t, id))!.holdTableIds).toHaveLength(3)
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationExperiences.saveExperience, {
          ...fields(world, { seats: 40 }),
          id,
        } as never),
      ),
    ).toBe('experience_room_unavailable')
    expect((await eventOf(t, id))!.seats).toBe(12)
  })
})

/* ------------------------------------------------------------------ */
/* The attendees                                                       */
/* ------------------------------------------------------------------ */

describe('the attendee list', () => {
  test('shows who bought, how many, what is paid or refunded, and what they asked', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await paidTicket(t, id, { seats: 2, email: 'a@example.com', note: 'Sans gluten' })
    await buy(t, id, { seats: 1, email: 'b@example.com' })
    const list = await world.waiter.query(api.reservationExperiences.listAttendees, { id })
    expect(list.truncated).toBe(false)
    expect(list.event).toMatchObject({ seats: 12, seatsSold: 3, seatsLeft: 9 })
    expect(list.attendees).toHaveLength(2)
    const [paid, unpaid] = list.attendees
    expect(paid).toMatchObject({
      guestEmail: 'a@example.com',
      seats: 2,
      status: 'confirmed',
      note: 'Sans gluten',
      payment: {
        state: 'paid',
        label: 'Places payées',
        paidCents: 13_000,
        refundedCents: 0,
        totalCents: 13_000,
      },
    })
    expect(unpaid).toMatchObject({
      seats: 1,
      status: 'pending_payment',
      payment: { label: 'Paiement en attente', paidCents: 0 },
    })
    expect(list.seatsByStatus).toEqual({ confirmed: 2, pending_payment: 1 })
  })

  test('marks a ticket the way a booking is marked, through the day book’s own actions', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const { row } = await paidTicket(t, id, { seats: 2 })
    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'arrived' })
    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'seated' })
    await world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'completed' })
    const [attendee] = (await world.waiter.query(api.reservationExperiences.listAttendees, { id }))
      .attendees
    expect(attendee!.status).toBe('completed')
    // A completed ticket stays sold: seats do not flicker back on sale.
    expect((await publicList(t, world))[0]!.seatsLeft).toBe(10)
  })

  test('is exported as a CSV by the manager only, safe to open in a spreadsheet', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await t.mutation(api.reservationExperiences.buy, {
      experienceId: id,
      seats: 2,
      guest: { name: '=HYPERLINK("http://x")', email: 'x@example.com', phone: '0612345678' },
      note: '+cmd',
      consentNoticeVersion: 'v1',
      paymentConsent: true,
    })
    await expect(
      world.waiter.query(api.reservationExperiences.exportAttendees, { id }),
    ).rejects.toThrow()
    const out = await world.manager.query(api.reservationExperiences.exportAttendees, { id })
    expect(out.truncated).toBe(false)
    expect(out.filename).toBe(`event-soiree-degustation-${dateIn(14)}.csv`)
    const lines = out.csv.trim().split('\r\n')
    expect(lines[0]).toBe(
      'Référence,Nom,E-mail,Téléphone,Places,Statut,Paiement,Payé (€),Remboursé (€),Demande du client,Réservé le',
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"\'=HYPERLINK(""http://x"")"')
    expect(lines[1]).toContain("'+cmd")
    expect(lines[1]).toContain('Paiement en attente')
  })
})

/* ------------------------------------------------------------------ */
/* « Me prévenir »                                                      */
/* ------------------------------------------------------------------ */

describe('being told that seats came back', () => {
  const alert = (
    t: Harness,
    id: Id<'reservationExperiences'>,
    over: Record<string, unknown> = {},
  ) =>
    t.mutation(api.reservationExperiences.joinAlert, {
      experienceId: id,
      guest: { name: 'Léa Martin', email: 'lea@example.com' },
      partySize: 2,
      noticeVersion: 'fr-2026-10',
      ...over,
    } as never)

  async function soldOut(world: World, t: Harness) {
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    const full = await paidTicket(t, id, { seats: 4, email: 'full@example.com' })
    return { id, full }
  }

  test('is refused while seats are on sale for the party, and for a version nobody wrote', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    expect(await refusalMessage(alert(t, id))).toMatch(/réserver directement/)
    await buy(t, id, { seats: 3 })
    // One seat left: a party of two is told, a party of one is not.
    await expect(alert(t, id)).resolves.toEqual({ joined: true })
    expect(
      await refusalMessage(
        alert(t, id, { partySize: 1, guest: { name: 'x', email: 'x@example.com' } }),
      ),
    ).toMatch(/réserver directement/)
    expect(await refusalCode(alert(t, id, { noticeVersion: 'invented' }))).toBe('consent_required')
  })

  test('is kept on the waitlist’s own table, with no hold, no offer and nothing on the day’s queue', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id } = await soldOut(world, t)
    await alert(t, id)
    const entries = await t.run((ctx) => ctx.db.query('waitlistEntries').collect())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      status: 'waiting',
      experienceId: id,
      guestEmail: 'lea@example.com',
      partySize: 2,
      privacyNoticeVersion: 'fr-2026-10',
    })
    expect(entries[0]!.heldSlot).toBeUndefined()
    expect(entries[0]!.date).toBe(dateIn(14))
    // The day's panel for tables never lists it, and the table matcher never offers it a table.
    const day = await world.waiter.query(api.reservationWaitlist.list, {
      storeId: world.storeId,
      date: dateIn(14),
    })
    expect(day).toEqual([])
    await t.mutation(internal.reservationStats.sweepDirty, {})
    const waitlistStats = await t.run(async (ctx) =>
      (await ctx.db.query('reservationStatsDaily').collect()).map((r) => r.waitlistJoined),
    )
    expect(waitlistStats.every((n) => n === 0)).toBe(true)
  })

  test('keeps one place per address, and its words, whatever a repeat says', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id } = await soldOut(world, t)
    await alert(t, id)
    await alert(t, id, { partySize: 3 })
    const entries = await t.run((ctx) => ctx.db.query('waitlistEntries').collect())
    expect(entries).toHaveLength(1)
    expect(entries[0]!.partySize).toBe(2)
  })

  test('mails the guests whose party fits, in the order they asked, once, when seats came back', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id, full } = await soldOut(world, t)
    for (const [name, email, partySize] of [
      ['Ana', 'ana@example.com', 3],
      ['Ben', 'ben@example.com', 1],
      ['Cléo', 'cleo@example.com', 2],
    ] as const) {
      await alert(t, id, { guest: { name, email }, partySize })
    }
    // Nothing yet: the event is still full.
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 0,
    })
    // Two seats come back (the guest of 4 cancels, another buys two): two seats left.
    await t.mutation(api.reservations.cancelByToken, { token: full.manageToken })
    await paidTicket(t, id, { seats: 2, email: 'other@example.com' })
    const run = await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})
    // Two seats: Ana (3) does not fit and is skipped, Ben (1) takes one, Cléo (2) does not
    // fit what is left (1) — one seat, one guest.
    expect(run.mailed).toBe(1)
    const entries = await t.run((ctx) => ctx.db.query('waitlistEntries').collect())
    const byName = Object.fromEntries(entries.map((e) => [e.guestName, e]))
    expect(byName.Ben).toMatchObject({ status: 'expired' })
    expect(byName.Ben!.notifiedAt).toBeGreaterThan(0)
    expect(byName.Ana).toMatchObject({ status: 'waiting' })
    expect(byName.Cléo).toMatchObject({ status: 'waiting' })
    expect(await seatAlertJobs(t)).toHaveLength(1)
    // A second run mails nobody twice: the seat Ben was told about is spoken for for an hour,
    // and the one left does not fit Cléo's two.
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 0,
    })
    expect(await seatAlertJobs(t)).toHaveLength(1)
    // An hour on, Ben has not bought: the next guest whose party fits is told.
    await t.run((ctx) => ctx.db.patch(byName.Ben!._id, { notifiedAt: Date.now() - 2 * HOUR }))
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 1,
    })
    expect((await t.run((ctx) => ctx.db.get(byName.Cléo!._id)))!.status).toBe('expired')
  })

  test('mails nobody when the sale is closed or the event cancelled, and closes the waiting alerts', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id, full } = await soldOut(world, t)
    await alert(t, id)
    await t.mutation(api.reservations.cancelByToken, { token: full.manageToken })
    await t.run((ctx) => ctx.db.patch(id, { salesClosesAt: Date.now() - 1 }))
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 0,
    })
    await t.run((ctx) => ctx.db.patch(id, { salesClosesAt: undefined }))
    await world.manager.mutation(api.reservationExperiences.cancelExperience, { id })
    const entries = await t.run((ctx) => ctx.db.query('waitlistEntries').collect())
    expect(entries[0]).toMatchObject({ status: 'removed' })
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 0,
    })
  })

  test('builds the mail from the entry, gives a failed claim back, and tries again an hour later', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id, full } = await soldOut(world, t)
    await alert(t, id)
    await t.mutation(api.reservations.cancelByToken, { token: full.manageToken })
    await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})
    const entry = (await t.run((ctx) => ctx.db.query('waitlistEntries').first()))!
    const payload = await t.query(internal.reservationExperiences.alertPayload, {
      waitlistEntryId: entry._id,
    })
    expect(payload).toMatchObject({
      toEmail: 'lea@example.com',
      guestName: 'Léa Martin',
      title: 'Soirée dégustation',
      store: { name: 'Chez Luigi' },
    })
    await t.mutation(internal.reservationExperiences.releaseAlertClaim, {
      waitlistEntryId: entry._id,
      failure: { reason: 'transport', detail: 'boom' },
    })
    const given = (await t.run((ctx) => ctx.db.get(entry._id)))!
    expect(given).toMatchObject({ status: 'waiting' })
    expect(given.notifiedAt).toBeUndefined()
    expect(given.noticeFailure).toMatchObject({ reason: 'transport' })
    // Not retried at once: a mailbox that refuses is not hammered every five minutes.
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 0,
    })
    await t.run((ctx) =>
      ctx.db.patch(entry._id, {
        noticeFailure: { reason: 'transport', at: Date.now() - 2 * HOUR },
      }),
    )
    expect(await t.mutation(internal.reservationExperiences.mailSeatAlerts, {})).toMatchObject({
      mailed: 1,
    })
  })

  test('is limited per address', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const { id } = await soldOut(world, t)
    for (let i = 0; i < 5; i++) await alert(t, id, { partySize: (i % 2) + 1 })
    await expect(alert(t, id)).rejects.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* The rest of the module                                              */
/* ------------------------------------------------------------------ */

describe('an event in the rest of the module', () => {
  test('leaves the table figures alone and counts its own: statistics', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 12 })
    await paidTicket(t, id, { seats: 3, email: 'a@example.com' })
    const cancelled = await paidTicket(t, id, { seats: 2, email: 'b@example.com' })
    await t.mutation(api.reservations.cancelByToken, { token: cancelled.manageToken })
    const day = dateIn(14)
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: day,
      to: day,
    })
    for (let i = 0; i < 10; i++) {
      const { hasMore } = await t.mutation(internal.reservationStats.sweepDirty, {})
      if (!hasMore) break
    }
    const row = (await t.run((ctx) => ctx.db.query('reservationStatsDaily').collect())).find(
      (r) => r.date === day,
    )!
    expect(row.experienceEvents).toBe(1)
    // Three seats stand; the two that were cancelled are not sold.
    expect(row.experienceSeats).toBe(3)
    // The tickets are in none of the booking figures: no booking, no cover, no cancellation.
    expect(row.channels.online).toEqual({ bookings: 0, covers: 0 })
    expect(row.statusCounts.confirmed).toBe(0)
    expect(row.statusCounts.cancelled_by_guest).toBe(0)
    expect(row.leadCount).toBe(0)
    expect(row.partySizes.every((n) => n === 0)).toBe(true)
    // The room the event holds is in the occupancy: three of eight tables from 21:00.
    expect(Math.max(...row.slotFill)).toBe(375)
  })

  test('is a room held in the week and month views, not a booking made', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 12 })
    await paidTicket(t, id, { seats: 3 })
    const range = await world.waiter.query(api.reservations.calendarRange, {
      storeId: world.storeId,
      from: dateIn(14),
      to: dateIn(14),
    })
    const day = range.days.find((d) => d.date === dateIn(14))!
    // One standing block of twelve covers: the event's hold. Its three tickets are not added
    // beside it.
    expect(day.covers).toBe(12)
    expect(day.bookings).toBe(1)
  })

  test('raises no alert and enters no daily report as a party to seat', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 20, maxSeatsPerBooking: 10 })
    await paidTicket(t, id, { seats: 10 })
    const alerts = await world.waiter.query(api.reservationAlerts.list, { storeId: world.storeId })
    expect(alerts.alerts.filter((a) => a.kind === 'large_party')).toEqual([])
  })

  test('appears in the day book with its kind, seats and no table', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    await paidTicket(t, id, { seats: 2 })
    const day = await world.waiter.query(api.reservations.listDay, {
      storeId: world.storeId,
      date: dateIn(14),
    })
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({
      kind: 'experience',
      experienceId: id,
      partySize: 2,
      tableIds: [],
    })
  })
})

describe('what an erasure does to a ticket', () => {
  test('deletes an unpaid ticket and the alert, keeps a paid one for the accounts without the guest', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    const paid = await paidTicket(t, id, {
      seats: 4,
      email: 'paid@example.com',
      note: 'allergie noix',
    })
    await t.mutation(api.reservationExperiences.joinAlert, {
      experienceId: id,
      guest: { name: 'Paid Guest', email: 'paid@example.com' },
      partySize: 1,
      noticeVersion: 'fr-2026-10',
    })
    await eraseFully(t, world.manager, 'paid@example.com')
    const kept = (await t.run((ctx) => ctx.db.get(paid.row._id)))!
    expect(kept).toMatchObject({ guestEmail: '', guestPhone: '', kind: 'experience' })
    expect(kept.guestNote).toBeUndefined()
    expect(kept.paymentTerms!.depositCents).toBe(26_000)
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(0)
  })

  test('deletes outright a ticket on which no money moved', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    const bought = await buy(t, id, { seats: 2, email: 'unpaid@example.com' })
    const row = await ticketOf(t, bought.manageToken)
    await eraseFully(t, world.manager, 'unpaid@example.com')
    expect(await t.run((ctx) => ctx.db.get(row._id))).toBeNull()
    // The seats are back on sale.
    expect((await publicList(t, world))[0]!.seatsLeft).toBe(12)
  })

  test('exports the ticket and the alert with the guest’s data', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 2, maxSeatsPerBooking: 2 })
    await paidTicket(t, id, { seats: 2, email: 'a@example.com', note: 'Sans gluten' })
    await t.mutation(api.reservationExperiences.joinAlert, {
      experienceId: id,
      guest: { name: 'A', email: 'a@example.com' },
      partySize: 1,
      noticeVersion: 'fr-2026-10',
    })
    const exported = JSON.stringify(
      await world.manager.query(api.privacy.exportDataSubject, { email: 'a@example.com' }),
    )
    expect(exported).toMatch(/Sans gluten/)
    expect(exported).toMatch(/waitlistEntries/)
    expect(exported).toMatch(/experience_purchased/)
  })

  test('sweeps an alert a week after the event, like any waitlist entry', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    await paidTicket(t, id, { seats: 4, email: 'full@example.com' })
    await t.mutation(api.reservationExperiences.joinAlert, {
      experienceId: id,
      guest: { name: 'L', email: 'l@example.com' },
      partySize: 1,
      noticeVersion: 'fr-2026-10',
    })
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(1)
    await t.mutation(internal.privacy.sweepExpiredCustomerData, {
      now: instant(14, '12:00') + 3 * DAY,
    })
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(1)
    let state: { step: number; storeIndex: number; cursor: string | null } | undefined
    for (let i = 0; i < 30; i++) {
      const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
        now: instant(14, '12:00') + 20 * DAY,
        ...(state ? { state } : {}),
      })
      if (!report.hasMore) break
      state = report.state
    }
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(0)
  })
})
