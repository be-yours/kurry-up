// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Rooms: several floor plans, tables that belong to one, and a diner who may say
 * which area they would like.
 *
 * Three promises are pinned here, because each one is easy to break by accident:
 *
 *  1. a table with no room stays valid, so every establishment that predates rooms
 *     books exactly as before;
 *  2. a preference changes WHICH table a party gets and never WHETHER one is found:
 *     what a diner with a preference is offered is never less than what a diner
 *     without one is offered;
 *  3. the choice is only put to a diner who has one — more than one room that can
 *     seat an online booking.
 */

import { describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import {
  bookSlot,
  dateIn,
  openSlots,
  refusalCode,
  reservationRows,
  seedWorld,
  createHarnessFactory,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()

const TWO_ROOMS = [
  { name: 'Salle', tables: 2 },
  { name: 'Terrasse', tables: 2 },
]

describe('managing rooms', () => {
  test('creates, renames and numbers rooms in the order they were made', async () => {
    const t = newHarness()
    const world = await seedWorld(t)
    const { manager, storeId } = world

    const salle = await manager.mutation(api.reservations.saveRoom, { storeId, name: ' Salle ' })
    const terrasse = await manager.mutation(api.reservations.saveRoom, {
      storeId,
      name: 'Terrasse',
    })
    await manager.mutation(api.reservations.saveRoom, { storeId, id: terrasse, name: 'Jardin' })

    const config = await manager.query(api.reservations.getConfig, { storeId })
    expect(config.rooms.map((r) => [r._id, r.name, r.sortOrder, r.archived])).toEqual([
      [salle, 'Salle', 0, false],
      [terrasse, 'Jardin', 1, false],
    ])
  })

  test('refuses a name already taken, whatever its case, and an empty or overlong one', async () => {
    const t = newHarness()
    const { manager, storeId } = await seedWorld(t)
    await manager.mutation(api.reservations.saveRoom, { storeId, name: 'Terrasse' })

    expect(
      await refusalCode(manager.mutation(api.reservations.saveRoom, { storeId, name: 'terrasse' })),
    ).toBe('invalid_input')
    expect(
      await refusalCode(manager.mutation(api.reservations.saveRoom, { storeId, name: '   ' })),
    ).toBe('invalid_input')
    expect(
      await refusalCode(
        manager.mutation(api.reservations.saveRoom, { storeId, name: 'x'.repeat(41) }),
      ),
    ).toBe('invalid_input')
  })

  test('renaming a room to its own name is fine', async () => {
    const t = newHarness()
    const { manager, storeId } = await seedWorld(t)
    const id = await manager.mutation(api.reservations.saveRoom, { storeId, name: 'Salle' })
    await expect(
      manager.mutation(api.reservations.saveRoom, { storeId, id, name: 'Salle' }),
    ).resolves.toBe(id)
  })

  test('stops at twelve rooms', async () => {
    const t = newHarness()
    const { manager, storeId } = await seedWorld(t)
    for (let i = 1; i <= 12; i++) {
      await manager.mutation(api.reservations.saveRoom, { storeId, name: `Salle ${i}` })
    }
    expect(
      await refusalCode(
        manager.mutation(api.reservations.saveRoom, { storeId, name: 'Une de trop' }),
      ),
    ).toBe('invalid_input')
  })

  test('reorders: the whole list in the new order, or nothing', async () => {
    const t = newHarness()
    const { manager, storeId } = await seedWorld(t, { rooms: TWO_ROOMS })
    const [salle, terrasse] = (await manager.query(api.reservations.getConfig, { storeId })).rooms

    await manager.mutation(api.reservations.reorderRooms, {
      storeId,
      ids: [terrasse!._id, salle!._id],
    })
    const after = (await manager.query(api.reservations.getConfig, { storeId })).rooms
    expect(after.map((r) => r.name)).toEqual(['Terrasse', 'Salle'])

    // A partial list would leave two rooms with one rank.
    expect(
      await refusalCode(
        manager.mutation(api.reservations.reorderRooms, { storeId, ids: [salle!._id] }),
      ),
    ).toBe('invalid_input')
    expect(
      await refusalCode(
        manager.mutation(api.reservations.reorderRooms, {
          storeId,
          ids: [salle!._id, salle!._id],
        }),
      ),
    ).toBe('invalid_input')
  })

  test('only a manager may change rooms', async () => {
    const t = newHarness()
    const { waiter, storeId } = await seedWorld(t)
    await expect(
      waiter.mutation(api.reservations.saveRoom, { storeId, name: 'Salle' }),
    ).rejects.toThrow()
    // But the host stand can read them.
    await expect(waiter.query(api.reservations.getConfig, { storeId })).resolves.toBeDefined()
  })

  test('archiving sends the tables back to « sans salle », unplaced, and they keep booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { rooms: TWO_ROOMS })
    const { manager, storeId, rooms, tables } = world
    await manager.mutation(api.reservations.saveTableLayout, {
      storeId,
      tables: [{ id: tables['Terrasse 1']!, x: 3, y: 4, width: 2, height: 2 }],
    })

    const result = await manager.mutation(api.reservations.archiveRoom, {
      id: rooms['Terrasse']!,
      archived: true,
    })
    expect(result).toEqual({ detached: 2 })

    const config = await manager.query(api.reservations.getConfig, { storeId })
    const terrasse = config.tables.find((tb) => tb._id === tables['Terrasse 1'])!
    expect(terrasse.roomId).toBeUndefined()
    expect([terrasse.x, terrasse.y, terrasse.width, terrasse.height]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(config.rooms.find((r) => r._id === rooms['Terrasse'])?.archived).toBe(true)
    // Still four tables on the books.
    expect((await openSlots(t, storeId, 4)).length).toBeGreaterThan(0)
  })

  test('restoring a room does not bring its tables back', async () => {
    const t = newHarness()
    const { manager, storeId, rooms, tables } = await seedWorld(t, { rooms: TWO_ROOMS })
    await manager.mutation(api.reservations.archiveRoom, { id: rooms['Salle']!, archived: true })
    const restored = await manager.mutation(api.reservations.archiveRoom, {
      id: rooms['Salle']!,
      archived: false,
    })
    expect(restored).toEqual({ detached: 0 })
    const config = await manager.query(api.reservations.getConfig, { storeId })
    expect(config.rooms.find((r) => r._id === rooms['Salle'])?.archived).toBe(false)
    expect(config.tables.find((tb) => tb._id === tables['Salle 1'])?.roomId).toBeUndefined()
  })

  test('archiving twice is a no-op', async () => {
    const t = newHarness()
    const { manager, rooms } = await seedWorld(t, { rooms: TWO_ROOMS })
    await manager.mutation(api.reservations.archiveRoom, { id: rooms['Salle']!, archived: true })
    await expect(
      manager.mutation(api.reservations.archiveRoom, { id: rooms['Salle']!, archived: true }),
    ).resolves.toEqual({ detached: 0 })
  })
})

describe('tables and rooms', () => {
  test('a table with no room is valid and books like any other', async () => {
    const t = newHarness()
    const { storeId } = await seedWorld(t, { looseTables: 1 })
    const [slot] = await openSlots(t, storeId)
    expect(slot).toBeDefined()
    const result = await bookSlot(t, { storeId }, slot!)
    expect(result.status).toBe('confirmed')
  })

  test('puts a table in a room, and takes it out again', async () => {
    const t = newHarness()
    const { manager, storeId, rooms, tables } = await seedWorld(t, {
      rooms: [{ name: 'Salle', tables: 1 }],
      looseTables: 1,
    })
    const fields = {
      storeId,
      minCovers: 1,
      maxCovers: 4,
      bookableOnline: true,
      outOfService: false,
    }
    await manager.mutation(api.reservations.saveTable, {
      ...fields,
      id: tables['Libre 1']!,
      name: 'Libre 1',
      roomId: rooms['Salle']!,
    })
    let config = await manager.query(api.reservations.getConfig, { storeId })
    expect(config.tables.find((tb) => tb._id === tables['Libre 1'])?.roomId).toBe(rooms['Salle'])

    await manager.mutation(api.reservations.saveTable, {
      ...fields,
      id: tables['Libre 1']!,
      name: 'Libre 1',
    })
    config = await manager.query(api.reservations.getConfig, { storeId })
    expect(config.tables.find((tb) => tb._id === tables['Libre 1'])?.roomId).toBeUndefined()
  })

  test('changing a table’s room forgets where it was drawn; changing its name does not', async () => {
    const t = newHarness()
    const { manager, storeId, rooms, tables } = await seedWorld(t, { rooms: TWO_ROOMS })
    const id = tables['Salle 1']!
    await manager.mutation(api.reservations.saveTableLayout, {
      storeId,
      tables: [{ id, x: 2, y: 2, width: 2, height: 2 }],
    })
    const fields = {
      storeId,
      id,
      minCovers: 1,
      maxCovers: 4,
      bookableOnline: true,
      outOfService: false,
    }

    await manager.mutation(api.reservations.saveTable, {
      ...fields,
      name: 'Renommée',
      roomId: rooms['Salle']!,
    })
    let table = (await manager.query(api.reservations.getConfig, { storeId })).tables.find(
      (tb) => tb._id === id,
    )!
    expect([table.x, table.width]).toEqual([2, 2])

    await manager.mutation(api.reservations.saveTable, {
      ...fields,
      name: 'Renommée',
      roomId: rooms['Terrasse']!,
    })
    table = (await manager.query(api.reservations.getConfig, { storeId })).tables.find(
      (tb) => tb._id === id,
    )!
    expect(table.roomId).toBe(rooms['Terrasse'])
    expect(table.x).toBeUndefined()
  })

  test('refuses an archived room, and a room of another establishment', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { rooms: TWO_ROOMS })
    const other = await seedWorld(t, {
      rooms: [{ name: 'Ailleurs', tables: 1 }],
      profiles: false,
    })
    await world.manager.mutation(api.reservations.archiveRoom, {
      id: world.rooms['Terrasse']!,
      archived: true,
    })
    const fields = {
      storeId: world.storeId,
      name: 'Nouvelle',
      minCovers: 1,
      maxCovers: 4,
      bookableOnline: true,
      outOfService: false,
    }
    expect(
      await refusalCode(
        world.manager.mutation(api.reservations.saveTable, {
          ...fields,
          roomId: world.rooms['Terrasse']!,
        }),
      ),
    ).toBe('invalid_input')
    expect(
      await refusalCode(
        world.manager.mutation(api.reservations.saveTable, {
          ...fields,
          roomId: other.rooms['Ailleurs']!,
        }),
      ),
    ).toBe('invalid_input')
  })
})

