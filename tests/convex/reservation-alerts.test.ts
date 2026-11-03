// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The alert centre: what the book raises for the host.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. alerts are DERIVED, never stored: settle the cause and the alert is gone, with
 *     nothing to clean up;
 *  2. each kind obeys its threshold, and the owner's threshold, not a constant;
 *  3. « lue » is per team member: one person's tidy-up does not hide a thing from a
 *     colleague, and can be undone;
 *  4. the e-mail goes once per alert, to each recipient on its own, carries no phone,
 *     address or request, and is dropped when the cause is settled before it is sent;
 *     the sweep is a cheap dispatcher plus one claim per establishment: each alert is
 *     claimed once per establishment, a failing establishment neither blocks nor
 *     repeats another, and the dispatcher reads a bounded page of rows and no book;
 *  5. the centre can be turned off, and reads a bounded book.
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

const ses = vi.hoisted(() => ({
  sends: [] as unknown[],
  failWith: null as string | null,
  /** Refuse only the messages addressed to this recipient. */
  failTo: null as string | null,
}))

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      if (ses.failWith) throw new Error(ses.failWith)
      const to = (command.input as { Destination?: { ToAddresses?: string[] } }).Destination
      if (ses.failTo && to?.ToAddresses?.includes(ses.failTo)) throw new Error('MessageRejected')
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

// The one place the e-mail claim can be made to fail for a single establishment: the capacity
// of its book is read through `capacityOf`, which carries the establishment on its settings row.
const claim = vi.hoisted(() => ({ failFor: null as string | null }))

vi.mock('@be-yours/convex-functions/reservationStats', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@be-yours/convex-functions/reservationStats')>()
  return {
    ...actual,
    capacityOf: (...args: Parameters<typeof actual.capacityOf>) => {
      const settings = args[0] as { storeId?: string } | null
      if (claim.failFor !== null && settings && String(settings.storeId) === claim.failFor) {
        throw new Error('the book of this establishment cannot be read')
      }
      return actual.capacityOf(...args)
    },
  }
})

import { restaurantDate } from '@be-yours/convex-schema'
import { api, internal } from '../../convex/_generated/api'
import {
  DAY,
  dateIn,
  refusalCode,
  seedBooking,
  seedWorld,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const sent = () => ses.sends as CapturedEmail[]
const HOUR = 60 * 60_000
const MIN = 60_000

beforeEach(() => {
  ses.sends.length = 0
  ses.failWith = null
  ses.failTo = null
  claim.failFor = null
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

const list = (world: Pick<World, 'storeId'>, as: { query: Harness['query'] }) =>
  as.query(api.reservationAlerts.list, { storeId: world.storeId })
const save = (world: World, fields: Record<string, unknown>) =>
  world.manager.mutation(api.reservationAutomations.save, { storeId: world.storeId, ...fields })
const keys = async (world: World, as = world.manager) =>
  ((await list(world, as)) as { alerts: Array<{ key: string }> }).alerts.map((a) => a.key)

/** A booking that starts `ahead` from now, however far from midnight that is. */
async function seedAt(
  t: Harness,
  world: World,
  ahead: number,
  extra: Parameters<typeof seedBooking>[2] = { date: dateIn(1), time: '19:30' },
) {
  const id = await seedBooking(t, world, extra)
  const startsAt = Date.now() + ahead
  await t.run((ctx) => ctx.db.patch(id, { startsAt, endsAt: startsAt + 90 * MIN }))
  return id
}

describe('a calm book', () => {
  test('raises nothing, and says the centre is on', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 6 })
    expect(await list(world, world.manager)).toMatchObject({
      enabled: true,
      alerts: [],
      dismissed: 0,
      truncated: false,
    })
    await seedAt(t, world, 2 * DAY)
    expect(await keys(world)).toEqual([])
  })

  test('is read by the team and by nobody without a role', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect((await list(world, world.waiter)).enabled).toBe(true)
    await expect(t.query(api.reservationAlerts.list, { storeId: world.storeId })).rejects.toThrow()
  })
})

