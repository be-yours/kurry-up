// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The thank-you after the visit, and what a guest answers to it.
 *
 * What is pinned, because each is the kind of rule that breaks silently:
 *
 *  1. the e-mail is OPT-IN, goes once, only for a completed sitting of a guest who has an
 *     address and has not answered, at the delay the owner chose and not hours past it;
 *  2. the five scores are links to the guest's page, which RECORDS NOTHING by itself;
 *  3. an answer is a whole score from 1 to 5 and a few words, one per booking, rewritten
 *     in place for 24 hours from the FIRST answer and locked after;
 *  4. the answer is PRIVATE: no public function returns anybody else's, and the team's
 *     reader is behind `reservations:read`;
 *  5. the owner's own public review link is offered to a 4 or a 5 and to no one else, and
 *     only when it is https.
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
import {
  DAY,
  dateIn,
  refusalCode,
  rebuildStats,
  seedBooking,
  seedWorld,
  statsRows,
  createHarnessFactory,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const sent = () => ses.sends as CapturedEmail[]
const HOUR = 60 * 60_000
const VERSION = 'fr-2026-10'

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

/** A sitting that was completed `ago` milliseconds ago. */
async function sittingCompleted(
  t: Harness,
  world: World,
  ago: number,
  extra: Parameters<typeof seedBooking>[2] = { date: dateIn(0), time: '12:00' },
) {
  const completedAt = Date.now() - ago
  const id = await seedBooking(t, world, {
    status: 'completed',
    completedAt,
    ...extra,
  })
  // The sitting began an hour and a half before it was completed.
  await t.run((ctx) =>
    ctx.db.patch(id, { startsAt: completedAt - 90 * 60_000, endsAt: completedAt }),
  )
  return id
}

const turnOn = (world: World, extra: Record<string, unknown> = {}) =>
  world.manager.mutation(api.reservationAutomations.save, {
    storeId: world.storeId,
    postVisitEnabled: true,
    ...extra,
  })

const sweep = (t: Harness) => t.mutation(internal.reservationFeedback.sendDue, {})
const rowOf = (
  t: Harness,
  id: ReturnType<typeof seedBooking> extends Promise<infer I> ? I : never,
) => t.run((ctx) => ctx.db.get(id))

describe('the thank-you e-mail', () => {
  test('is off until the owner turns it on', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    expect(await deliver(t, () => sweep(t))).toEqual({ thanked: 0 })
    expect(sent()).toHaveLength(0)
    expect((await rowOf(t, id))!.notices?.post_visit).toBeUndefined()
  })

  test('goes once, three hours after the sitting by default, with five links to the guest’s page', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000, {
      date: dateIn(0),
      time: '12:00',
      email: 'marie@example.com',
    })
    await turnOn(world)

    expect(await deliver(t, () => sweep(t))).toEqual({ thanked: 1 })
    const row = (await rowOf(t, id))!
    expect(row.notices?.post_visit).toBeTypeOf('number')
    expect(sent()).toHaveLength(1)
    const mail = sent()[0]!
    expect(mail.Destination.ToAddresses).toEqual(['marie@example.com'])
    expect(mail.Content.Simple.Subject.Data).toBe('Merci de votre visite chez Chez Luigi')
    const text = mail.Content.Simple.Body.Text.Data
    for (let score = 1; score <= 5; score++) {
      expect(text).toContain(
        `https://chez-luigi.example/reservation/feedback/${row.manageToken}?score=${score}`,
      )
    }
    expect(text).toContain('jamais publiée')

    // A second run claims nothing it already claimed.
    expect(await deliver(t, () => sweep(t))).toEqual({ thanked: 0 })
    expect(sent()).toHaveLength(1)
  })

  test('waits for the owner’s delay and does not run hours past the catch-up', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const early = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000, {
      date: dateIn(0),
      time: '12:00',
      email: 'early@example.com',
    })
    const ready = await sittingCompleted(t, world, 6 * HOUR + 10 * 60_000, {
      date: dateIn(0),
      time: '12:00',
      email: 'ready@example.com',
    })
    const lost = await sittingCompleted(t, world, 13 * HOUR, {
      date: dateIn(0),
      time: '12:00',
      email: 'lost@example.com',
    })
    await turnOn(world, { postVisitDelayHours: 6 })

    await deliver(t, () => sweep(t))
    expect((await rowOf(t, early))!.notices?.post_visit).toBeUndefined()
    expect((await rowOf(t, ready))!.notices?.post_visit).toBeTypeOf('number')
    // An outage longer than the catch-up loses the mail on purpose.
    expect((await rowOf(t, lost))!.notices?.post_visit).toBeUndefined()
  })

  test('is not sent to a walk-in, a booking with no address, a guest who answered, or a sitting that did not take place', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const ago = 3 * HOUR + 10 * 60_000
    const skipped = [
      await sittingCompleted(t, world, ago, { date: dateIn(0), time: '12:00', channel: 'walk_in' }),
      await sittingCompleted(t, world, ago, { date: dateIn(0), time: '12:00', feedbackScore: 4 }),
    ]
    const noAddress = await sittingCompleted(t, world, ago, { date: dateIn(0), time: '12:00' })
    await t.run((ctx) => ctx.db.patch(noAddress, { guestEmail: '' }))
    skipped.push(noAddress)
    const seated = await seedBooking(t, world, { date: dateIn(0), time: '12:00', status: 'seated' })
    skipped.push(seated)
    await turnOn(world)

    expect(await deliver(t, () => sweep(t))).toEqual({ thanked: 0 })
    for (const id of skipped) expect((await rowOf(t, id))!.notices?.post_visit).toBeUndefined()
    expect(sent()).toHaveLength(0)
  })

  test('is not sent for an establishment that is no longer open to online booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    await turnOn(world)
    await t.run((ctx) => ctx.db.patch(world.storeId, { reservationMode: 'off' }))
    expect(await deliver(t, () => sweep(t))).toEqual({ thanked: 0 })
  })

  test('gives its claim back, and says why, when the provider refuses', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    await turnOn(world)
    ses.failWith = 'MessageRejected'
    await deliver(t, () => sweep(t))
    const row = (await rowOf(t, id))!
    expect(row.notices?.post_visit).toBeUndefined()
    expect(row.noticeFailure).toMatchObject({ reason: 'transport' })
  })

  test('is not sent when there is nowhere to send the answer', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    await turnOn(world)
    vi.stubEnv('SITE_URL', '')
    vi.stubEnv('BID_APP_URL', '')
    await deliver(t, () => sweep(t))
    expect(sent()).toHaveLength(0)
    expect((await rowOf(t, id))!.notices?.post_visit).toBeUndefined()
  })

  test('is dropped when the owner turns it off between the claim and the send', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    await turnOn(world)
    // Claimed, not yet sent.
    await sweep(t)
    await world.manager.mutation(api.reservationAutomations.save, {
      storeId: world.storeId,
      postVisitEnabled: false,
    })
    const payload = await t.query(internal.reservations.noticePayload, {
      reservationId: id,
      kind: 'post_visit',
    })
    expect(payload).toBeNull()
  })

  test('counts in the day’s figures: a thank-you sent and, later, an answer', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await sittingCompleted(t, world, 3 * HOUR + 10 * 60_000)
    await turnOn(world)
    await deliver(t, () => sweep(t))
    await t.mutation(internal.reservationStats.sweepDirty, {})
    const [row] = await statsRows(t)
    expect(row!.postVisitSent).toBe(1)
    expect(row!.feedbackCount).toBe(0)
  })
})

