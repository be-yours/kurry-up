// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The e-mails a guest gets about a table booking, from the mutation that changes
 * the booking to the `SendEmailCommand` SES is handed.
 *
 * Four properties are pinned here rather than in the renderer's own tests:
 *
 *  1. each notice is sent ONCE: the claim is written in the same transaction as
 *     the booking, so a replayed request queues nothing;
 *  2. a mail is never sent for a state the booking has already left — confirmed
 *     and then cancelled before the first went out means one mail, the true one;
 *  3. a send that could not happen gives its claim back and says why on the
 *     booking, instead of leaving a booking that looks notified and is not;
 *  4. an address SES has told us is dead is not mailed again.
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

const ses = vi.hoisted(() => ({
  sends: [] as unknown[],
  failWith: null as string | null,
  renderFails: false,
}))

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      if (ses.failWith) throw new Error(ses.failWith)
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

vi.mock('@be-yours/core/aws/ses/reservation-notice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@be-yours/core/aws/ses/reservation-notice')>()
  return {
    ...actual,
    renderReservationNotice: (...args: Parameters<typeof actual.renderReservationNotice>) => {
      if (ses.renderFails) throw new Error('render exploded')
      return actual.renderReservationNotice(...args)
    },
  }
})

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = Date.now()
const DAY = 24 * 60 * 60_000
const SITE_URL = 'https://chez-luigi.example'
const DEPLOYMENT_SENDER = 'no-reply@beindigital.example'
const sent = () => ses.sends as CapturedEmail[]

const harnesses: ReturnType<typeof convexTest>[] = []
type Harness = ReturnType<typeof convexTest>

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(() => {
  ses.sends.length = 0
  ses.failWith = null
  ses.renderFails = false
  vi.stubEnv('AWS_SES_FROM_EMAIL', DEPLOYMENT_SENDER)
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

// ── Fixtures ────────────────────────────────────────────────────────────────

function bookingDate(): string {
  return new Date(NOW + 10 * DAY).toISOString().slice(0, 10)
}

async function seed(t: Harness, options: { autoConfirm?: boolean; emailConfig?: boolean } = {}) {
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
      phone: '01 42 60 00 00',
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
      capacityMode: 'tables' as const,
      slotStepMinutes: 30,
      turnoverBufferMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      autoConfirm: options.autoConfirm ?? true,
      cancellationDeadlineHours: 2,
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
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert('reservationTables', {
        storeId,
        name: `T${i + 1}`,
        minCovers: 1,
        maxCovers: 4,
        bookableOnline: true,
        outOfService: false,
      })
    }
    if (options.emailConfig !== false) {
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
    }
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

/**
 * Run `act`, then let whatever it queued run.
 *
 * The fake timers go in BEFORE the action: `runAfter(0)` becomes a `setTimeout`
 * at the moment it is called, and a timer registered against the real clock is
 * not adopted by a fake one installed afterwards.
 */
async function deliver(t: Harness, act: () => Promise<unknown>) {
  vi.useFakeTimers()
  try {
    const result = await act()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return result
  } finally {
    vi.useRealTimers()
  }
}

async function firstSlot(t: Harness, storeId: Id<'stores'>) {
  const slots = await t.query(api.reservations.getAvailability, {
    storeId,
    date: bookingDate(),
    partySize: 2,
  })
  const slot = slots.find((s) => s.available)
  if (!slot) throw new Error('no open slot')
  return slot
}

function book(
  t: Harness,
  storeId: Id<'stores'>,
  slot: { serviceId: string; startsAt: number },
  email = 'Marie@Example.com',
) {
  return t.mutation(api.reservations.create, {
    storeId,
    date: bookingDate(),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize: 2,
    guest: { name: 'Marie Dupont', email, phone: '0612345678' },
    consentNoticeVersion: 'v1',
  })
}

const rowOf = (t: Harness) => t.run((ctx) => ctx.db.query('reservations').first())
const jobsOf = (t: Harness) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => job.name === 'customerEmail:sendReservationNotice',
    ),
  )
const bodies = (mail: CapturedEmail) => [
  mail.Content.Simple.Body.Html.Data,
  mail.Content.Simple.Body.Text.Data,
]

