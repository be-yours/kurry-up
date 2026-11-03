// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A guest's booking is personal data, and the three obligations reach it
 * (RGPD art. 15, 17, 20 and the retention window of art. 5.1.e).
 *
 * A booking carries a name, an address, a phone number and whatever the guest
 * wrote about allergies — the last of which is health data. An erasure that
 * reached the orders and left the table booking behind would leave the person
 * in the one place a restaurant is most likely to look them up.
 */

import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = 1_760_000_000_000
const DAY = 24 * 60 * 60_000
const EMAIL = 'marie.dupont@example.fr'
/** As the team typed it on a phone call: unfolded. */
const EMAIL_AS_TYPED = 'Marie.Dupont@Example.FR'

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
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

type Harness = ReturnType<typeof convexTest>

async function seed(t: Harness, startsAt: number) {
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
    const make = async (guestEmail: string, reference: string) => {
      const id = await ctx.db.insert('reservations', {
        storeId,
        reference,
        status: 'confirmed' as const,
        serviceId,
        startsAt,
        endsAt: startsAt + 90 * 60_000,
        partySize: 2,
        tableIds: [],
        guestName: 'Marie Dupont',
        guestEmail,
        guestPhone: '+33612345678',
        guestNote: 'allergie aux arachides',
        channel: 'staff' as const,
        manageToken: `token-${reference}`,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert('reservationEvents', {
        storeId,
        reservationId: id,
        at: NOW,
        actor: 'staff' as const,
        to: 'confirmed' as const,
      })
      return id
    }
    const hers = await make(EMAIL_AS_TYPED, 'RES-2026-00001')
    const someoneElse = await make('autre@example.fr', 'RES-2026-00002')
    return { storeId, hers, someoneElse }
  })
}

async function seedOwner(t: Harness, storeId: Id<'stores'>) {
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: 'owner',
      role: 'client_admin' as const,
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return t.withIdentity({ subject: 'owner' })
}

describe('erasure by address', () => {
  test("takes her booking and its history, finds it unfolded, leaves everyone else's", async () => {
    const t = newHarness()
    const { storeId, hers, someoneElse } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)

    let result = await owner.mutation(api.privacy.eraseDataSubject, { email: EMAIL })
    let guard = 0
    while (!result.complete) {
      if (guard++ > 50) throw new Error('erasure never completed')
      result = await t.mutation(internal.privacy.continueErasure, {
        email: EMAIL,
        storeIds: result.storeIds as Id<'stores'>[],
        everyStore: result.everyStore,
        actor: result.actor,
        state: result.state,
      })
    }

    expect(await t.run((ctx) => ctx.db.get(hers))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(someoneElse))).not.toBeNull()
    const events = await t.run((ctx) => ctx.db.query('reservationEvents').collect())
    expect(events.map((e) => e.reservationId)).toEqual([someoneElse])
    expect(result.report.tallies.find((tl) => tl.table === 'reservations')).toMatchObject({
      deleted: 1,
    })
  })

  test('says plainly when it released a table that was still expected', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW + 5 * DAY)
    const owner = await seedOwner(t, storeId)
    // `holdsCapacity` and the future are judged against the real clock.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('reservations').collect()) {
        const startsAt = Date.now() + 5 * DAY
        await ctx.db.patch(row._id, { startsAt, endsAt: startsAt + 90 * 60_000 })
      }
    })
    const result = await owner.mutation(api.privacy.eraseDataSubject, { email: EMAIL })
    expect(result.report.retained.find((r) => r.table === 'reservations')?.reason).toMatch(
      /réservation à venir/,
    )
  })
})

describe('export by address', () => {
  test('hands back the raw row, allergy note included, and removes nothing', async () => {
    const t = newHarness()
    const { storeId, hers } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)

    const bundle = await owner.query(api.privacy.exportDataSubject, { email: EMAIL })
    const rows = bundle.records.find((r) => r.table === 'reservations')?.rows ?? []
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).toContain('allergie aux arachides')
    expect(await t.run((ctx) => ctx.db.get(hers))).not.toBeNull()
  })
})

