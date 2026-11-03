// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * `soundConfig` reaches the kitchen display through the real mutation (#224).
 *
 * The audit listed it beside `orderConfirmation` and `displayConfig` as a dead
 * setting — "mutations and audit entries wired, with no reader or writer" — and
 * 74de4e9 deleted the mutations for the other two on the strength of that.
 *
 * The claim was wrong about all three, and the note this file used to carry
 * repeated it. `soundConfig` is read by `KitchenContent`, which hands it to
 * `KitchenSoundManager` in both apps on the routed `/dashboard/orders/kitchen`
 * screen. `orderConfirmation` is read by `releaseToKitchen`. `displayConfig` is
 * read by `kitchenTickets.getForDisplay`, and always was — the dining-room
 * screen has been applying it since it shipped. Both mutations are back;
 * `kitchen-display-config.test.ts` holds the second one to the same standard as
 * this file holds this one.
 *
 * This test exists so the claim is checked rather than remembered. It writes
 * through the real mutation and reads back through `stores.getById` — the query
 * the KDS uses — so the write and the read are the same seam the kitchen runs
 * on.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

/** The shape `KitchenSoundManager` destructures. */
const SOUND_CONFIG = {
  newTicket: { enabled: true, volume: 80 },
  overdue: { enabled: false, volume: 100 },
  printerOffline: { enabled: true, volume: 60 },
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


async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
      address: {
        street: "12 rue Oberkampf",
        city: "Paris",
        postalCode: "75011",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedStaff(
  t: ReturnType<typeof convexTest>,
  role: "client_admin" | "kitchen",
  storeIds: Id<"stores">[]
) {
  const subject = `user:${role}`
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

// ============================================================================

describe("stores.updateSoundConfig", () => {
  test("reaches the query the kitchen display reads", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateSoundConfig, {
      id: storeId,
      soundConfig: SOUND_CONFIG,
    })

    // `KitchenContent` reads its establishment through `getById`, under the
    // `kitchen` role — which does not hold `stores:read`.
    const asKitchen = await seedStaff(t, "kitchen", [storeId])
    const store = await asKitchen.query(api.stores.getById, { id: storeId })

    expect(store?.soundConfig).toEqual(SOUND_CONFIG)
  })

  test("carries a muted alert through, rather than losing it to a default", async () => {
    // `KitchenSoundManager` falls back to `{ enabled: true, ... }` for every
    // alert, so an `enabled: false` that does not survive the round trip is
    // indistinguishable from no configuration at all — the overdue alarm would
    // keep sounding in a kitchen that switched it off.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateSoundConfig, {
      id: storeId,
      soundConfig: SOUND_CONFIG,
    })

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.soundConfig?.overdue).toEqual({ enabled: false, volume: 100 })
  })

  test("leaves the audit trail an entry", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateSoundConfig, {
      id: storeId,
      soundConfig: SOUND_CONFIG,
    })

    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    expect(entries.some((e) => e.details?.includes("updateSoundConfig"))).toBe(true)
  })
})
