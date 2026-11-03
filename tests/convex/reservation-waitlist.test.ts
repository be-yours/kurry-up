// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The waitlist: a guest asks to be told, a freed table is offered to the first in
 * line, and taking it goes through the same engine as any booking.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. the waitlist is OPT-IN, and refuses a wish a table already suits (a guest who
 *     joined with a table free would wait for one that never comes);
 *  2. a freed table is offered to the first guest it suits, by arrival order, and
 *     ONE e-mail goes out per offer;
 *  3. an offer is a HOLD: nobody else — not the public, not another waitlisted
 *     guest — can book the table while it stands, and it goes back when it lapses;
 *  4. claiming recomputes availability in its own transaction and creates the
 *     booking through the same door as `create`; two guests cannot both have it;
 *  5. turning an offer down, or letting it lapse, offers the table to the next;
 *  6. the walk-in queue is the same table, with no address and no e-mail ever.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface CapturedEmail {
  Destination: { ToAddresses: string[] }
  Content: {
    Simple: {
      Subject: { Data: string }
      Body: { Html: { Data: string }; Text: { Data: string } }
    }
  }
}

const ses = vi.hoisted(() => ({ sends: [] as unknown[], failWith: null as string | null }))

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

import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  NOW,
  bookSlot,
  dateIn,
  guest,
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

beforeEach(() => {
  ses.sends.length = 0
  ses.failWith = null
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

/** Run `act`, then let whatever it queued run (fake timers first: see the notices suite). */
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

const VERSION = 'fr-2026-10'
const DATE = dateIn(10)

async function enableWaitlist(t: Harness, storeId: Id<'stores'>, minutes?: number) {
  await t.run(async (ctx) => {
    const settings = await ctx.db.query('reservationSettings').first()
    await ctx.db.patch(settings!._id, {
      waitlistEnabled: true,
      ...(minutes ? { waitlistOfferMinutes: minutes } : {}),
    })
  })
  return storeId
}

/** Book every open slot of the day, one table at a time, until none is left. */
async function fillDay(t: Harness, world: World) {
  const ids: Id<'reservations'>[] = []
  for (let i = 0; i < 20; i++) {
    const [slot] = await openSlots(t, world.storeId)
    if (!slot) return ids
    await bookSlot(t, world, slot, { email: `full${i}@example.com`, name: `Full ${i}` })
    ids.push((await reservationRows(t)).at(-1)!._id)
  }
  throw new Error('the day never filled up')
}

const join = (
  t: Harness,
  world: Pick<World, 'storeId'>,
  extra: Partial<{
    email: string
    name: string
    phone: string
    partySize: number
    date: string
    earliest: string
    latest: string
    privacyNoticeVersion: string
    serviceId: Id<'reservationServices'>
  }> = {},
) =>
  t.mutation(api.reservationWaitlist.join, {
    storeId: world.storeId,
    guest: {
      name: extra.name ?? guest.name,
      email: extra.email ?? guest.email,
      ...(extra.phone === undefined ? { phone: guest.phone } : { phone: extra.phone }),
    },
    partySize: extra.partySize ?? 2,
    date: extra.date ?? DATE,
    ...(extra.earliest ? { earliest: extra.earliest, latest: extra.latest ?? '23:00' } : {}),
    ...(extra.serviceId ? { serviceId: extra.serviceId } : {}),
    privacyNoticeVersion: extra.privacyNoticeVersion ?? VERSION,
  })

const entries = (t: Harness) => t.run((ctx) => ctx.db.query('waitlistEntries').collect())

const claim = (t: Harness, token: string, extra: { consent?: string; phone?: string } = {}) =>
  t.mutation(api.reservationWaitlist.claim, {
    token,
    consentNoticeVersion: extra.consent ?? 'v1',
    privacyNoticeVersion: VERSION,
    ...(extra.phone ? { phone: extra.phone } : {}),
  })

/** A full house with a waitlist on: one table, every slot of the day booked. */
async function fullHouse(t: Harness, options: { looseTables?: number } = {}) {
  const world = await seedWorld(t, { looseTables: options.looseTables ?? 1 })
  await enableWaitlist(t, world.storeId)
  const booked = await fillDay(t, world)
  return { world, booked }
}

describe('joining', () => {
  test('is off until the owner turns it on, and the page is told so', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const config = await t.query(api.reservations.getPublicConfig, { storeId: world.storeId })
    expect(config?.waitlistEnabled).toBe(false)

    await fillDay(t, world)
    expect(await refusalCode(join(t, world))).toBe('waitlist_disabled')

    await enableWaitlist(t, world.storeId)
    const on = await t.query(api.reservations.getPublicConfig, { storeId: world.storeId })
    expect(on?.waitlistEnabled).toBe(true)
    expect(on?.waitlistOfferMinutes).toBe(15)
  })

  test('refuses a wish a table already suits: book it, do not wait for it', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    await enableWaitlist(t, world.storeId)
    expect(await refusalCode(join(t, world))).toBe('invalid_input')
    expect(await entries(t)).toHaveLength(0)
  })

  test('on a full day, keeps the wish, the consent version and a secret link', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    const answer = await join(t, world, { earliest: '19:00', latest: '20:30' })
    // The credential is never in the answer: it goes by e-mail to the stored address.
    expect(answer).toEqual({ joined: true })

    const [entry] = await entries(t)
    const token = entry!.token
    expect(entry).toMatchObject({
      status: 'waiting',
      source: 'online',
      guestEmail: 'marie@example.com',
      partySize: 2,
      date: DATE,
      earliest: '19:00',
      latest: '20:30',
      privacyNoticeVersion: VERSION,
      token,
    })
    expect(entry!.consentAcceptedAt).toBeTypeOf('number')
    expect(token.length).toBeGreaterThan(20)
  })

  test('the same address asking again for the same day keeps one entry, untouched', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    const first = await join(t, world, { partySize: 2 })
    const again = await join(t, world, { partySize: 3 })

    expect(again).toEqual(first)
    const rows = await entries(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ partySize: 2 })
  })

  test('refuses an unknown notice version, a bad address and a date out of range', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    expect(await refusalCode(join(t, world, { privacyNoticeVersion: 'made-up' }))).toBe(
      'consent_required',
    )
    expect(await refusalCode(join(t, world, { email: 'not-an-address' }))).toBe('invalid_input')
    expect(await refusalCode(join(t, world, { date: dateIn(-3) }))).toBe('invalid_input')
    expect(await refusalCode(join(t, world, { date: dateIn(400) }))).toBe('invalid_input')
    expect(await refusalCode(join(t, world, { partySize: 40 }))).toBe('invalid_input')
    expect(await entries(t)).toHaveLength(0)
  })

  test('is rate limited per address', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    for (let i = 0; i < 5; i++) await join(t, world, { date: dateIn(10 + (i % 1)) })
    // The sixth request in the hour from the same address is refused.
    await expect(join(t, world)).rejects.toThrow()
  })
})

