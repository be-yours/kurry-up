// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The sweep that closes table requests nobody answered.
 *
 * Rows are written straight into the table: the sweep is driven by the clock,
 * and a booking in the past is not something `create` would let anyone make.
 */

import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = Date.now()
const HOUR = 60 * 60_000

type Harness = ReturnType<typeof convexTest>
type Status = 'pending' | 'pending_payment' | 'confirmed' | 'arrived' | 'completed'

async function seedBooking(t: Harness, status: Status, startsAt: number, index = 0) {
  return t.run(async (ctx) => {
    const storeId = await ctx.db.insert('stores', {
      name: `Chez Luigi ${index}`,
      slug: `luigi-${index}-${startsAt}-${status}`,
      address: {
        street: '1 rue de la Paix',
        city: 'Paris',
        postalCode: '75002',
        country: 'France',
      },
      hours: [],
      status: 'open' as const,
      reservationMode: 'native' as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const serviceId = await ctx.db.insert('reservationServices', {
      storeId,
      name: 'Dîner',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: '19:00',
      end: '23:00',
      durations: [{ upToParty: 8, minutes: 90 }],
      bookableOnline: true,
      sortOrder: 0,
    })
    const id = await ctx.db.insert('reservations', {
      storeId,
      reference: `RES-TEST-${index}-${status}-${startsAt}`,
      status,
      serviceId,
      startsAt,
      endsAt: startsAt + 90 * 60_000,
      partySize: 2,
      tableIds: [],
      guestName: 'Marie Dupont',
      guestEmail: 'marie@example.com',
      guestPhone: '0601020304',
      channel: 'online' as const,
      manageToken: `token-${index}-${status}-${startsAt}`,
      createdAt: NOW - 3 * HOUR,
      updatedAt: NOW - 3 * HOUR,
    })
    return { id: id as Id<'reservations'>, storeId }
  })
}

const rowOf = (t: Harness, id: Id<'reservations'>) => t.run((ctx) => ctx.db.get(id))

describe('expiring unanswered requests', () => {
  test('a request whose time has passed expires, by the system, and says nothing to the guest', async () => {
    const t = convexTest(schema, modules)
    const { id } = await seedBooking(t, 'pending', NOW - HOUR)

    const result = await t.mutation(internal.reservations.expireUnanswered, {})

    expect(result).toEqual({ expired: 1 })
    const row = await rowOf(t, id)
    expect(row?.status).toBe('expired')
    // Restaurant-side exit: no cancellation stamp, so nothing could be charged.
    expect(row?.cancelledAt).toBeUndefined()
    const events = await t.run((ctx) =>
      ctx.db
        .query('reservationEvents')
        .withIndex('by_reservationId', (q) => q.eq('reservationId', id))
        .collect(),
    )
    expect(events).toMatchObject([{ actor: 'system', from: 'pending', to: 'expired' }])
    // No mail is claimed: the hour has passed and an e-mail now would be noise.
    expect(row?.notices?.pending).toBeUndefined()
    expect(
      await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()),
    ).toHaveLength(0)
  })

  test('a request still ahead of its time is left for the restaurant to answer', async () => {
    const t = convexTest(schema, modules)
    const { id } = await seedBooking(t, 'pending', NOW + HOUR)
    expect(await t.mutation(internal.reservations.expireUnanswered, {})).toEqual({ expired: 0 })
    expect((await rowOf(t, id))?.status).toBe('pending')
  })

  test('only requests expire: a confirmed or finished booking in the past is not touched', async () => {
    const t = convexTest(schema, modules)
    const confirmed = await seedBooking(t, 'confirmed', NOW - HOUR, 1)
    const arrived = await seedBooking(t, 'arrived', NOW - HOUR, 2)
    const completed = await seedBooking(t, 'completed', NOW - 5 * HOUR, 3)

    expect(await t.mutation(internal.reservations.expireUnanswered, {})).toEqual({ expired: 0 })
    expect((await rowOf(t, confirmed.id))?.status).toBe('confirmed')
    expect((await rowOf(t, arrived.id))?.status).toBe('arrived')
    expect((await rowOf(t, completed.id))?.status).toBe('completed')
  })

  test('an accepted-but-unpaid booking lapses the same way', async () => {
    const t = convexTest(schema, modules)
    const { id } = await seedBooking(t, 'pending_payment', NOW - HOUR)
    expect(await t.mutation(internal.reservations.expireUnanswered, {})).toEqual({ expired: 1 })
    expect((await rowOf(t, id))?.status).toBe('expired')
  })

  test('sweeps every establishment in one run, and a second run finds nothing', async () => {
    const t = convexTest(schema, modules)
    const a = await seedBooking(t, 'pending', NOW - 2 * HOUR, 1)
    const b = await seedBooking(t, 'pending', NOW - HOUR, 2)

    expect(await t.mutation(internal.reservations.expireUnanswered, {})).toEqual({ expired: 2 })
    expect((await rowOf(t, a.id))?.status).toBe('expired')
    expect((await rowOf(t, b.id))?.status).toBe('expired')
    expect(await t.mutation(internal.reservations.expireUnanswered, {})).toEqual({ expired: 0 })
  })
})
