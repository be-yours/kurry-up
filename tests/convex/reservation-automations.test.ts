// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The built-in automations and the daily report.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. every switch on the settings screen is WIRED: the registry names eight, and a
 *     table below holds one test per automation (a missing key fails the typecheck, so a
 *     ninth switch cannot be added without a behaviour and a test behind it);
 *  2. saving is a patch: it changes only what it is given, and does not wipe the rules
 *     nor get wiped by the rules form;
 *  3. an e-mail that would go to nobody cannot be switched on, and an address that is not
 *     one is refused by name;
 *  4. the daily report is due once a day at the wall-clock time in the establishment's own
 *     zone, across the clock changes, and says how many bookings carry a request without
 *     ever repeating the words.
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

import {
  RESERVATION_AUTOMATIONS,
  wallClockToInstant,
  type AutomationId,
} from '@be-yours/convex-schema'
import { api, internal } from '../../convex/_generated/api'
import {
  DAY,
  bookSlot,
  dateIn,
  openSlots,
  refusalCode,
  refusalMessage,
  reservationRows,
  seedBooking,
  seedWorld,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const sent = () => ses.sends as CapturedEmail[]
const HOUR = 60 * 60_000
const TZ = 'Europe/Paris'
const at = (date: string, time: string) => wallClockToInstant(date, time, TZ)!.at

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
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Run `act` with the clock at `now`, then let whatever it queued run. */
async function at_<T>(t: Harness, now: number, act: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ now })
  try {
    const result = await act()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return result
  } finally {
    vi.useRealTimers()
  }
}

const save = (world: World, fields: Record<string, unknown>) =>
  world.manager.mutation(api.reservationAutomations.save, { storeId: world.storeId, ...fields })
const read = (world: Pick<World, 'manager' | 'storeId'>) =>
  world.manager.query(api.reservationAutomations.get, { storeId: world.storeId })
const settingsRow = (t: Harness) => t.run((ctx) => ctx.db.query('reservationSettings').first())
const automationsRow = (t: Harness) =>
  t.run((ctx) => ctx.db.query('reservationAutomations').first())

describe('the state the screen shows', () => {
  test('is the default of each automation until the owner decides', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, storeEmail: 'contact@luigi.fr' })
    const state = await read(world)
    expect(state).toMatchObject({
      rules: { autoConfirm: true, reminderHoursBefore: 0, waitlistEnabled: false },
      reconfirmationEnabled: true,
      autoExpireRequests: true,
      postVisitEnabled: false,
      postVisitDelayHours: 3,
      reviewUrl: null,
      dailyReportEnabled: false,
      dailyReportTime: '17:00',
      alertsEnabled: true,
      alertsEmailEnabled: false,
      recipients: [],
      suggestedRecipient: 'contact@luigi.fr',
    })
    expect(state.alertThresholds).toEqual({
      nearlyFullPercent: 85,
      largeParty: 8,
      repeatNoShows: 2,
      unconfirmedMinutes: 180,
      pendingHours: 4,
    })
    // The defaults the screen quotes are the ones the server applies.
    expect(state.defaults.alertThresholds).toEqual(state.alertThresholds)
  })

  test('is the same for a team member who may only read, who may not change it', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect(
      await world.waiter.query(api.reservationAutomations.get, { storeId: world.storeId }),
    ).toBeTruthy()
    await expect(
      world.waiter.mutation(api.reservationAutomations.save, {
        storeId: world.storeId,
        postVisitEnabled: true,
      }),
    ).rejects.toThrow()
    await expect(
      t.query(api.reservationAutomations.get, { storeId: world.storeId }),
    ).rejects.toThrow()
  })
})