describe('a freed table', () => {
  test('is offered to the first guest in line, with one e-mail and a link', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'first@example.com', name: 'Première' })
    await join(t, world, { email: 'second@example.com', name: 'Seconde' })

    // The restaurant cancels the 19:00 booking: its table is free until 20:30.
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )

    const rows = await entries(t)
    const first = rows.find((r) => r.guestEmail === 'first@example.com')!
    const second = rows.find((r) => r.guestEmail === 'second@example.com')!
    expect(first.status).toBe('offered')
    expect(first.heldSlot).toBeDefined()
    expect(first.offerExpiresAt! - first.offeredAt!).toBe(15 * 60_000)
    // Arrival order, and only one table freed: the second keeps waiting.
    expect(second.status).toBe('waiting')

    const offers = sent().filter((m) => m.Destination.ToAddresses[0] === 'first@example.com')
    expect(offers).toHaveLength(1)
    expect(offers[0]!.Content.Simple.Subject.Data).toMatch(/Une table s'est libérée/)
    expect(offers[0]!.Content.Simple.Body.Text.Data).toContain(
      `https://chez-luigi.example/reservation/waitlist/${first.token}`,
    )
    expect(offers[0]!.Content.Simple.Body.Text.Data).toMatch(/gardée 15 minutes/)
    expect(sent().some((m) => m.Destination.ToAddresses[0] === 'second@example.com')).toBe(false)
  })

  test('is offered to the first guest whose wish it suits, skipping one it does not', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    // First in line wants a table for six: this one seats four.
    await join(t, world, { email: 'big@example.com', partySize: 6 })
    await join(t, world, { email: 'small@example.com', partySize: 2 })

    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    const rows = await entries(t)
    expect(rows.find((r) => r.guestEmail === 'big@example.com')!.status).toBe('waiting')
    expect(rows.find((r) => r.guestEmail === 'small@example.com')!.status).toBe('offered')
  })

  test('a guest cancelling from their link frees the table for the waitlist too', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1, cancellationDeadlineHours: 0 })
    await enableWaitlist(t, world.storeId)
    const ids = await fillDay(t, world)
    const [first] = await reservationRows(t)
    await join(t, world, { email: 'wait@example.com' })

    await deliver(t, () =>
      t.mutation(api.reservations.cancelByToken, { token: first!.manageToken }),
    )
    expect(ids.length).toBeGreaterThan(0)
    expect((await entries(t))[0]!.status).toBe('offered')
  })

  test('nothing is offered while the waitlist is off, even for a guest who had joined', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world)
    await t.run(async (ctx) => {
      const settings = await ctx.db.query('reservationSettings').first()
      await ctx.db.patch(settings!._id, { waitlistEnabled: false })
    })
    await world.manager.mutation(api.reservations.setStatus, {
      id: booked[0]!,
      to: 'cancelled_by_restaurant',
    })
    expect((await entries(t))[0]!.status).toBe('waiting')
  })

  test('is not held for the public: the offer keeps the table, for everybody', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'wait@example.com' })
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )

    // The table is free in the book, yet no slot is open: it is promised.
    expect(await openSlots(t, world.storeId)).toHaveLength(0)
    const [slot] = (
      await t.query(api.reservations.getAvailability, {
        storeId: world.storeId,
        date: DATE,
        partySize: 2,
      })
    ).slice(0, 1)
    expect(slot!.available).toBe(false)
    expect(
      await refusalCode(
        t.mutation(api.reservations.create, {
          storeId: world.storeId,
          date: DATE,
          serviceId: world.serviceId,
          startsAt: slot!.startsAt,
          partySize: 2,
          guest,
          consentNoticeVersion: 'v1',
        }),
      ),
    ).toBe('slot_unavailable')
  })
})