describe('what the booking page is told', () => {
  test('offers no choice of area for one room, for none, or on covers', async () => {
    const t = newHarness()
    const none = await seedWorld(t, { looseTables: 2 })
    expect(
      (await t.query(api.reservations.getPublicConfig, { storeId: none.storeId }))?.rooms,
    ).toEqual([])

    const one = await seedWorld(t, { rooms: [{ name: 'Salle', tables: 2 }] })
    expect(
      (await t.query(api.reservations.getPublicConfig, { storeId: one.storeId }))?.rooms,
    ).toEqual([])

    const covers = await seedWorld(t, { rooms: TWO_ROOMS, capacityMode: 'covers' })
    expect(
      (await t.query(api.reservations.getPublicConfig, { storeId: covers.storeId }))?.rooms,
    ).toEqual([])
  })

  test('offers the rooms, in order, by name — and nothing else about them', async () => {
    const t = newHarness()
    const { storeId, rooms } = await seedWorld(t, { rooms: TWO_ROOMS })
    const config = await t.query(api.reservations.getPublicConfig, { storeId })
    expect(config?.rooms).toEqual([
      { id: rooms['Salle'], name: 'Salle' },
      { id: rooms['Terrasse'], name: 'Terrasse' },
    ])
  })

  test('stops offering the choice once only one room can seat an online booking', async () => {
    const t = newHarness()
    const { storeId, manager, rooms, tables } = await seedWorld(t, { rooms: TWO_ROOMS })
    // The terrace is for the team: no table of it is bookable online.
    for (const name of ['Terrasse 1', 'Terrasse 2']) {
      await manager.mutation(api.reservations.saveTable, {
        storeId,
        id: tables[name]!,
        name,
        roomId: rooms['Terrasse']!,
        minCovers: 1,
        maxCovers: 4,
        bookableOnline: false,
        outOfService: false,
      })
    }
    expect((await t.query(api.reservations.getPublicConfig, { storeId }))?.rooms).toEqual([])
  })

  test('drops an archived room from the choice', async () => {
    const t = newHarness()
    const { storeId, manager, rooms } = await seedWorld(t, {
      rooms: [...TWO_ROOMS, { name: 'Bar', tables: 1 }],
    })
    await manager.mutation(api.reservations.archiveRoom, { id: rooms['Bar']!, archived: true })
    const names = (await t.query(api.reservations.getPublicConfig, { storeId }))?.rooms.map(
      (r) => r.name,
    )
    expect(names).toEqual(['Salle', 'Terrasse'])
  })
})