describe('saving', () => {
  test('changes only what it is given, on the rules row and on its own', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const before = (await settingsRow(t))!
    await save(world, { reminderHoursBefore: 24, waitlistEnabled: true, postVisitEnabled: true })

    const rules = (await settingsRow(t))!
    expect(rules).toMatchObject({ reminderHoursBefore: 24, waitlistEnabled: true })
    // Patched, never replaced: everything else on the rules row is as it was.
    expect({
      ...rules,
      reminderHoursBefore: undefined,
      waitlistEnabled: undefined,
      updatedAt: 0,
    }).toEqual({
      ...before,
      reminderHoursBefore: undefined,
      waitlistEnabled: undefined,
      updatedAt: 0,
    })
    expect(await automationsRow(t)).toMatchObject({ postVisitEnabled: true, recipients: [] })

    // A second save of one field leaves the others alone.
    await save(world, { postVisitDelayHours: 5 })
    expect(await automationsRow(t)).toMatchObject({
      postVisitEnabled: true,
      postVisitDelayHours: 5,
    })
  })

  test('a reminder of 0 hours switches it off, and the rules form does not undo the automations', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await save(world, { reminderHoursBefore: 24 })
    await save(world, { reminderHoursBefore: 0 })
    expect((await settingsRow(t))!.reminderHoursBefore).toBeUndefined()

    await save(world, {
      dailyReportEnabled: false,
      postVisitEnabled: true,
      recipients: ['chef@example.com'],
    })
    // The rules form replaces the whole rules row with what it knows.
    const rules = (await settingsRow(t))!
    await world.manager.mutation(api.reservations.saveSettings, {
      storeId: world.storeId,
      capacityMode: rules.capacityMode,
      slotStepMinutes: rules.slotStepMinutes,
      turnoverBufferMinutes: rules.turnoverBufferMinutes,
      minNoticeMinutes: rules.minNoticeMinutes,
      maxHorizonDays: rules.maxHorizonDays,
      maxPartySize: rules.maxPartySize,
      maxSimultaneousCovers: rules.maxSimultaneousCovers,
      autoConfirm: rules.autoConfirm,
      cancellationDeadlineHours: rules.cancellationDeadlineHours,
      noticeVersion: rules.noticeVersion,
    })
    expect(await automationsRow(t)).toMatchObject({
      postVisitEnabled: true,
      recipients: ['chef@example.com'],
    })
  })

  test('refuses the rules it cannot honour, and says which', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    for (const bad of [
      { reminderHoursBefore: 73 },
      { reminderHoursBefore: 1.5 },
      { postVisitDelayHours: 0 },
      { postVisitDelayHours: 73 },
      { dailyReportTime: '25:00' },
      { dailyReportTime: '5pm' },
      { alertThresholds: { nearlyFullPercent: 20 } },
      { alertThresholds: { largeParty: 1 } },
      { alertThresholds: { pendingHours: 1000 } },
    ]) {
      expect(await refusalCode(save(world, bad)), JSON.stringify(bad)).toBe('invalid_input')
    }
    expect(await automationsRow(t)).toBeNull()
  })

  test('refuses an address that is not one, naming it, and more than five', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect(
      await refusalMessage(save(world, { recipients: ['chef@example.com', 'pas-une-adresse'] })),
    ).toMatch(/pas-une-adresse/)
    expect(
      await refusalCode(
        save(world, { recipients: Array.from({ length: 6 }, (_, i) => `u${i}@example.com`) }),
      ),
    ).toBe('invalid_input')
    await save(world, {
      recipients: [' Chef@Example.com ', 'chef@example.com', 'compta@example.com'],
    })
    expect((await read(world)).recipients).toEqual(['chef@example.com', 'compta@example.com'])
  })

  test('refuses to switch on an e-mail that would go to nobody, and keeps recipients you already have', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect(await refusalMessage(save(world, { dailyReportEnabled: true }))).toMatch(
      /au moins une adresse/,
    )
    expect(await refusalCode(save(world, { alertsEmailEnabled: true }))).toBe('invalid_input')
    await save(world, {
      recipients: ['chef@example.com'],
      dailyReportEnabled: true,
      alertsEmailEnabled: true,
    })
    // Once there are recipients, switching on again is fine…
    await save(world, { dailyReportEnabled: true })
    // …but they cannot be taken away while an e-mail still depends on them.
    expect(await refusalMessage(save(world, { recipients: [] }))).toMatch(/au moins une adresse/)
    await save(world, { dailyReportEnabled: false, alertsEmailEnabled: false, recipients: [] })
    expect((await read(world)).recipients).toEqual([])
  })

  test('refuses to change a booking rule on a book that was never set up', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await t.run(async (ctx) => {
      await ctx.db.delete((await ctx.db.query('reservationSettings').first())!._id)
    })
    expect(await refusalCode(save(world, { autoConfirm: false }))).toBe(
      'reservations_not_configured',
    )
    // The rest do not need rules.
    expect(await refusalCode(save(world, { alertsEnabled: false }))).toBeUndefined()
  })

  test('merges thresholds one at a time', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await save(world, { alertThresholds: { largeParty: 12 } })
    await save(world, { alertThresholds: { pendingHours: 6 } })
    expect((await read(world)).alertThresholds).toMatchObject({
      largeParty: 12,
      pendingHours: 6,
      nearlyFullPercent: 85,
    })
  })
})

