// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The establishment audit trail, end to end.
 *
 * `systemAuditLog` existed but nothing outside the system operations ever wrote
 * to it: a restaurant could be created, renamed, moved, reconfigured or deleted
 * and the journal stayed empty. These tests run the real Convex functions
 * against the real schema, in memory, and assert the three things a trail is
 * for — that the change is recorded, that it names who did it, and that it
 * cannot be read by someone who should not see that establishment.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

type Role =
  | "super_admin"
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "delivery"
  | "customer"

const NOW = 1_700_000_000_000

const AN_ADDRESS = {
  street: "1 rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  country: "France",
}

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Product, menu and store mutations queue work through `ctx.scheduler.runAfter`
 * — `scheduleMenuSync` puts the Uber Eats and Deliveroo syncs at a 5s delay on
 * every catalogue write. A test finishes in milliseconds and leaves them
 * pending; whatever fires them next writes against a transaction that closed,
 * and because nothing awaits it that arrives as an unhandled rejection. The run
 * then reports every test green and still exits 1, blaming whichever file
 * happened to be running rather than the one that queued the work.
 *
 * Cancel rather than run. `syncAllStores` is an `internalAction`, and running
 * one here is the disease, not the cure: convex-test patches its
 * `_scheduled_functions` row on completion, an action has no transaction to
 * patch it in, and the failure comes straight back. Finishing the queue with
 * `finishAllScheduledFunctions` was tried first and made it worse — ten
 * rejections in a run where leaving the jobs alone produced two.
 */
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
        // Only what is still outstanding: cancelling a job that already
        // finished is not a no-op. Same guard as `cancelScheduled` in
        // campaign-send.test.ts, which reached this from the other direction.
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})


async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      address: AN_ADDRESS,
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

/** Every audit row, oldest first. */
async function auditRows(t: ReturnType<typeof convexTest>) {
  const rows = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
  return rows.sort((a, b) => a._creationTime - b._creationTime)
}

/** The single audit row written so far, with `details` parsed. */
async function soleAuditRow(t: ReturnType<typeof convexTest>) {
  const rows = await auditRows(t)
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  // `JSON.parse` already hands back `any`; annotating it would only trip the
  // no-explicit-any rule for no gain in a test that asserts on the shape.
  return { ...row, parsed: JSON.parse(row.details!) }
}

// ============================================================================
// Every establishment change lands in the journal
// ============================================================================

