// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Second review, findings 7, 9 and the event part of 10.
 *
 *  7. an anonymous visitor cannot fake « complet » on an event: seats held for a payment that
 *     has not come are capped per event, and junk tickets cannot crowd the real attendees out
 *     of the host's door list;
 *  9. cancelling an event whose run failed midway is resumed, by a sweep and from the screen;
 * 10. editing a published event marks the day it LEFT as well as the day it went to.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** Failure injection: the ticket whose reference is named cannot be cancelled by `applyStatus`. */
const inject = vi.hoisted(() => ({ failRef: null as string | null }))

vi.mock('@be-yours/convex-functions/reservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@be-yours/convex-functions/reservations')>()
  return {
    ...actual,
    applyStatus: async (...args: Parameters<typeof actual.applyStatus>) => {
      if (inject.failRef !== null && args[1].reference === inject.failRef) {
        throw new Error('injected failure')
      }
      return actual.applyStatus(...args)
    },
  }
})
import { api, internal } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { wallClockToInstant } from '@be-yours/convex-schema'
import {
  NOW,
  createHarnessFactory,
  dateIn,
  guest,
  refusalCode,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'
import {
  bookingByToken,
  payBooking,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
beforeEach(() => {
  inject.failRef = null
  stubPaymentWorld()
})
afterEach(unstubPaymentWorld)

const instant = (days: number, time: string) =>
  wallClockToInstant(dateIn(days), time, 'Europe/Paris')!.at

async function experienceWorld(t: Harness): Promise<World> {
  await setupGlobalSettings(t)
  return await seedWorld(t, {
    capacityMode: 'covers',
    autoConfirm: true,
    rooms: [{ name: 'Salle', tables: 6 }],
  })
}

async function publishedEvent(world: World, over: Record<string, unknown> = {}) {
  const { id } = await world.manager.mutation(api.reservationExperiences.saveExperience, {
    storeId: world.storeId,
    title: 'Soirée dégustation',
    description: 'Six vins.',
    startsAt: instant(14, '21:00'),
    endsAt: instant(14, '23:00'),
    seats: 8,
    priceCents: 6500,
    cancellationCutoffHours: 48,
    maxSeatsPerBooking: 2,
    ...over,
  } as never)
  await world.manager.mutation(api.reservationExperiences.publishExperience, { id })
  return id as Id<'reservationExperiences'>
}

const buy = (
  t: Harness,
  experienceId: Id<'reservationExperiences'>,
  extra: { seats?: number; email?: string } = {},
) =>
  t.mutation(api.reservationExperiences.buy, {
    experienceId,
    seats: extra.seats ?? 2,
    guest: { ...guest, email: extra.email ?? guest.email },
    consentNoticeVersion: 'v1',
    paymentConsent: true,
  })

/* ------------------------------------------------------------------ */
/* 7 — unpaid holds cannot fake « sold out »                           */
/* ------------------------------------------------------------------ */

describe('seats held for a payment that has not come', () => {
  test('are capped per event, whoever asks, and a paid ticket frees its share of the cap', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    // 8 seats, at most 2 a booking: half the room, 4 seats, may wait for a payment at once.
    const first = await buy(t, id, { email: 'a@example.com' })
    await buy(t, id, { email: 'b@example.com' })
    expect(await refusalCode(buy(t, id, { email: 'c@example.com' }))).toBe('experience_holds_busy')
    // Throwaway addresses do not help: the cap is on the event, not on the identity.
    expect(await refusalCode(buy(t, id, { email: 'd@example.com', seats: 1 }))).toBe(
      'experience_holds_busy',
    )
    // The real seats left are untouched by the refusal: the event is not « complet ».
    const [card] = await t.query(api.reservationExperiences.listPublic, { storeId: world.storeId })
    expect(card!.state).toBe('on_sale')

    // A payment turns the hold into a sold seat and lets the next guest in.
    await payBooking(t, first.manageToken)
    await expect(buy(t, id, { email: 'c@example.com' })).resolves.toMatchObject({
      status: 'pending_payment',
    })
  })

  test('a free event holds nothing unpaid, so the cap never applies to it', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { priceCents: 0 })
    for (let i = 0; i < 4; i++) await buy(t, id, { email: `free${i}@example.com` })
    expect(
      (await t.query(api.reservationExperiences.listPublic, { storeId: world.storeId }))[0],
    ).toMatchObject({ seatsLeft: 0, state: 'sold_out' })
  })

  test('the hold of a single party is always allowed, even on a small event', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { seats: 4, maxSeatsPerBooking: 4 })
    await expect(buy(t, id, { seats: 4 })).resolves.toMatchObject({ status: 'pending_payment' })
  })
})