/**
 * One test per automation: the switch, the reader, and both states. The type of this
 * record is the registry's ids, so adding an automation without a test here fails the
 * typecheck rather than shipping a switch nothing proves.
 */
const WIRING: Record<AutomationId, () => Promise<void>> = {
  async confirmation() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, autoConfirm: true })
    const [slot] = await openSlots(t, world.storeId)
    await bookSlot(t, world, slot!)
    expect((await reservationRows(t))[0]!.status).toBe('confirmed')

    await save(world, { autoConfirm: false })
    const [other] = await openSlots(t, world.storeId, 2, { date: dateIn(11) })
    await bookSlot(t, world, other!, { date: dateIn(11), email: 'autre@example.com' })
    expect(
      (await reservationRows(t)).find((r) => r.guestEmail === 'autre@example.com')!.status,
    ).toBe('pending')
  },

  async reminder() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const now = Date.now()
    const make = async () => {
      const id = await seedBooking(t, world, { date: dateIn(1), time: '19:30' })
      await t.run((ctx) =>
        ctx.db.patch(id, {
          startsAt: now + 23 * HOUR,
          endsAt: now + 24.5 * HOUR,
          createdAt: now - 3 * DAY,
        }),
      )
      return id
    }
    const id = await make()
    // Off by default: the sweep reminds nobody.
    await t.mutation(internal.reservations.sendDueReminders, {})
    expect((await t.run((ctx) => ctx.db.get(id)))!.notices?.reminder).toBeUndefined()

    await save(world, { reminderHoursBefore: 24 })
    await t.mutation(internal.reservations.sendDueReminders, {})
    expect((await t.run((ctx) => ctx.db.get(id)))!.notices?.reminder).toBeTypeOf('number')
  },

  async reconfirmation() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await seedBooking(t, world, { date: dateIn(3), time: '19:30' })
    const row = (await t.run((ctx) => ctx.db.get(id)))!
    const page = () => t.query(api.reservations.getByToken, { token: row.manageToken })

    // On by default: the page offers « Je serai là », the reminder asks, the button works.
    expect((await page())!.canReconfirm).toBe(true)
    const asks = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'reminder',
    })
    expect(asks!.email.askReconfirmation).toBe(true)

    await save(world, { reconfirmationEnabled: false })
    expect((await page())!.canReconfirm).toBe(false)
    const tells = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'reminder',
    })
    expect(tells!.email.askReconfirmation).toBe(false)
    expect(
      await refusalCode(t.mutation(api.reservations.reconfirmByToken, { token: row.manageToken })),
    ).toBe('transition_refused')
    // The kind of notice that is not a reminder says nothing about it.
    const other = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'confirmed',
    })
    expect(other!.email.askReconfirmation).toBeUndefined()
  },

  async waitlist() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 1 })
    for (let i = 0; i < 20; i++) {
      const [slot] = await openSlots(t, world.storeId)
      if (!slot) break
      await bookSlot(t, world, slot, { email: `full${i}@example.com` })
    }
    const join = () =>
      t.mutation(api.reservationWaitlist.join, {
        storeId: world.storeId,
        guest: { name: 'Paul', email: 'paul@example.com', phone: '0600000000' },
        partySize: 2,
        date: dateIn(10),
        privacyNoticeVersion: 'fr-2026-10',
      })
    expect(await refusalCode(join())).toBe('waitlist_disabled')
    expect(
      (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
        .waitlistEnabled,
    ).toBe(false)

    await save(world, { waitlistEnabled: true })
    expect(
      (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
        .waitlistEnabled,
    ).toBe(true)
    expect(await join()).toEqual({ joined: true })

    await save(world, { waitlistEnabled: false })
    expect((await read(world)).rules!.waitlistEnabled).toBe(false)
  },

  async auto_expiry() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const stale = async (email: string) => {
      const id = await seedBooking(t, world, {
        date: dateIn(-1),
        time: '19:30',
        status: 'pending',
        email,
      })
      return id
    }
    const kept = await stale('kept@example.com')
    await save(world, { autoExpireRequests: false })
    await t.mutation(internal.reservations.expireUnanswered, {})
    // Switched off: the stale request stays in the book for the team to settle by hand.
    expect((await t.run((ctx) => ctx.db.get(kept)))!.status).toBe('pending')

    await save(world, { autoExpireRequests: true })
    await t.mutation(internal.reservations.expireUnanswered, {})
    expect((await t.run((ctx) => ctx.db.get(kept)))!.status).toBe('expired')
  },

  async post_visit() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const completedAt = Date.now() - 3 * HOUR - 10 * 60_000
    const id = await seedBooking(t, world, {
      date: dateIn(0),
      time: '12:00',
      status: 'completed',
      completedAt,
    })
    await t.run((ctx) =>
      ctx.db.patch(id, { startsAt: completedAt - 90 * 60_000, endsAt: completedAt }),
    )
    expect(await t.mutation(internal.reservationFeedback.sendDue, {})).toEqual({ thanked: 0 })
    await save(world, { postVisitEnabled: true })
    expect(
      await at_(t, Date.now(), () => t.mutation(internal.reservationFeedback.sendDue, {})),
    ).toEqual({
      thanked: 1,
    })
  },

  async daily_report() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const now = at('2026-11-03', '17:05')
    await save(world, { recipients: ['chef@example.com'] })
    await at_(t, now, async () => {
      expect(await t.mutation(internal.reservationAutomations.sendDue, {})).toEqual({ reports: 0 })
    })
    await save(world, { dailyReportEnabled: true })
    await at_(t, now, async () => {
      expect(await t.mutation(internal.reservationAutomations.sendDue, {})).toEqual({ reports: 1 })
    })
    expect(sent()).toHaveLength(1)
  },

  async alerts() {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    expect(
      (await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId })).enabled,
    ).toBe(true)
    await save(world, { alertsEnabled: false })
    expect(
      await world.manager.query(api.reservationAlerts.list, { storeId: world.storeId }),
    ).toEqual({
      enabled: false,
      alerts: [],
      dismissed: 0,
      truncated: false,
    })
    // E-mailed alerts are a switch of their own, and need recipients and the centre on.
    await save(world, {
      alertsEnabled: true,
      recipients: ['chef@example.com'],
      alertsEmailEnabled: true,
    })
    await seedBooking(t, world, { date: dateIn(2), time: '20:00', partySize: 10 })
    await at_(t, Date.now(), async () => {
      // The dispatcher names the establishment; its own job claims the alert.
      expect(await t.mutation(internal.reservationAlerts.sendDue, {})).toEqual({ stores: 1 })
    })
    const emailed = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('reservationAlertMarks').collect()).filter((m) => m.kind === 'emailed'),
      )
    expect(await emailed()).toHaveLength(1)
    await save(world, { alertsEmailEnabled: false })
    await seedBooking(t, world, { date: dateIn(3), time: '20:00', partySize: 11 })
    await at_(t, Date.now(), async () => {
      expect(await t.mutation(internal.reservationAlerts.sendDue, {})).toEqual({ stores: 0 })
    })
    expect(await emailed()).toHaveLength(1)
  },
}