describe("establishment changes are recorded", () => {
  test("creating a restaurant records who created it", async () => {
    const t = newHarness()
    const admin = await seedUser(t, "user_admin", "client_admin", [])

    const storeId = await admin.mutation(api.stores.create, {
      name: "Pizzeria Roma",
      slug: "pizzeria-roma",
      address: AN_ADDRESS,
      phone: "+33100000000",
    })

    const row = await soleAuditRow(t)
    expect(row.action).toBe("store_created")
    expect(row.performedBy).toBe("user_admin")
    expect(row.targetStoreId).toBe(storeId)
    expect(row.result).toBe("success")
    expect(row.performedAt).toBeGreaterThan(0)
    expect(row.parsed.operation).toBe("create")
    expect(row.parsed.storeName).toBe("Pizzeria Roma")
    expect(row.parsed.snapshot).toMatchObject({
      name: "Pizzeria Roma",
      slug: "pizzeria-roma",
      status: "draft",
      phone: "+33100000000",
    })
  })

  test("renaming a restaurant records the before and the after", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])

    await admin.mutation(api.stores.update, {
      id: storeId,
      name: "Roma Trastevere",
      status: "closed",
    })

    const row = await soleAuditRow(t)
    expect(row.action).toBe("store_updated")
    expect(row.performedBy).toBe("user_admin")
    expect(row.targetStoreId).toBe(storeId)
    expect(row.parsed.operation).toBe("update")
    expect(row.parsed.changes).toEqual({
      name: { before: "Pizzeria Roma", after: "Roma Trastevere" },
      status: { before: "open", after: "closed" },
    })
  })

  test("moving a restaurant records both addresses", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])

    await admin.mutation(api.stores.updateAddress, {
      id: storeId,
      address: { ...AN_ADDRESS, street: "2 avenue de l'Opéra" },
    })

    const row = await soleAuditRow(t)
    expect(row.parsed.operation).toBe("updateAddress")
    expect(row.parsed.changes.address.before.street).toBe("1 rue de la Paix")
    expect(row.parsed.changes.address.after.street).toBe("2 avenue de l'Opéra")
  })

  test("a settings change is recorded like any other edit", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])

    await admin.mutation(api.stores.updateOrderMode, {
      id: storeId,
      orderMode: "auto_accept",
    })

    const row = await soleAuditRow(t)
    expect(row.action).toBe("store_updated")
    expect(row.parsed.operation).toBe("updateOrderMode")
    expect(row.parsed.changes.orderMode.after).toBe("auto_accept")
  })

  test("changing the opening hours is recorded", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])
    const hours = [{ day: 1, open: "09:00", close: "22:00", isClosed: false }]

    await admin.mutation(api.stores.updateHours, { id: storeId, hours })

    const row = await soleAuditRow(t)
    expect(row.parsed.operation).toBe("updateHours")
    expect(row.parsed.changes.hours).toEqual({ before: [], after: hours })
  })

  test("deleting a restaurant keeps a record of what disappeared", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_super", "super_admin", [])

    await admin.mutation(api.stores.remove, { id: storeId })

    expect(await t.run((ctx) => ctx.db.get(storeId))).toBeNull()
    const row = await soleAuditRow(t)
    expect(row.action).toBe("store_deleted")
    expect(row.performedBy).toBe("user_super")
    expect(row.targetStoreId).toBe(storeId)
    expect(row.parsed.storeName).toBe("Pizzeria Roma")
    expect(row.parsed.snapshot).toMatchObject({
      name: "Pizzeria Roma",
      slug: "pizzeria-roma",
      status: "open",
    })
  })

  test("each edit adds its own entry rather than replacing the last", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])

    await admin.mutation(api.stores.update, { id: storeId, name: "Roma I" })
    await admin.mutation(api.stores.update, { id: storeId, name: "Roma II" })
    await admin.mutation(api.stores.updateTrendingMode, {
      id: storeId,
      trendingMode: "automatic",
    })

    const rows = await auditRows(t)
    expect(rows.map((r) => JSON.parse(r.details!).operation)).toEqual([
      "update",
      "update",
      "updateTrendingMode",
    ])
    // The second rename starts from where the first one left off.
    expect(JSON.parse(rows[1]!.details!).changes.name).toEqual({
      before: "Roma I",
      after: "Roma II",
    })
  })
})

// ============================================================================
// The journal must not become a way out for secrets
// ============================================================================

describe("secrets never reach the journal", () => {
  test("the printer credential is stored on the restaurant but masked in the log", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_admin", "client_admin", [storeId])

    await admin.mutation(api.stores.updatePrintConfig, {
      id: storeId,
      printConfig: {
        provider: "star_cloud",
        apiKey: "sk-live-printer-secret",
        triggers: ["confirmed"],
        paperSize: "80mm",
        enabled: true,
      },
    })

    const row = await soleAuditRow(t)
    expect(row.details).not.toContain("sk-live-printer-secret")
    expect(row.details).toContain("[redacted]")

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.printConfig?.apiKey).toBe("sk-live-printer-secret")
  })

  test("a deletion snapshot leaves the legacy integrations blob behind", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        integrations: { deliveroo: { apiKey: "deliveroo-secret" } },
      })
    )
    const admin = await seedUser(t, "user_super", "super_admin", [])

    await admin.mutation(api.stores.remove, { id: storeId })

    const row = await soleAuditRow(t)
    expect(row.details).not.toContain("deliveroo-secret")
    expect(row.details).not.toContain("integrations")
  })
})

// ============================================================================
// The trail does not weaken the guards it sits behind
// ============================================================================

describe("access control is preserved", () => {
  test("a refused edit leaves no entry behind", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const kitchen = await seedUser(t, "user_kitchen", "kitchen", [storeId])

    await expect(
      kitchen.mutation(api.stores.update, { id: storeId, name: "Roma Trastevere" })
    ).rejects.toThrow()

    expect(await auditRows(t)).toHaveLength(0)
  })

  test("an anonymous caller can neither edit nor log", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")

    await expect(
      t.mutation(api.stores.update, { id: storeId, name: "Roma Trastevere" })
    ).rejects.toThrow(/Not authenticated/)

    expect(await auditRows(t)).toHaveLength(0)
  })

  test("an edit that throws mid-flight rolls its entry back with it", async () => {
    const t = newHarness()
    const admin = await seedUser(t, "user_super", "super_admin", [])
    const storeId = await seedStore(t, "Pizzeria Roma")
    await t.run((ctx) => ctx.db.delete(storeId))

    await expect(
      admin.mutation(api.stores.update, { id: storeId, name: "Fantôme" })
    ).rejects.toThrow()

    expect(await auditRows(t)).toHaveLength(0)
  })
})