describe('a service that crosses midnight', () => {
  test('a table freed after midnight is offered to a guest waiting for the evening it belongs to', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    await enableWaitlist(t, world.storeId)
    // Dinner until three in the morning: its last sittings start after midnight, on
    // the next calendar day, and still belong to the evening that began on DATE.
    await t.run((ctx) => ctx.db.patch(world.serviceId, { end: '03:00', lastSeating: '01:00' }))
    const booked = await fillDay(t, world)
    const rows = await reservationRows(t)
    const lateBooking = [...rows].sort((a, b) => b.startsAt - a.startsAt)[0]!
    const lateDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(lateBooking.startsAt))
    // The booking really is on the next calendar day: that is the case under test.
    expect(lateDate > DATE).toBe(true)
    expect(booked).toContain(lateBooking._id)

    await join(t, world, { email: 'night@example.com' })
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: lateBooking._id,
        to: 'cancelled_by_restaurant',
      }),
    )
    const [entry] = await entries(t)
    expect(entry).toMatchObject({ date: DATE, status: 'offered' })
  })
})

describe('claiming an offer', () => {
  async function offered(t: Harness) {
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'wait@example.com', phone: '' })
    const token = (await entries(t)).find((e) => e.guestEmail === 'wait@example.com')!.token
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    return { world, booked, token }
  }

  test('books the held table through the engine, and closes the entry', async () => {
    const t = newHarness()
    const { world, token } = await offered(t)
    const view = await t.query(api.reservationWaitlist.getByToken, { token })
    expect(view?.offer).not.toBeNull()
    expect(view?.needsPhone).toBe(true)

    const result = await deliver(t, () => claim(t, token, { phone: '0612345678' }))
    expect(result.claimed).toBe(true)

    const booking = (await reservationRows(t)).find((r) => r.guestEmail === 'wait@example.com')!
    expect(booking).toMatchObject({
      status: 'confirmed',
      partySize: 2,
      channel: 'online',
      guestPhone: '0612345678',
      consentNoticeVersion: 'v1',
      privacyNoticeVersion: VERSION,
    })
    const entry = (await entries(t)).find((e) => e.guestEmail === 'wait@example.com')!
    expect(entry.status).toBe('booked')
    expect(entry.reservationId).toBe(booking._id)
    expect(entry.heldSlot).toBeUndefined()
    // The page the guest lands on can send them on to their booking.
    const after = await t.query(api.reservationWaitlist.getByToken, { token })
    expect(after?.manageToken).toBe(booking.manageToken)
    // The same confirmation e-mail as any booking.
    expect(
      sent().some(
        (m) =>
          m.Destination.ToAddresses[0] === 'wait@example.com' &&
          /confirmée/.test(m.Content.Simple.Subject.Data),
      ),
    ).toBe(true)
    // Their profile exists, and the booking counted.
    const profiles = await t.run((ctx) => ctx.db.query('guestProfiles').collect())
    expect(profiles.find((p) => p.email === 'wait@example.com')).toMatchObject({ bookings: 1 })
    expect(world.storeId).toBeDefined()
  })

  test('needs a phone number when none was given, and the right consent version', async () => {
    const t = newHarness()
    const { token } = await offered(t)
    expect(await refusalCode(claim(t, token, { consent: 'old' }))).toBe('consent_required')
    // No phone typed: a booking holds one.
    expect(await refusalCode(claim(t, token))).toBe('invalid_input')
    expect((await entries(t)).find((e) => e.guestEmail === 'wait@example.com')!.status).toBe(
      'offered',
    )
  })

  test('twice is once: the second claim finds no offer', async () => {
    const t = newHarness()
    const { token } = await offered(t)
    await claim(t, token, { phone: '0612345678' })
    expect(await refusalCode(claim(t, token, { phone: '0612345678' }))).toBe('offer_unavailable')
    expect(
      (await reservationRows(t)).filter((r) => r.guestEmail === 'wait@example.com'),
    ).toHaveLength(1)
  })

  test('after the offer lapsed it is refused, and the page says it ran out', async () => {
    const t = newHarness()
    const { token } = await offered(t)
    await t.run(async (ctx) => {
      const [entry] = await ctx.db.query('waitlistEntries').collect()
      await ctx.db.patch(entry!._id, { offerExpiresAt: Date.now() - 1000 })
    })
    expect(await refusalCode(claim(t, token, { phone: '0612345678' }))).toBe('offer_unavailable')
    const view = await t.query(api.reservationWaitlist.getByToken, { token })
    expect(view?.lapsed).toBe(true)
    expect(view?.offer).toBeNull()
  })

  test('a table the rules no longer allow is an answer, not an error, and moves on', async () => {
    const t = newHarness()
    const { world, token } = await offered(t)
    // A closure on the day: the held table cannot be given any more.
    await world.manager.mutation(api.reservations.saveClosure, {
      storeId: world.storeId,
      startDate: DATE,
      endDate: DATE,
    })
    const result = await claim(t, token, { phone: '0612345678' })
    expect(result.claimed).toBe(false)
    expect((await entries(t)).find((e) => e.guestEmail === 'wait@example.com')!.status).toBe(
      'expired',
    )
  })
})