describe('every switch is wired to a behaviour', () => {
  for (const automation of RESERVATION_AUTOMATIONS) {
    test(`${automation.id}: ${automation.title}`, async () => {
      await WIRING[automation.id]()
    })
  }

  test('the registry names exactly the automations tested above', () => {
    expect(RESERVATION_AUTOMATIONS.map((a) => a.id).sort()).toEqual(Object.keys(WIRING).sort())
  })
})

describe('the daily report', () => {
  const TODAY = '2026-11-03'

  async function reportWorld(t: Harness, extra: Record<string, unknown> = {}) {
    const world = await seedWorld(t, { looseTables: 6, storeEmail: 'contact@luigi.fr' })
    await save(world, {
      dailyReportEnabled: true,
      recipients: ['chef@example.com', 'compta@example.com'],
      ...extra,
    })
    return world
  }

  const claims = (t: Harness) => t.run((ctx) => ctx.db.query('reservationAutomations').first())
  const run = (t: Harness, now: number) =>
    at_(t, now, () => t.mutation(internal.reservationAutomations.sendDue, {}))

  test('is not due before its time, due from it, and claimed once for the day', async () => {
    const t = newHarness()
    await reportWorld(t)
    expect(await run(t, at(TODAY, '16:59'))).toEqual({ reports: 0 })
    expect(sent()).toHaveLength(0)

    expect(await run(t, at(TODAY, '17:05'))).toEqual({ reports: 1 })
    expect((await claims(t))!.dailyReportClaimedFor).toBe(TODAY)
    // One mail to each recipient, on its own: nobody sees a colleague's address.
    expect(sent().map((mail) => mail.Destination.ToAddresses)).toEqual([
      ['chef@example.com'],
      ['compta@example.com'],
    ])

    expect(await run(t, at(TODAY, '17:20'))).toEqual({ reports: 0 })
    expect(sent()).toHaveLength(2)
    // And again the next day.
    expect(await run(t, at('2026-11-04', '17:00'))).toEqual({ reports: 1 })
    expect(sent()).toHaveLength(4)
  })

  test('uses the owner’s time, in the establishment’s own zone', async () => {
    const t = newHarness()
    await reportWorld(t, { dailyReportTime: '08:30' })
    expect(await run(t, at(TODAY, '08:00'))).toEqual({ reports: 0 })
    expect(await run(t, at(TODAY, '08:31'))).toEqual({ reports: 1 })
  })

  test('is lost, on purpose, once the catch-up has run out', async () => {
    const t = newHarness()
    await reportWorld(t)
    expect(await run(t, at(TODAY, '20:15'))).toEqual({ reports: 0 })
  })

  test('says how tomorrow looks and how yesterday went', async () => {
    const t = newHarness()
    const world = await reportWorld(t, { alertThresholds: { largeParty: 8 } })
    // Tomorrow: a pair, a party of ten, a request waiting for the team, one with a request.
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '19:30',
      partySize: 2,
      table: 'Libre 1',
    })
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '20:00',
      partySize: 10,
      table: 'Libre 2',
    })
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '20:00',
      partySize: 3,
      status: 'pending',
      table: 'Libre 3',
    })
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '20:30',
      partySize: 2,
      guestNote: 'allergie aux arachides',
      table: 'Libre 4',
      email: 'allergique@example.com',
    })
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '20:30',
      partySize: 4,
      status: 'cancelled_by_guest',
    })
    // Yesterday: two sittings, one absence, one cancellation, a walk-in.
    await seedBooking(t, world, {
      date: '2026-11-02',
      time: '19:30',
      partySize: 4,
      status: 'completed',
      mealMinutes: 80,
    })
    await seedBooking(t, world, {
      date: '2026-11-02',
      time: '19:30',
      partySize: 2,
      status: 'completed',
      mealMinutes: 100,
      table: 'Libre 2',
    })
    await seedBooking(t, world, {
      date: '2026-11-02',
      time: '20:00',
      status: 'no_show',
      table: 'Libre 3',
    })
    await seedBooking(t, world, {
      date: '2026-11-02',
      time: '20:00',
      status: 'cancelled_by_restaurant',
      table: 'Libre 4',
    })
    await seedBooking(t, world, {
      date: '2026-11-02',
      time: '20:30',
      partySize: 3,
      channel: 'walk_in',
      status: 'completed',
      table: 'Libre 5',
    })

    await run(t, at(TODAY, '17:05'))
    const mail = sent()[0]!
    expect(mail.Content.Simple.Subject.Data).toBe(
      'Carnet de demain chez Chez Luigi : 4 réservations',
    )
    const text = mail.Content.Simple.Body.Text.Data
    expect(text).toContain('DEMAIN, MERCREDI 4 NOVEMBRE')
    expect(text).toContain('4 réservations · 17 couverts')
    expect(text).toContain('Pic : 20:30')
    expect(text).toContain('Grands groupes (8 personnes et plus) : 20:00 · 10 personnes')
    expect(text).toContain('À valider : 1 demande attend votre réponse')
    expect(text).toContain('Demandes particulières à lire dans le carnet (1) : 20:30 · 2 personnes')
    expect(text).toContain('HIER, LUNDI 2 NOVEMBRE')
    expect(text).toContain('2 réservations · 6 couverts')
    expect(text).toContain('3 couverts sans réservation')
    expect(text).toContain('1 absence · 1 annulation')
    expect(text).toContain("Durée moyenne d'un repas : 1 h 30")
    expect(text).toContain('https://chez-luigi.example/dashboard/reservations')
    expect(text).toContain('Pour arrêter ce rapport')
  })

  test('never repeats what a guest wrote, nor a phone number or an address', async () => {
    const t = newHarness()
    const world = await reportWorld(t)
    await seedBooking(t, world, {
      date: '2026-11-04',
      time: '20:00',
      guestNote: 'allergie aux arachides sévère',
      email: 'allergique@example.com',
      name: 'Hélène Allergique',
    })
    await run(t, at(TODAY, '17:05'))
    for (const mail of sent()) {
      const body = `${mail.Content.Simple.Body.Text.Data}${mail.Content.Simple.Body.Html.Data}`
      expect(body).not.toMatch(/arachides|allergique@|Hélène|0612345678/i)
      expect(body).toMatch(/Demandes particulières à lire dans le carnet \(1\)/)
    }
  })

  test('says plainly when nothing is booked', async () => {
    const t = newHarness()
    await reportWorld(t)
    await run(t, at(TODAY, '17:05'))
    expect(sent()[0]!.Content.Simple.Subject.Data).toBe(
      'Carnet de demain chez Chez Luigi : aucune réservation',
    )
  })

  test('gives its claim back, and says why, when nobody could be reached', async () => {
    const t = newHarness()
    await reportWorld(t)
    ses.failWith = 'MessageRejected'
    await run(t, at(TODAY, '17:05'))
    const row = (await claims(t))!
    expect(row.dailyReportClaimedFor).toBeUndefined()
    expect(row.dailyReportFailure).toMatchObject({ reason: 'transport' })
    // The next quarter of an hour tries again, inside the catch-up window.
    ses.failWith = null
    await run(t, at(TODAY, '17:20'))
    expect(sent()).toHaveLength(2)
    expect((await claims(t))!.dailyReportClaimedFor).toBe(TODAY)
    expect((await claims(t))!.dailyReportFailure).toBeUndefined()
  })

  test('says there is no sender when there is none', async () => {
    const t = newHarness()
    await reportWorld(t)
    vi.stubEnv('AWS_SES_FROM_EMAIL', '')
    await run(t, at(TODAY, '17:05'))
    expect((await claims(t))!.dailyReportFailure).toMatchObject({ reason: 'no_sender_address' })
    expect(sent()).toHaveLength(0)
  })

  test('is dropped when the owner turns it off between the claim and the send', async () => {
    const t = newHarness()
    const world = await reportWorld(t)
    vi.useFakeTimers({ now: at(TODAY, '17:05') })
    try {
      await t.mutation(internal.reservationAutomations.sendDue, {})
      await save(world, { dailyReportEnabled: false })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }
    expect(sent()).toHaveLength(0)
  })

  test('is sent to nobody for an establishment closed to online booking, or with no recipients', async () => {
    const t = newHarness()
    const world = await reportWorld(t)
    await t.run((ctx) => ctx.db.patch(world.storeId, { reservationMode: 'off' }))
    expect(await run(t, at(TODAY, '17:05'))).toEqual({ reports: 0 })
    await t.run((ctx) => ctx.db.patch(world.storeId, { reservationMode: 'native' }))
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('reservationAutomations').first())!
      await ctx.db.patch(row._id, { recipients: [] })
    })
    expect(await run(t, at(TODAY, '17:05'))).toEqual({ reports: 0 })
  })

  test('goes out once on the day the clocks go forward, for a time that does not exist', async () => {
    const t = newHarness()
    await reportWorld(t, { dailyReportTime: '02:30' })
    // 2026-03-29: Paris skips 02:00-03:00, so 02:30 resolves forward, to 03:30.
    const resolved = wallClockToInstant('2026-03-29', '02:30', TZ)!
    expect(resolved.kind).toBe('nonexistent')
    let reports = 0
    for (let now = at('2026-03-29', '00:00'); now < at('2026-03-30', '00:00'); now += 15 * 60_000) {
      const result = await at_(t, now, () =>
        t.mutation(internal.reservationAutomations.sendDue, {}),
      )
      reports += result.reports
      if (result.reports > 0) expect(now).toBeGreaterThanOrEqual(resolved.at)
    }
    expect(reports).toBe(1)
  })

  test('goes out once on the day the clocks go back, for a time that happens twice', async () => {
    const t = newHarness()
    await reportWorld(t, { dailyReportTime: '02:30' })
    const resolved = wallClockToInstant('2026-10-25', '02:30', TZ)!
    expect(resolved.kind).toBe('ambiguous')
    let reports = 0
    for (let now = at('2026-10-25', '00:00'); now < at('2026-10-26', '05:00'); now += 15 * 60_000) {
      const result = await at_(t, now, () =>
        t.mutation(internal.reservationAutomations.sendDue, {}),
      )
      reports += result.reports
    }
    // The 25th and the 26th: one report each, not three.
    expect(reports).toBe(2)
  })
})
