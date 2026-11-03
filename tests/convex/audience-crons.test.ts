// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The two scheduled jobs behind « Fréquentation », run the way Convex runs them.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DID. `audienceRollup.test.ts` and
 * `audienceRetention.test.ts` exercise the pure definitions in
 * `@be-yours/convex-functions`, against a fake database. `cron-registry.test.ts`
 * asserts the two jobs are registered with the handler and the schedule they
 * claim. Between those sits the part that had never been executed by anything:
 * the WRAPPERS in `convex/audience.ts`, which are what a cron actually calls,
 * and which do the one thing the pure functions cannot — reschedule themselves
 * through `ctx.scheduler` while there is more to do.
 *
 * Both were run by hand exactly once, against a local backend, while this
 * feature was being built. That proved they work; it proved nothing about them
 * staying that way.
 *
 * WHY THIS IS NOT A PLAYWRIGHT SPEC. A cron has no browser. What Playwright can
 * reach is the collector and the screen, and it already does — five storefront
 * specs and nine admin ones. `convex-test` runs the real functions against the
 * real schema with a real scheduler, which is as end-to-end as a scheduled job
 * gets without waiting a quarter of an hour for one.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test, vi } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const DAY_MS = 24 * 60 * 60 * 1000
/** A Monday afternoon, so the local-midnight arithmetic reads as wall clock. */
const NOW = Date.UTC(2026, 8, 21, 10)
/** Local midnight of that day in Europe/Paris, which is UTC+2 in September. */
const PARIS_MIDNIGHT = Date.UTC(2026, 8, 20, 22)

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(
  t: ReturnType<typeof convexTest>,
  dataRetention?: { audienceDays?: number; enabled: boolean }
): Promise<Id<"stores">> {
  return t.run(async (ctx) => {
    await ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
      ...(dataRetention
        ? {
            dataRetention: {
              customerDataDays: 1095,
              updatedAt: NOW,
              ...dataRetention,
            },
          }
        : {}),
    })

    return ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      status: "open",
      address: {
        street: "12 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "FR",
      },
      hours: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

/** `count` view hits at the same instant, all on one visit. */
async function seedHits(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  count: number,
  at: number = NOW
): Promise<void> {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("audienceHits", {
        storeId,
        at: at + i,
        kind: "view" as const,
        page: "menu",
        referrer: "google",
        device: "mobile" as const,
        firstHitOfVisit: i === 0,
      })
    }
  })
}

const countersOf = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("audienceDaily").collect())

const hitsLeft = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("audienceHits").collect()).length)

describe("roll up audience hits", () => {
  test("folds the raw hits into the establishment's own local day", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 3)

    const result = await t.mutation(internal.audience.rollupPending, { now: NOW })

    expect(result).toMatchObject({ folded: 3, hasMore: false })
    expect(await hitsLeft(t)).toBe(0)

    const counters = await countersOf(t)
    const views = counters.find((c) => c.dimension === "total" && c.key === "views")
    expect(views).toMatchObject({ storeId, day: PARIS_MIDNIGHT, count: 3 })
    // One visit, because only the first hit declared one.
    expect(
      counters.find((c) => c.dimension === "total" && c.key === "visits")?.count
    ).toBe(1)
  })

  test("adds to a counter that already exists rather than writing a second", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 2)
    await t.mutation(internal.audience.rollupPending, { now: NOW })

    await seedHits(t, storeId, 2, NOW + 60_000)
    await t.mutation(internal.audience.rollupPending, { now: NOW + 120_000 })

    const pages = (await countersOf(t)).filter((c) => c.dimension === "page")
    expect(pages).toHaveLength(1)
    expect(pages[0]?.count).toBe(4)
  })

  /*
   * THE REASON THIS FILE EXISTS. The wrapper reschedules itself a minute later
   * while `hasMore` is true, and nothing had ever executed that branch — the
   * unit tests call the pure definition, which has no scheduler. A backlog that
   * did not drain would look exactly like a backlog that did until somebody
   * read the counters.
   */
  test("drains a backlog larger than one transaction, on its own schedule", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 7)

    vi.useFakeTimers()
    try {
      const first = await t.mutation(internal.audience.rollupPending, {
        now: NOW,
        limit: 3,
      })
      expect(first).toMatchObject({ folded: 3, hasMore: true })
      expect(await hitsLeft(t)).toBe(4)

      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }

    expect(await hitsLeft(t)).toBe(0)
    expect(
      (await countersOf(t)).find((c) => c.dimension === "total" && c.key === "views")
        ?.count
    ).toBe(7)
  })

  test("schedules nothing when it has folded everything", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 2)

    await t.mutation(internal.audience.rollupPending, { now: NOW })

    const pending = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(pending.filter((job) => job.state.kind === "pending")).toEqual([])
  })

  test("does nothing, and says so, on a deployment with no traffic", async () => {
    const t = newHarness()
    await seedStore(t)

    expect(await t.mutation(internal.audience.rollupPending, { now: NOW })).toEqual({
      folded: 0,
      hasMore: false,
    })
  })
})

