// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The statistics of the book: the rollup, and what the screen reads.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. every path that changes the book MARKS its day (a booking, a status, a change of
 *     date, a walk-in, an answer, an offer), and the sweep recomputes what was marked;
 *  2. the figures are the ones the definitions say — rates divided by what they are a
 *     rate of, walk-ins kept apart from bookings made, the meal measured from the
 *     stamps — and an empty period says « nothing », never a quiet month;
 *  3. a period is read from rollup rows only: bounded, refused beyond a year, and a day
 *     whose book was too large to read in full is flagged rather than passed off as whole;
 *  4. the CSV export and the rebuild are a manager's, and the rows carry no guest;
 *  5. the nightly repair re-marks the last two weeks and drops what is too old.
 */

import { describe, expect, test, vi } from 'vitest'
import { restaurantDate } from '@be-yours/convex-schema'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  bookSlot,
  dateIn,
  openSlots,
  rebuildStats,
  refusalCode,
  reservationRows,
  seedBooking,
  seedWorld,
  statsRows,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()

const sweep = async (t: Harness) => {
  for (let i = 0; i < 40; i++) {
    const { hasMore } = await t.mutation(internal.reservationStats.sweepDirty, {})
    if (!hasMore) return
  }
  throw new Error('the sweep never finished')
}

const rowOf = async (t: Harness, date: string) =>
  (await statsRows(t)).find((row) => row.date === date)

const get = (
  world: Pick<World, 'manager' | 'storeId'>,
  from: string,
  to: string,
  compare = false,
) => world.manager.query(api.reservationStats.get, { storeId: world.storeId, from, to, compare })

describe('marking the days', () => {
  test('a booking marks its day dirty, and the sweep computes it and clears the mark', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    await bookSlot(t, world, slot!, { partySize: 3 })

    const marked = await rowOf(t, dateIn(10))
    expect(marked).toMatchObject({ refreshedAt: 0 })
    expect(marked!.dirtyAt).toBeTypeOf('number')

    await sweep(t)
    const done = await rowOf(t, dateIn(10))
    expect(done!.dirtyAt).toBeUndefined()
    expect(done!.refreshedAt).toBeGreaterThan(0)
    expect(done!.channels.online).toEqual({ bookings: 1, covers: 3 })
    expect(done!.statusCounts.confirmed).toBe(1)
  })

  test('a status change marks the day again, so a no-show reaches the figures', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    await bookSlot(t, world, slot!)
    await sweep(t)
    expect((await rowOf(t, dateIn(10)))!.dirtyAt).toBeUndefined()

    const [booking] = await reservationRows(t)
    await world.manager.mutation(api.reservations.setStatus, {
      id: booking!._id,
      to: 'cancelled_by_restaurant',
    })
    expect((await rowOf(t, dateIn(10)))!.dirtyAt).toBeTypeOf('number')
    await sweep(t)
    const after = await rowOf(t, dateIn(10))
    expect(after!.statusCounts.cancelled_by_restaurant).toBe(1)
    expect(after!.channels.online.bookings).toBe(0)
  })

  test('moving a booking to another date marks the day it left and the day it joined', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    const booked = await bookSlot(t, world, slot!)
    await sweep(t)

    const [other] = await openSlots(t, world.storeId, 2, { date: dateIn(11) })
    await t.mutation(api.reservations.modifyByToken, {
      token: booked.manageToken,
      date: dateIn(11),
      serviceId: other!.serviceId as Id<'reservationServices'>,
      startsAt: other!.startsAt,
      partySize: 2,
    })
    expect((await rowOf(t, dateIn(10)))!.dirtyAt).toBeTypeOf('number')
    expect((await rowOf(t, dateIn(11)))!.dirtyAt).toBeTypeOf('number')
    await sweep(t)
    expect((await rowOf(t, dateIn(10)))!.channels.online.bookings).toBe(0)
    expect((await rowOf(t, dateIn(11)))!.channels.online.bookings).toBe(1)
  })

  test('a party seated without a booking marks today and counts as a table served, not a booking made', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() - (Date.now() % DAY) + 19.5 * 60 * 60_000))
    try {
      await world.waiter.mutation(api.reservations.seatWalkIn, {
        storeId: world.storeId,
        partySize: 3,
      })
      await sweep(t)
    } finally {
      vi.useRealTimers()
    }
    const [row] = await statsRows(t)
    expect(row!.channels.walkIn).toEqual({ bookings: 1, covers: 3 })
    expect(row!.channels.online.bookings + row!.channels.staff.bookings).toBe(0)
    expect(Object.values(row!.statusCounts).reduce((a, b) => a + b, 0)).toBe(0)
  })

  test('a waitlist entry marks the date it asks for', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    await t.run(async (ctx) => {
      const settings = await ctx.db.query('reservationSettings').first()
      await ctx.db.patch(settings!._id, { waitlistEnabled: true })
    })
    for (let i = 0; i < 20; i++) {
      const [slot] = await openSlots(t, world.storeId)
      if (!slot) break
      await bookSlot(t, world, slot, { email: `full${i}@example.com` })
    }
    await sweep(t)
    await t.mutation(api.reservationWaitlist.join, {
      storeId: world.storeId,
      guest: { name: 'Paul', email: 'paul@example.com', phone: '0600000000' },
      partySize: 2,
      date: dateIn(10),
      privacyNoticeVersion: 'fr-2026-10',
    })
    expect((await rowOf(t, dateIn(10)))!.dirtyAt).toBeTypeOf('number')
    await sweep(t)
    expect((await rowOf(t, dateIn(10)))!.waitlistJoined).toBe(1)
  })
})