// ── Tests ───────────────────────────────────────────────────────────────────

describe('a guest who books', () => {
  test('gets one confirmation, from the establishment, with their own link', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const slot = await firstSlot(t, storeId)

    const result = (await deliver(t, () => book(t, storeId, slot))) as { manageToken: string }

    expect(sent()).toHaveLength(1)
    const mail = sent()[0]!
    expect(mail.Destination.ToAddresses).toEqual(['marie@example.com'])
    expect(mail.FromEmailAddress).toContain('reservations@luigi.example')
    expect(mail.Content.Simple.Subject.Data).toContain('confirmée')
    for (const body of bodies(mail)) {
      expect(body).toContain('RES-')
      expect(body).toContain(`${SITE_URL}/reservation/manage/${result.manageToken}`)
    }
    expect((await rowOf(t))?.notices?.confirmed).toBeTypeOf('number')
  })

  test('is never told about the claim: the answer carries no `notice`', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const result = await book(t, storeId, await firstSlot(t, storeId))
    expect(Object.keys(result).sort()).toEqual(['manageToken', 'reference', 'status'])
  })

  test('a request that waits for the restaurant gets the waiting mail, then the answer', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, { autoConfirm: false })
    const owner = t.withIdentity({ subject: 'owner' })

    const slot = await firstSlot(t, storeId)
    await deliver(t, () => book(t, storeId, slot))
    expect(sent().map((m) => m.Content.Simple.Subject.Data)).toEqual([
      expect.stringContaining('Votre demande de réservation'),
    ])

    const id = (await rowOf(t))!._id
    await deliver(t, () => owner.mutation(api.reservations.setStatus, { id, to: 'confirmed' }))
    expect(sent()).toHaveLength(2)
    expect(sent()[1]!.Content.Simple.Subject.Data).toContain('confirmée')
  })

  test('is told when the restaurant declines, and when it cancels', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, { autoConfirm: false })
    const owner = t.withIdentity({ subject: 'owner' })
    await book(t, storeId, await firstSlot(t, storeId))
    const id = (await rowOf(t))!._id

    await deliver(t, () => owner.mutation(api.reservations.setStatus, { id, to: 'declined' }))
    expect(sent().at(-1)!.Content.Simple.Subject.Data).toContain("n'a pas pu être acceptée")
    // Nothing leaves a declined booking, so no second mail can follow.
    expect(await jobsOf(t)).toHaveLength(2)
  })

  test('is told when the restaurant cancels a confirmed table', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const owner = t.withIdentity({ subject: 'owner' })
    await book(t, storeId, await firstSlot(t, storeId))
    const id = (await rowOf(t))!._id

    await deliver(t, () =>
      owner.mutation(api.reservations.setStatus, {
        id,
        to: 'cancelled_by_restaurant',
        note: 'Fuite',
      }),
    )
    const mail = sent().at(-1)!
    expect(mail.Content.Simple.Subject.Data).toContain('a été annulée')
    // A cancelled booking offers no link to manage it.
    for (const body of bodies(mail)) expect(body).not.toContain('reservation/manage')
  })

  test('gets an acknowledgement of their own cancellation', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const { manageToken } = await book(t, storeId, await firstSlot(t, storeId))

    await deliver(t, () => t.mutation(api.reservations.cancelByToken, { token: manageToken }))
    expect(sent().at(-1)!.Content.Simple.Subject.Data).toContain('annulation')
  })

  test("hears nothing about the moves that are the restaurant's business", async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const owner = t.withIdentity({ subject: 'owner' })
    await book(t, storeId, await firstSlot(t, storeId))
    const id = (await rowOf(t))!._id
    const before = (await jobsOf(t)).length

    for (const to of ['arrived', 'seated', 'completed'] as const) {
      await owner.mutation(api.reservations.setStatus, { id, to })
    }
    expect(await jobsOf(t)).toHaveLength(before)
  })
})