// ============================================================================
// Reading the journal
// ============================================================================

describe("getAuditLog", () => {
  test("surfaces establishment entries and filters on the new actions", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_super", "super_admin", [])

    await admin.mutation(api.stores.update, { id: storeId, name: "Roma I" })
    await admin.mutation(api.stores.remove, { id: storeId })

    const all = await admin.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
    expect(all.page.map((e) => e.action).sort()).toEqual([
      "store_deleted",
      "store_updated",
    ])

    const deletions = await admin.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
      filterAction: "store_deleted",
    })
    expect(deletions.page).toHaveLength(1)
    expect(deletions.page[0]!.action).toBe("store_deleted")
  })

  test("a manager cannot read the journal at all", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const manager = await seedUser(t, "user_manager", "manager", [storeId])

    await expect(
      manager.query(api.system.getAuditLog, {
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).rejects.toThrow(/system:read/)
  })

  test("an owner is not shown another establishment's history", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Pizzeria Roma")
    const theirs = await seedStore(t, "Pizzeria Napoli")
    const superAdmin = await seedUser(t, "user_super", "super_admin", [])
    const owner = await seedUser(t, "user_owner", "client_admin", [mine])

    await superAdmin.mutation(api.stores.update, { id: mine, name: "Roma I" })
    await superAdmin.mutation(api.stores.update, { id: theirs, name: "Napoli I" })
    // A system-wide entry, tied to no establishment.
    await t.run((ctx) =>
      ctx.db.insert("systemAuditLog", {
        action: "version_check" as const,
        performedBy: "user_super",
        performedAt: NOW,
        result: "success" as const,
      })
    )

    const seenByOwner = await owner.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
    expect(seenByOwner.page.map((e) => e.targetStoreId ?? "system").sort()).toEqual(
      [mine, "system"].sort()
    )

    const seenBySuperAdmin = await superAdmin.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
    expect(seenBySuperAdmin.page).toHaveLength(3)
  })

  test("an owner removed from a restaurant stops seeing their own past entries on it", async () => {
    const t = newHarness()
    const roma = await seedStore(t, "Pizzeria Roma")
    const marie = await seedUser(t, "marie", "client_admin", [roma])
    const root = await seedUser(t, "root", "super_admin", [])

    await marie.mutation(api.stores.update, { id: roma, name: "Roma Trastevere" })

    const whileAdministering = await marie.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
    expect(whileAdministering.page).toHaveLength(1)

    // The one route that can still strip a client admin of a store: a super
    // admin rewriting the profile. Team revocation leaves admin roles alone,
    // and #117 means creating a store grants it rather than withholding it.
    await root.mutation(internal.userProfiles.upsert, {
      userId: "marie",
      role: "client_admin",
      storeIds: [],
      permissions: [],
    })

    // The journal follows the access, not the authorship. Someone deliberately
    // removed from a restaurant is exactly who scoping is for — recorded here
    // as a decision rather than left to be inferred from a missing test.
    const afterRemoval = await marie.query(api.system.getAuditLog, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
    expect(afterRemoval.page).toHaveLength(0)
  })

  test("paging walks the whole journal instead of stalling after page two", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Roma")
    const admin = await seedUser(t, "user_super", "super_admin", [])

    const TOTAL = 25
    for (let i = 0; i < TOTAL; i++) {
      await admin.mutation(api.stores.update, { id: storeId, name: `Roma ${i}` })
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const result: {
        page: Array<{ _id: string }>
        continueCursor: string | null
        isDone: boolean
      } = await admin.query(api.system.getAuditLog, {
        paginationOpts: { cursor, numItems: 10 },
      })
      seen.push(...result.page.map((e) => e._id))
      pages++
      if (result.isDone || pages > 10) break
      cursor = result.continueCursor
    }

    expect(new Set(seen).size).toBe(TOTAL)
    expect(pages).toBeLessThanOrEqual(4)
  })
})
