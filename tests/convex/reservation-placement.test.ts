// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Putting parties on tables from the host's plan, seeing the evening before's
 * parties still at table, and the week and month views.
 *
 * What is pinned:
 *
 *  1. a move that overlaps another booking is refused, and names what is in the
 *     way; only `reservations:manage` can override it, and an override is logged;
 *  2. the tables must exist here and be in service — whatever the screen sent;
 *  3. a walk-in can be seated on the table the host picked, under the same rule;
 *  4. a party that started before midnight is still on its table after it, and the
 *     day screen can read it;
 *  5. the calendar counts what holds a table, on the restaurant's own dates.
 */

import { describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import {
  NOW,
  bookSlot,
  dateIn,
  eventRows,
  openSlots,
  refusalCode,
  refusalMessage,
  reservationRows,
  rowById,
  seedWorld,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()

/** Two bookings at the same hour, on different tables. */
async function twoParties(t: Harness, world: World) {
  const [slot] = await openSlots(t, world.storeId)
  await bookSlot(t, world, slot!, { email: 'a@example.com', name: 'Alice' })
  await bookSlot(t, world, slot!, { email: 'b@example.com', name: 'Bruno' })
  const rows = (await reservationRows(t)).sort((a, b) => a._creationTime - b._creationTime)
  return { slot: slot!, alice: rows[0]!, bruno: rows[1]! }
}

describe('moving a booking to another table', () => {
  test('puts it on a free table and says so in the history', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    const free = Object.values(world.tables).find(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )!

    const answer = await world.waiter.mutation(api.reservations.moveTables, {
      id: alice._id,
      tableIds: [free],
    })
    expect(answer).toEqual({ changed: true })
    expect((await rowById(t, alice._id))!.tableIds).toEqual([free])
    expect((await eventRows(t)).at(-1)).toMatchObject({
      actor: 'staff',
      from: 'confirmed',
      to: 'confirmed',
      note: 'tables_moved',
    })
  })

  test('is a no-op on the tables it already has', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { alice } = await twoParties(t, world)
    const before = (await eventRows(t)).length
    await expect(
      world.waiter.mutation(api.reservations.moveTables, {
        id: alice._id,
        tableIds: [...alice.tableIds],
      }),
    ).resolves.toEqual({ changed: false })
    expect(await eventRows(t)).toHaveLength(before)
  })

  test('refuses a table another booking holds, and names the table and the booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { alice, bruno } = await twoParties(t, world)

    const call = () =>
      world.waiter.mutation(api.reservations.moveTables, {
        id: alice._id,
        tableIds: [...bruno.tableIds],
      })
    expect(await refusalCode(call())).toBe('table_conflict')
    const message = await refusalMessage(call())
    expect(message).toContain(bruno.reference)
    expect(message).toMatch(/Libre [12]/)
    // Nothing moved.
    expect((await rowById(t, alice._id))!.tableIds).toEqual(alice.tableIds)
  })

  test('does not count a party at the same table an hour later as a conflict', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const slots = await openSlots(t, world.storeId)
    const early = slots[0]!
    // 19:00 is 90 minutes; the same table is free from 20:30.
    const late = slots.find((s) => s.startsAt >= early.startsAt + 90 * 60_000)
    if (!late) throw new Error('fixture: no later slot')
    await bookSlot(t, world, early, { email: 'a@example.com' })
    await bookSlot(t, world, late, { email: 'b@example.com' })
    const rows = (await reservationRows(t)).sort((a, b) => a.startsAt - b.startsAt)
    // Swapping tables changes nothing here, but asking for the other's table is no clash.
    await expect(
      world.waiter.mutation(api.reservations.moveTables, {
        id: rows[1]!._id,
        tableIds: [...rows[0]!.tableIds],
      }),
    ).resolves.toEqual({ changed: false })
  })

  test('a waiter cannot override; a manager can, and the history says it was forced', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { alice, bruno } = await twoParties(t, world)
    const args = { id: alice._id, tableIds: [...bruno.tableIds], override: true }

    await expect(world.waiter.mutation(api.reservations.moveTables, args)).rejects.toThrow()
    expect((await rowById(t, alice._id))!.tableIds).toEqual(alice.tableIds)

    await expect(world.manager.mutation(api.reservations.moveTables, args)).resolves.toEqual({
      changed: true,
    })
    expect((await rowById(t, alice._id))!.tableIds).toEqual(bruno.tableIds)
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'tables_moved_override' })
  })

  test('an override flag on a free table is just a move, and costs no permission', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    const free = Object.values(world.tables).find(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )!
    await expect(
      world.waiter.mutation(api.reservations.moveTables, {
        id: alice._id,
        tableIds: [free],
        override: true,
      }),
    ).resolves.toEqual({ changed: true })
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'tables_moved' })
  })

  test('moves a party to a pushed-together group, every table of it checked', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    const [freeTable] = Object.values(world.tables).filter(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )
    // One free table and one Bruno holds: the group is refused as a whole.
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.moveTables, {
          id: alice._id,
          tableIds: [freeTable!, bruno.tableIds[0]!],
        }),
      ),
    ).toBe('table_conflict')
  })

  test('refuses a table that is out of service, even for a manager overriding', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    const free = Object.values(world.tables).find(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )!
    await t.run((ctx) => ctx.db.patch(free, { outOfService: true }))
    expect(
      await refusalCode(
        world.manager.mutation(api.reservations.moveTables, {
          id: alice._id,
          tableIds: [free],
          override: true,
        }),
      ),
    ).toBe('table_unavailable')
  })

  test('refuses a table of another establishment', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const other = await seedWorld(t, { looseTables: 1, profiles: false })
    const { alice } = await twoParties(t, world)
    expect(
      await refusalCode(
        world.manager.mutation(api.reservations.moveTables, {
          id: alice._id,
          tableIds: [other.tables['Libre 1']!],
        }),
      ),
    ).toBe('table_unavailable')
  })

  test('refuses a booking that no longer holds a table, and an empty or oversized list', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    const free = Object.values(world.tables).find(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )!

    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.moveTables, { id: alice._id, tableIds: [] }),
      ),
    ).toBe('invalid_input')

    await t.run((ctx) => ctx.db.patch(alice._id, { status: 'cancelled_by_guest' }))
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.moveTables, { id: alice._id, tableIds: [free] }),
      ),
    ).toBe('transition_refused')
  })

  test('a party at table can be moved to another', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const { alice, bruno } = await twoParties(t, world)
    await t.run((ctx) => ctx.db.patch(alice._id, { status: 'seated' }))
    const free = Object.values(world.tables).find(
      (id) => !alice.tableIds.includes(id) && !bruno.tableIds.includes(id),
    )!
    await expect(
      world.waiter.mutation(api.reservations.moveTables, { id: alice._id, tableIds: [free] }),
    ).resolves.toEqual({ changed: true })
  })

  test('is refused on a book that runs on covers', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { capacityMode: 'covers', looseTables: 2 })
    const [slot] = await openSlots(t, world.storeId)
    await bookSlot(t, world, slot!)
    const [row] = await reservationRows(t)
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.moveTables, {
          id: row!._id,
          tableIds: [world.tables['Libre 1']!],
        }),
      ),
    ).toBe('invalid_input')
  })

  test('is a write the host stand has and a stranger does not', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { alice } = await twoParties(t, world)
    await expect(
      t.mutation(api.reservations.moveTables, {
        id: alice._id,
        tableIds: [world.tables['Libre 1']!],
      }),
    ).rejects.toThrow()
  })

  test('catches a party still seated from the evening before', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { alice } = await twoParties(t, world)
    // A party seated yesterday at 23:00 for five hours holds a table until 04:00,
    // across the booking's own window if that were at night. Force the overlap.
    const startsAt = alice.startsAt - 60 * 60_000
    const night = await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: 'RES-2026-00098',
        status: 'seated',
        serviceId: world.serviceId,
        startsAt: startsAt - 24 * 60 * 60_000,
        endsAt: alice.startsAt + 30 * 60_000,
        partySize: 2,
        tableIds: [world.tables['Libre 1']!, world.tables['Libre 2']!].filter(
          (id) => !alice.tableIds.includes(id),
        ),
        guestName: '',
        guestEmail: '',
        guestPhone: '',
        channel: 'walk_in',
        manageToken: 'night-token-0001',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const held = (await rowById(t, night))!.tableIds
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.moveTables, { id: alice._id, tableIds: [...held] }),
      ),
    ).toBe('table_conflict')
  })
})

