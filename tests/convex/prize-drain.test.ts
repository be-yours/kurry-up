// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The anonymous prize drain (#323, source card NEW-N).
 *
 * `gamePlay.play` is public and anonymous on purpose — the whole product is a
 * diner scanning a QR code at a table — and its only fairness mechanism was a
 * 24h cooldown keyed on `args.fingerprint`, a string the browser sends. So the
 * loop below used to empty a restaurant's prize budget: 40 calls changing
 * nothing but that string, 0 refused, a five-prize stock at zero.
 *
 * These tests drive the real public mutation through the real schema and the
 * real `rateLimits` table, because that is the seam the card measured. The
 * unit suite in `packages/convex-functions` calls the same handlers past a
 * hand-rolled `db` mock, which cannot show that the limiter's index exists.
 *
 * #NEW-N closed the residual those windows left open. Two guards were added and
 * both are pinned below: an establishment-wide PRIZE BUDGET (the windows bound
 * how often the endpoint is called, never how much it gives away — 500 calls
 * over 40 table codes still issued 200 prizes in an hour), and server-side
 * enforcement of the store's REQUIRED ACTIONS (`completedActions` was written
 * to the row and never read to permit anything, so a caller sending `[]` won a
 * prize while the store required a Google review).
 *
 * One case here was REWRITTEN rather than kept. "what this does NOT fix: the
 * stock still empties" asserted the defect as settled behaviour. It is still
 * true of a stock smaller than the budget in force, and that half survives
 * below with its reasoning intact — but it is no longer true of the store as a
 * whole, and an owner can now set a budget that protects a small stock. A test
 * that blessed the old ceiling would have hidden the new one.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

import { GAME_CONSENT_NOTICE_VERSIONS } from "@be-yours/convex-functions/gamePlay"

const modules = import.meta.glob("../../convex/**/*.ts")

/** The play mutation refuses a play whose notice version it does not know. */
const CONSENT_VERSION = GAME_CONSENT_NOTICE_VERSIONS[0]!

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
})

/**
 * A restaurant running a wheel that always wins, with a five-prize budget.
 *
 * The store goes through `stores.create` rather than a hand-built row: the
 * table has required fields a fixture forgets, and the point of an app-level
 * test is to stop guessing at them.
 */
