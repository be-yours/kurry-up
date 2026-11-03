// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The reminder before a confirmed booking, and the guest's reply to it.
 *
 * Bookings are written straight into the table: the reminder follows the clock,
 * and `create` would never let anyone book an evening that started yesterday.
 */

import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface CapturedEmail {
  FromEmailAddress: string
  Destination: { ToAddresses: string[] }
  Content: {
    Simple: {
      Subject: { Data: string }
      Body: { Html: { Data: string }; Text: { Data: string } }
    }
  }
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

import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = Date.now()
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const SITE_URL = 'https://chez-luigi.example'
const sent = () => ses.sends as CapturedEmail[]

type Harness = ReturnType<typeof convexTest>
const harnesses: Harness[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(() => {
  ses.sends.length = 0
  vi.stubEnv('AWS_SES_FROM_EMAIL', 'no-reply@beindigital.example')
  vi.stubEnv('AWS_REGION', 'eu-west-3')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret')
  vi.stubEnv('SITE_URL', SITE_URL)
})

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
  vi.unstubAllEnvs()
})

/** `null` seeds no setting at all; an omitted argument seeds the usual 24 h. */
async function seed(t: Harness, reminderHoursBefore: number | null = 24) {
  return t.run(async (ctx) => {
    const storeId = await ctx.db.insert('stores', {
      name: 'Chez Luigi',
      slug: 'luigi',
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
    await ctx.db.insert('globalSettings', {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
    await ctx.db.insert('reservationSettings', {
      storeId,
      capacityMode: 'covers' as const,
      slotStepMinutes: 30,
      turnoverBufferMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      maxSimultaneousCovers: 20,
      autoConfirm: true,
      cancellationDeadlineHours: 2,
      ...(reminderHoursBefore === null ? {} : { reminderHoursBefore }),
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
    await ctx.db.insert('emailConfig', {
      storeId,
      senderName: 'Chez Luigi',
      replyToEmail: 'contact@luigi.example',
      fromEmail: 'reservations@luigi.example',
      branding: { primaryColor: '#000000', secondaryColor: '#ffffff' },
      unsubscribeText: 'Se désabonner',
      maxEmailsPerWeek: 100,
      automationSettings: {
        welcomeEnabled: true,
        postOrderEnabled: true,
        birthdayEnabled: false,
        inactiveEnabled: false,
        abandonedCartEnabled: false,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert('userProfiles', {
      userId: 'owner',
      role: 'client_admin' as const,
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return { storeId, serviceId }
  })
}

let counter = 0

async function booking(
  t: Harness,
  ids: { storeId: Id<'stores'>; serviceId: Id<'reservationServices'> },
  options: {
    status?: 'pending' | 'confirmed' | 'cancelled_by_guest' | 'completed'
    startsIn: number
    createdAgo?: number
  },
) {
  counter += 1
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('reservations', {
      storeId: ids.storeId,
      reference: `RES-TEST-${counter}`,
      status: options.status ?? 'confirmed',
      serviceId: ids.serviceId,
      startsAt: NOW + options.startsIn,
      endsAt: NOW + options.startsIn + 90 * 60_000,
      partySize: 2,
      tableIds: [],
      guestName: 'Marie Dupont',
      guestEmail: 'marie@example.com',
      guestPhone: '0612345678',
      channel: 'online' as const,
      manageToken: `token-${counter}-abcdefgh`,
      createdAt: NOW - (options.createdAgo ?? 3 * DAY),
      updatedAt: NOW - (options.createdAgo ?? 3 * DAY),
    })
    return id as Id<'reservations'>
  })
}

async function sweep(t: Harness) {
  vi.useFakeTimers()
  try {
    const result = await t.mutation(internal.reservations.sendDueReminders, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return result
  } finally {
    vi.useRealTimers()
  }
}

const rowOf = (t: Harness, id: Id<'reservations'>) => t.run((ctx) => ctx.db.get(id))

async function refusalCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (error) {
    const data = (error as { data?: unknown }).data
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    return (parsed as { code?: string } | undefined)?.code
  }
  return undefined
}

describe('the reminder', () => {
  test('goes to a confirmed guest once their reminder moment has come, from the establishment', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    const id = await booking(t, ids, { startsIn: 23 * HOUR })

    expect(await sweep(t)).toEqual({ reminded: 1 })

    expect(sent()).toHaveLength(1)
    const mail = sent()[0]!
    expect(mail.Destination.ToAddresses).toEqual(['marie@example.com'])
    expect(mail.FromEmailAddress).toContain('reservations@luigi.example')
    expect(mail.Content.Simple.Subject.Data).toContain('Rappel')
    const token = (await rowOf(t, id))!.manageToken
    for (const body of [mail.Content.Simple.Body.Html.Data, mail.Content.Simple.Body.Text.Data]) {
      expect(body).toContain(`${SITE_URL}/reservation/manage/${token}`)
      expect(body).toContain('Confirmer ma venue')
    }
    expect((await rowOf(t, id))?.notices?.reminder).toBeTypeOf('number')
  })

  test('is sent once however often the sweep runs', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    await booking(t, ids, { startsIn: 23 * HOUR })

    await sweep(t)
    expect(await sweep(t)).toEqual({ reminded: 0 })
    expect(await sweep(t)).toEqual({ reminded: 0 })
    expect(sent()).toHaveLength(1)
  })

  test('waits for its moment: a booking further away than the lead time is left alone', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    const id = await booking(t, ids, { startsIn: 30 * HOUR })

    expect(await sweep(t)).toEqual({ reminded: 0 })
    expect(sent()).toHaveLength(0)
    expect((await rowOf(t, id))?.notices?.reminder).toBeUndefined()
  })

  test('does not run late for ever: past the catch-up window the moment is missed, not mailed', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    // 24 h lead, 3 h of catch-up: a booking 20 h away had its moment 4 h ago.
    await booking(t, ids, { startsIn: 20 * HOUR })
    expect(await sweep(t)).toEqual({ reminded: 0 })
  })

  test.each([
    ['no setting at all', null],
    ['a lead time of 0', 0],
  ])('an establishment with %s sends none', async (_label, hours) => {
    const t = newHarness()
    const ids = await seed(t, hours)
    // Inside the window a 24 h lead would remind (see the control below), so a
    // silent sweep here is the setting's doing and not the booking's distance.
    await booking(t, ids, { startsIn: 23 * HOUR })
    expect(await sweep(t)).toEqual({ reminded: 0 })
    expect(sent()).toHaveLength(0)
  })

  test('the same booking is reminded once the establishment sets a 24 h lead', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    await booking(t, ids, { startsIn: 23 * HOUR })
    expect(await sweep(t)).toEqual({ reminded: 1 })
  })

  test('is not sent to a booking made after the reminder moment: the confirmation said it', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    // Booked half an hour ago for an evening 23 h away: the reminder moment
    // (24 h before) was an hour ago, before the guest booked.
    await booking(t, ids, { startsIn: 23 * HOUR, createdAgo: 30 * 60_000 })
    expect(await sweep(t)).toEqual({ reminded: 0 })
    expect(sent()).toHaveLength(0)
  })

  test.each(['pending', 'cancelled_by_guest', 'completed'] as const)(
    'is not sent for a booking that is %s',
    async (status) => {
      const t = newHarness()
      const ids = await seed(t, 24)
      await booking(t, ids, { status, startsIn: 23 * HOUR })
      expect(await sweep(t)).toEqual({ reminded: 0 })
      expect(sent()).toHaveLength(0)
    },
  )

  test('is not sent for a booking that has already started', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    await booking(t, ids, { startsIn: -HOUR })
    expect(await sweep(t)).toEqual({ reminded: 0 })
  })

  test("uses each establishment's own lead time", async () => {
    const t = newHarness()
    const a = await seed(t, 24)
    const idA = await booking(t, a, { startsIn: 23 * HOUR })
    // A second establishment that reminds 2 hours ahead.
    const b = await t.run(async (ctx) => {
      const storeId = await ctx.db.insert('stores', {
        name: 'Sakura',
        slug: 'sakura',
        address: { street: '2 rue', city: 'Paris', postalCode: '75003', country: 'France' },
        hours: [],
        status: 'open' as const,
        reservationMode: 'native' as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert('reservationSettings', {
        storeId,
        capacityMode: 'covers' as const,
        slotStepMinutes: 30,
        turnoverBufferMinutes: 0,
        minNoticeMinutes: 60,
        maxHorizonDays: 60,
        maxPartySize: 8,
        maxSimultaneousCovers: 20,
        autoConfirm: true,
        cancellationDeadlineHours: 2,
        reminderHoursBefore: 2,
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
      return { storeId, serviceId }
    })
    const idB = await booking(t, b, { startsIn: 90 * 60_000 })
    const idBFar = await booking(t, b, { startsIn: 23 * HOUR })

    expect(await sweep(t)).toEqual({ reminded: 2 })
    expect((await rowOf(t, idA))?.notices?.reminder).toBeTypeOf('number')
    expect((await rowOf(t, idB))?.notices?.reminder).toBeTypeOf('number')
    // 23 h away is not within Sakura's 2 h.
    expect((await rowOf(t, idBFar))?.notices?.reminder).toBeUndefined()
  })

  test('says nothing to a guest whose booking is cancelled between the claim and the send', async () => {
    const t = newHarness()
    const ids = await seed(t, 24)
    const id = await booking(t, ids, { startsIn: 23 * HOUR })

    vi.useFakeTimers()
    try {
      await t.mutation(internal.reservations.sendDueReminders, {})
      // The guest cancels before the scheduled action runs.
      await t.run((ctx) => ctx.db.patch(id, { status: 'cancelled_by_guest' as const }))
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }
    expect(sent()).toHaveLength(0)
    // The claim is given back, so nothing is left saying a reminder went out.
    expect((await rowOf(t, id))?.notices?.reminder).toBeUndefined()
  })
})

describe('reconfirming from the booking page', () => {
  test('records the answer once and shows it on the guest page and in the history', async () => {
    const t = newHarness()
    const ids = await seed(t)
    const id = await booking(t, ids, { startsIn: 20 * HOUR })
    const token = (await rowOf(t, id))!.manageToken

    const before = await t.query(api.reservations.getByToken, { token })
    expect(before).toMatchObject({ canReconfirm: true, reconfirmedAt: null })

    const first = await t.mutation(api.reservations.reconfirmByToken, { token })
    const second = await t.mutation(api.reservations.reconfirmByToken, { token })
    expect(second.reconfirmedAt).toBe(first.reconfirmedAt)

    const after = await t.query(api.reservations.getByToken, { token })
    expect(after).toMatchObject({ status: 'confirmed', reconfirmedAt: first.reconfirmedAt })
    const row = await rowOf(t, id)
    expect(row?.status).toBe('confirmed')
    const events = await t.run((ctx) =>
      ctx.db
        .query('reservationEvents')
        .withIndex('by_reservationId', (q) => q.eq('reservationId', id))
        .collect(),
    )
    expect(events).toMatchObject([
      { actor: 'guest', from: 'confirmed', to: 'confirmed', note: 'reconfirmed' },
    ])
  })

  test('is refused for a booking that is not standing, or has started, or is unknown', async () => {
    const t = newHarness()
    const ids = await seed(t)
    const cancelled = await booking(t, ids, { status: 'cancelled_by_guest', startsIn: 5 * HOUR })
    const past = await booking(t, ids, { startsIn: -HOUR })
    const pending = await booking(t, ids, { status: 'pending', startsIn: 5 * HOUR })

    for (const id of [cancelled, past, pending]) {
      const token = (await rowOf(t, id))!.manageToken
      expect(await refusalCode(t.mutation(api.reservations.reconfirmByToken, { token }))).toBe(
        'transition_refused',
      )
    }
    expect(
      await refusalCode(
        t.mutation(api.reservations.reconfirmByToken, { token: 'not-a-real-token' }),
      ),
    ).toBe('invalid_input')
    // A refusal leaves nothing behind.
    expect((await rowOf(t, pending))?.reconfirmedAt).toBeUndefined()
  })

  test('is offered only while the booking can still be honoured', async () => {
    const t = newHarness()
    const ids = await seed(t)
    const pending = await booking(t, ids, { status: 'pending', startsIn: 5 * HOUR })
    const token = (await rowOf(t, pending))!.manageToken
    expect(await t.query(api.reservations.getByToken, { token })).toMatchObject({
      canReconfirm: false,
    })
  })
})

describe('the reminder setting', () => {
  const rules = {
    capacityMode: 'covers' as const,
    slotStepMinutes: 15,
    turnoverBufferMinutes: 10,
    minNoticeMinutes: 120,
    maxHorizonDays: 90,
    maxPartySize: 10,
    maxSimultaneousCovers: 40,
    autoConfirm: true,
    cancellationDeadlineHours: 24,
    noticeVersion: '2026-10',
  }

  test('is saved by a manager and read back with the rest of the rules', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, null)
    const owner = t.withIdentity({ subject: 'owner' })
    await owner.mutation(api.reservations.saveSettings, {
      storeId,
      ...rules,
      reminderHoursBefore: 24,
    })
    const config = await owner.query(api.reservations.getConfig, { storeId })
    expect(config.settings).toMatchObject({ reminderHoursBefore: 24 })
  })

  test('refuses a lead time that is not a whole number of hours between 0 and 72', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, null)
    const owner = t.withIdentity({ subject: 'owner' })
    for (const bad of [-1, 1.5, 73]) {
      expect(
        await refusalCode(
          owner.mutation(api.reservations.saveSettings, {
            storeId,
            ...rules,
            reminderHoursBefore: bad,
          }),
        ),
      ).toBe('invalid_input')
    }
  })
})