describe('the guest’s page', () => {
  test('knows an unknown link as nothing', async () => {
    const t = newHarness()
    await seedWorld(t, { looseTables: 2 })
    expect(
      await t.query(api.reservationFeedback.getByToken, { token: 'inconnu-inconnu' }),
    ).toBeNull()
    expect(await t.query(api.reservationFeedback.getByToken, { token: 'x' })).toBeNull()
  })

  test('is open for a completed sitting and shut for any other, and shows the guest nothing of anyone else', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const done = await seedBooking(t, world, {
      date: dateIn(-1),
      time: '19:30',
      status: 'completed',
      feedbackScore: 4,
      feedbackComment: 'Très bien',
      feedbackAnsweredAt: Date.now() - HOUR,
    })
    const upcoming = await seedBooking(t, world, { date: dateIn(3), time: '19:30' })
    const doneRow = (await rowOf(t, done))!
    const upcomingRow = (await rowOf(t, upcoming))!

    const open = await t.query(api.reservationFeedback.getByToken, { token: doneRow.manageToken })
    expect(open).toMatchObject({
      open: true,
      storeName: 'Chez Luigi',
      reference: doneRow.reference,
      answer: { score: 4, comment: 'Très bien', editable: true },
    })
    expect(open!.notice.version).toBe(VERSION)
    // The visit's facts and the guest's own words: no address, phone or name.
    expect(JSON.stringify(open)).not.toMatch(/@|0612|Marie/)

    const shut = await t.query(api.reservationFeedback.getByToken, {
      token: upcomingRow.manageToken,
    })
    expect(shut).toMatchObject({ open: false, answer: null })
  })

  test('shows the review link to a 4 or a 5 and to no one else, and only when the owner set one', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const ids = [] as string[]
    const tokens: Record<number, string> = {}
    for (const score of [2, 3, 4, 5]) {
      const id = await seedBooking(t, world, {
        date: dateIn(-1),
        time: '19:30',
        status: 'completed',
        feedbackScore: score,
      })
      ids.push(String(id))
      tokens[score] = (await rowOf(t, id))!.manageToken
    }
    const link = (score: number) =>
      t.query(api.reservationFeedback.getByToken, { token: tokens[score]! })

    for (const score of [2, 3, 4, 5]) expect((await link(score))!.reviewUrl).toBeNull()

    await world.manager.mutation(api.reservationAutomations.save, {
      storeId: world.storeId,
      reviewUrl: ' https://g.page/r/chez-luigi/review ',
    })
    expect((await link(2))!.reviewUrl).toBeNull()
    expect((await link(3))!.reviewUrl).toBeNull()
    expect((await link(4))!.reviewUrl).toBe('https://g.page/r/chez-luigi/review')
    expect((await link(5))!.reviewUrl).toBe('https://g.page/r/chez-luigi/review')
  })

  test('refuses a review link that is not https, in the settings that carry it', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    for (const bad of ['http://example.com/avis', 'javascript:alert(1)', 'pas un lien']) {
      expect(
        await refusalCode(
          world.manager.mutation(api.reservationAutomations.save, {
            storeId: world.storeId,
            reviewUrl: bad,
          }),
        ),
      ).toBe('invalid_input')
    }
    // Empty clears it.
    await world.manager.mutation(api.reservationAutomations.save, {
      storeId: world.storeId,
      reviewUrl: 'https://example.com/avis',
    })
    await world.manager.mutation(api.reservationAutomations.save, {
      storeId: world.storeId,
      reviewUrl: '',
    })
    expect(
      (await world.manager.query(api.reservationAutomations.get, { storeId: world.storeId }))
        .reviewUrl,
    ).toBeNull()
  })
})

