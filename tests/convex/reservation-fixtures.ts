/**
 * A booking book to test against: one native establishment, a dinner service
 * every night, and — when asked — rooms with tables in them, a manager who may
 * override and a waiter who may not.
 *
 * Shared by the room, change and placement suites so each file states what it
 * is about instead of rebuilding the same world. Not a test file: Vitest runs
 * `*.test.ts` only.
 */

import { convexTest } from 'convex-test'
import { afterEach } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'
import { wallClockToInstant } from '@be-yours/convex-schema'

export const NOW = Date.now()
export const DAY = 24 * 60 * 60_000

export type Harness = ReturnType<typeof convexTest>

const modules = import.meta.glob('../../convex/**/*.ts')

/**
 * A harness factory that also leaves nothing on the scheduler once a test ends
 * (see `reservations.test.ts` for why cancelling a running job is the wrong way).
 *
 * NOT named `use…`: it registers an `afterEach` and returns a function, it is not a React
 * hook, and the name made `react-hooks/rules-of-hooks` reject every suite that called it
 * at the top level of its file.
 */
export function createHarnessFactory() {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const t of harnesses) {
      await t.finishInProgressScheduledFunctions()
      await t.run(async (ctx) => {
        const pending = await ctx.db.system.query('_scheduled_functions').collect()
        for (const job of pending) {
          if (job.state.kind === 'pending' || job.state.kind === 'inProgress') {
            await ctx.scheduler.cancel(job._id)
          }
        }
      })
    }
    harnesses.length = 0
  })
  return () => {
    const t = convexTest(schema, modules)
    harnesses.push(t)
    return t
  }
}

/** A date `days` out, in the restaurant's calendar (Paris). */
export function dateIn(days: number): string {
  return new Date(NOW + days * DAY).toISOString().slice(0, 10)
}

export interface WorldOptions {
  autoConfirm?: boolean
  capacityMode?: 'covers' | 'tables'
  cancellationDeadlineHours?: number
  guestChangeCutoffHours?: number
  /** Rooms to create, each with that many tables of four. */
  rooms?: Array<{ name: string; tables: number }>
  /** Tables of four with no room. */
  looseTables?: number
  storeEmail?: string
  turnoverBufferMinutes?: number
  /** `false` for a second establishment in the same deployment: the team is already seeded. */
  profiles?: boolean
}

export interface World {
  storeId: Id<'stores'>
  serviceId: Id<'reservationServices'>
  rooms: Record<string, Id<'reservationRooms'>>
  /** Table ids by name: `Salle 1`, `Salle 2`, `Terrasse 1`…, `Libre 1`… */
  tables: Record<string, Id<'reservationTables'>>
  manager: ReturnType<Harness['withIdentity']>
  waiter: ReturnType<Harness['withIdentity']>
}

