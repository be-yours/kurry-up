// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Pausing a store in the admin has to reach Uber Eats and Deliveroo.
 *
 * The integration card's "Statut sur la plateforme" select has always written
 * `storeIntegrations.storeStatus`, and that value has always stopped in Convex:
 * `updateStoreStatus` existed in the integrations package with zero callers, so
 * a "paused" restaurant kept taking platform orders. `upsert` now schedules
 * `platformStoreStatus.pushStoreStatus`.
 *
 * Which saves push is the delicate part, and these tests pin it from both
 * sides — the form defaults to OFFLINE, so pushing indiscriminately pulls a
 * restaurant off the platform it just connected; and there is no action
 * retrier in this repo, so refusing to push an unchanged value would leave a
 * failed push unretryable.
 *
 * The second suite covers the other admin control that changed availability
 * and told nobody: the inventory page's stock-tracking switch.
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

/** Outstanding status pushes only — the menu sweeps are another suite's job. */
async function queuedStatusPushes(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect()
    return rows
      .filter((row) => row.state.kind === "pending" || row.state.kind === "inProgress")
      .filter((row) => row.name === "platformStoreStatus:pushStoreStatus")
      .map((row) => row.args[0] as { storeId?: string; platform?: string })
  })
}

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
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

function integrationArgs(
  storeId: Id<"stores">,
  storeStatus?: "ONLINE" | "PAUSED" | "OFFLINE"
) {
  return {
    storeId,
    platform: "uberEats" as const,
    platformStoreId: "uber-store-1",
    syncMenu: true,
    autoAccept: false,
    enabled: true,
    ...(storeStatus ? { storeStatus } : {}),
  }
}

describe("platform store status push", () => {
  // The form initialises the select to "OFFLINE" without anyone choosing it.
  // Pushing that would take a restaurant off Uber Eats the moment it connected.
  test("connecting an integration does not push the form's default OFFLINE", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "OFFLINE"))

    expect(await queuedStatusPushes(t)).toHaveLength(0)
  })

  test("a save with no status at all pushes nothing", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store))

    expect(await queuedStatusPushes(t)).toHaveLength(0)
  })

  // Same trap one save later: the row exists but never stored a status, so the
  // card still shows its OFFLINE fallback.
  test("OFFLINE on a row that never had a status is still treated as the default", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store))
    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "OFFLINE"))

    expect(await queuedStatusPushes(t)).toHaveLength(0)
  })

  test("choosing a status pushes it to the platform", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store))
    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "ONLINE"))

    const pushes = await queuedStatusPushes(t)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ storeId: store, platform: "uberEats" })
  })

  test("pausing an online store pushes the pause", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "ONLINE"))
    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "PAUSED"))

    expect(await queuedStatusPushes(t)).toHaveLength(2)
  })

  // The regression that matters most. A scheduled action that throws is
  // terminal here — there is no action retrier — so if an unchanged value
  // refused to push, a failed pause would strand the store live on the platform
  // with Convex and the card both insisting it is paused, and the only way out
  // would be selecting ONLINE: re-opening a restaurant the owner wanted shut.
  test("re-saving the same status pushes again, so a failed push can be retried", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "PAUSED"))
    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "PAUSED"))

    expect(await queuedStatusPushes(t)).toHaveLength(2)
  })

  // Switching the integration off and selecting "Hors ligne" in one save is how
  // an owner stops serving a platform; it has to reach the platform.
  test("disabling the integration with OFFLINE still pushes", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, [store])

    await asOwner.mutation(api.storeIntegrations.upsert, integrationArgs(store, "ONLINE"))
    await asOwner.mutation(api.storeIntegrations.upsert, {
      ...integrationArgs(store, "OFFLINE"),
      enabled: false,
    })

    expect(await queuedStatusPushes(t)).toHaveLength(2)
  })
})

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

async function queuedMenuSyncs(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect()
    return rows
      .filter((row) => row.state.kind === "pending" || row.state.kind === "inProgress")
      .filter((row) => row.name.endsWith("MenuSync:internalSyncStore"))
      .map((row) => row.name)
  })
}

/**
 * Turning stock tracking on or off changes whether a dish is orderable —
 * `isProductOutOfStock` is `tracked && quantity <= 0` — so it has to reach the
 * platforms like `updateStock` does. It was the one stock control in the admin
 * (`packages/admin/src/pages/inventory/inventory-page.tsx`) that changed
 * availability and scheduled nothing.
 */
describe("stock tracking reaches the platforms", () => {
  test("toggling stock tracking books a menu push", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const categoryId = await seedCategory(t, store)
    const asOwner = await seedOwner(t, [store])

    // Seeded straight into the table, not through `products.create`: a create
    // claims the per-store menu-sync window, and the toggle would then
    // correctly ride the push that create already booked, hiding whether it
    // books one of its own.
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId: store,
        categoryId,
        name: "Pizza Margherita",
        slug: "pizza-margherita",
        price: 1200,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        source: "manual" as const,
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asOwner.mutation(api.products.toggleStockTracking, { id: productId, tracked: true })

    expect((await queuedMenuSyncs(t)).sort()).toEqual([
      "deliverooMenuSync:internalSyncStore",
      "uberEatsMenuSync:internalSyncStore",
    ])
  })
})