describe('the sweep', () => {
  test('recomputes at most eight days a run and says when more remain', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(-20),
      to: dateIn(-1),
    })
    expect(await statsRows(t)).toHaveLength(20)
    const first = await t.mutation(internal.reservationStats.sweepDirty, {})
    expect(first).toEqual({ refreshed: 8, hasMore: true })
    const second = await t.mutation(internal.reservationStats.sweepDirty, {})
    expect(second).toEqual({ refreshed: 8, hasMore: true })
    const third = await t.mutation(internal.reservationStats.sweepDirty, {})
    expect(third).toEqual({ refreshed: 4, hasMore: false })
    expect((await statsRows(t)).every((row) => row.dirtyAt === undefined)).toBe(true)
  })

  test('has nothing to do when nothing was marked', async () => {
    const t = newHarness()
    await seedWorld(t, { looseTables: 2 })
    expect(await t.mutation(internal.reservationStats.sweepDirty, {})).toEqual({
      refreshed: 0,
      hasMore: false,
    })
  })
})

/** Five days ago: a busy evening with every kind of outcome. */
async function busyEvening(t: Harness, world: World, date: string) {
  const at = (time: string, extra: Parameters<typeof seedBooking>[2]) =>
    seedBooking(t, world, { date, time, ...extra })
  await at('19:30', {
    partySize: 4,
    status: 'completed',
    table: 'Libre 1',
    leadHours: 48,
    seatedAfterMin: 5,
    mealMinutes: 80,
    feedbackScore: 5,
  })
  await at('19:30', {
    partySize: 2,
    status: 'completed',
    table: 'Libre 2',
    leadHours: 24,
    mealMinutes: 100,
    feedbackScore: 3,
  })
  await at('20:00', {
    partySize: 6,
    status: 'completed',
    channel: 'staff',
    table: 'Libre 3',
    leadHours: 2,
    mealMinutes: 90,
  })
  await at('20:00', { partySize: 2, status: 'no_show', table: 'Libre 4' })
  await at('19:00', { partySize: 2, status: 'cancelled_by_guest' })
  await at('19:00', { partySize: 3, status: 'cancelled_by_restaurant' })
  await at('19:00', { partySize: 2, status: 'declined' })
  await at('20:30', {
    partySize: 3,
    status: 'completed',
    channel: 'walk_in',
    table: 'Libre 4',
    mealMinutes: 90,
  })
}