describe('the claim', () => {
  test('queues one mail per notice, however many times the booking is read back', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const slot = await firstSlot(t, storeId)
    const first = await book(t, storeId, slot)
    // The same form submitted again with the same key is the same booking.
    const again = await t.mutation(api.reservations.create, {
      storeId,
      date: bookingDate(),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest: { name: 'Marie Dupont', email: 'marie@example.com', phone: '0612345678' },
      consentNoticeVersion: 'v1',
      idempotencyKey: 'key-1',
    })
    const replay = await t.mutation(api.reservations.create, {
      storeId,
      date: bookingDate(),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 2,
      guest: { name: 'Marie Dupont', email: 'marie@example.com', phone: '0612345678' },
      consentNoticeVersion: 'v1',
      idempotencyKey: 'key-1',
    })
    expect(replay).toEqual(again)
    expect(first.reference).not.toBe(again.reference)
    // Two bookings, two mails; the replay queued none.
    expect(await jobsOf(t)).toHaveLength(2)
  })

  test('a booking that moved on is not told what is no longer true', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    const owner = t.withIdentity({ subject: 'owner' })

    await deliver(t, async () => {
      await book(t, storeId, await firstSlot(t, storeId))
      const id = (await rowOf(t))!._id
      // Cancelled before the confirmation went out.
      await owner.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_restaurant' })
    })

    expect(sent().map((m) => m.Content.Simple.Subject.Data)).toEqual([
      expect.stringContaining('a été annulée'),
    ])
    // The confirmation's claim went back; the cancellation's stays.
    expect((await rowOf(t))?.notices?.confirmed).toBeUndefined()
    expect((await rowOf(t))?.notices?.cancelled_by_restaurant).toBeTypeOf('number')
  })
})

describe('a mail that cannot go', () => {
  test('is not sent to an address SES has given up on', async () => {
    const t = newHarness()
    const { storeId } = await seed(t)
    await t.run((ctx) =>
      ctx.db.insert('emailSubscribers', {
        storeId,
        email: 'marie@example.com',
        status: 'bounced' as const,
        source: 'storefront_form' as const,
        tags: [],
        consentAt: NOW,
        consentSource: 'test',
        bounceCount: 3,
        metadata: {
          totalOrders: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          favoriteProducts: [],
          orderTypes: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    await deliver(t, async () => book(t, storeId, await firstSlot(t, storeId)))
    expect(sent()).toHaveLength(0)
    expect(await jobsOf(t)).toHaveLength(0)
    // The booking itself is made all the same.
    expect((await rowOf(t))?.status).toBe('confirmed')
  })

  test('with no sender configured gives the claim back and says so on the booking', async () => {
    vi.stubEnv('AWS_SES_FROM_EMAIL', '')
    const t = newHarness()
    const { storeId } = await seed(t, { emailConfig: false })
    await deliver(t, async () => book(t, storeId, await firstSlot(t, storeId)))

    expect(sent()).toHaveLength(0)
    const row = await rowOf(t)
    expect(row?.notices?.confirmed).toBeUndefined()
    expect(row?.noticeFailure).toMatchObject({ reason: 'no_sender_address' })
  })

  test("refused by the provider gives the claim back and keeps the provider's reason", async () => {
    ses.failWith = 'MessageRejected: Email address is not verified'
    const t = newHarness()
    const { storeId } = await seed(t)
    await deliver(t, async () => book(t, storeId, await firstSlot(t, storeId)))

    const row = await rowOf(t)
    expect(row?.notices?.confirmed).toBeUndefined()
    expect(row?.noticeFailure).toMatchObject({ reason: 'transport' })
    expect(row?.noticeFailure?.detail).toContain('not verified')
    // The booking stands: an outage is not a reason to lose a table.
    expect(row?.status).toBe('confirmed')
  })

  test('that fails while rendering gives the claim back rather than leaking it', async () => {
    ses.renderFails = true
    const t = newHarness()
    const { storeId } = await seed(t)
    await deliver(t, async () => book(t, storeId, await firstSlot(t, storeId)))

    expect(sent()).toHaveLength(0)
    const row = await rowOf(t)
    expect(row?.notices?.confirmed).toBeUndefined()
    expect(row?.noticeFailure).toMatchObject({ reason: 'transport', detail: 'render exploded' })
  })
})