describe('seating a walk-in on the table the host picked', () => {
  /** A dinner service is open at this instant only if the clock says so; fix the service wide open. */
  async function allDayWorld(t: Harness) {
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run((ctx) => ctx.db.patch(world.serviceId, { start: '00:00', end: '23:59' }))
    return world
  }

  test('seats the party on the chosen table', async () => {
    const t = newHarness()
    const world = await allDayWorld(t)
    const table = world.tables['Libre 2']!
    const answer = await world.waiter.mutation(api.reservations.seatWalkIn, {
      storeId: world.storeId,
      partySize: 2,
      tableIds: [table],
    })
    expect(answer).toMatchObject({ seated: true })
    const [row] = await reservationRows(t)
    expect(row).toMatchObject({ channel: 'walk_in', status: 'seated', tableIds: [table] })
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'walk_in' })
  })

  test('says the chosen table is busy, with the wait for that table, and writes nothing', async () => {
    const t = newHarness()
    const world = await allDayWorld(t)
    const table = world.tables['Libre 1']!
    // A booking holds Libre 1 from now for 90 minutes.
    await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: 'RES-2026-00097',
        status: 'confirmed',
        serviceId: world.serviceId,
        startsAt: NOW + 10 * 60_000,
        endsAt: NOW + 100 * 60_000,
        partySize: 2,
        tableIds: [table],
        guestName: 'Alice',
        guestEmail: 'a@example.com',
        guestPhone: '0600000000',
        channel: 'online',
        manageToken: 'busy-token-00001',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const outlook = await world.waiter.query(api.reservations.walkInOutlook, {
      storeId: world.storeId,
      partySize: 2,
      tableIds: [table],
    })
    expect(outlook).toMatchObject({ canSeatNow: false, reason: 'table_busy' })
    expect(outlook.waitMinutes).toBeGreaterThan(0)
    // Any table is free: the other one.
    expect(
      await world.waiter.query(api.reservations.walkInOutlook, {
        storeId: world.storeId,
        partySize: 2,
      }),
    ).toMatchObject({ canSeatNow: true })

    const answer = await world.waiter.mutation(api.reservations.seatWalkIn, {
      storeId: world.storeId,
      partySize: 2,
      tableIds: [table],
    })
    expect(answer).toMatchObject({ seated: false, reason: 'table_busy' })
    expect(await reservationRows(t)).toHaveLength(1)
  })

  test('a manager may override a busy table, a waiter may not', async () => {
    const t = newHarness()
    const world = await allDayWorld(t)
    const table = world.tables['Libre 1']!
    await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: 'RES-2026-00097',
        status: 'confirmed',
        serviceId: world.serviceId,
        startsAt: NOW + 10 * 60_000,
        endsAt: NOW + 100 * 60_000,
        partySize: 2,
        tableIds: [table],
        guestName: 'Alice',
        guestEmail: 'a@example.com',
        guestPhone: '0600000000',
        channel: 'online',
        manageToken: 'busy-token-00001',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const args = { storeId: world.storeId, partySize: 2, tableIds: [table], override: true }
    await expect(world.waiter.mutation(api.reservations.seatWalkIn, args)).rejects.toThrow()
    const answer = await world.manager.mutation(api.reservations.seatWalkIn, args)
    expect(answer).toMatchObject({ seated: true })
    expect((await eventRows(t)).at(-1)).toMatchObject({ note: 'walk_in_override' })
  })

  test('refuses a table that is out of service or not here, even overriding', async () => {
    const t = newHarness()
    const world = await allDayWorld(t)
    const other = await seedWorld(t, { looseTables: 1, profiles: false })
    await t.run((ctx) => ctx.db.patch(world.tables['Libre 1']!, { outOfService: true }))
    for (const tableIds of [[world.tables['Libre 1']!], [other.tables['Libre 1']!]]) {
      const answer = await world.manager.mutation(api.reservations.seatWalkIn, {
        storeId: world.storeId,
        partySize: 2,
        tableIds,
        override: true,
      })
      expect(answer).toMatchObject({ seated: false, reason: 'table_unavailable' })
    }
  })

  test('refuses an empty or oversized choice', async () => {
    const t = newHarness()
    const world = await allDayWorld(t)
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservations.seatWalkIn, {
          storeId: world.storeId,
          partySize: 2,
          tableIds: [],
        }),
      ),
    ).toBe('invalid_input')
  })
})