async function seedGame(
  t: ReturnType<typeof convexTest>,
  prizeStock = 5,
  opts: {
    /** Extra table codes, so a drain can spread across a room. */
    tables?: number
    /** What the owner set, if anything. Absent means the shipped default. */
    prizeBudget?: { maxPrizes: number; windowHours: number }
    /** Social actions the store demands before a draw. */
    requiredActions?: number
  } = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "marie",
      role: "client_admin",
      storeIds: [],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  const marie = t.withIdentity({ subject: "marie" })
  const storeId: Id<"stores"> = await marie.mutation(api.stores.create, {
    name: "Pizzeria Napoli",
    slug: "pizzeria-napoli",
    description: "Napolitaine au feu de bois",
    address: {
      street: "12 rue Oberkampf",
      city: "Paris",
      postalCode: "75011",
      country: "France",
    },
    phone: "+33145678901",
    email: "napoli@example.com",
  })

  return await t.run(async (ctx) => {
    const codes: string[] = []
    for (let i = 0; i < (opts.tables ?? 1); i++) {
      const code = i === 0 ? "TABLE1" : `TABLE${i + 1}`
      codes.push(code)
      await ctx.db.insert("gameQRCodes", {
        storeId,
        code,
        isActive: true,
        scannedCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
    const gameId: Id<"games"> = await ctx.db.insert("games", {
      storeId,
      type: "wheel",
      name: "Roue de la chance",
      winRatio: 100,
      isActive: true,
      ...(opts.prizeBudget ? { config: { prizeBudget: opts.prizeBudget } } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    })
    const prizeId: Id<"prizes"> = await ctx.db.insert("prizes", {
      storeId,
      name: "Pizza offerte",
      type: "free_product",
      validityDays: 7,
      remainingCount: prizeStock,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const actionIds: Id<"requiredActions">[] = []
    for (let i = 0; i < (opts.requiredActions ?? 0); i++) {
      actionIds.push(
        await ctx.db.insert("requiredActions", {
          storeId,
          type: "google_review",
          name: `Avis Google ${i + 1}`,
          isRequired: true,
          sortOrder: i,
          isActive: true,
          createdAt: NOW,
          updatedAt: NOW,
        })
      )
    }
    return { storeId, gameId, prizeId, codes, actionIds }
  })
}


describe("the drain the card measured, run against the real backend", () => {
  test("40 anonymous plays rotating the fingerprint are refused past the window", async () => {
    const t = newHarness()
    const { gameId, prizeId } = await seedGame(t)

    let refused = 0
    let admitted = 0
    for (let i = 0; i < 40; i++) {
      try {
        await t.mutation(api.gamePlay.play, {
          consentNoticeVersion: CONSENT_VERSION,
          code: "TABLE1",
          gameId,
          // The only thing that changes, and the only thing that used to matter.
          fingerprint: `drain-${i}`,
          completedActions: [],
        })
        admitted++
      } catch {
        refused++
      }
    }

    // Before #323: admitted 40, refused 0.
    expect(admitted).toBe(10)
    expect(refused).toBe(30)

    const plays = await t.run((ctx) => ctx.db.query("gamePlays").collect())
    expect(plays).toHaveLength(10)

    // The limiter wrote through the real index, not a mock.
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect())
    expect(limits.some((r) => r.key.startsWith("gamePlayPerQr:"))).toBe(true)
    expect(limits.some((r) => r.key.startsWith("gamePlayPerStore:"))).toBe(true)

    // eslint-disable-next-line no-console
    console.log({
      attempts: 40,
      admitted,
      refused,
      stockAfter: (await t.run((ctx) => ctx.db.get(prizeId)))?.remainingCount,
    })
  })

  test("the window survives a caller changing every argument it controls", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 100)

    for (let i = 0; i < 10; i++) {
      await t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        fingerprint: `f-${i}`,
        completedActions: [`invented-${i}`],
        userAgent: `UA-${i}`,
      })
    }

    await expect(
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        fingerprint: "brand-new",
        completedActions: [],
      })
    ).rejects.toThrow()
  })

  test("the establishment budget bounds a drain spread across the whole room", async () => {
    const t = newHarness()
    // 40 photographed table codes: enough to spend `gamePlayPerQr` forty times
    // over and reach `gamePlayPerStore`, which is what made the per-QR window
    // insufficient on its own.
    const { gameId, prizeId, codes } = await seedGame(t, 500, { tables: 40 })

    let won = 0
    let refused = 0
    for (let i = 0; i < 500; i++) {
      try {
        const r = await t.mutation(api.gamePlay.play, {
          consentNoticeVersion: CONSENT_VERSION,
          code: codes[i % codes.length]!,
          gameId,
          fingerprint: `drain-${i}`,
          completedActions: [],
        })
        if (r.didWin) won++
      } catch {
        refused++
      }
    }

    // Measured before the budget landed: won 200, stock 500 -> 300. The rate
    // windows admitted 200 plays an hour and a 100% win ratio turned every one
    // of them into a free pizza.
    expect(won).toBe(50)
    expect(refused).toBeGreaterThan(0)
    expect((await t.run((ctx) => ctx.db.get(prizeId)))?.remainingCount).toBe(450)
  })

  test("an owner who sets the budget below the stock keeps the rest of it", async () => {
    const t = newHarness()
    const { gameId, prizeId, codes } = await seedGame(t, 5, {
      prizeBudget: { maxPrizes: 2, windowHours: 24 },
    })

    const outcomes: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: codes[0]!,
        gameId,
        fingerprint: `taker-${i}`,
        completedActions: [],
      })
      outcomes.push(r.didWin)
    }

    // Past the budget the play still resolves — the diner spins and loses.
    // Refusing would tell a prober where the budget sits and would punish
    // whoever happened to scan next.
    expect(outcomes).toEqual([true, true, false, false, false])
    expect((await t.run((ctx) => ctx.db.get(prizeId)))?.remainingCount).toBe(3)
    const plays = await t.run((ctx) => ctx.db.query("gamePlays").collect())
    expect(plays).toHaveLength(5)
  })

  test("a losing spin costs the budget nothing", async () => {
    const t = newHarness()
    const { gameId, codes, storeId } = await seedGame(t, 5, {
      prizeBudget: { maxPrizes: 2, windowHours: 24 },
    })
    await t.run(async (ctx) => {
      const game = (await ctx.db.query("games").first())!
      await ctx.db.patch(game._id, { winRatio: 0 })
    })

    for (let i = 0; i < 3; i++) {
      const r = await t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: codes[0]!,
        gameId,
        fingerprint: `loser-${i}`,
        completedActions: [],
      })
      expect(r.didWin).toBe(false)
    }

    // A ledger that recorded attempts would let a run of losing spins exhaust a
    // budget nothing came out of.
    const ledger = await t.run((ctx) => ctx.db.query("prizeIssuance").collect())
    expect(ledger.filter((r) => r.storeId === storeId)).toHaveLength(0)
  })

  test("the window rolls, so the budget cannot be spent twice across a boundary", async () => {
    const t = newHarness()
    const { gameId, codes } = await seedGame(t, 100, {
      prizeBudget: { maxPrizes: 2, windowHours: 24 },
    })

    const play = (fingerprint: string) =>
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: codes[0]!,
        gameId,
        fingerprint,
        completedActions: [],
      })

    expect((await play("a")).didWin).toBe(true)
    expect((await play("b")).didWin).toBe(true)
    expect((await play("c")).didWin).toBe(false)

    // Backdate the two issuances to just inside the window. With the fixed
    // window this replaced, the counter's START was what aged out, so the whole
    // budget became spendable again at once: 50 prizes, then 50 more a minute
    // later, against "50 per rolling 24 h". Here each prize ages out on its own.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("prizeIssuance").first())!
      const nearlyOut = Date.now() - 24 * 60 * 60 * 1000 + 60_000
      await ctx.db.patch(row._id, { issuedAt: [nearlyOut - 1000, nearlyOut] })
    })
    expect((await play("d")).didWin).toBe(false)

    // Only once both have genuinely left the window does the budget return.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("prizeIssuance").first())!
      const longGone = Date.now() - 25 * 60 * 60 * 1000
      await ctx.db.patch(row._id, { issuedAt: [longGone, longGone + 1000] })
    })
    expect((await play("e")).didWin).toBe(true)
  })

  test("an owner tightening then restoring the budget does not refund it", async () => {
    const t = newHarness()
    const { storeId, gameId, codes } = await seedGame(t, 100, {
      prizeBudget: { maxPrizes: 3, windowHours: 24 },
    })
    const play = (fingerprint: string) =>
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: codes[0]!,
        gameId,
        fingerprint,
        completedActions: [],
      })
    const setBudget = (maxPrizes: number, windowHours: number) =>
      t.run(async (ctx) => {
        const game = (await ctx.db.query("games").first())!
        await ctx.db.patch(game._id, { config: { prizeBudget: { maxPrizes, windowHours } } })
      })
    // The rate windows are not what is under test here.
    const clearRateLimits = () =>
      t.run(async (ctx) => {
        for (const row of await ctx.db.query("rateLimits").collect()) await ctx.db.delete(row._id)
      })

    for (let i = 0; i < 3; i++) expect((await play(`a-${i}`)).didWin).toBe(true)
    expect((await play("a-3")).didWin).toBe(false)

    // The owner types the stricter-looking "1 per hour". Pruning the ledger to
    // the budget in force truncated it here, and restoring the day budget then
    // issued the whole thing again: 100 prizes against a fifty-prize ceiling in
    // the measured version, by an owner tightening their own setting.
    await clearRateLimits()
    await setBudget(1, 1)
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("prizeIssuance").first())!
      await ctx.db.patch(row._id, {
        issuedAt: row.issuedAt.map((at: number) => at - 2 * 60 * 60 * 1000),
      })
    })
    expect((await play("b-0")).didWin).toBe(true)

    await clearRateLimits()
    await setBudget(3, 24)
    expect((await play("c-0")).didWin).toBe(false)

    const ledger = await t.run((ctx) => ctx.db.query("prizeIssuance").first())
    expect(ledger?.storeId).toBe(storeId)
    expect(ledger?.issuedAt).toHaveLength(4)
  })

  test("a second game cannot loosen the establishment's budget", async () => {
    const t = newHarness()
    const { storeId, gameId, codes } = await seedGame(t, 100, {
      prizeBudget: { maxPrizes: 50, windowHours: 24 },
    })
    // The owner adds a scratch card and sets it to one prize a day. `play`
    // takes `gameId` from the caller, so reading the budget off the game they
    // named let them pick the generous one — and a game with a shorter window
    // used to reset the shared counter outright.
    const tightGameId = await t.run((ctx) =>
      ctx.db.insert("games", {
        storeId,
        type: "scratch_card",
        name: "Carte à gratter",
        winRatio: 100,
        isActive: true,
        config: { prizeBudget: { maxPrizes: 1, windowHours: 24 } },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const wins: boolean[] = []
    for (const id of [gameId, tightGameId, gameId, tightGameId]) {
      wins.push(
        (
          await t.mutation(api.gamePlay.play, {
            consentNoticeVersion: CONSENT_VERSION,
            code: codes[0]!,
            gameId: id,
            fingerprint: `f-${wins.length}`,
            completedActions: [],
          })
        ).didWin
      )
    }
    expect(wins).toEqual([true, false, false, false])
  })

  test("what this still does NOT fix: a stock smaller than the budget in force", async () => {
    const t = newHarness()
    // Five prizes behind the shipped default of fifty a day.
    const { gameId, prizeId, codes } = await seedGame(t, 5)

    for (let i = 0; i < 5; i++) {
      await t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: codes[0]!,
        gameId,
        fingerprint: `taker-${i}`,
        completedActions: [],
      })
    }

    // Five plays inside one window, five prizes gone, all to one caller.
    // Nothing in a Convex mutation can tell one person sending five
    // fingerprints from five diners, and lowering the rate windows far enough
    // to protect five prizes would refuse real players first. What the budget
    // buys is a ceiling the owner sets — the case above shows it holding at 2 —
    // and a bound on the establishment as a whole. What it does not buy is
    // identity. Closing that needs a sign-in or an anti-automation check at the
    // edge, and this platform has neither.
    // Pinned so nobody reads NEW-N as "the prize budget is now safe".
    const prize = await t.run((ctx) => ctx.db.get(prizeId))
    expect(prize?.remainingCount).toBe(0)
  })

  test("only real action ids are stored, however many the caller invents", async () => {
    const t = newHarness()
    const { gameId, actionIds } = await seedGame(t, 5, { requiredActions: 1 })
    const actionId = actionIds[0]!

    await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "device-1",
      completedActions: [
        actionId,
        actionId,
        "requiredActions:never-existed",
        "x".repeat(500),
      ],
    })

    const play = await t.run((ctx) => ctx.db.query("gamePlays").first())
    // Written verbatim before #323 — unbounded array, unbounded strings.
    expect(play?.completedActions).toEqual([actionId])
  })
})