describe('large parties', () => {
  test('are flagged from the owner’s size, not before', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    const big = await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 7 })
    expect(await keys(world)).toEqual([`large_party:${big}`])

    await save(world, { alertThresholds: { largeParty: 12 } })
    expect(await keys(world)).toEqual([])
    await save(world, { alertThresholds: { largeParty: 6 } })
    expect(await keys(world)).toHaveLength(2)
  })

  test('are not flagged for a walk-in, a cancelled booking or a table already seated', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      partySize: 12,
      channel: 'walk_in',
      status: 'seated',
    })
    await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      partySize: 12,
      status: 'cancelled_by_guest',
    })
    await seedAt(t, world, -HOUR, { date: dateIn(0), time: '19:00', partySize: 12 })
    expect(await keys(world)).toEqual([])
  })

  test('vanish when the cause is settled: nothing is stored, so nothing to clean up', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    const big = await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    expect(await keys(world)).toHaveLength(1)
    await world.manager.mutation(api.reservations.setStatus, {
      id: big,
      to: 'cancelled_by_restaurant',
    })
    expect(await keys(world)).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())).toHaveLength(0)
  })
})

describe('a day nearly full', () => {
  test('is raised from the owner’s share of capacity, and is urgent once it is full', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const date = dateIn(1)
    for (const n of [1, 2, 3]) {
      await seedAt(t, world, DAY, { date, time: '20:00', table: `Libre ${n}` })
    }
    // Three of four tables: 75 %, under the default 85 %.
    expect(await keys(world)).toEqual([])
    await save(world, { alertThresholds: { nearlyFullPercent: 70 } })
    const [alert] = (
      (await list(world, world.manager)) as {
        alerts: Array<{ kind: string; severity: string; key: string }>
      }
    ).alerts
    expect(alert).toMatchObject({ kind: 'nearly_full', severity: 'warning' })
    expect(alert!.key).toMatch(/^nearly_full:\d{4}-\d{2}-\d{2}$/)

    await seedAt(t, world, DAY, { date, time: '20:00', table: 'Libre 4' })
    const full = (
      (await list(world, world.manager)) as { alerts: Array<{ kind: string; severity: string }> }
    ).alerts
    expect(full.find((a) => a.kind === 'nearly_full')).toMatchObject({ severity: 'urgent' })
  })
})

describe('guests who did not come before', () => {
  test('are flagged when they book again, from the owner’s number of absences', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 6 })
    const id = await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      email: 'habitue@example.com',
      name: 'Paul Habitué',
    })
    await t.run((ctx) =>
      ctx.db.insert('guestProfiles', {
        storeId: world.storeId,
        email: 'habitue@example.com',
        name: 'Paul Habitué',
        phone: '0600000000',
        firstSeenAt: Date.now() - 30 * DAY,
        lastSeenAt: Date.now() - DAY,
        bookings: 4,
        visits: 1,
        covers: 2,
        noShows: 2,
        cancellations: 0,
        tags: [],
        createdAt: Date.now() - 30 * DAY,
        updatedAt: Date.now(),
      }),
    )
    const found = (
      (await list(world, world.manager)) as { alerts: Array<{ key: string; title: string }> }
    ).alerts
    expect(found.map((a) => a.key)).toEqual([`repeat_no_show:${id}`])
    expect(found[0]!.title).toContain('2 fois')

    await save(world, { alertThresholds: { repeatNoShows: 3 } })
    expect(await keys(world)).toEqual([])
  })
})

describe('bookings nobody has settled', () => {
  test('raises a request that has waited too long, and a request close to its start', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 6 })
    const stuck = await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      status: 'pending',
      createdAt: Date.now() - 5 * HOUR,
    })
    const soon = await seedAt(t, world, 2 * HOUR, {
      date: dateIn(0),
      time: '20:00',
      status: 'pending',
      createdAt: Date.now() - HOUR,
    })
    expect(await keys(world)).toEqual([`unconfirmed_soon:${soon}`, `stuck_pending:${stuck}`])
    await save(world, { alertThresholds: { pendingHours: 8 } })
    expect(await keys(world)).toEqual([`unconfirmed_soon:${soon}`])
  })

  test('raises a guest who was asked to confirm and did not, unless the owner stopped asking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 6 })
    const asked = await seedAt(t, world, HOUR, {
      date: dateIn(0),
      time: '20:00',
      notices: { reminder: Date.now() - 20 * HOUR },
    })
    await seedAt(t, world, HOUR, {
      date: dateIn(0),
      time: '20:00',
      table: 'Libre 2',
      notices: { reminder: Date.now() - 20 * HOUR },
      reconfirmedAt: Date.now() - 10 * HOUR,
    })
    expect(await keys(world)).toEqual([`unconfirmed_soon:${asked}`])
    await save(world, { reconfirmationEnabled: false })
    expect(await keys(world)).toEqual([])
  })
})