describe('letting a table go on', () => {
  test('a guest turning an offer down offers it to the next in line', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com' })
    await join(t, world, { email: 'b@example.com' })
    const aToken = (await entries(t)).find((e) => e.guestEmail === 'a@example.com')!.token
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    expect((await entries(t)).find((e) => e.guestEmail === 'b@example.com')!.status).toBe('waiting')

    await deliver(t, () => t.mutation(api.reservationWaitlist.leave, { token: aToken }))
    const rows = await entries(t)
    expect(rows.find((e) => e.guestEmail === 'a@example.com')!.status).toBe('removed')
    expect(rows.find((e) => e.guestEmail === 'b@example.com')!.status).toBe('offered')
    expect(sent().filter((m) => m.Destination.ToAddresses[0] === 'b@example.com')).toHaveLength(1)
  })

  test('an offer nobody took lapses, and the sweep offers the table to the next', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com' })
    await join(t, world, { email: 'b@example.com' })
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    // Fifteen minutes pass without a claim.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('waitlistEntries').collect()).find(
        (e) => e.guestEmail === 'a@example.com',
      )!
      await ctx.db.patch(row._id, { offerExpiresAt: Date.now() - 1000 })
    })

    // Before the sweep runs the hold has already ended on its own.
    expect(await openSlots(t, world.storeId)).not.toHaveLength(0)

    await deliver(t, () => t.mutation(internal.reservationWaitlist.expireOffers, {}))
    const rows = await entries(t)
    expect(rows.find((e) => e.guestEmail === 'a@example.com')!.status).toBe('expired')
    expect(rows.find((e) => e.guestEmail === 'b@example.com')!.status).toBe('offered')
    expect(sent().filter((m) => m.Destination.ToAddresses[0] === 'b@example.com')).toHaveLength(1)
  })

  test('an offer whose e-mail cannot be sent goes back to waiting, with the reason', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com' })
    ses.failWith = 'ses is down'
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    const [entry] = await entries(t)
    expect(entry!.status).toBe('waiting')
    expect(entry!.heldSlot).toBeUndefined()
    expect(entry!.noticeFailure).toMatchObject({ reason: 'transport' })
    // The table is free for the public again, not held for nobody.
    expect(await openSlots(t, world.storeId)).not.toHaveLength(0)
  })
})

