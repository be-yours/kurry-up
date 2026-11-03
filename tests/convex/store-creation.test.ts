// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Creating an establishment from the dashboard (#125).
 *
 * On a product billed per store, this is the central commercial gesture, and
 * it threw on every attempt. `stores.create` declares six fields — `name`,
 * `slug`, `description`, `address`, `phone`, `email` — and the create dialog
 * sent a seventh: a `settings` object holding currency, timezone, service
 * toggles, fees and a tax rate. Convex rejects an undeclared argument instead
 * of dropping it, so the mutation never ran and the dialog only ever showed
 * "Échec de la création de l'établissement". The only stores that existed came
 * from `seedFixture`.
 *
 * The unit suites could not see this: they call the handler directly, past the
 * validator. These tests go through the real Convex function, the real
 * validator and the real schema, which is the seam that broke.
 *
 * `STORE_CREATE_PAYLOAD` is the dashboard's payload, field for field. If
 * `handleCreateStore` ever grows a field again, this file is where it has to
 * be declared first.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const AN_ADDRESS = {
  street: "12 rue Oberkampf",
  city: "Paris",
  postalCode: "75011",
  country: "France",
}

/**
 * Exactly what `stores-page.tsx` sends — `slugify(name)` included, and
 * `undefined` for the optional fields the form left empty.
 */
const STORE_CREATE_PAYLOAD = {
  name: "Pizzeria Napoli",
  slug: "pizzeria-napoli",
  description: "Napolitaine au feu de bois",
  address: AN_ADDRESS,
  phone: "+33145678901",
  email: "napoli@example.com",
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


/** An owner, signed in, with no establishment yet. */
async function seedOwner(
  t: ReturnType<typeof convexTest>,
  subject: string,
  storeIds: Id<"stores">[] = []
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role: "client_admin",
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
// The dashboard's payload
// ============================================================================

describe("stores.create, called the way the dashboard calls it", () => {
  test("creates the establishment", async () => {
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    const storeId = await marie.mutation(api.stores.create, STORE_CREATE_PAYLOAD)

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.name).toBe("Pizzeria Napoli")
    expect(store?.slug).toBe("pizzeria-napoli")
    expect(store?.address.city).toBe("Paris")
    expect(store?.phone).toBe("+33145678901")
  })

  test("opens it as a draft, with a week of hours and global hours on", async () => {
    // The defaults `create` stamps on top of the payload. A brand-new
    // establishment is not a storefront until its owner publishes it.
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    const storeId = await marie.mutation(api.stores.create, STORE_CREATE_PAYLOAD)

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.status).toBe("draft")
    expect(store?.useGlobalHours).toBe(true)
    expect(store?.hours).toHaveLength(7)
  })

  test("hands the creator access to what they just created", async () => {
    // #117: without this the owner is refused by every screen that would show
    // them their new location.
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    const storeId = await marie.mutation(api.stores.create, STORE_CREATE_PAYLOAD)

    const profile = await t.run((ctx) =>
      ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", "marie"))
        .unique()
    )
    expect(profile?.storeIds).toContain(storeId)
  })

  test("takes a second establishment for the same owner", async () => {
    // The product is billed per store. One owner, many locations, is the
    // business model — not an edge case.
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    await marie.mutation(api.stores.create, STORE_CREATE_PAYLOAD)
    await marie.mutation(api.stores.create, {
      ...STORE_CREATE_PAYLOAD,
      name: "Pizzeria Roma",
      slug: "pizzeria-roma",
    })

    const listed = await marie.query(api.stores.listAll, {})
    expect(listed.map((s) => s.name).sort()).toEqual([
      "Pizzeria Napoli",
      "Pizzeria Roma",
    ])
  })

  test("works with only the required fields", async () => {
    // `description`, `phone` and `email` are optional in the form and in the
    // validator; an owner who fills in nothing but the name and the address
    // must still get their establishment.
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    const storeId = await marie.mutation(api.stores.create, {
      name: "Chez Marie",
      slug: "chez-marie",
      address: AN_ADDRESS,
      description: undefined,
      phone: undefined,
      email: undefined,
    })

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.name).toBe("Chez Marie")
  })
})

// ============================================================================
// The field that broke it
// ============================================================================

describe("the rejected `settings` block", () => {
  test("is still refused by the validator, and writes nothing", async () => {
    // This is the failure as it shipped. It is pinned rather than deleted:
    // re-adding an undeclared field to the payload has to fail here, not in a
    // restaurant owner's browser.
    const t = newHarness()
    const marie = await seedOwner(t, "marie")

    await expect(
      marie.mutation(api.stores.create, {
        ...STORE_CREATE_PAYLOAD,
        settings: {
          currency: "EUR",
          timezone: "Europe/Paris",
          deliveryEnabled: true,
          pickupEnabled: true,
          dineInEnabled: true,
          minimumOrderAmount: 1000,
          deliveryFee: 300,
          deliveryRadius: 5000,
          taxRate: 10,
        },
        // The whole point is passing a field the validator does not declare,
        // which TypeScript refuses to type.
      } as unknown as typeof STORE_CREATE_PAYLOAD)
    ).rejects.toThrow(/settings/)

    const stores = await t.run((ctx) => ctx.db.query("stores").collect())
    expect(stores).toEqual([])
  })
})