describe('the figures of a period', () => {
  test('are the ones the definitions say, rate by rate', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const evening = dateIn(-5)
    await busyEvening(t, world, evening)
    await seedBooking(t, world, { date: dateIn(-2), time: '19:30', partySize: 2 })
    await seedBooking(t, world, {
      date: dateIn(-10),
      time: '19:30',
      partySize: 2,
      status: 'completed',
    })
    await rebuildStats(t, world, world.storeId, dateIn(-10), dateIn(-1))

    const stats = await get(world, dateIn(-5), dateIn(-1), true)
    const p = stats.period

    // Bookings made, walk-ins apart: two online and one by the team stood, plus the one still open.
    expect(p.bookings).toBe(4)
    expect(p.covers).toBe(4 + 2 + 6 + 2)
    expect(p.averageParty).toBeCloseTo(14 / 4)
    expect(p.channels.walkIn).toEqual({ bookings: 1, covers: 3 })
    expect(p.channelShares!.walkIn).toBeCloseTo(3 / 17)

    // One absence among the four parties whose outcome is known (three came, one did not).
    expect(p.noShows).toBe(1)
    expect(p.attended).toBe(3)
    expect(p.noShowRate).toBeCloseTo(1 / 4)
    // Two cancellations out of every booking accepted at some point; the refused one is not in it.
    expect(p.cancellationsByGuest).toBe(1)
    expect(p.cancellationsByRestaurant).toBe(1)
    expect(p.declined).toBe(1)
    expect(p.accepted).toBe(3 + 1 + 2 + 1)
    expect(p.cancellationRate).toBeCloseTo(2 / 7)

    // Lead time of the standing bookings made (48 h, 24 h, 2 h, and the open one at 24 h).
    expect(p.leadMinutes).toBeCloseTo((2880 + 1440 + 120 + 1440) / 4)
    // The real meal, from the stamps, of every completed sitting, a walk-in's included.
    expect(p.mealCount).toBe(4)
    expect(p.mealMinutes).toBeCloseTo((80 + 100 + 90 + 90) / 4)
    expect(p.feedback).toMatchObject({ count: 2, average: 4, scores: [0, 0, 1, 0, 1], sent: 0 })
    expect(p.feedback.responseRate).toBeNull()

    expect(p.partySizes).toEqual([0, 2, 1, 1, 0, 1, 0, 0])
    expect(p.activeDays).toBe(2)
    expect(p.busiestDays[0]).toMatchObject({ date: evening, covers: 12 })
  })

  test('read the room by half hour and by service', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    await busyEvening(t, world, dateIn(-5))
    await rebuildStats(t, world, world.storeId, dateIn(-5), dateIn(-5))
    const { period } = await get(world, dateIn(-5), dateIn(-5))

    const at = (time: string) => period.slotFill[parseInt(time) * 2 + (time.endsWith('30') ? 1 : 0)]
    // Of four tables: 19:30 holds two, 20:00 three, 20:30 all four, 21:00 two again.
    expect(at('19:00')).toBe(0)
    expect(at('19:30')).toBeCloseTo(50)
    expect(at('20:00')).toBeCloseTo(75)
    expect(at('20:30')).toBeCloseTo(100)
    expect(at('21:00')).toBeCloseTo(50)
    // Closed: unknown, not empty.
    expect(at('12:00')).toBeNull()
    expect(at('22:30')).toBeNull()
    expect(period.busiestSlots[0]).toMatchObject({ time: '20:30', fill: 100 })

    expect(period.services).toHaveLength(1)
    expect(period.services[0]).toMatchObject({
      name: 'Dîner',
      // Reservations: the walk-in (3 covers) is a party seated without one, counted apart.
      bookings: 3,
      covers: 12,
      daysOpen: 1,
      averagePeak: 100,
    })
  })

  test('compare with the period before, and only when asked', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    await busyEvening(t, world, dateIn(-5))
    await seedBooking(t, world, { date: dateIn(-8), time: '19:30', status: 'completed' })
    await rebuildStats(t, world, world.storeId, dateIn(-9), dateIn(-1))

    const alone = await get(world, dateIn(-4), dateIn(-1))
    expect(alone.previous).toBeNull()
    expect(alone.comparison).toBeNull()

    const compared = await get(world, dateIn(-5), dateIn(-1), true)
    expect(compared.previous!.from).toBe(dateIn(-10))
    expect(compared.previous!.to).toBe(dateIn(-6))
    // The previous five days hold one booking of two covers; this one holds three of twelve.
    expect(compared.previous!.bookings).toBe(1)
    expect(compared.comparison!.bookings).toMatchObject({ current: 3, previous: 1, change: 2 })
    expect(compared.comparison!.covers!.ratio).toBeCloseTo((12 - 2) / 2)
  })

  test('give a bar per day, a day with no row being a day with nothing', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    await seedBooking(t, world, { date: dateIn(-2), time: '20:00', partySize: 5 })
    await rebuildStats(t, world, world.storeId, dateIn(-2), dateIn(-2))
    const { series } = await get(world, dateIn(-3), dateIn(-1))
    expect(series.map((s) => s.date)).toEqual([dateIn(-3), dateIn(-2), dateIn(-1)])
    expect(series.map((s) => [s.bookings, s.covers])).toEqual([
      [0, 0],
      [1, 5],
      [0, 0],
    ])
  })

  test('say so, and say since when, when the establishment is new', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const empty = await get(world, dateIn(-6), dateIn(0))
    expect(empty.since).toBeNull()
    expect(empty.period.bookings).toBe(0)
    expect(empty.period.noShowRate).toBeNull()
    expect(empty.period.cancellationRate).toBeNull()
    expect(empty.refreshedAt).toBeNull()
    expect(empty.pendingDays).toBe(0)

    await seedBooking(t, world, { date: dateIn(-3), time: '19:30' })
    await rebuildStats(t, world, world.storeId, dateIn(-4), dateIn(-3))
    const started = await get(world, dateIn(-30), dateIn(0))
    // Measured only from when the module has figures: before it, nothing was counted.
    expect(started.since).toBe(dateIn(-4))
    expect(started.refreshedAt).toBeTypeOf('number')
  })

  test('say how many days still wait to be recomputed', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(-3),
      to: dateIn(-1),
    })
    expect((await get(world, dateIn(-3), dateIn(-1))).pendingDays).toBe(3)
    await sweep(t)
    expect((await get(world, dateIn(-3), dateIn(-1))).pendingDays).toBe(0)
  })

  test('know whether the capacity is known, which the occupancy needs', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect((await get(world, dateIn(-1), dateIn(0))).capacityKnown).toBe(true)
    await t.run(async (ctx) => {
      for (const table of await ctx.db.query('reservationTables').collect()) {
        await ctx.db.patch(table._id, { outOfService: true })
      }
    })
    expect((await get(world, dateIn(-1), dateIn(0))).capacityKnown).toBe(false)
  })
})