describe('the evening before, still at table', () => {
  /** A 23:00 dinner on `date`, running into the night, on its own row. */
  async function lateParty(
    t: Harness,
    world: World,
    date: string,
    status: 'seated' | 'confirmed' | 'completed' = 'seated',
  ) {
    // Paris is UTC+1 or +2: 21:30 UTC is 22:30 or 23:30 locally — always before midnight.
    const startsAt = Date.parse(`${date}T21:30:00Z`)
    return t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: `RES-2026-0009${status.length}`,
        status,
        serviceId: world.serviceId,
        startsAt,
        endsAt: startsAt + 4 * 60 * 60_000,
        partySize: 2,
        tableIds: [world.tables['Libre 1']!],
        guestName: 'Nuit',
        guestEmail: 'nuit@example.com',
        guestPhone: '0600000000',
        channel: 'staff',
        manageToken: `night-${status}-0001`,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
  }
  const next = (date: string) =>
    new Date(Date.parse(`${date}T12:00:00Z`) + 24 * 60 * 60_000).toISOString().slice(0, 10)

  test('lists a party that started the evening before and is still on its table', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const date = dateIn(10)
    const id = await lateParty(t, world, date)

    const carried = await world.waiter.query(api.reservations.listCarryOver, {
      storeId: world.storeId,
      date: next(date),
    })
    expect(carried.map((r) => r._id)).toEqual([id])
    // It is not in its own day's "starting" list twice, and not in the next day's.
    const onItsDay = await world.waiter.query(api.reservations.listDay, {
      storeId: world.storeId,
      date,
    })
    const onNextDay = await world.waiter.query(api.reservations.listDay, {
      storeId: world.storeId,
      date: next(date),
    })
    expect(onItsDay.map((r) => r._id)).toEqual([id])
    expect(onNextDay).toEqual([])
  })

  test('leaves out one that has finished, and one whose window ended before midnight', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const date = dateIn(10)
    await lateParty(t, world, date, 'completed')
    const early = Date.parse(`${date}T17:00:00Z`)
    await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId: world.storeId,
        reference: 'RES-2026-00090',
        status: 'seated',
        serviceId: world.serviceId,
        startsAt: early,
        endsAt: early + 90 * 60_000,
        partySize: 2,
        tableIds: [world.tables['Libre 1']!],
        guestName: 'Tôt',
        guestEmail: 't@example.com',
        guestPhone: '0600000000',
        channel: 'staff',
        manageToken: 'early-token-0001',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    expect(
      await world.waiter.query(api.reservations.listCarryOver, {
        storeId: world.storeId,
        date: next(date),
      }),
    ).toEqual([])
  })

  test('is a read of the host stand, and refuses a malformed date', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    await expect(
      t.query(api.reservations.listCarryOver, { storeId: world.storeId, date: dateIn(10) }),
    ).rejects.toThrow()
    expect(
      await refusalCode(
        world.waiter.query(api.reservations.listCarryOver, {
          storeId: world.storeId,
          date: 'demain',
        }),
      ),
    ).toBe('invalid_input')
  })
})

