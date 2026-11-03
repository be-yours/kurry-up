// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Second review, finding 4 (and the cheap ones of finding 10 that live in the statistics): one
 * day that cannot be computed must not block the sweep for everybody, nor leave the daily report
 * holding a claim it will never use.
 *
 * The failure is injected the way production reaches it: more than 60 published events in one
 * window make `liveExperienceHolds` refuse with `book_too_busy`, and every statistics read of a
 * day around them throws.
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

import { wallClockToInstant } from '@be-yours/convex-schema'
import { api, internal } from '../../convex/_generated/api'
import {
  createHarnessFactory,
  dateIn,
  seedBooking,
  seedWorld,
  statsRows,
  type Harness,
} from './reservation-fixtures'
import {
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const at = (days: number, time: string) =>
  wallClockToInstant(dateIn(days), time, 'Europe/Paris')!.at

beforeEach(() => {
  ses.sends.length = 0
  stubPaymentWorld()
  vi.stubEnv('AWS_SES_FROM_EMAIL', 'no-reply@beindigital.example')
  vi.stubEnv('AWS_REGION', 'eu-west-3')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret')
  vi.stubEnv('SITE_URL', 'https://chez-luigi.example')
})
afterEach(() => {
  vi.useRealTimers()
  unstubPaymentWorld()
  vi.unstubAllEnvs()
})

/** A published event on day +14 and sixty more like it: every read around that day refuses. */
async function overloadedWorld(t: Harness) {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    capacityMode: 'covers',
    autoConfirm: true,
    looseTables: 6,
    storeEmail: 'contact@luigi.fr',
  })
  const { id } = await world.manager.mutation(api.reservationExperiences.saveExperience, {
    storeId: world.storeId,
    title: 'Soirée',
    description: 'x',
    startsAt: at(14, '19:00'),
    endsAt: at(14, '21:00'),
    seats: 2,
    priceCents: 0,
    cancellationCutoffHours: 48,
    maxSeatsPerBooking: 2,
  } as never)
  await world.manager.mutation(api.reservationExperiences.publishExperience, { id })
  await t.run(async (ctx) => {
    const { _id, _creationTime, ...event } = (await ctx.db.get(id))!
    void _id
    void _creationTime
    for (let i = 0; i < 61; i++) await ctx.db.insert('reservationExperiences', event)
  })
  return world
}

describe('the statistics sweep', () => {
  test('a day that cannot be computed waits its turn instead of blocking every other day', async () => {
    const t = newHarness()
    const world = await overloadedWorld(t)
    await seedBooking(t, world, { date: dateIn(5), time: '19:30', status: 'confirmed' })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(5),
      to: dateIn(5),
    })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: dateIn(14),
      to: dateIn(14),
    })

    const result = await t.mutation(internal.reservationStats.sweepDirty, {})
    expect(result.hasMore).toBe(false)

    const rows = await statsRows(t)
    const healthy = rows.find((row) => row.date === dateIn(5))!
    const failing = rows.find((row) => row.date === dateIn(14))!
    expect(healthy.dirtyAt).toBeUndefined()
    expect(healthy.refreshedAt).toBeGreaterThan(0)
    // The failing day is not retried at once: its mark is pushed into the future.
    expect(failing.dirtyAt).toBeGreaterThan(Date.now())

    // The next sweep neither throws nor touches it before its time.
    const again = await t.mutation(internal.reservationStats.sweepDirty, {})
    expect(again).toMatchObject({ refreshed: 0, hasMore: false })
  })
})

describe('the daily report', () => {
  test('gives its claim back, and says why, when the book cannot be read', async () => {
    const t = newHarness()
    const world = await overloadedWorld(t)
    await world.manager.mutation(api.reservationAutomations.save, {
      storeId: world.storeId,
      dailyReportEnabled: true,
      recipients: ['chef@example.com'],
    })
    // Yesterday, for a report sent on day +15, is the overloaded day +14.
    vi.useFakeTimers({ now: at(15, '17:05') })
    await t.mutation(internal.reservationAutomations.sendDue, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined)
    vi.useRealTimers()

    const row = (await t.run((ctx) => ctx.db.query('reservationAutomations').first()))!
    expect(row.dailyReportClaimedFor).toBeUndefined()
    expect(row.dailyReportFailure).toMatchObject({ reason: 'transport' })
    expect(ses.sends).toHaveLength(0)
  })
})

describe('the day read', () => {
  test('is not cut short by a busy evening the day before', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const target = dateIn(5)
    const previous = dateIn(4)
    await seedBooking(t, world, { date: target, time: '19:30', partySize: 3 })
    // A previous evening with more bookings than one read takes: they come first in index order.
    await t.run(async (ctx) => {
      const [first] = await ctx.db.query('reservations').collect()
      const { _id, _creationTime, ...row } = first!
      void _id
      void _creationTime
      const base = wallClockToInstant(previous, '22:00', 'Europe/Paris')!.at
      for (let i = 0; i < 1005; i++) {
        await ctx.db.insert('reservations', {
          ...row,
          reference: `RES-BUSY-${i}`,
          manageToken: `busy-token-${i}`,
          startsAt: base + (i % 50) * 60_000,
          endsAt: base + 90 * 60_000,
          partySize: 1,
        })
      }
    })
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: target,
      to: target,
    })
    await t.mutation(internal.reservationStats.sweepDirty, {})
    const row = (await statsRows(t)).find((r) => r.date === target)!
    // The day's own booking is counted, and the figure is whole: the evening before only lends windows.
    expect(row.channels.online.bookings).toBe(1)
    expect(row.channels.online.covers).toBe(3)
    expect(row.truncated).toBe(false)
  })
})