describe('answering', () => {
  async function completed(
    t: Harness,
    world: World,
    extra: Parameters<typeof seedBooking>[2] = { date: dateIn(-1), time: '19:30' },
  ) {
    const id = await seedBooking(t, world, { status: 'completed', ...extra })
    return { id, token: (await rowOf(t, id))!.manageToken }
  }
  const answer = (t: Harness, token: string, score: number, comment?: string) =>
    t.mutation(api.reservationFeedback.submit, {
      token,
      score,
      ...(comment === undefined ? {} : { comment }),
      noticeVersion: VERSION,
    })

  test('records a score and a few words on the booking, with the wording the guest saw', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    const result = await answer(t, token, 5, '  Excellent accueil  ')
    expect(result.score).toBe(5)
    const row = (await rowOf(t, id))!
    expect(row).toMatchObject({
      feedbackScore: 5,
      feedbackComment: 'Excellent accueil',
      feedbackNoticeVersion: VERSION,
    })
    expect(row.feedbackAnsweredAt).toBeTypeOf('number')
    expect(result.editableUntil).toBe(row.feedbackAnsweredAt! + 24 * HOUR)
  })

  test('takes a score alone, and an empty comment clears the words', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    await answer(t, token, 3)
    expect((await rowOf(t, id))!.feedbackComment).toBeUndefined()
    await answer(t, token, 3, 'Un mot')
    await answer(t, token, 3, '   ')
    expect((await rowOf(t, id))!.feedbackComment).toBeUndefined()
  })

  test('is one answer per booking, rewritten in place, and the 24 hours run from the FIRST one', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    await answer(t, token, 2, 'Déçu')
    const first = (await rowOf(t, id))!
    await answer(t, token, 4, 'Finalement bien')
    const second = (await rowOf(t, id))!
    expect(second.feedbackScore).toBe(4)
    expect(second.feedbackComment).toBe('Finalement bien')
    expect(second.feedbackAnsweredAt).toBe(first.feedbackAnsweredAt)
    expect(second.feedbackUpdatedAt).toBeGreaterThanOrEqual(first.feedbackUpdatedAt!)
    // Still one row, still one answer.
    expect(
      (await t.run((ctx) => ctx.db.query('reservations').collect())).filter(
        (r) => r.feedbackScore !== undefined,
      ),
    ).toHaveLength(1)
  })

  test('locks after 24 hours and keeps the answer as it stands', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    await answer(t, token, 2, 'Déçu')
    await t.run((ctx) => ctx.db.patch(id, { feedbackAnsweredAt: Date.now() - 24 * HOUR - 1000 }))
    expect(await refusalCode(answer(t, token, 5, 'Changé'))).toBe('feedback_locked')
    const row = (await rowOf(t, id))!
    expect(row).toMatchObject({ feedbackScore: 2, feedbackComment: 'Déçu' })
    const page = await t.query(api.reservationFeedback.getByToken, { token })
    expect(page!.answer).toMatchObject({ score: 2, editable: false })
  })

  test('refuses what is not a whole score from 1 to 5', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    for (const bad of [0, 6, 2.5, -1, 100]) {
      expect(await refusalCode(answer(t, token, bad))).toBe('invalid_input')
    }
    expect((await rowOf(t, id))!.feedbackScore).toBeUndefined()
  })

  test('refuses an unknown wording version, an unknown link, and a visit that did not take place', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const { token } = await completed(t, world)
    expect(
      await refusalCode(
        t.mutation(api.reservationFeedback.submit, { token, score: 4, noticeVersion: 'inventée' }),
      ),
    ).toBe('consent_required')
    expect(await refusalCode(answer(t, 'inconnu-inconnu-inconnu', 4))).toBe('invalid_input')

    for (const status of ['confirmed', 'no_show', 'cancelled_by_guest', 'seated'] as const) {
      const id = await seedBooking(t, world, { date: dateIn(-1), time: '19:30', status })
      const row = (await rowOf(t, id))!
      expect(await refusalCode(answer(t, row.manageToken, 4)), status).toBe('feedback_unavailable')
    }
  })

  test('caps the comment, and rate limits the booking', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { id, token } = await completed(t, world)
    expect(await refusalCode(answer(t, token, 4, 'x'.repeat(1001)))).toBe('field_too_long')
    expect((await rowOf(t, id))!.feedbackScore).toBeUndefined()
    await answer(t, token, 4, 'x'.repeat(1000))

    for (let i = 0; i < 9; i++) await answer(t, token, 4, `essai ${i}`)
    expect(await refusalCode(answer(t, token, 4, 'une de trop'))).toBe('rate_limited')
  })

  test('marks the day so the figures follow, and the rollup counts the answer', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const { token } = await completed(t, world)
    await rebuildStats(t, world, world.storeId, dateIn(-1), dateIn(-1))
    await answer(t, token, 5)
    expect((await statsRows(t))[0]!.dirtyAt).toBeTypeOf('number')
    await t.mutation(internal.reservationStats.sweepDirty, {})
    const row = (await statsRows(t))[0]!
    expect(row).toMatchObject({ feedbackCount: 1, feedbackSum: 5 })
    expect(row.feedbackScores).toEqual([0, 0, 0, 0, 1])
  })
})