describe('the host', () => {
  test('sees the day’s waiting in arrival order, never a token', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com', name: 'Alice' })
    await join(t, world, { email: 'b@example.com', name: 'Bob' })

    const list = await world.waiter.query(api.reservationWaitlist.list, {
      storeId: world.storeId,
      date: DATE,
    })
    expect(list.map((e) => e.guestName)).toEqual(['Alice', 'Bob'])
    expect(JSON.stringify(list)).not.toContain('token')
    // Signed out, the list is not readable at all.
    await expect(
      t.query(api.reservationWaitlist.list, { storeId: world.storeId, date: DATE }),
    ).rejects.toThrow()
  })

  test('offers a table by hand, and is told when there is none', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com' })
    const [entry] = await entries(t)

    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationWaitlist.proposeTable, { id: entry!._id }),
      ),
    ).toBe('slot_unavailable')

    // A table frees up while the host is looking at the list (here: directly).
    await t.run((ctx) => ctx.db.patch(booked[0]!, { status: 'cancelled_by_restaurant' }))
    const result = await deliver(t, () =>
      world.waiter.mutation(api.reservationWaitlist.proposeTable, { id: entry!._id }),
    )
    expect(result.offered).toBe(1)
    expect((await entries(t))[0]!.status).toBe('offered')
    expect(sent().filter((m) => m.Destination.ToAddresses[0] === 'a@example.com')).toHaveLength(1)
  })

  test('takes an entry off the list, and a held table goes to the next in line', async () => {
    const t = newHarness()
    const { world, booked } = await fullHouse(t)
    await join(t, world, { email: 'a@example.com' })
    await join(t, world, { email: 'b@example.com' })
    await deliver(t, () =>
      world.manager.mutation(api.reservations.setStatus, {
        id: booked[0]!,
        to: 'cancelled_by_restaurant',
      }),
    )
    const a = (await entries(t)).find((e) => e.guestEmail === 'a@example.com')!
    await deliver(t, () => world.waiter.mutation(api.reservationWaitlist.remove, { id: a._id }))
    const rows = await entries(t)
    expect(rows.find((e) => e.guestEmail === 'a@example.com')!.status).toBe('removed')
    expect(rows.find((e) => e.guestEmail === 'b@example.com')!.status).toBe('offered')
  })

  test('a user with no access to the book cannot read or change the list', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    await join(t, world)
    const [entry] = await entries(t)
    await expect(t.mutation(api.reservationWaitlist.remove, { id: entry!._id })).rejects.toThrow()
  })
})

describe('the walk-in queue', () => {
  test('puts a party in the queue with an estimated wait, and holds no address', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    const result = await world.waiter.mutation(api.reservationWaitlist.addToQueue, {
      storeId: world.storeId,
      partySize: 3,
      label: 'Famille Martin',
    })
    expect(result.id).toBeTypeOf('string')
    expect(typeof result.canSeatNow).toBe('boolean')

    const [entry] = await entries(t)
    expect(entry).toMatchObject({
      source: 'walk_in',
      status: 'waiting',
      guestName: 'Famille Martin',
      guestEmail: '',
      guestPhone: '',
      partySize: 3,
    })
    // Nothing is ever mailed to a walk-in.
    expect(sent()).toHaveLength(0)
  })

  test('seats a queued party when a table is free, and closes the entry with the booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    // The service must be open now for a walk-in: hours are the seeded 19:00–22:00,
    // so this runs inside them by pinning the clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW - (NOW % DAY) + 19.5 * 60 * 60_000))
    try {
      const { id } = await world.waiter.mutation(api.reservationWaitlist.addToQueue, {
        storeId: world.storeId,
        partySize: 2,
      })
      const listed = await world.waiter.query(api.reservationWaitlist.list, {
        storeId: world.storeId,
        date: new Date(Date.now()).toISOString().slice(0, 10),
      })
      expect(listed.find((e) => e._id === id)).toBeDefined()

      const seated = await world.waiter.mutation(api.reservationWaitlist.seatFromQueue, { id })
      expect(seated.seated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    const [entry] = await entries(t)
    expect(entry!.status).toBe('booked')
    const [booking] = await reservationRows(t)
    expect(booking).toMatchObject({ channel: 'walk_in', status: 'seated', partySize: 2 })
    expect(entry!.reservationId).toBe(booking!._id)
  })

  test('only a queued walk-in can be seated from the queue', async () => {
    const t = newHarness()
    const { world } = await fullHouse(t)
    await join(t, world)
    const [entry] = await entries(t)
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationWaitlist.seatFromQueue, { id: entry!._id }),
      ),
    ).toBe('invalid_input')
  })
})