describe('the waitlist', () => {
  const entry = (
    t: Harness,
    world: World,
    status: 'offered' | 'expired',
    extra: Record<string, unknown> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert('waitlistEntries', {
        storeId: world.storeId,
        source: 'online',
        status,
        guestName: 'Paul',
        guestEmail: 'paul@example.com',
        guestPhone: '',
        partySize: 4,
        // The restaurant's today, which is not always the UTC date.
        date: restaurantDate(Date.now(), 'Europe/Paris'),
        token: `entry-${status}-${crypto.randomUUID()}`,
        createdAt: Date.now() - HOUR,
        updatedAt: Date.now() - 10 * MIN,
        ...extra,
      }),
    )

  test('says a table was offered, and that an offer lapsed', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const offered = await entry(t, world, 'offered', {
      offerExpiresAt: Date.now() + 10 * MIN,
      heldSlot: {
        serviceId: world.serviceId,
        startsAt: Date.now() + HOUR,
        endsAt: Date.now() + 2 * HOUR,
        tableIds: [],
      },
    })
    await entry(t, world, 'expired')
    const found = ((await list(world, world.manager)) as { alerts: Array<{ kind: string }> }).alerts
    expect(found.map((a) => a.kind).sort()).toEqual(['waitlist_expired', 'waitlist_offer'])
    expect(offered).toBeTruthy()
  })

  test('never mentions the walk-in queue', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await entry(t, world, 'expired', { source: 'walk_in' })
    expect(await keys(world)).toEqual([])
  })
})

describe('marking an alert as read', () => {
  async function oneAlert() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    const id = await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    return { t, world, key: `large_party:${id}` }
  }

  const dismiss = (world: World, as: { mutation: Harness['mutation'] }, key: string[]) =>
    as.mutation(api.reservationAlerts.dismiss, { storeId: world.storeId, keys: key })

  test('is one person’s: a colleague still sees it', async () => {
    const { world, key } = await oneAlert()
    expect(await dismiss(world, world.manager, [key])).toEqual({ dismissed: 1 })
    expect(await keys(world, world.manager)).toEqual([])
    expect(await keys(world, world.waiter)).toEqual([key])
    const mine = await list(world, world.manager)
    expect(mine).toMatchObject({ dismissed: 1, alerts: [] })
  })

  test('is idempotent: dismissing twice leaves one mark', async () => {
    const { t, world, key } = await oneAlert()
    await dismiss(world, world.manager, [key])
    expect(await dismiss(world, world.manager, [key])).toEqual({ dismissed: 0 })
    expect(await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())).toHaveLength(1)
  })

  test('can be undone, and only the person’s own mark', async () => {
    const { world, key } = await oneAlert()
    await dismiss(world, world.manager, [key])
    await dismiss(world, world.waiter, [key])
    expect(
      await world.manager.mutation(api.reservationAlerts.restore, {
        storeId: world.storeId,
        keys: [key],
      }),
    ).toEqual({ restored: 1 })
    expect(await keys(world, world.manager)).toEqual([key])
    expect(await keys(world, world.waiter)).toEqual([])
    // With no key at all, it brings back everything of one's own.
    await dismiss(world, world.manager, [key])
    expect(
      await world.manager.mutation(api.reservationAlerts.restore, { storeId: world.storeId }),
    ).toEqual({ restored: 1 })
  })

  test('ignores a key nobody raised, so no mark is left that never expires', async () => {
    const { t, world } = await oneAlert()
    expect(
      await dismiss(world, world.manager, ['large_party:inventée', 'nearly_full:2000-01-01']),
    ).toEqual({ dismissed: 0 })
    expect(await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())).toHaveLength(0)
  })

  test('refuses an empty list and an absurd one', async () => {
    const { world } = await oneAlert()
    expect(await refusalCode(dismiss(world, world.manager, []))).toBe('invalid_input')
    expect(
      await refusalCode(
        dismiss(
          world,
          world.manager,
          Array.from({ length: 60 }, (_, i) => `k${i}`),
        ),
      ),
    ).toBe('invalid_input')
  })

  test('gives each mark an end, and the nightly pass drops what is over', async () => {
    const { t, world, key } = await oneAlert()
    await dismiss(world, world.manager, [key])
    const [mark] = await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())
    expect(mark!.expiresAt).toBeGreaterThan(Date.now())
    expect(await t.mutation(internal.reservationAlerts.prune, {})).toMatchObject({ pruned: 0 })
    await t.run((ctx) => ctx.db.patch(mark!._id, { expiresAt: Date.now() - 1 }))
    expect(await t.mutation(internal.reservationAlerts.prune, {})).toMatchObject({ pruned: 1 })
    expect(await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())).toHaveLength(0)
  })
})