describe('the answer stays private', () => {
  test('has no reader a diner can reach: the booking page of the guest carries none of it', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    const id = await seedBooking(t, world, {
      date: dateIn(-1),
      time: '19:30',
      status: 'completed',
      feedbackScore: 2,
      feedbackComment: 'Service lent',
    })
    const row = (await rowOf(t, id))!
    const page = await t.query(api.reservations.getByToken, { token: row.manageToken })
    expect(JSON.stringify(page)).not.toMatch(/feedback|Service lent/)
    // The public availability and configuration carry no figure about guests either.
    const config = await t.query(api.reservations.getPublicConfig, { storeId: world.storeId })
    expect(JSON.stringify(config)).not.toMatch(/feedback|score|rating|avis/i)
  })

  test('is read by the team, newest first, and by nobody without a role', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 4 })
    const old = await seedBooking(t, world, {
      date: dateIn(-5),
      time: '19:30',
      status: 'completed',
      name: 'Ancienne Cliente',
      feedbackScore: 3,
      feedbackComment: 'Correct',
      feedbackAnsweredAt: Date.now() - 4 * DAY,
    })
    const recent = await seedBooking(t, world, {
      date: dateIn(-1),
      time: '19:30',
      status: 'completed',
      name: 'Récent Client',
      feedbackScore: 5,
      feedbackComment: 'Parfait',
      feedbackAnsweredAt: Date.now() - HOUR,
    })
    await seedBooking(t, world, { date: dateIn(-1), time: '20:00', status: 'completed' })
    expect(old).not.toBe(recent)

    const list = await world.waiter.query(api.reservationFeedback.list, { storeId: world.storeId })
    expect(list.map((entry) => [entry.guestName, entry.score, entry.comment])).toEqual([
      ['Récent Client', 5, 'Parfait'],
      ['Ancienne Cliente', 3, 'Correct'],
    ])
    await expect(
      t.query(api.reservationFeedback.list, { storeId: world.storeId }),
    ).rejects.toThrow()
  })

  test('is capped at thirty answers a read', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    for (let i = 0; i < 35; i++) {
      await seedBooking(t, world, {
        date: dateIn(-1),
        time: '19:30',
        status: 'completed',
        feedbackScore: 4,
        feedbackAnsweredAt: Date.now() - i * 60_000,
      })
    }
    const list = await world.manager.query(api.reservationFeedback.list, {
      storeId: world.storeId,
      limit: 1000,
    })
    expect(list).toHaveLength(30)
  })

  test('is never aggregated into a table a visitor could read', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2 })
    await seedBooking(t, world, {
      date: dateIn(-1),
      time: '19:30',
      status: 'completed',
      feedbackScore: 5,
    })
    const tables = Object.keys((await import('../../convex/schema')).default.tables)
    // This product has no review or rating table, and phase 4 adds none.
    expect(tables.filter((name) => /review|rating|testimonial|avis/i.test(name))).toEqual([])
  })
})