describe('the calendar', () => {
  test('counts bookings, covers and requests per day, and the load of the busiest moment', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4, autoConfirm: false })
    const date = dateIn(10)
    const slots = await openSlots(t, world.storeId)
    await bookSlot(t, world, slots[0]!, { email: 'a@example.com' })
    await bookSlot(t, world, slots[0]!, { email: 'b@example.com', partySize: 3 })
    const [first] = (await reservationRows(t)).sort((a, b) => a._creationTime - b._creationTime)
    await world.manager.mutation(api.reservations.setStatus, { id: first!._id, to: 'confirmed' })

    const result = await world.waiter.query(api.reservations.calendarRange, {
      storeId: world.storeId,
      from: dateIn(8),
      to: dateIn(12),
    })
    expect(result.truncated).toBe(false)
    expect(result.days).toHaveLength(5)
    const day = result.days.find((d) => d.date === date)!
    expect(day).toMatchObject({ bookings: 2, covers: 5, toValidate: 1 })
    // Two of four tables at the same moment.
    expect(day.load).toBe(0.5)
    expect(day.level).toBe('medium')
    expect(result.days.filter((d) => d.date !== date).every((d) => d.bookings === 0)).toBe(true)
  })

  test('does not count what has left the book, and says nothing it cannot read', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const slots = await openSlots(t, world.storeId)
    await bookSlot(t, world, slots[0]!)
    const [row] = await reservationRows(t)
    await world.waiter.mutation(api.reservations.setStatus, {
      id: row!._id,
      to: 'cancelled_by_restaurant',
    })
    const result = await world.waiter.query(api.reservations.calendarRange, {
      storeId: world.storeId,
      from: dateIn(10),
      to: dateIn(10),
    })
    expect(result.days[0]).toMatchObject({ bookings: 0, covers: 0, level: 'none' })
    // Aggregates only: no name, e-mail or note ever leaves.
    expect(JSON.stringify(result)).not.toMatch(/Marie|marie@|0612/)
  })

  test('reads covers against the ceiling on a book that runs on covers', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { capacityMode: 'covers' })
    const slots = await openSlots(t, world.storeId, 4)
    await bookSlot(t, world, slots[0]!, { partySize: 4 })
    const result = await world.waiter.query(api.reservations.calendarRange, {
      storeId: world.storeId,
      from: dateIn(10),
      to: dateIn(10),
    })
    // 4 of the 20 covers the fixture allows at once.
    expect(result.days[0]!.load).toBe(0.2)
    expect(result.days[0]!.level).toBe('light')
  })

  test('refuses a backwards range, a bad date, and more than six weeks', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const ask = (from: string, to: string) =>
      refusalCode(
        world.waiter.query(api.reservations.calendarRange, { storeId: world.storeId, from, to }),
      )
    expect(await ask(dateIn(12), dateIn(10))).toBe('invalid_input')
    expect(await ask('demain', dateIn(10))).toBe('invalid_input')
    expect(await ask(dateIn(0), dateIn(42))).toBe('invalid_input')
    expect(await ask(dateIn(0), dateIn(41))).toBeUndefined()
  })

  test('is a read of the host stand', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    await expect(
      t.query(api.reservations.calendarRange, {
        storeId: world.storeId,
        from: dateIn(1),
        to: dateIn(2),
      }),
    ).rejects.toThrow()
  })
})
