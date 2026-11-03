// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Saving the Integrations tab must not delete the Uber Direct credentials
 * (#169).
 *
 * `useSettingsForm` read `api.globalSettings.get` — the *public* storefront
 * query, which strips `customerId`, `clientId`, `clientSecret` and `apiKey`. So
 * the three credential fields came up empty, and pressing Enregistrer patched
 * those empty values over the stored ones. Opening the tab and saving anything
 * at all silently deleted the deliveries integration; the failure only showed
 * up later, as couriers no longer being dispatched.
 *
 * Two halves, and both are here: the form now reads `getAdmin`, and `upsert`
 * no longer replaces `integrations` as one blob.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const CREDENTIALS = {
  customerId: "cus_uberdirect_42",
  clientId: "cli_uberdirect_42",
  clientSecret: "sec_uberdirect_42",
  enabled: true,
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


/** A deployment with Uber Direct connected and the other two platforms on. */
async function seedSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 20,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: false },
      hours: [{ day: 1, open: "09:00", close: "22:00", isClosed: false }],
      delivery: { feeMode: "fixed" as const, fee: 350 },
      integrations: {
        uberDirect: CREDENTIALS,
        uberEats: { enabled: true, priceMarkup: 15 },
        deliveroo: { enabled: false },
      },
      updatedAt: NOW,
    })
  )
}

async function seedAdmin(t: ReturnType<typeof convexTest>, subject = "marie") {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role: "client_admin",
      storeIds: [],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

/** The Uber Direct block as it is actually stored. */
async function storedUberDirect(t: ReturnType<typeof convexTest>) {
  const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())
  return settings?.integrations?.uberDirect
}

// ============================================================================

describe("the two queries", () => {
  test("the public one hands out no credentials", async () => {
    // The storefront needs the tax rate, the delivery config and the opening
    // rules before anyone signs in. It does not need the keys.
    const t = newHarness()
    await seedSettings(t)

    const settings = await t.query(api.globalSettings.get, {})

    expect(settings?.integrations?.uberDirect?.enabled).toBe(true)
    expect(settings?.integrations?.uberDirect).not.toHaveProperty("customerId")
    expect(settings?.integrations?.uberDirect).not.toHaveProperty("clientId")
    expect(settings?.integrations?.uberDirect).not.toHaveProperty("clientSecret")
  })

  test("the admin one returns them, which is why the form has to use it", async () => {
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    const settings = await marie.query(api.globalSettings.getAdmin, {})

    expect(settings?.integrations?.uberDirect?.customerId).toBe("cus_uberdirect_42")
    expect(settings?.integrations?.uberDirect?.clientSecret).toBe("sec_uberdirect_42")
  })

  test("the admin one refuses a caller without settings:read", async () => {
    const t = newHarness()
    await seedSettings(t)
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "luc",
        role: "kitchen",
        storeIds: [],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    /*
     * The refusal carries a CODE since #649 routed this guard through
     * `requireRolePermission`: the engine's `denied()` shape, which says which of
     * the two gates closed. Asserting the code rather than the old prose, so a
     * reworded message does not fail this and a role check silently becoming a
     * module check does.
     */
    await expect(
      t.withIdentity({ subject: "luc" }).query(api.globalSettings.getAdmin, {})
    ).rejects.toThrow(/permission_denied/)
  })
})

describe("saving the Integrations tab", () => {
  test("keeps the credentials when the form loaded them from getAdmin", async () => {
    // The whole loop the bug lived in: read, then write back what was read.
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    const loaded = await marie.query(api.globalSettings.getAdmin, {})
    const uberDirect = loaded?.integrations?.uberDirect

    await marie.mutation(api.globalSettings.upsert, {
      integrations: {
        uberDirect: {
          customerId: uberDirect?.customerId || undefined,
          clientId: uberDirect?.clientId || undefined,
          clientSecret: uberDirect?.clientSecret || undefined,
          enabled: uberDirect?.enabled ?? false,
        },
        uberEats: { enabled: true, priceMarkup: 15 },
        deliveroo: { enabled: false },
      },
    })

    expect(await storedUberDirect(t)).toEqual(CREDENTIALS)
  })

  test("deletes them when the form loaded them from the public query", async () => {
    // The failure as it shipped, reproduced. `get` strips the three fields, so
    // the form sent `undefined` for each and the patch stored that.
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    const loaded = await marie.query(api.globalSettings.get, {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uberDirect = loaded?.integrations?.uberDirect as any

    await marie.mutation(api.globalSettings.upsert, {
      integrations: {
        uberDirect: {
          customerId: uberDirect?.customerId || undefined,
          clientId: uberDirect?.clientId || undefined,
          clientSecret: uberDirect?.clientSecret || undefined,
          enabled: uberDirect?.enabled ?? false,
        },
        uberEats: { enabled: true, priceMarkup: 15 },
        deliveroo: { enabled: false },
      },
    })

    const stored = await storedUberDirect(t)
    expect(stored?.customerId).toBeUndefined()
    expect(stored?.clientSecret).toBeUndefined()
  })

  test("leaves the other platforms alone when only one is sent", async () => {
    // `ctx.db.patch` replaces a whole object field, so a partial `integrations`
    // used to take out everything beside it.
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    await marie.mutation(api.globalSettings.upsert, {
      integrations: { deliveroo: { enabled: true, priceMarkup: 20 } },
    })

    const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())
    expect(settings?.integrations?.uberDirect).toEqual(CREDENTIALS)
    expect(settings?.integrations?.uberEats).toEqual({ enabled: true, priceMarkup: 15 })
    expect(settings?.integrations?.deliveroo).toEqual({ enabled: true, priceMarkup: 20 })
  })

  test("still lets an owner disconnect Uber Direct on purpose", async () => {
    // The merge is per platform, not per field: sending `uberDirect` replaces
    // it whole, so clearing the credentials remains possible. A merge that
    // could not forget would be its own bug.
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    await marie.mutation(api.globalSettings.upsert, {
      integrations: { uberDirect: { enabled: false } },
    })

    expect(await storedUberDirect(t)).toEqual({ enabled: false })
  })

  test("does not touch the settings the tab was not editing", async () => {
    const t = newHarness()
    await seedSettings(t)
    const marie = await seedAdmin(t)

    await marie.mutation(api.globalSettings.upsert, {
      integrations: { deliveroo: { enabled: true } },
    })

    const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())
    expect(settings?.taxRate).toBe(20)
    expect(settings?.timezone).toBe("Europe/Paris")
    expect(settings?.hours).toHaveLength(1)
  })
})