describe('what a guest said of the visit', () => {
  test('is exported with the booking, comment included, and erased with it', async () => {
    const t = newHarness()
    const { storeId, hers, someoneElse } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run(async (ctx) => {
      await ctx.db.patch(hers, {
        status: 'completed' as const,
        feedbackScore: 2,
        feedbackComment: 'Trop long à servir',
        feedbackAnsweredAt: NOW - 9 * DAY,
        feedbackNoticeVersion: 'fr-2026-10',
      })
      await ctx.db.patch(someoneElse, { feedbackScore: 5, feedbackComment: 'Parfait' })
    })

    const bundle = await owner.query(api.privacy.exportDataSubject, { email: EMAIL })
    const rows = bundle.records.find((r) => r.table === 'reservations')?.rows ?? []
    expect(JSON.stringify(rows)).toContain('Trop long à servir')
    expect(JSON.stringify(rows)).not.toContain('Parfait')

    await eraseFully(t, owner, EMAIL)
    expect(await t.run((ctx) => ctx.db.get(hers))).toBeNull()
    // Her words went with her booking; the other guest's stayed with theirs.
    expect((await t.run((ctx) => ctx.db.get(someoneElse)))!.feedbackComment).toBe('Parfait')
  })
})

describe('the retention sweep', () => {
  test('deletes a visit older than the window and keeps a recent or a future one', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 4 * 365 * DAY)
    // A recent visit and a table booked for next month.
    await t.run(async (ctx) => {
      const serviceId = (await ctx.db.query('reservationServices').first())!._id
      for (const [reference, startsAt] of [
        ['RES-2026-00003', NOW - 30 * DAY],
        ['RES-2026-00004', NOW + 30 * DAY],
      ] as const) {
        await ctx.db.insert('reservations', {
          storeId,
          reference,
          status: 'confirmed' as const,
          serviceId,
          startsAt,
          endsAt: startsAt + 90 * 60_000,
          partySize: 2,
          tableIds: [],
          guestName: 'Paul',
          guestEmail: 'paul@example.fr',
          guestPhone: '0600000000',
          channel: 'staff' as const,
          manageToken: `token-${reference}`,
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    const left = (await t.run((ctx) => ctx.db.query('reservations').collect()))
      .map((r) => r.reference)
      .sort()
    // Both the 4-year-old bookings (hers and the other guest's) are gone.
    expect(left).toEqual(['RES-2026-00003', 'RES-2026-00004'])
    expect(await t.run((ctx) => ctx.db.query('reservationEvents').collect())).toHaveLength(0)
  })
})

/*
 * The waitlist and the guest book hold a diner too: a name, an address, a phone
 * number, and — in the profile — a record of a marketing agreement. An erasure that
 * reached the bookings and left either behind would leave the person in the two
 * places a restaurant is most likely to look them up next.
 */

type DbCtx = Parameters<Parameters<Harness['run']>[0]>[0]

async function insertEntry(
  ctx: DbCtx,
  storeId: Id<'stores'>,
  at: number,
  email: string,
  date: string,
  status: 'waiting' | 'offered' = 'waiting',
) {
  const serviceId = (await ctx.db.query('reservationServices').first())!._id
  return ctx.db.insert('waitlistEntries', {
    storeId,
    source: 'online' as const,
    status,
    guestName: 'Marie Dupont',
    guestEmail: email,
    guestPhone: '+33612345678',
    partySize: 2,
    date,
    token: `entry-${email}-${date}`,
    privacyNoticeVersion: 'fr-2026-10',
    ...(status === 'offered'
      ? {
          heldSlot: { serviceId, startsAt: at + DAY, endsAt: at + DAY + 90 * 60_000, tableIds: [] },
          offerExpiresAt: Date.now() + 15 * 60_000,
          offeredAt: Date.now(),
        }
      : {}),
    createdAt: at,
    updatedAt: at,
  })
}

function insertProfile(
  ctx: DbCtx,
  storeId: Id<'stores'>,
  email: string,
  lastSeenAt: number,
  extra: object = {},
) {
  return ctx.db.insert('guestProfiles', {
    storeId,
    email,
    name: 'Marie Dupont',
    phone: '+33612345678',
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    bookings: 3,
    visits: 2,
    covers: 5,
    noShows: 1,
    cancellations: 0,
    tags: ['VIP'],
    hostNotes: 'Table 12',
    marketingOptInAt: lastSeenAt,
    marketingOptInVersion: 'fr-2026-10',
    createdAt: lastSeenAt,
    updatedAt: lastSeenAt,
    ...extra,
  })
}

async function eraseFully(t: Harness, owner: ReturnType<Harness['withIdentity']>, email: string) {
  let result = await owner.mutation(api.privacy.eraseDataSubject, { email })
  let guard = 0
  while (!result.complete) {
    if (guard++ > 50) throw new Error('erasure never completed')
    result = await t.mutation(internal.privacy.continueErasure, {
      email,
      storeIds: result.storeIds as Id<'stores'>[],
      everyStore: result.everyStore,
      actor: result.actor,
      state: result.state,
    })
  }
  return result
}

describe('the waitlist and the guest book', () => {
  test('an erasure takes her waitlist entry and her profile, and nobody else’s', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run(async (ctx) => {
      await insertEntry(ctx, storeId, NOW, EMAIL_AS_TYPED, '2026-12-01')
      await insertEntry(ctx, storeId, NOW, 'autre@example.fr', '2026-12-01')
      await insertProfile(ctx, storeId, EMAIL, NOW)
      await insertProfile(ctx, storeId, 'autre@example.fr', NOW)
    })

    const result = await eraseFully(t, owner, EMAIL)

    const entries = await t.run((ctx) => ctx.db.query('waitlistEntries').collect())
    expect(entries.map((e) => e.guestEmail)).toEqual(['autre@example.fr'])
    const profiles = await t.run((ctx) => ctx.db.query('guestProfiles').collect())
    expect(profiles.map((p) => p.email)).toEqual(['autre@example.fr'])
    expect(result.report.tallies.find((tl) => tl.table === 'waitlistEntries')).toMatchObject({
      deleted: 1,
    })
    expect(result.report.tallies.find((tl) => tl.table === 'guestProfiles')).toMatchObject({
      deleted: 1,
    })
  })

  test('an offer standing at the time is withdrawn, and the report says the table is free again', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run((ctx) => insertEntry(ctx, storeId, NOW, EMAIL, '2026-12-01', 'offered'))
    const result = await owner.mutation(api.privacy.eraseDataSubject, { email: EMAIL })
    expect(result.report.retained.find((r) => r.table === 'waitlistEntries')?.reason).toMatch(
      /proposition de table/,
    )
  })

  test('a merged address goes with the profile it was merged into, and an address alone leaves a note', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    const merged = { name: '', phone: '', tags: [], hostNotes: undefined }
    await t.run(async (ctx) => {
      const kept = await insertProfile(ctx, storeId, EMAIL, NOW)
      await insertProfile(ctx, storeId, 'm.dupont@work.example', NOW, {
        mergedInto: kept,
        ...merged,
      })
    })
    await eraseFully(t, owner, EMAIL)
    expect(await t.run((ctx) => ctx.db.query('guestProfiles').collect())).toHaveLength(0)

    // Erasing the absorbed address alone leaves the kept profile, and says so.
    await t.run(async (ctx) => {
      const kept = await insertProfile(ctx, storeId, EMAIL, NOW)
      await insertProfile(ctx, storeId, 'm.dupont@work.example', NOW, {
        mergedInto: kept,
        ...merged,
      })
    })
    const result = await owner.mutation(api.privacy.eraseDataSubject, {
      email: 'm.dupont@work.example',
    })
    expect(await t.run((ctx) => ctx.db.query('guestProfiles').collect())).toHaveLength(1)
    expect(result.report.retained.find((r) => r.table === 'guestProfiles')?.reason).toMatch(
      /fusionnée/,
    )
  })

  test('a walk-in in the queue holds no address, so no request can find or touch it', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert('waitlistEntries', {
        storeId,
        source: 'walk_in' as const,
        status: 'waiting' as const,
        guestName: 'Famille Martin',
        guestEmail: '',
        guestPhone: '',
        partySize: 4,
        date: '2026-12-01',
        token: 'nobody-holds-this',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    await eraseFully(t, owner, EMAIL)
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(1)
  })

  test('the export hands back the raw rows of all four tables, and removes nothing', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run(async (ctx) => {
      await insertEntry(ctx, storeId, NOW, EMAIL, '2026-12-01')
      await insertProfile(ctx, storeId, EMAIL, NOW)
    })
    const bundle = await owner.query(api.privacy.exportDataSubject, { email: EMAIL })
    const tables = bundle.records.map((r) => r.table).sort()
    expect(tables).toEqual(
      expect.arrayContaining([
        'guestProfiles',
        'reservationEvents',
        'reservations',
        'waitlistEntries',
      ]),
    )
    const profileRows = bundle.records.find((r) => r.table === 'guestProfiles')!.rows
    expect(JSON.stringify(profileRows[0])).toContain('Table 12')
    expect(await t.run((ctx) => ctx.db.query('guestProfiles').collect())).toHaveLength(1)
    expect(await t.run((ctx) => ctx.db.query('waitlistEntries').collect())).toHaveLength(1)
  })

  test('the preview counts all of it and deletes none of it', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    await t.run(async (ctx) => {
      await insertEntry(ctx, storeId, NOW, EMAIL, '2026-12-01')
      await insertProfile(ctx, storeId, EMAIL, NOW)
    })
    const preview = await owner.query(api.privacy.previewErasure, { email: EMAIL })
    const tally = (table: string) => preview.tallies.find((tl) => tl.table === table)?.deleted
    expect(tally('waitlistEntries')).toBe(1)
    expect(tally('guestProfiles')).toBe(1)
    expect(tally('reservations')).toBe(1)
    expect(await t.run((ctx) => ctx.db.query('guestProfiles').collect())).toHaveLength(1)
  })

  test('the report names the e-mails a booking sent, which no erasure can reach', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, NOW - 10 * DAY)
    const owner = await seedOwner(t, storeId)
    const result = await eraseFully(t, owner, EMAIL)
    expect(result.report.retained.find((r) => r.table === 'reservationMail')?.reason).toMatch(
      /Amazon SES ou Resend/,
    )
  })
})