describe('the centre', () => {
  test('can be turned off, and then asks the book nothing', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    await save(world, { alertsEnabled: false })
    expect(await list(world, world.manager)).toEqual({
      enabled: false,
      alerts: [],
      dismissed: 0,
      truncated: false,
    })
  })

  test('reads a bounded book: past the cap it answers with what it has and says so', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run(async (ctx) => {
      const startsAt = Date.now() + 2 * DAY
      for (let i = 0; i < 2001; i++) {
        await ctx.db.insert('reservations', {
          storeId: world.storeId,
          reference: `RES-BULK-${i}`,
          status: 'confirmed',
          serviceId: world.serviceId,
          startsAt: startsAt + i,
          endsAt: startsAt + i + 60_000,
          partySize: 2,
          tableIds: [],
          guestName: '',
          guestEmail: '',
          guestPhone: '',
          channel: 'walk_in',
          manageToken: `bulk-token-${i}-${crypto.randomUUID()}`,
          createdAt: startsAt - HOUR,
          updatedAt: startsAt,
        })
      }
    })
    const answer = (await list(world, world.manager)) as { truncated: boolean }
    expect(answer.truncated).toBe(true)
  })
})

describe('the e-mail', () => {
  async function mailedWorld() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 30 })
    await save(world, {
      alertsEmailEnabled: true,
      recipients: ['chef@example.com', 'compta@example.com'],
    })
    return { t, world }
  }

  const sentDigests = (t: Harness) =>
    t.run(async (ctx) => {
      const jobs = await ctx.db.system.query('_scheduled_functions').collect()
      return jobs.filter((job) => job.name.endsWith('customerEmail:sendAlertDigest')).length
    })

  /**
   * One run of the sweep: the dispatcher, the claim it schedules for each establishment,
   * and the mail each claim hands over. `digests` counts the messages that were claimed.
   */
  async function sweep(t: Harness) {
    const before = await sentDigests(t)
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      const dispatched = await t.mutation(internal.reservationAlerts.sendDue, {})
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      return { ...dispatched, digests: (await sentDigests(t)) - before }
    } finally {
      vi.useRealTimers()
    }
  }

  const settle = async (t: Harness) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }
  }

  test('goes once per alert, to each recipient on its own, and names the alert', async () => {
    const { t, world } = await mailedWorld()
    await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      partySize: 10,
      name: 'Marie Dupont',
    })

    expect(await sweep(t)).toMatchObject({ stores: 1, digests: 1 })
    expect(sent().map((mail) => mail.Destination.ToAddresses)).toEqual([
      ['chef@example.com'],
      ['compta@example.com'],
    ])
    const mail = sent()[0]!
    expect(mail.Content.Simple.Subject.Data).toBe('1 alerte sur les réservations de Chez Luigi')
    expect(mail.Content.Simple.Body.Text.Data).toContain('Groupe de 10 personnes')
    expect(mail.Content.Simple.Body.Text.Data).toContain(
      'Ouvrir le carnet : https://chez-luigi.example/dashboard/reservations',
    )

    // A second sweep finds nothing new.
    expect(await sweep(t)).toMatchObject({ digests: 0 })
    expect(sent()).toHaveLength(2)
  })

  test('carries no phone, no address and no request of a guest', async () => {
    const { t, world } = await mailedWorld()
    await seedAt(t, world, 2 * DAY, {
      date: dateIn(2),
      time: '20:00',
      partySize: 10,
      guestNote: 'allergie aux arachides',
      email: 'secret@example.com',
    })
    await sweep(t)
    for (const mail of sent()) {
      const body = `${mail.Content.Simple.Body.Text.Data}${mail.Content.Simple.Body.Html.Data}`
      expect(body).not.toMatch(/arachides|secret@|0612345678/i)
    }
  })

  test('says nothing about an alert that is not new, and a new one goes in the next mail', async () => {
    const { t, world } = await mailedWorld()
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    await sweep(t)
    sent().length = 0
    ses.sends.length = 0
    await seedAt(t, world, 3 * DAY, {
      date: dateIn(3),
      time: '20:00',
      partySize: 12,
      table: 'Libre 2',
    })
    expect(await sweep(t)).toMatchObject({ digests: 1 })
    const text = sent()[0]!.Content.Simple.Body.Text.Data
    expect(text).toContain('Groupe de 12 personnes')
    expect(text).not.toContain('Groupe de 10 personnes')
  })

  test('puts ten alerts in a mail and leaves the rest for the next', async () => {
    const { t, world } = await mailedWorld()
    for (let i = 0; i < 12; i++) {
      await seedAt(t, world, 2 * DAY + i * MIN, {
        date: dateIn(2),
        time: '20:00',
        partySize: 10,
        table: `Libre ${i + 1}`,
      })
    }
    expect(await sweep(t)).toMatchObject({ digests: 1 })
    expect(sent()[0]!.Content.Simple.Subject.Data).toBe(
      '10 alertes sur les réservations de Chez Luigi',
    )
    ses.sends.length = 0
    expect(await sweep(t)).toMatchObject({ digests: 1 })
    expect(sent()[0]!.Content.Simple.Subject.Data).toBe(
      '2 alertes sur les réservations de Chez Luigi',
    )
    ses.sends.length = 0
    expect(await sweep(t)).toMatchObject({ digests: 0 })
  })

  test('is not sent for an alert that was settled before the mail left', async () => {
    const { t, world } = await mailedWorld()
    const id = await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    const claimed = await t.mutation(internal.reservationAlerts.sendDueForStore, {
      storeId: world.storeId,
    })
    expect(claimed).toEqual({ digests: 1 })
    await world.manager.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_restaurant' })
    await settle(t)
    expect(sent()).toHaveLength(0)
  })

  test('is not retried when the provider refuses: the alerts stay in the centre', async () => {
    const { t, world } = await mailedWorld()
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    ses.failWith = 'MessageRejected'
    expect(await sweep(t)).toMatchObject({ digests: 1 })
    ses.failWith = null
    expect(await sweep(t)).toMatchObject({ digests: 0 })
    expect(sent()).toHaveLength(0)
    expect(await keys(world)).toHaveLength(1)
  })

  test('is off until the owner turns it on, and needs the centre on', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 20 })
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    expect(await sweep(t)).toMatchObject({ stores: 0, digests: 0 })
    await save(world, {
      recipients: ['chef@example.com'],
      alertsEmailEnabled: true,
      alertsEnabled: false,
    })
    expect(await sweep(t)).toMatchObject({ stores: 0, digests: 0 })
  })

  test('marks an alert once, for the establishment, not for a person', async () => {
    const { t, world } = await mailedWorld()
    await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    await sweep(t)
    const marks = await t.run((ctx) => ctx.db.query('reservationAlertMarks').collect())
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ kind: 'emailed' })
    expect(marks[0]!.userId).toBeUndefined()
    // Having been e-mailed does not hide it from anyone: it is still in the centre.
    expect(await keys(world, world.manager)).toHaveLength(1)
  })
})

