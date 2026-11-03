// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Second review, finding 1: a public join must never hand out, or act on, an entry
 * that only an e-mail address matched.
 *
 * Before: an anonymous `join` with a victim's address (folded) matched the victim's open
 * entry, overwrote its name and phone, and returned `mine.token` — the credential for
 * `leave`, `claim` and, after a claim, the booking's manage token.
 *
 * Now: the response is the same for a fresh and a repeated join (`{ joined: true }`, no
 * token), a repeated join patches nothing, and the link goes by e-mail to the address
 * STORED on the entry, at most once an hour per entry.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface CapturedEmail {
  Destination: { ToAddresses: string[] }
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } }
}

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

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  bookSlot,
  dateIn,
  openSlots,
  refusalCode,
  reservationRows,
  seedWorld,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const sent = () => ses.sends as CapturedEmail[]
const VERSION = 'fr-2026-10'
const DATE = dateIn(10)

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

async function fullHouse(t: Harness): Promise<World> {
  const world = await seedWorld(t, { looseTables: 1 })
  await t.run(async (ctx) => {
    const settings = await ctx.db.query('reservationSettings').first()
    await ctx.db.patch(settings!._id, { waitlistEnabled: true })
  })
  for (let i = 0; i < 20; i++) {
    const [slot] = await openSlots(t, world.storeId)
    if (!slot) break
    await bookSlot(t, world, slot, { email: `full${i}@example.com`, name: `Full ${i}` })
  }
  void reservationRows
  return world
}

const join = (
  t: Harness,
  world: Pick<World, 'storeId'>,
  guestInfo: { name: string; email: string; phone: string },
) =>
  t.mutation(api.reservationWaitlist.join, {
    storeId: world.storeId,
    guest: guestInfo,
    partySize: 2,
    date: DATE,
    privacyNoticeVersion: VERSION,
  })

const entries = (t: Harness) => t.run((ctx) => ctx.db.query('waitlistEntries').collect())

describe('a repeated join with someone else’s address', () => {
  test('returns no token, patches nothing, and answers like a fresh join', async () => {
    const t = newHarness()
    const world = await fullHouse(t)
    const victim = await deliver(t, () =>
      join(t, world, { name: 'Victim', email: 'victim@example.com', phone: '0611111111' }),
    )
    const attacker = await deliver(t, () =>
      join(t, world, { name: 'Attacker', email: ' VICTIM@example.com ', phone: '0699999999' }),
    )

    expect(attacker).toEqual(victim)
    expect(Object.keys(attacker)).not.toContain('token')
    const rows = await entries(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ guestName: 'Victim', guestPhone: '0611111111' })
  })

  test('the link goes to the stored address, once an hour, never to the caller', async () => {
    const t = newHarness()
    const world = await fullHouse(t)
    await deliver(t, () =>
      join(t, world, { name: 'Victim', email: 'victim@example.com', phone: '0611111111' }),
    )
    const [entry] = await entries(t)
    const toVictim = () =>
      sent().filter((m) => m.Destination.ToAddresses[0] === 'victim@example.com')
    expect(toVictim()).toHaveLength(1)
    expect(toVictim()[0]!.Content.Simple.Body.Text.Data).toContain(
      `https://chez-luigi.example/reservation/waitlist/${entry!.token}`,
    )

    // Asked again inside the hour: same answer, no second mail.
    await deliver(t, () =>
      join(t, world, { name: 'Attacker', email: 'victim@example.com', phone: '0699999999' }),
    )
    expect(toVictim()).toHaveLength(1)
    expect(sent().every((m) => m.Destination.ToAddresses[0] === 'victim@example.com')).toBe(true)

    // An hour later the guest who lost the mail can ask for it again.
    await t.run(async (ctx) => {
      await ctx.db.patch(entry!._id, { linkNoticeAt: Date.now() - 61 * 60_000 })
    })
    await deliver(t, () =>
      join(t, world, { name: 'Victim', email: 'victim@example.com', phone: '0611111111' }),
    )
    expect(toVictim()).toHaveLength(2)
  })

  test('the entry stays in the line: no second row, nothing leaves with the caller', async () => {
    const t = newHarness()
    const world = await fullHouse(t)
    await join(t, world, { name: 'Victim', email: 'victim@example.com', phone: '0611111111' })
    expect(
      await refusalCode(join(t, world, { name: 'A', email: 'victim@example.com', phone: '' })),
    ).toBe(undefined)
    expect(await entries(t)).toHaveLength(1)
  })
})

describe('the same class of hole elsewhere', () => {
  test('an anonymous booking with a known address does not rewrite the guest’s profile', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 3 })
    const slots = await openSlots(t, world.storeId)
    await bookSlot(t, world, slots[0]!, { email: 'known@example.com', name: 'Marie Dupont' })
    const second = (await openSlots(t, world.storeId)).find(
      (s) => s.startsAt !== slots[0]!.startsAt,
    )!
    await bookSlot(t, world, second, { email: 'known@example.com', name: 'Mallory' })
    const profile = (await t.run((ctx) => ctx.db.query('guestProfiles').collect())).find(
      (p) => p.email === 'known@example.com',
    )!
    expect(profile.name).toBe('Marie Dupont')
    expect(profile.bookings).toBe(2)
  })

  test('an alert asked twice for the same address keeps the first guest’s words', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const { id } = await world.manager.mutation(api.reservationExperiences.saveExperience, {
      storeId: world.storeId,
      title: 'Soirée',
      description: 'x',
      startsAt: new Date(`${dateIn(14)}T18:00:00Z`).getTime(),
      endsAt: new Date(`${dateIn(14)}T20:00:00Z`).getTime(),
      seats: 2,
      priceCents: 0,
      cancellationCutoffHours: 48,
      maxSeatsPerBooking: 2,
    } as never)
    await world.manager.mutation(api.reservationExperiences.publishExperience, { id })
    await t.mutation(api.reservationExperiences.buy, {
      experienceId: id,
      seats: 2,
      guest: { name: 'Full', email: 'full@example.com', phone: '0600000000' },
      consentNoticeVersion: 'v1',
    } as never)
    const alert = (name: string, partySize: number) =>
      t.mutation(api.reservationExperiences.joinAlert, {
        experienceId: id as Id<'reservationExperiences'>,
        guest: { name, email: 'lea@example.com' },
        partySize,
        noticeVersion: VERSION,
      } as never)
    await alert('Léa', 1)
    await expect(alert('Mallory', 2)).resolves.toEqual({ joined: true })
    const rows = await entries(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ guestName: 'Léa', partySize: 1 })
  })
})
