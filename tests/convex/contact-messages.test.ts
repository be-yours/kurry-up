// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Reading the inbox the storefront contact form fills.
 *
 * `list` collected every message a store had ever received in one call. Nothing
 * noticed, because nothing called it (issue #272): the query was shaped for a
 * screen that did not exist. A restaurant that has been open a year has a
 * table this query would return whole, on every render of the screen that now
 * reads it.
 *
 * Driven through the real query, with the identity the guard demands, because
 * `customers:read` is part of what the screen relies on.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/** Same reason as the other suites here: leave nothing on the scheduler. */
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
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
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

/** An owner of `storeId`, which is what `customers:read` is granted through. */
async function seedOwner(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner" })
}

/** `count` messages, oldest first, so index `0` is the oldest subject. */
async function seedMessages(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  count: number,
  status: "new" | "read" | "archived" = "new"
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("contactMessages", {
        storeId,
        name: `Client ${i}`,
        email: `client${i}@example.com`,
        subject: `Sujet ${i}`,
        message: "Bonjour, une question sur vos horaires.",
        status,
        createdAt: NOW + i,
      })
    }
  })
}

describe("contactMessages.list", () => {
  test("answers with one page, not with the whole inbox", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 30)

    const first = await owner.query(api.contactMessages.list, {
      storeId,
      paginationOpts: { numItems: 10, cursor: null },
    })

    expect(first.page).toHaveLength(10)
    expect(first.isDone).toBe(false)
  })

  test("the cursor reaches the rest of the inbox exactly once", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 30)

    const seen: string[] = []
    let cursor: string | null = null
    let isDone = false

    while (!isDone) {
      const result = await owner.query(api.contactMessages.list, {
        storeId,
        paginationOpts: { numItems: 10, cursor },
      })
      seen.push(...result.page.map((m: { subject: string }) => m.subject))
      cursor = result.continueCursor
      isDone = result.isDone
    }

    expect(new Set(seen).size).toBe(30)
    expect(seen[0]).toBe("Sujet 29")
    expect(seen.at(-1)).toBe("Sujet 0")
  })

  test("a status filter pages over only that status", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 3, "new")
    await seedMessages(t, storeId, 12, "archived")

    const result = await owner.query(api.contactMessages.list, {
      storeId,
      status: "new",
      paginationOpts: { numItems: 10, cursor: null },
    })

    expect(result.page.map((m: { status: string }) => m.status)).toEqual([
      "new",
      "new",
      "new",
    ])
    expect(result.isDone).toBe(true)
  })
})

describe("contactMessages.unreadCount", () => {
  test("counts what the owner has not read yet", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 4, "new")
    await seedMessages(t, storeId, 7, "read")
    await seedMessages(t, storeId, 2, "archived")

    expect(await owner.query(api.contactMessages.unreadCount, { storeId })).toEqual({
      count: 4,
      hasMore: false,
    })
  })

  test("stops at 99 rather than scanning a year of inbox", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 120, "new")

    expect(await owner.query(api.contactMessages.unreadCount, { storeId })).toEqual({
      count: 99,
      hasMore: true,
    })
  })
})

describe("contactMessages.updateStatus", () => {
  test("moves a message from new to read to archived", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedMessages(t, storeId, 1)

    const [message] = (
      await owner.query(api.contactMessages.list, {
        storeId,
        paginationOpts: { numItems: 1, cursor: null },
      })
    ).page

    await owner.mutation(api.contactMessages.updateStatus, {
      id: message._id,
      status: "read",
    })
    expect((await t.run((ctx) => ctx.db.get(message._id)))?.status).toBe("read")

    await owner.mutation(api.contactMessages.updateStatus, {
      id: message._id,
      status: "archived",
    })
    expect((await t.run((ctx) => ctx.db.get(message._id)))?.status).toBe("archived")
  })
})