describe('the reservation window', () => {
  const VISIT = (days: number) => NOW - days * DAY

  test('is its own number: a shorter one sweeps bookings the customer window would keep', async () => {
    const t = newHarness()
    const { storeId, hers } = await seed(t, VISIT(200))
    const owner = await seedOwner(t, storeId)
    // The seed made the settings row; set both windows.
    await owner.mutation(api.privacy.setRetention, {
      customerDataDays: 1095,
      reservationDays: 90,
      enabled: true,
    })

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(await t.run((ctx) => ctx.db.get(hers))).toBeNull()
  })

  test('defaults to three years, and a booking inside it stays', async () => {
    const t = newHarness()
    const { storeId, hers } = await seed(t, VISIT(2 * 365))
    await seedOwner(t, storeId)
    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(await t.run((ctx) => ctx.db.get(hers))).not.toBeNull()
    const current = await t.query(api.privacy.getRetention, {})
    expect(current.reservationDays).toBe(1095)
  })

  test('may be shortened and never lengthened past three years, nor set below a month', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, VISIT(10))
    const owner = await seedOwner(t, storeId)
    const set = (reservationDays: number) =>
      owner.mutation(api.privacy.setRetention, {
        customerDataDays: 1095,
        reservationDays,
        enabled: true,
      })
    await expect(set(1096)).rejects.toThrow(/RESERVATION_WINDOW_OUT_OF_RANGE/)
    await expect(set(29)).rejects.toThrow(/RESERVATION_WINDOW_OUT_OF_RANGE/)
    expect((await set(365)).reservationDays).toBe(365)
    // A save from the screen that does not know this window leaves it alone.
    await owner.mutation(api.privacy.setRetention, { customerDataDays: 730, enabled: true })
    expect((await t.query(api.privacy.getRetention, {})).reservationDays).toBe(365)
  })

  test('sweeps a profile of a guest who has not booked for the window, with its merged addresses', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, VISIT(10))
    await t.run(async (ctx) => {
      const old = await insertProfile(ctx, storeId, 'old@example.fr', VISIT(4 * 365))
      await insertProfile(ctx, storeId, 'old.alias@example.fr', VISIT(4 * 365), { mergedInto: old })
      await insertProfile(ctx, storeId, 'recent@example.fr', VISIT(30))
    })
    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    const left = (await t.run((ctx) => ctx.db.query('guestProfiles').collect())).map((p) => p.email)
    expect(left).toEqual(['recent@example.fr'])
  })

  test('sweeps a waitlist entry a week after the date it was for, not before', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, VISIT(10))
    const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10)
    await t.run(async (ctx) => {
      await insertEntry(ctx, storeId, NOW, 'a@example.fr', day(-8))
      await insertEntry(ctx, storeId, NOW, 'b@example.fr', day(-7))
      await insertEntry(ctx, storeId, NOW, 'c@example.fr', day(-3))
      await insertEntry(ctx, storeId, NOW, 'd@example.fr', day(5))
    })
    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    const left = (await t.run((ctx) => ctx.db.query('waitlistEntries').collect()))
      .map((e) => e.guestEmail)
      .sort()
    // Seven days after the date: gone. Six: still there for the guest's own page.
    expect(left).toEqual(['c@example.fr', 'd@example.fr'])
  })

  test('a paused sweep reports and writes nothing', async () => {
    const t = newHarness()
    const { storeId } = await seed(t, VISIT(5 * 365))
    const owner = await seedOwner(t, storeId)
    await t.run((ctx) => insertProfile(ctx, storeId, 'old@example.fr', VISIT(5 * 365)))
    await owner.mutation(api.privacy.setRetention, { customerDataDays: 1095, enabled: false })
    const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(report.armed).toBe(false)
    expect(await t.run((ctx) => ctx.db.query('guestProfiles').collect())).toHaveLength(1)
    expect(report.tallies.find((tl) => tl.table === 'guestProfiles')?.deleted).toBe(1)
  })
})
