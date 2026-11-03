// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A catalogue edit books one menu push, for the restaurant that changed.
 *
 * It used to book two sweeps — `uberEatsMenuSync.syncAllStores` and
 * `deliverooMenuSync.syncAllStores` — on every single product and menu
 * mutation, five seconds out. Convex does not dedupe scheduled jobs, so the
 * count was linear in the number of edits: a fifty-product import queued a
 * hundred sweeps, measured. Worse, a sweep is not scoped: each one walked every
 * enabled integration on the deployment and uploaded that store's whole menu,
 * so a burst in one restaurant re-uploaded the menus of all the others too.
 *
 * Uber caps `PUT /v2/eats/stores/{id}/menu` at roughly one call a minute per
 * store. Almost none of those hundred uploads could have succeeded.
 *
 * These tests count what reaches the scheduler. They are the reason the
 * comments in the twenty other suites here — "puts the Uber Eats and Deliveroo
 * syncs at a 5s delay on every catalogue write" — no longer describe the code.
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

/** Cancel whatever the test left queued — see the note in catalogue-scope. */
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

/**
 * Every platform menu push still outstanding: function name and target store.
 *
 * Cancelled rows stay in `_scheduled_functions`, so the state has to be
 * filtered or a test that cancels its own queue counts it twice.
 *
 * Scoped to the two sync functions on purpose. A catalogue write now also
 * books a debounced translation per document (#147), which is one job per
 * product by design — this suite is about the platform push not growing with
 * the import, and counting everything on the scheduler would measure the
 * wrong thing.
 */
const MENU_SYNC_JOBS = [
  "uberEatsMenuSync:internalSyncStore",
  "deliverooMenuSync:internalSyncStore",
]

async function queuedSyncs(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect()
    return rows
      .filter((row) => row.state.kind === "pending" || row.state.kind === "inProgress")
      .filter((row) => MENU_SYNC_JOBS.includes(row.name))
      .map((row) => ({
        name: row.name,
        storeId: (row.args[0] as { storeId?: string } | undefined)?.storeId,
      }))
  })
}

async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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

async function seedCategory(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedOwner(t: ReturnType<typeof convexTest>, storeIds: Id<"stores">[]) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:owner",
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "user:owner" })
}

function createProduct(
  storeId: Id<"stores">,
  categoryId: Id<"categories">,
  index: number
) {
  return {
    storeId,
    categoryId,
    name: `Pizza ${index}`,
    slug: `pizza-${index}`,
    price: 1200,
    taxRate: 10,
    images: [],
    isActive: true,
    isFeatured: false,
    sortOrder: index,
  }
}

describe("menu sync scheduling", () => {
  test("a fifty-product import books two pushes, not a hundred sweeps", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const asOwner = await seedOwner(t, [store])

    for (let i = 0; i < 50; i++) {
      await asOwner.mutation(api.products.create, createProduct(store, categoryId, i))
    }

    const queued = await queuedSyncs(t)

    // One per platform. The number must NOT grow with the size of the import.
    expect(queued).toHaveLength(2)
    expect(queued.map((job) => job.name).sort()).toEqual([
      "deliverooMenuSync:internalSyncStore",
      "uberEatsMenuSync:internalSyncStore",
    ])
  })

  test("the push is scoped to the restaurant that changed", async () => {
    const t = newHarness()
    const edited = await seedStore(t, "Chez Luigi")
    const untouched = await seedStore(t, "Chez Marco")
    const categoryId = await seedCategory(t, edited)
    const asOwner = await seedOwner(t, [edited, untouched])

    await asOwner.mutation(api.products.create, createProduct(edited, categoryId, 1))

    const queued = await queuedSyncs(t)

    // The sweep this replaces would have uploaded Marco's menu as well, on
    // every edit Luigi made.
    expect(queued.map((job) => job.storeId)).toEqual([edited, edited])
    expect(queued.some((job) => job.storeId === untouched)).toBe(false)
  })

  test("a second restaurant editing at the same time gets its own push", async () => {
    const t = newHarness()
    const luigi = await seedStore(t, "Chez Luigi")
    const marco = await seedStore(t, "Chez Marco")
    const luigiCategory = await seedCategory(t, luigi)
    const marcoCategory = await seedCategory(t, marco)
    const asOwner = await seedOwner(t, [luigi, marco])

    await asOwner.mutation(api.products.create, createProduct(luigi, luigiCategory, 1))
    await asOwner.mutation(api.products.create, createProduct(marco, marcoCategory, 2))

    const queued = await queuedSyncs(t)

    // The window is per (platform, restaurant): one restaurant's burst must
    // never swallow another's push.
    expect(queued).toHaveLength(4)
    expect(queued.filter((job) => job.storeId === luigi)).toHaveLength(2)
    expect(queued.filter((job) => job.storeId === marco)).toHaveLength(2)
  })

  test("menu mutations share the product window rather than adding to it", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const asOwner = await seedOwner(t, [store])

    const productId = await asOwner.mutation(
      api.products.create,
      createProduct(store, categoryId, 1)
    )

    await asOwner.mutation(api.menus.create, {
      storeId: store,
      name: "Formule midi",
      price: 1500,
      isActive: true,
      sortOrder: 0,
      sections: [
        {
          sectionId: "plat",
          label: "Plat",
          type: "fixed" as const,
          required: true,
          minChoices: 1,
          maxChoices: 1,
          allowDuplicates: false,
          sortOrder: 0,
          productId,
        },
      ],
    })

    // Products and menus feed the same platform upload, so they claim the same
    // window. Two mutations, still one push per platform.
    expect(await queuedSyncs(t)).toHaveLength(2)
  })

  test("deleting a product still books its push, after the document is gone", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const asOwner = await seedOwner(t, [store])

    const productId = await asOwner.mutation(
      api.products.create,
      createProduct(store, categoryId, 1)
    )

    // Past the window the create claimed, so this mutation has to claim its own
    // — and it has to resolve the store BEFORE the delete, because the resolver
    // reads the very document `remove` is about to erase.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (row.state.kind === "pending") await ctx.scheduler.cancel(row._id)
      }
      for (const row of await ctx.db.query("rateLimits").collect()) {
        await ctx.db.delete(row._id)
      }
    })

    await asOwner.mutation(api.products.remove, { id: productId })

    const queued = await queuedSyncs(t)
    expect(queued).toHaveLength(2)
    expect(queued.map((job) => job.storeId)).toEqual([store, store])
  })
})