describe('the e-mail sweep across establishments', () => {
  /** Two establishments in one deployment, each with a large party and the digest on. */
  async function twoStores() {
    const t = newHarness()
    const a = await seedWorld(t, { looseTables: 20 })
    const b = await seedWorld(t, { looseTables: 20, profiles: false })
    for (const [world, recipient] of [
      [a, 'chef-a@example.com'],
      [b, 'chef-b@example.com'],
    ] as const) {
      await t.run((ctx) =>
        ctx.db.insert('reservationAutomations', {
          storeId: world.storeId,
          recipients: [recipient],
          alertsEmailEnabled: true,
          updatedAt: Date.now(),
        }),
      )
      await seedAt(t, world, 2 * DAY, { date: dateIn(2), time: '20:00', partySize: 10 })
    }
    return { t, a, b }
  }

  const emailedMarks = (t: Harness, storeId: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query('reservationAlertMarks').collect()).filter(
        (mark) => mark.kind === 'emailed' && String(mark.storeId) === storeId,
      ),
    )
  const recipients = () => sent().map((mail) => mail.Destination.ToAddresses[0])

  async function run(t: Harness) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      const dispatched = await t.mutation(internal.reservationAlerts.sendDue, {})
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      return dispatched
    } finally {
      vi.useRealTimers()
    }
  }

  test('mails each establishment its own alerts, once, and never another one’s', async () => {
    const { t, a, b } = await twoStores()
    expect(await run(t)).toEqual({ stores: 2 })
    expect(recipients().sort()).toEqual(['chef-a@example.com', 'chef-b@example.com'])
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(1)
    expect(await emailedMarks(t, String(b.storeId))).toHaveLength(1)

    ses.sends.length = 0
    await run(t)
    expect(sent()).toHaveLength(0)
  })

  test('claims an alert once per establishment however often the claim is asked for', async () => {
    const { t, a } = await twoStores()
    const first = await t.mutation(internal.reservationAlerts.sendDueForStore, {
      storeId: a.storeId,
    })
    const second = await t.mutation(internal.reservationAlerts.sendDueForStore, {
      storeId: a.storeId,
    })
    expect(first).toEqual({ digests: 1 })
    expect(second).toEqual({ digests: 0 })
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(1)
  })

  test('an establishment that fails neither blocks nor repeats another', async () => {
    const { t, a, b } = await twoStores()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    claim.failFor = String(a.storeId)

    await run(t)
    // B was claimed and mailed; A's whole claim rolled back, so it holds no mark at all.
    expect(recipients()).toEqual(['chef-b@example.com'])
    expect(await emailedMarks(t, String(b.storeId))).toHaveLength(1)
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(0)

    // The next quarter of an hour: A still fails, and B is not mailed a second time.
    ses.sends.length = 0
    await run(t)
    expect(sent()).toHaveLength(0)
    expect(await emailedMarks(t, String(b.storeId))).toHaveLength(1)

    // Once A can be read again it gets its own mail, and only its own.
    claim.failFor = null
    await run(t)
    expect(recipients()).toEqual(['chef-a@example.com'])
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(1)
    expect(await emailedMarks(t, String(b.storeId))).toHaveLength(1)
  })

  test('a failed send in one establishment is not retried and leaves the other’s mail alone', async () => {
    const { t, a, b } = await twoStores()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ses.failTo = 'chef-a@example.com'
    await run(t)
    expect(recipients()).toEqual(['chef-b@example.com'])
    // Both were claimed; the one whose send failed is not asked for again.
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(1)
    expect(await emailedMarks(t, String(b.storeId))).toHaveLength(1)
    ses.failTo = null
    ses.sends.length = 0
    await run(t)
    expect(sent()).toHaveLength(0)
  })

  test('the dispatcher reads rows of settings and no book, only for establishments that want it', async () => {
    const { t, a } = await twoStores()
    // A turns the digest off: it is not even named.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('reservationAutomations')
        .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
        .unique()
      await ctx.db.patch(row!._id, { alertsEmailEnabled: false })
    })
    expect(await run(t)).toEqual({ stores: 1 })
    expect(recipients()).toEqual(['chef-b@example.com'])
  })

  test('a claim re-reads the settings: a digest turned off since the dispatch claims nothing', async () => {
    const { t, a } = await twoStores()
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('reservationAutomations')
        .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
        .unique()
      await ctx.db.patch(row!._id, { recipients: [] })
    })
    expect(
      await t.mutation(internal.reservationAlerts.sendDueForStore, { storeId: a.storeId }),
    ).toEqual({ digests: 0 })
    expect(await emailedMarks(t, String(a.storeId))).toHaveLength(0)
  })

  test('the dispatcher is bounded: a page of rows at a time, the rest by its own next page', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const TOTAL = 130 // more than one page
    await t.run(async (ctx) => {
      for (let i = 0; i < TOTAL; i++) {
        const storeId =
          i === 0
            ? world.storeId
            : await ctx.db.insert('stores', {
                name: `Store ${i}`,
                slug: `store-${i}`,
                address: { street: '1 rue', city: 'Paris', postalCode: '75002', country: 'France' },
                hours: [],
                status: 'open' as const,
                reservationMode: 'native' as const,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              })
        await ctx.db.insert('reservationAutomations', {
          storeId,
          recipients: ['chef@example.com'],
          alertsEmailEnabled: true,
          updatedAt: Date.now(),
        })
      }
    })

    // One dispatcher call names one page only…
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    let first: { stores: number }
    try {
      first = await t.mutation(internal.reservationAlerts.sendDue, {})
      expect(first.stores).toBeGreaterThan(0)
      expect(first.stores).toBeLessThan(TOTAL)
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }

    // The pages it scheduled name every establishment, each exactly once.
    const jobs = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name.endsWith('reservationAlerts:sendDueForStore'))
        .map((job) => String((job.args[0] as { storeId: string }).storeId)),
    )
    expect(new Set(jobs).size).toBe(TOTAL)
    expect(jobs).toHaveLength(TOTAL)
  })
})