describe('what is refused', () => {
  test('a period that is not real, not ordered, or longer than a year', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect(await refusalCode(get(world, dateIn(-1), dateIn(-5)))).toBe('invalid_input')
    expect(await refusalCode(get(world, '2026-02-30', '2026-03-01'))).toBe('invalid_input')
    expect(await refusalCode(get(world, 'hier', 'demain'))).toBe('invalid_input')
    expect(await refusalCode(get(world, dateIn(-400), dateIn(0)))).toBe('invalid_input')
    // A year exactly is fine, and so is a compared year: two years of rows still fit one request.
    expect(await get(world, dateIn(-365), dateIn(0))).toBeTruthy()
    expect(await get(world, dateIn(-365), dateIn(0), true)).toBeTruthy()
  })

  test('a day whose book is too large to read is flagged, never passed off as whole', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run(async (ctx) => {
      const startsAt = Date.now() - 3 * DAY
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert('reservations', {
          storeId: world.storeId,
          reference: `RES-BULK-${i}`,
          status: 'completed',
          serviceId: world.serviceId,
          startsAt: startsAt + i,
          endsAt: startsAt + i + 60_000,
          partySize: 2,
          tableIds: [],
          guestName: 'x',
          guestEmail: `x${i}@example.com`,
          guestPhone: '0',
          channel: 'online',
          manageToken: `bulk-token-${i}-${crypto.randomUUID()}`,
          createdAt: startsAt - 3_600_000,
          updatedAt: startsAt,
        })
      }
    })
    const [first] = await t.run((ctx) => ctx.db.query('reservations').take(1))
    // The restaurant's day, which is not always the UTC date.
    const day = restaurantDate(first!.startsAt, 'Europe/Paris')
    await rebuildStats(t, world, world.storeId, day, day)
    const stats = await get(world, day, day)
    expect(stats.period.truncatedDays).toBe(1)
    // The first thousand are what it counted.
    expect(stats.period.bookings).toBeLessThanOrEqual(1000)
  })

  test('a team member who may not read the book reads nothing', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await expect(
      t.query(api.reservationStats.get, {
        storeId: world.storeId,
        from: dateIn(-1),
        to: dateIn(0),
      }),
    ).rejects.toThrow()
  })
})

