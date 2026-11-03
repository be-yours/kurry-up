// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The limiter must not become the attack (#323, adversarial round).
 *
 * A Convex mutation is a transaction. When a handler throws, every write it
 * made is rolled back — the limiter row included. So metering a path that
 * THROWS costs nothing and buys nothing, and the first round of #323 spent all
 * its care there. The paths that RETURN are the opposite: they commit, so a
 * slot spent on one is spent for real, and two of them were metered.
 *
 * Both were live denials of service against the restaurant, introduced by the
 * fix rather than found by it:
 *
 * - 60 replays of one already-claimed `playId`, with 60 invented addresses,
 *   emptied `gameClaimPerStore` and told the next genuine winner standing at
 *   the counter to come back in an hour.
 * - 100 calls to `ensureReferralCode` from a single browser tab — an endpoint
 *   that is idempotent by design and called on every visit — emptied
 *   `gameReferralPerStore` and refused a code to every diner after it.
 *
 * These run through `convex-test` and not the package's mock `db` on purpose:
 * the mock does not roll back, so it cannot tell the two kinds of path apart
 * and would have said both designs were fine.
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
async function seedGame(t: ReturnType<typeof convexTest>, prizeStock = 5) {
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
    await ctx.db.insert("gameQRCodes", {
      storeId,
      code: "TABLE1",
      isActive: true,
      scannedCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const gameId: Id<"games"> = await ctx.db.insert("games", {
      storeId,
      type: "wheel",
      name: "Roue de la chance",
      winRatio: 100,
      isActive: true,
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
    return { storeId, gameId, prizeId }
  })
}


describe("a free path must not spend the restaurant's window", () => {
  test("repeat claims on one playId leave a genuine winner able to claim", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t, 100)

    const winner = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1", gameId, fingerprint: "victim", completedActions: [],
    })
    await t.mutation(api.gamePlay.claim, {
      playId: winner.playId, firstName: "Marie", lastName: "Dupont",
      email: "marie@example.fr",
    })

    // Sixty no-op repeats, rotating the address so the per-email window never
    // bites. Each returns `alreadyClaimed`, writes no redemption and sends no
    // mail — so each must cost the restaurant nothing.
    for (let i = 0; i < 60; i++) {
      await t.mutation(api.gamePlay.claim, {
        playId: winner.playId, firstName: "B", lastName: "urn",
        email: `burn-${i}@example.com`,
      })
    }

    const other = await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1", gameId, fingerprint: "honest-winner", completedActions: [],
    })
    const claimed = await t.mutation(api.gamePlay.claim, {
      playId: other.playId, firstName: "Yanis", lastName: "Bouzid",
      email: "yanis@example.fr",
    })
    expect(claimed.alreadyClaimed).toBe(false)
    expect(claimed.code).toHaveLength(8)

    // Two genuine claims, two slots. Sixty replays, none.
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect())
    const store = limits.filter((r) => r.key.startsWith("gameClaimPerStore"))
    expect(store).toHaveLength(1)
    expect(store[0]?.count).toBe(2)
  })

  test("a tab re-calling ensureReferralCode leaves the next diner able to get a code", async () => {
    const t = newHarness()
    await seedGame(t, 100)

    for (let i = 0; i < 100; i++) {
      await t.mutation(api.gamePlay.ensureReferralCode, {
        code: "TABLE1", fingerprint: "one-tab",
      })
    }

    const mine = await t.mutation(api.gamePlay.ensureReferralCode, {
      code: "TABLE1", fingerprint: "a-new-diner",
    })
    expect(mine.code).toHaveLength(8)

    const rows = await t.run((ctx) => ctx.db.query("gameReferrals").collect())
    expect(rows).toHaveLength(2)
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect())
    const store = limits.filter((r) => r.key.startsWith("gameReferralPerStore"))
    expect(store[0]?.count).toBe(2)
  })

  test("junk ids ahead of a real one do not push the real one out", async () => {
    const t = newHarness()
    const { storeId, gameId } = await seedGame(t)
    const actionId = await t.run((ctx) =>
      ctx.db.insert("requiredActions", {
        storeId, type: "google_review", name: "Avis Google", isRequired: true,
        sortOrder: 0, isActive: true, createdAt: NOW, updatedAt: NOW,
      })
    )

    await t.mutation(api.gamePlay.play, {
      consentNoticeVersion: CONSENT_VERSION,
      code: "TABLE1", gameId, fingerprint: "d1",
      // The cap used to be applied before the filter, so 32 invented ids ahead
      // of the genuine one stored nothing at all — losing the diner's real
      // progress rather than bounding anything.
      completedActions: [
        ...Array.from({ length: 32 }, (_, i) => `junk-${i}`),
        actionId,
      ],
    })

    const play = await t.run((ctx) => ctx.db.query("gamePlays").first())
    expect(play?.completedActions).toEqual([actionId])
  })
})
