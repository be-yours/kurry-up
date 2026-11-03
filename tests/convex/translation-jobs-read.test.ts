// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * `listJobs` reads the right table, for the right establishment (#480, held
 * here since #532).
 *
 * WHAT ITS UNIT TESTS CANNOT SEE. `__tests__/translationJobs.test.ts` drives the
 * handler with a hand-written `ctx`:
 *
 *     query: () => ({ withIndex: () => ({ take: async (n) => rows.slice(0, n) }) })
 *
 * `query` ignores the table name and `withIndex` ignores both the index and the
 * range. So the handler returns the fixture whatever it asks for — measured by
 * #532, which pointed `listJobs` at the wrong table and watched every case stay
 * green. Those cases are good at what they do, which is the SHAPING: the fields
 * returned, the ordering, the clamping, the row written before `error` existed.
 * They cannot speak for the two things a fake `ctx` defines away.
 *
 * So this file drives the same handler through `convex-test`, against the real
 * schema, where `ctx.db.query("translationJobs")` means that table and
 * `by_storeId` means that index. Two facts, and they are the two a wrong query
 * would break first: the runs come from `translationJobs`, and they come from
 * ONE establishment.
 *
 * The second is not hypothetical. A chain runs one deployment per client but
 * several establishments inside it, and a back-fill is per establishment — so a
 * query that dropped the store bound would show the Lyon kitchen's German
 * translation run on the Paris languages screen, with a « 80 / 300 » nobody
 * there can act on.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { listJobs } from "@be-yours/convex-functions/autoTranslate"
import schema from "../../convex/schema"
import type { Id } from "../../convex/_generated/dataModel"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function newHarness() {
  return convexTest(schema, modules)
}

async function seedStore(t: ReturnType<typeof convexTest>, slug: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: slug,
      slug,
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedJob(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("translationJobs", {
      storeId,
      sourceLanguage: "fr",
      targetLanguage: "de",
      entityType: "products",
      totalItems: 300,
      completedItems: 300,
      status: "completed" as const,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    } as never)
  )
}

/** The handler, through a real database. */
const read = (t: ReturnType<typeof convexTest>, storeId: Id<"stores">, limit?: number) =>
  t.run((ctx) =>
    listJobs.handler(ctx, { storeId, ...(limit === undefined ? {} : { limit }) })
  )

describe("the runs the languages screen shows", () => {
  test("come from translationJobs", async () => {
    /*
     * The fake `ctx` answered its fixture whatever table was named, so pointing
     * the handler at another one changed nothing. Here the rows exist in
     * `translationJobs` and nowhere else, so a query naming a different table
     * comes back empty.
     */
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    await seedJob(t, storeId, { completedItems: 80, status: "failed", error: "quota" })

    const found = await read(t, storeId)

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      targetLanguage: "de",
      entityType: "products",
      status: "failed",
      totalItems: 300,
      completedItems: 80,
      error: "quota",
    })
  })

  test("come from this establishment and no other", async () => {
    /*
     * THE BOUND A FAKE `withIndex` DEFINES AWAY. One deployment per client, but
     * several establishments inside it, and a back-fill is per establishment.
     * Without the store bound the Lyon kitchen's run appears on the Paris
     * languages screen, showing « 80 / 300 » to people who cannot act on it.
     */
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    await seedJob(t, mine, { targetLanguage: "de" })
    await seedJob(t, theirs, { targetLanguage: "it" })
    await seedJob(t, theirs, { targetLanguage: "es" })

    const found = await read(t, mine)

    expect(found).toHaveLength(1)
    expect(found[0]?.targetLanguage).toBe("de")
  })

  test("are empty for an establishment that has never run one", async () => {
    // Anti-vacuity for the case above: a handler answering nothing at all would
    // satisfy it, and this is what separates "scoped" from "broken".
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    await seedJob(t, theirs)

    expect(await read(t, mine)).toEqual([])
  })

  test("are the most recent ones, newest first", async () => {
    // The index is on `by_storeId`, not on time, so the ordering happens in
    // memory — over a bounded read. Both halves are real here: a wrong index
    // would return the wrong rows before the sort ever saw them.
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    await seedJob(t, storeId, { targetLanguage: "de", updatedAt: NOW - 2 * HOUR })
    await seedJob(t, storeId, { targetLanguage: "it", updatedAt: NOW })
    await seedJob(t, storeId, { targetLanguage: "es", updatedAt: NOW - HOUR })

    expect((await read(t, storeId)).map((job) => job.targetLanguage)).toEqual([
      "it",
      "es",
      "de",
    ])
  })

  test("stop at the window the caller asked for", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    for (let i = 0; i < 6; i++) {
      await seedJob(t, storeId, { targetLanguage: `l${i}`, updatedAt: NOW - i * HOUR })
    }

    expect(await read(t, storeId, 2)).toHaveLength(2)
  })
})