describe("the social actions the whole pitch rests on, enforced server-side", () => {
  test("a prize cannot be won without the action being claimed", async () => {
    const t = newHarness()
    const { gameId, prizeId } = await seedGame(t, 5, { requiredActions: 1 })

    // Measured before NEW-N: this exact call returned `didWin: true`.
    await expect(
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        fingerprint: "lazy-diner",
        completedActions: [],
      })
    ).rejects.toThrow(/ACTIONS_INCOMPLETE/)

    // Nothing was written and nothing left the stock: the guard runs before the
    // draw, not after it.
    expect(await t.run((ctx) => ctx.db.query("gamePlays").collect())).toHaveLength(0)
    expect((await t.run((ctx) => ctx.db.get(prizeId)))?.remainingCount).toBe(5)
  })

  test("an invented action id does not buy a draw", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 5, { requiredActions: 1 })

    await expect(
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        fingerprint: "lazy-diner",
        completedActions: ["requiredActions:invented", "x".repeat(200)],
      })
    ).rejects.toThrow(/ACTIONS_INCOMPLETE/)
  })

  test("the diner who does the action that is due plays and wins", async () => {
    const t = newHarness()
    const { gameId, actionIds } = await seedGame(t, 5, { requiredActions: 2 })

    const result = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "honest-diner",
      completedActions: [actionIds[0]!],
    })
    expect(result.didWin).toBe(true)
  })

  test("the second action is what the second visit must claim", async () => {
    const t = newHarness()
    const { gameId, actionIds } = await seedGame(t, 5, { requiredActions: 2 })

    await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "honest-diner",
      completedActions: [actionIds[0]!],
    })
    // The cooldown has to be out of the way before the actions rule can be the
    // thing under test.
    await t.run(async (ctx) => {
      const play = (await ctx.db.query("gamePlays").first())!
      await ctx.db.patch(play._id, { playedAt: NOW - 48 * 60 * 60 * 1000 })
    })

    // Re-claiming the one already done does not advance the progression.
    await expect(
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        fingerprint: "honest-diner",
        completedActions: [actionIds[0]!],
      })
    ).rejects.toThrow(/ACTIONS_INCOMPLETE/)

    const result = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "honest-diner",
      completedActions: [actionIds[1]!],
    })
    expect(result.didWin).toBe(true)
  })

  test("the session stops offering a friend welcome the play would refuse", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 100, { requiredActions: 1 })
    const { code: shareCode } = await t.mutation(api.gamePlay.ensureReferralCode, {
      code: "TABLE1",
      fingerprint: "referrer-device",
    })

    const welcomed: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const session = await t.query(api.gamePlay.getSession, {
        code: "TABLE1",
        fingerprint: `friend-${i}`,
        ref: shareCode,
      })
      welcomed.push(session.status === "ready" && session.referral.isFriendWelcome)
      try {
        await t.mutation(api.gamePlay.play, {
          consentNoticeVersion: CONSENT_VERSION,
          code: "TABLE1",
          gameId,
          fingerprint: `friend-${i}`,
          completedActions: [],
          ref: shareCode,
        })
      } catch {
        // The refusal past the third is the point of the assertion below.
      }
    }

    // Before this, the fourth and fifth friends were told the actions could be
    // skipped, sent straight to the wheel, and had the spin throw an error the
    // screen was told could not happen.
    expect(welcomed).toEqual([true, true, true, false, false])
  })

  test("a fingerprint long enough to be storage is refused", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t)
    await expect(
      t.mutation(api.gamePlay.play, {
        consentNoticeVersion: CONSENT_VERSION,
        code: "TABLE1",
        gameId,
        // `fingerprint` becomes a `rateLimits.key` on an index; 200 000
        // characters went in before this.
        fingerprint: "x".repeat(10_000),
        completedActions: [],
      })
    ).rejects.toThrow()
    expect(await t.run((ctx) => ctx.db.query("rateLimits").collect())).toHaveLength(0)
  })

  test("a store with no actions configured is unaffected", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 5)
    const result = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "device-1",
      completedActions: [],
    })
    expect(result.didWin).toBe(true)
  })

  test("a friend arriving on a real referral code still plays, as the UI routes them", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 5, { requiredActions: 1 })

    // The referrer mints their code the way the referral screen does.
    const { code: shareCode } = await t.mutation(api.gamePlay.ensureReferralCode, {
      code: "TABLE1",
      fingerprint: "referrer-device",
    })

    const result = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1",
      gameId,
      fingerprint: "friend-device",
      completedActions: [],
      ref: shareCode,
    })
    expect(result.didWin).toBe(true)
  })

  test("one referral code cannot exempt an unbounded loop from the actions", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 100, { requiredActions: 1 })
    const { code: shareCode } = await t.mutation(api.gamePlay.ensureReferralCode, {
      code: "TABLE1",
      fingerprint: "referrer-device",
    })

    // Measured before this was metered: `isFriendWelcome` turns on
    // `isFirstPlay`, which is per fingerprint, so every rotated fingerprint was
    // a first-timer and one `?ref` took 120 plays past a store demanding three
    // Google reviews without a single refusal.
    let exempted = 0
    let refused = 0
    for (let i = 0; i < 8; i++) {
      try {
        await t.mutation(api.gamePlay.play, {
          consentNoticeVersion: CONSENT_VERSION,
          code: "TABLE1",
          gameId,
          fingerprint: `friend-${i}`,
          completedActions: [],
          ref: shareCode,
        })
        exempted++
      } catch {
        refused++
      }
    }
    expect(exempted).toBe(3)
    expect(refused).toBe(5)
  })

  test("a referrer's banked bonuses are capped, however many friends are invented", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 100)
    const { code: shareCode } = await t.mutation(api.gamePlay.ensureReferralCode, {
      code: "TABLE1",
      fingerprint: "referrer-device",
    })

    // A bonus play skips both the cooldown and the actions gate, so banking
    // them without limit turns one referral code into an exemption factory.
    for (let i = 0; i < 8; i++) {
      try {
        await t.mutation(api.gamePlay.play, {
          consentNoticeVersion: CONSENT_VERSION,
          code: "TABLE1",
          gameId,
          fingerprint: `friend-${i}`,
          completedActions: [],
          ref: shareCode,
        })
      } catch {
        // The rate window closes before the eighth; the cap is what is under
        // test, not how many get through.
      }
    }

    const referral = await t.run((ctx) => ctx.db.query("gameReferrals").first())
    expect(referral?.pendingBonuses).toBeLessThanOrEqual(5)
  })
})