describe('the export and the rebuild', () => {
  test('are a manager’s: the waiter reads the figures and may neither export nor rebuild', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const range = { storeId: world.storeId, from: dateIn(-3), to: dateIn(-1) }
    expect(await world.waiter.query(api.reservationStats.get, range)).toBeTruthy()
    await expect(world.waiter.query(api.reservationStats.exportDays, range)).rejects.toThrow()
    await expect(world.waiter.mutation(api.reservationStats.rebuild, range)).rejects.toThrow()
    expect(await world.manager.query(api.reservationStats.exportDays, range)).toBeTruthy()
  })

  test('carry figures only: no guest, no note, no comment', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await seedBooking(t, world, {
      date: dateIn(-2),
      time: '20:00',
      name: 'Hélène Martin',
      email: 'helene@example.com',
      guestNote: 'allergie aux arachides',
      status: 'completed',
      feedbackScore: 4,
      feedbackComment: 'Très bon accueil',
    })
    await rebuildStats(t, world, world.storeId, dateIn(-2), dateIn(-2))
    const answer = await world.manager.query(api.reservationStats.exportDays, {
      storeId: world.storeId,
      from: dateIn(-2),
      to: dateIn(-2),
    })
    expect(answer.rows).toHaveLength(1)
    const text = JSON.stringify(answer)
    expect(text).not.toMatch(/Hélène|helene|arachides|accueil|0612|RES-/)
    expect(Object.keys(answer.rows[0]!)).not.toContain('storeId')
    expect(answer.rows[0]!.feedbackScores).toEqual([0, 0, 0, 1, 0])
  })

  test('rebuilding a period marks every day of it, and nothing outside', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const result = await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(-4),
      to: dateIn(-2),
    })
    expect(result).toEqual({ marked: 3 })
    expect((await statsRows(t)).map((r) => r.date).sort()).toEqual([
      dateIn(-4),
      dateIn(-3),
      dateIn(-2),
    ])
  })
})

describe('the nightly repair', () => {
  test('re-marks the last two weeks of every book, and not a day more', async () => {
    const t = newHarness()
    await seedWorld(t, { looseTables: 2 })
    const result = await t.mutation(internal.reservationStats.repair, {})
    expect(result.marked).toBe(14)
    const rows = await statsRows(t)
    expect(rows).toHaveLength(14)
    expect(rows.every((r) => r.dirtyAt !== undefined)).toBe(true)
    // Running it again adds nothing: a day already marked is left alone.
    await t.mutation(internal.reservationStats.repair, {})
    expect(await statsRows(t)).toHaveLength(14)
  })

  test('repairs a day that a path forgot to mark', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    // A booking written behind the functions' back, as a path that never marked would.
    await seedBooking(t, world, { date: dateIn(-3), time: '19:30', partySize: 4 })
    expect(await statsRows(t)).toHaveLength(0)
    await t.mutation(internal.reservationStats.repair, {})
    await sweep(t)
    expect((await rowOf(t, dateIn(-3)))!.channels.online).toEqual({ bookings: 1, covers: 4 })
  })

  test('drops the rows older than the kept window', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(-900),
      to: dateIn(-899),
    })
    expect(await statsRows(t)).toHaveLength(2)
    const result = await t.mutation(internal.reservationStats.repair, {})
    expect(result.pruned).toBe(2)
    expect((await statsRows(t)).every((r) => r.date >= dateIn(-14))).toBe(true)
  })
})