describe('the host’s door list', () => {
  test('shows the standing tickets however many abandoned ones came before', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world, { priceCents: 0, seats: 20, maxSeatsPerBooking: 4 })
    const event = (await t.run((ctx) => ctx.db.get(id)))!
    // 700 abandoned tickets, written FIRST: the index order the read used to take.
    await t.run(async (ctx) => {
      for (let i = 0; i < 700; i++) {
        await ctx.db.insert('reservations', ticketRow(event, i, 'expired'))
      }
    })
    await buy(t, id, { email: 'real1@example.com' })
    await buy(t, id, { email: 'real2@example.com' })

    const list = await world.manager.query(api.reservationExperiences.listAttendees, { id })
    const names = list.attendees.filter((a) => a.status === 'confirmed')
    expect(names).toHaveLength(2)
    expect(list.attendees.length).toBeLessThan(700)
    expect(list.seatsByStatus.confirmed).toBe(4)
    // Standing seats are exact; what was cut is the abandoned tickets, and the screen is told.
    expect(list.truncated).toBe(true)
  })
})

function ticketRow(
  event: Doc<'reservationExperiences'>,
  i: number,
  status: Doc<'reservations'>['status'],
) {
  return {
    storeId: event.storeId,
    reference: `RES-JUNK-${i}`,
    status,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    partySize: 1,
    tableIds: [],
    kind: 'experience' as const,
    experienceId: event._id,
    guestName: `Junk ${i}`,
    guestEmail: `junk${i}@example.com`,
    guestPhone: '0600000000',
    channel: 'online' as const,
    manageToken: `junk-token-${String(i).padStart(6, '0')}`,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

void bookingByToken

/* ------------------------------------------------------------------ */
/* 9 — a cancellation that failed midway is resumed                     */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000

/**
 * Run `act` under a fake clock, then let everything it scheduled run, the one-second continuations
 * included. The clock must be fake BEFORE the call: a timer is armed when the job is scheduled.
 */
async function settled<T>(t: Harness, act: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const result = await act()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return result
  } finally {
    vi.useRealTimers()
  }
}

async function bigEvent(t: Harness) {
  const world = await experienceWorld(t)
  const id = await publishedEvent(world, { priceCents: 0, seats: 20, maxSeatsPerBooking: 4 })
  const event = (await t.run((ctx) => ctx.db.get(id)))!
  await t.run(async (ctx) => {
    for (let i = 0; i < 130; i++) {
      await ctx.db.insert('reservations', ticketRow(event, i, 'confirmed'))
    }
  })
  return { world, id }
}

const statuses = (t: Harness) =>
  t
    .run((ctx) => ctx.db.query('reservations').collect())
    .then((rows) => {
      const counts: Record<string, number> = {}
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1
      return counts
    })

async function failedMidway(t: Harness) {
  const { world, id } = await bigEvent(t)
  // The 100th ticket sits in the second batch of sixty: the first batch commits, the second fails.
  inject.failRef = 'RES-JUNK-99'
  await settled(t, () =>
    world.manager.mutation(api.reservationExperiences.cancelExperience, { id }),
  )
  inject.failRef = null
  return { world, id }
}

describe('cancelling an event', () => {
  test('a run that failed midway leaves the event marked, and the host can resume it', async () => {
    const t = newHarness()
    const { world, id } = await failedMidway(t)
    const left = await statuses(t)
    expect(left.cancelled_by_restaurant).toBe(60)
    expect(left.confirmed).toBe(70)
    const event = (await t.run((ctx) => ctx.db.get(id)))!
    expect(event.status).toBe('cancelled')
    expect(event.cancelPendingAt).toBeGreaterThan(0)
    const card = (await world.manager.query(api.reservationExperiences.listExperiences, {
      storeId: world.storeId,
    })) as { experiences: Array<{ cancelling?: boolean }> }
    expect(card.experiences[0]!.cancelling).toBe(true)

    await settled(t, () =>
      world.manager.mutation(api.reservationExperiences.cancelExperience, { id }),
    )
    expect(await statuses(t)).toEqual({ cancelled_by_restaurant: 130 })
    expect((await t.run((ctx) => ctx.db.get(id)))!.cancelPendingAt).toBeUndefined()
  })

  test('a sweep resumes a cancellation nobody came back to, and leaves a live one alone', async () => {
    const t = newHarness()
    const { id } = await failedMidway(t)

    // Just failed: a chain could still be running, so the sweep waits.
    await settled(t, () => t.mutation(internal.reservationExperiences.resumeCancellations, {}))
    expect((await statuses(t)).confirmed).toBe(70)

    await t.run(async (ctx) => {
      await ctx.db.patch(id, { cancelPendingAt: Date.now() - 10 * MINUTE })
    })
    await settled(t, () => t.mutation(internal.reservationExperiences.resumeCancellations, {}))
    expect(await statuses(t)).toEqual({ cancelled_by_restaurant: 130 })
    expect((await t.run((ctx) => ctx.db.get(id)))!.cancelPendingAt).toBeUndefined()
  })

  test('is idempotent per ticket, and a finished cancellation is still refused as already done', async () => {
    const t = newHarness()
    const { world, id } = await failedMidway(t)
    await settled(t, () =>
      world.manager.mutation(api.reservationExperiences.cancelExperience, { id }),
    )
    const before = await t.run((ctx) => ctx.db.query('reservationEvents').collect())
    await t.mutation(internal.reservationExperiences.cancelTickets, { id })
    expect(await t.run((ctx) => ctx.db.query('reservationEvents').collect())).toHaveLength(
      before.length,
    )
    expect(
      await refusalCode(
        world.manager.mutation(api.reservationExperiences.cancelExperience, { id }),
      ),
    ).toBe('invalid_input')
  })
})

describe('editing a published event', () => {
  test('marks the day it left as well as the day it went to', async () => {
    const t = newHarness()
    const world = await experienceWorld(t)
    const id = await publishedEvent(world)
    // Settle every mark the publication left.
    for (let i = 0; i < 10; i++) {
      const { hasMore } = await t.mutation(internal.reservationStats.sweepDirty, {})
      if (!hasMore) break
    }
    const dirty = async () =>
      (await t.run((ctx) => ctx.db.query('reservationStatsDaily').collect()))
        .filter((row) => row.dirtyAt !== undefined)
        .map((row) => row.date)
    expect(await dirty()).toEqual([])

    await world.manager.mutation(api.reservationExperiences.saveExperience, {
      storeId: world.storeId,
      id,
      title: 'Soirée dégustation',
      description: 'Six vins.',
      startsAt: instant(16, '21:00'),
      endsAt: instant(16, '23:00'),
      seats: 8,
      priceCents: 6500,
      cancellationCutoffHours: 48,
      maxSeatsPerBooking: 2,
    } as never)
    expect((await dirty()).sort()).toEqual([dateIn(14), dateIn(16)])
  })
})