describe('availability with an area preference', () => {
  test('seats the party in the area asked for and says so', async () => {
    const t = newHarness()
    const { storeId, rooms, tables } = await seedWorld(t, { rooms: TWO_ROOMS })
    const [slot] = await openSlots(t, storeId, 2, { roomPreference: rooms['Terrasse']! })
    expect(slot).toMatchObject({ preference: 'met', roomName: 'Terrasse' })

    await bookSlot(t, { storeId }, slot!, { roomPreference: rooms['Terrasse']! })
    const [row] = await reservationRows(t)
    expect([tables['Terrasse 1'], tables['Terrasse 2']]).toContain(row!.tableIds[0])
    expect(row!.roomPreference).toBe(rooms['Terrasse'])
  })

  test('tells nothing about rooms to a diner who did not ask', async () => {
    const t = newHarness()
    const { storeId } = await seedWorld(t, { rooms: TWO_ROOMS })
    const [slot] = await openSlots(t, storeId)
    expect(slot).toMatchObject({ preference: null, roomName: null })
    expect(Object.keys(slot!)).not.toContain('tableIds')
    expect(Object.keys(slot!)).not.toContain('roomId')
  })

  test('offers the other area, clearly, when the preferred one is full at that time', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { rooms: TWO_ROOMS })
    const { storeId, rooms } = world
    // Fill the terrace at 19:00 (two tables of four, two parties).
    const [first] = await openSlots(t, storeId, 2, { roomPreference: rooms['Terrasse']! })
    await bookSlot(t, { storeId }, first!, { roomPreference: rooms['Terrasse']! })
    await bookSlot(t, { storeId }, first!, {
      roomPreference: rooms['Terrasse']!,
      email: 'autre@example.com',
    })

    const slots = await openSlots(t, storeId, 2, { roomPreference: rooms['Terrasse']! })
    const at19 = slots.find((s) => s.startsAt === first!.startsAt)!
    expect(at19).toMatchObject({ available: true, preference: 'other', roomName: 'Salle' })
    // The same hour is still on offer without a preference.
    const without = await openSlots(t, storeId, 2)
    expect(without.some((s) => s.startsAt === first!.startsAt)).toBe(true)
  })

  test('never offers a diner with a preference less than one without', async () => {
    const t = newHarness()
    const { storeId, rooms } = await seedWorld(t, { rooms: TWO_ROOMS })
    const [slot] = await openSlots(t, storeId, 2)
    // Take a terrace table and a room table at 19:00.
    await bookSlot(t, { storeId }, slot!, { roomPreference: rooms['Terrasse']! })
    await bookSlot(t, { storeId }, slot!, {
      roomPreference: rooms['Salle']!,
      email: 'b@example.com',
    })

    const times = async (roomPreference?: (typeof rooms)[string]) =>
      (await openSlots(t, storeId, 2, { roomPreference })).map((s) => s.startsAt)
    const plain = await times()
    expect(await times(rooms['Terrasse'])).toEqual(plain)
    expect(await times(rooms['Salle'])).toEqual(plain)
  })

  test('a booking is refused, not silently moved, when the area fills up and the guest did not accept another', async () => {
    const t = newHarness()
    const { storeId, rooms } = await seedWorld(t, { rooms: TWO_ROOMS })
    const [slot] = await openSlots(t, storeId, 2, { roomPreference: rooms['Terrasse']! })
    // The terrace fills between the page and the click.
    await bookSlot(t, { storeId }, slot!, {
      roomPreference: rooms['Terrasse']!,
      email: 'a@example.com',
    })
    await bookSlot(t, { storeId }, slot!, {
      roomPreference: rooms['Terrasse']!,
      email: 'b@example.com',
    })

    expect(
      await refusalCode(
        bookSlot(t, { storeId }, slot!, {
          roomPreference: rooms['Terrasse']!,
          email: 'c@example.com',
        }),
      ),
    ).toBe('area_unavailable')
    // Accepting the other area books it there.
    const accepted = await bookSlot(t, { storeId }, slot!, {
      roomPreference: rooms['Terrasse']!,
      acceptOtherRoom: true,
      email: 'c@example.com',
    })
    expect(accepted.status).toBe('confirmed')
  })

  test('refuses a room the diner could not have been offered', async () => {
    const t = newHarness()
    const { storeId, manager, rooms } = await seedWorld(t, { rooms: TWO_ROOMS })
    await manager.mutation(api.reservations.archiveRoom, { id: rooms['Terrasse']!, archived: true })
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, {
          storeId,
          date: dateIn(10),
          partySize: 2,
          roomPreference: rooms['Terrasse']!,
        }),
      ),
    ).toBe('invalid_input')
  })

  test('where a table is drawn changes nothing; which room it is in only changes which table', async () => {
    const t = newHarness()
    const { storeId, manager, tables } = await seedWorld(t, { rooms: TWO_ROOMS })
    const before = (await openSlots(t, storeId, 4)).map((s) => s.startsAt)
    await manager.mutation(api.reservations.saveTableLayout, {
      storeId,
      tables: [{ id: tables['Salle 1']!, x: 30, y: 20, width: 4, height: 3 }],
    })
    expect((await openSlots(t, storeId, 4)).map((s) => s.startsAt)).toEqual(before)
  })

  test('is ignored on a book that runs on covers', async () => {
    const t = newHarness()
    const { storeId, rooms } = await seedWorld(t, { rooms: TWO_ROOMS, capacityMode: 'covers' })
    // The page never offers the choice here; a hand-built request is refused like any stale room.
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, {
          storeId,
          date: dateIn(10),
          partySize: 2,
          roomPreference: rooms['Salle']!,
        }),
      ),
    ).toBe('invalid_input')
  })
})