export async function seedWorld(t: Harness, options: WorldOptions = {}): Promise<World> {
  const seeded = await t.run(async (ctx) => {
    const storeId = await ctx.db.insert('stores', {
      name: 'Chez Luigi',
      slug: 'luigi',
      address: {
        street: '1 rue de la Paix',
        city: 'Paris',
        postalCode: '75002',
        country: 'France',
      },
      ...(options.storeEmail ? { email: options.storeEmail } : {}),
      hours: [],
      status: 'open' as const,
      reservationMode: 'native' as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert('reservationSettings', {
      storeId,
      capacityMode: options.capacityMode ?? 'tables',
      slotStepMinutes: 30,
      turnoverBufferMinutes: options.turnoverBufferMinutes ?? 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      maxSimultaneousCovers: 20,
      autoConfirm: options.autoConfirm ?? true,
      cancellationDeadlineHours: options.cancellationDeadlineHours ?? 2,
      ...(options.guestChangeCutoffHours !== undefined
        ? { guestChangeCutoffHours: options.guestChangeCutoffHours }
        : {}),
      noticeVersion: 'v1',
      updatedAt: NOW,
    })
    const serviceId = await ctx.db.insert('reservationServices', {
      storeId,
      name: 'Dîner',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: '19:00',
      end: '22:00',
      durations: [{ upToParty: 99, minutes: 90 }],
      bookableOnline: true,
      sortOrder: 0,
    })
    const rooms: Record<string, Id<'reservationRooms'>> = {}
    const tables: Record<string, Id<'reservationTables'>> = {}
    const table = (name: string, roomId?: Id<'reservationRooms'>) =>
      ctx.db.insert('reservationTables', {
        storeId,
        name,
        ...(roomId ? { roomId } : {}),
        minCovers: 1,
        maxCovers: 4,
        bookableOnline: true,
        outOfService: false,
      })
    let order = 0
    for (const room of options.rooms ?? []) {
      const roomId = await ctx.db.insert('reservationRooms', {
        storeId,
        name: room.name,
        sortOrder: order++,
        archived: false,
      })
      rooms[room.name] = roomId
      for (let i = 1; i <= room.tables; i++) {
        tables[`${room.name} ${i}`] = await table(`${room.name} ${i}`, roomId)
      }
    }
    for (let i = 1; i <= (options.looseTables ?? 0); i++) {
      tables[`Libre ${i}`] = await table(`Libre ${i}`)
    }
    for (const [userId, role] of options.profiles === false
      ? []
      : ([
          ['manager', 'client_admin'],
          ['waiter', 'waiter'],
        ] as const)) {
      await ctx.db.insert('userProfiles', {
        userId,
        role,
        storeIds: [storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
    return { storeId, serviceId, rooms, tables }
  })
  return {
    ...seeded,
    manager: t.withIdentity({ subject: 'manager' }),
    waiter: t.withIdentity({ subject: 'waiter' }),
  }
}

export const guest = { name: 'Marie Dupont', email: 'marie@example.com', phone: '0612345678' }

/** The refusal code a rejected call carried (serialised under `convex-test`). */
export async function refusalCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (error) {
    const data = (error as { data?: unknown }).data
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    return (parsed as { code?: string } | undefined)?.code
  }
  return undefined
}

/** A message a rejected call carried, for the refusals that name what is in the way. */
export async function refusalMessage(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (error) {
    const data = (error as { data?: unknown }).data
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    return (parsed as { message?: string } | undefined)?.message
  }
  return undefined
}

export async function openSlots(
  t: Harness,
  storeId: Id<'stores'>,
  partySize = 2,
  extra: { roomPreference?: Id<'reservationRooms'>; date?: string } = {},
) {
  const slots = await t.query(api.reservations.getAvailability, {
    storeId,
    date: extra.date ?? dateIn(10),
    partySize,
    ...(extra.roomPreference ? { roomPreference: extra.roomPreference } : {}),
  })
  return slots.filter((s) => s.available)
}

export async function bookSlot(
  t: Harness,
  world: Pick<World, 'storeId'>,
  slot: { serviceId: string; startsAt: number },
  extra: {
    partySize?: number
    date?: string
    email?: string
    name?: string
    note?: string
    roomPreference?: Id<'reservationRooms'>
    acceptOtherRoom?: boolean
  } = {},
) {
  return t.mutation(api.reservations.create, {
    storeId: world.storeId,
    date: extra.date ?? dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize: extra.partySize ?? 2,
    guest: {
      name: extra.name ?? guest.name,
      email: extra.email ?? guest.email,
      phone: guest.phone,
    },
    note: extra.note,
    consentNoticeVersion: 'v1',
    roomPreference: extra.roomPreference,
    acceptOtherRoom: extra.acceptOtherRoom,
  })
}

export const reservationRows = (t: Harness) =>
  t.run((ctx) => ctx.db.query('reservations').collect())
export const eventRows = (t: Harness) => t.run((ctx) => ctx.db.query('reservationEvents').collect())
export const rowById = (t: Harness, id: Id<'reservations'>) => t.run((ctx) => ctx.db.get(id))

let seeded = 0

export interface SeedBookingOptions {
  date: string
  /** "HH:MM" in Paris. */
  time: string
  partySize?: number
  status?: Doc<'reservations'>['status']
  channel?: 'online' | 'staff' | 'walk_in'
  email?: string
  name?: string
  /** Hours the booking was made before it starts. Default 24. */
  leadHours?: number
  /** Minutes between the start and `seatedAt` / `completedAt` for a completed sitting. */
  seatedAfterMin?: number
  mealMinutes?: number
  feedbackScore?: number
  feedbackComment?: string
  feedbackAnsweredAt?: number
  guestNote?: string
  completedAt?: number
  /** Table name from the world, default the first one. */
  table?: string
  notices?: Doc<'reservations'>['notices']
  reconfirmedAt?: number
  createdAt?: number
  minutes?: number
}

/**
 * Insert a booking row directly, for the suites that need a book with a known past:
 * statistics, alerts, thank-yous. It bypasses the booking functions on purpose — it is
 * how a day last month gets its parties — so nothing marks the day or claims a notice.
 */
export async function seedBooking(
  t: Harness,
  world: Pick<World, 'storeId' | 'serviceId' | 'tables'>,
  options: SeedBookingOptions,
): Promise<Id<'reservations'>> {
  const startsAt = wallClockToInstant(options.date, options.time, 'Europe/Paris')!.at
  const tableId = options.table ? world.tables[options.table]! : Object.values(world.tables)[0]
  const n = ++seeded
  const status = options.status ?? 'confirmed'
  const walkIn = options.channel === 'walk_in'
  const seatedAt =
    status === 'completed' || status === 'seated'
      ? startsAt + (options.seatedAfterMin ?? 0) * 60_000
      : undefined
  return await t.run((ctx) =>
    ctx.db.insert('reservations', {
      storeId: world.storeId,
      reference: `RES-SEED-${String(n).padStart(5, '0')}`,
      status,
      serviceId: world.serviceId,
      startsAt,
      endsAt: startsAt + (options.minutes ?? 90) * 60_000,
      partySize: options.partySize ?? 2,
      tableIds: tableId ? [tableId] : [],
      guestName: walkIn ? '' : (options.name ?? 'Marie Dupont'),
      guestEmail: walkIn ? '' : (options.email ?? `seed${n}@example.com`),
      guestPhone: walkIn ? '' : '0612345678',
      ...(options.guestNote ? { guestNote: options.guestNote } : {}),
      channel: options.channel ?? 'online',
      manageToken: `seed-token-${String(n).padStart(6, '0')}-${crypto.randomUUID()}`,
      ...(seatedAt !== undefined ? { seatedAt } : {}),
      ...(status === 'completed'
        ? {
            completedAt:
              options.completedAt ?? (seatedAt ?? startsAt) + (options.mealMinutes ?? 90) * 60_000,
          }
        : {}),
      ...(options.feedbackScore !== undefined
        ? {
            feedbackScore: options.feedbackScore,
            ...(options.feedbackComment ? { feedbackComment: options.feedbackComment } : {}),
            feedbackAnsweredAt: options.feedbackAnsweredAt ?? startsAt + 4 * 3_600_000,
          }
        : {}),
      ...(options.notices ? { notices: options.notices } : {}),
      ...(options.reconfirmedAt !== undefined ? { reconfirmedAt: options.reconfirmedAt } : {}),
      createdAt: options.createdAt ?? startsAt - (options.leadHours ?? 24) * 3_600_000,
      updatedAt: startsAt,
    }),
  )
}

/** Recompute a period's rollup rows now, the way the sweep would. */
export async function rebuildStats(
  t: Harness,
  world: Pick<World, 'manager'>,
  storeId: Id<'stores'>,
  from: string,
  to: string,
) {
  await world.manager.mutation(api.reservationStats.rebuild, { storeId, from, to })
  for (let i = 0; i < 40; i++) {
    const { hasMore } = await t.mutation(internal.reservationStats.sweepDirty, {})
    if (!hasMore) return
  }
  throw new Error('the statistics sweep never finished')
}

export const statsRows = (t: Harness) =>
  t.run((ctx) => ctx.db.query('reservationStatsDaily').collect())