describe("sweep expired audience data", () => {
  test("carries away raw hits a rollup never reached", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 1, NOW - 3 * DAY_MS)
    await seedHits(t, storeId, 1, NOW - 60_000)

    const result = await t.mutation(internal.audience.sweepExpiredAudience, { now: NOW })

    expect(result).toMatchObject({ hitsDeleted: 1, paused: false })
    expect(await hitsLeft(t)).toBe(1)
  })

  test("carries away counters past the window the establishment set", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, { audienceDays: 60, enabled: true })
    await t.run(async (ctx) => {
      for (const day of [NOW - 90 * DAY_MS, NOW - 30 * DAY_MS]) {
        await ctx.db.insert("audienceDaily", {
          storeId,
          day,
          dimension: "total",
          key: "views",
          count: 1,
        })
      }
    })

    const result = await t.mutation(internal.audience.sweepExpiredAudience, { now: NOW })

    expect(result.countersDeleted).toBe(1)
    const left = await countersOf(t)
    expect(left).toHaveLength(1)
    expect(left[0]?.day).toBe(NOW - 30 * DAY_MS)
  })

  /*
   * `dataRetention.enabled: false` pauses the diner-data purge and reports what
   * it WOULD have done. The same switch has to pause this one, or an operator
   * who stopped the sweep to investigate something would find the audience
   * history leaving anyway.
   */
  test("reports without deleting while the purge is paused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, { audienceDays: 60, enabled: false })
    await seedHits(t, storeId, 1, NOW - 3 * DAY_MS)
    await t.run((ctx) =>
      ctx.db.insert("audienceDaily", {
        storeId,
        day: NOW - 90 * DAY_MS,
        dimension: "total",
        key: "views",
        count: 1,
      })
    )

    const result = await t.mutation(internal.audience.sweepExpiredAudience, { now: NOW })

    expect(result).toMatchObject({ hitsDeleted: 1, countersDeleted: 1, paused: true })
    expect(await hitsLeft(t)).toBe(1)
    expect(await countersOf(t)).toHaveLength(1)
  })

  test("drains a backlog larger than one transaction, on its own schedule", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 5, NOW - 3 * DAY_MS)

    vi.useFakeTimers()
    try {
      const first = await t.mutation(internal.audience.sweepExpiredAudience, {
        now: NOW,
        limit: 2,
      })
      expect(first).toMatchObject({ hitsDeleted: 2, hasMore: true })

      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }

    expect(await hitsLeft(t)).toBe(0)
  })

  test("leaves a hit that is merely waiting for the next rollup", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 1, NOW - DAY_MS)

    expect(
      (await t.mutation(internal.audience.sweepExpiredAudience, { now: NOW })).hitsDeleted
    ).toBe(0)
    expect(await hitsLeft(t)).toBe(1)
  })
})

describe("the two jobs together", () => {
  /*
   * The whole scheduled story in one pass: hits arrive, the quarter-hourly fold
   * turns them into counters and deletes them, and the nightly sweep finds
   * nothing left to carry away because the fold already did.
   */
  test("the sweep has nothing to do after the rollup has run", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedHits(t, storeId, 4)

    await t.mutation(internal.audience.rollupPending, { now: NOW })
    const swept = await t.mutation(internal.audience.sweepExpiredAudience, {
      now: NOW + 3 * DAY_MS,
    })

    expect(swept).toMatchObject({ hitsDeleted: 0, countersDeleted: 0 })
    // And the counters the fold wrote are still there, well inside their window.
    expect((await countersOf(t)).length).toBeGreaterThan(0)
  })
})
