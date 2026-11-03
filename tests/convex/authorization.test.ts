// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Authorisation tests — the negative half.
 *
 * The audit's central finding was that the store-scoped seam existed and simply
 * was not applied: functions guarded only by "are you logged in", public reads
 * of admin data, a privilege escalation through `userProfiles.upsert`. Sprint 2
 * closed those one by one, but a migration is only as good as the test that
 * proves it happened.
 *
 * These tests run the real Convex functions against a real schema, in memory.
 * They assert what must be REFUSED — the assertions that fail loudly if a guard
 * is ever weakened or a wrapper quietly reverts to `query(defs.x)`.
 */

import { convexTest } from "convex-test"
import { anyApi } from "convex/server"
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


/** A store record with only the fields the schema demands. */
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

/** A user whose profile grants `role` over `storeIds`. */
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

async function seedPrize(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("prizes", {
      storeId,
      name: "Café offert",
      type: "custom" as const,
      validityDays: 30,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

// ============================================================================
// The seam refuses anonymous callers
// ============================================================================

describe("no session", () => {
  test("a store-scoped read is refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")

    await expect(t.query(api.prizes.list, { storeId })).rejects.toThrow(
      /Not authenticated/
    )
  })

  test("a store-scoped write is refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")

    await expect(
      t.mutation(api.gameQRCodes.create, {
        storeId,
        code: "TABLE1",
        tableNumber: "1",
        isActive: true,
      })
    ).rejects.toThrow(/Not authenticated/)
  })
})

// ============================================================================
// The tenant boundary
// ============================================================================

describe("cross-store access", () => {
  test("a user of store A cannot read store B", async () => {
    // `prizes.list` was a bare public query: a storeId — visible in the
    // /display/[storeId] URL — was enough to read a competitor's prize stock.
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const storeB = await seedStore(t, "Pizza B")
    const asOwnerOfA = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(asOwnerOfA.query(api.prizes.list, { storeId: storeB })).rejects.toThrow(
      /Access denied/
    )
  })

  test("a user of store A cannot write to store B", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const storeB = await seedStore(t, "Pizza B")
    const asOwnerOfA = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(
      asOwnerOfA.mutation(api.gameQRCodes.create, {
        storeId: storeB,
        code: "TABLE1",
        tableNumber: "1",
        isActive: true,
      })
    ).rejects.toThrow(/Access denied/)
  })

  test("a user of store A cannot delete store B's data", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const storeB = await seedStore(t, "Pizza B")
    const prizeInB = await seedPrize(t, storeB)
    const asOwnerOfA = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(asOwnerOfA.mutation(api.prizes.remove, { id: prizeInB })).rejects.toThrow(
      /Access denied/
    )
  })

  test("the owner of the store itself is allowed", async () => {
    // The mirror of the tests above: the guard must not lock out the person it
    // exists to serve.
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const asOwner = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(asOwner.query(api.prizes.list, { storeId: storeA })).resolves.toEqual([])
  })

  test("a super admin reaches every store", async () => {
    const t = newHarness()
    await seedStore(t, "Pizza A")
    const storeB = await seedStore(t, "Pizza B")
    const asRoot = await seedUser(t, "user:root", "super_admin", [])

    await expect(asRoot.query(api.prizes.list, { storeId: storeB })).resolves.toEqual([])
  })
})

// ============================================================================
// The role boundary — membership is not enough
// ============================================================================

describe("insufficient role", () => {
  test("kitchen staff cannot delete the store they work in", async () => {
    // Store-scoped without `permission:` only checks membership, which is how a
    // kitchen account could delete the restaurant.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")
    const asKitchen = await seedUser(t, "user:k", "kitchen", [storeId])

    await expect(asKitchen.mutation(api.stores.remove, { id: storeId })).rejects.toThrow(
      /lacks permission/
    )
  })

  test("kitchen staff cannot run email marketing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")
    const asKitchen = await seedUser(t, "user:k", "kitchen", [storeId])

    await expect(
      asKitchen.query(api.emailCampaigns.list, { storeId })
    ).rejects.toThrow(/lacks permission/)
  })

  test("a waiter cannot change the game odds", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")
    const asWaiter = await seedUser(t, "user:w", "waiter", [storeId])

    await expect(asWaiter.query(api.games.list, { storeId })).rejects.toThrow(
      /lacks permission/
    )
  })

  test("kitchen staff CAN read their own kitchen display", async () => {
    // The risk of adding permissions everywhere is locking the kitchen out of
    // the one screen it needs.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")
    const asKitchen = await seedUser(t, "user:k", "kitchen", [storeId])

    await expect(
      asKitchen.query(api.kitchenTickets.getByStore, { storeId })
    ).resolves.toBeDefined()
  })
})

// ============================================================================
// Privilege escalation
// ============================================================================

describe("privilege escalation", () => {
  test("a customer cannot promote themselves to manager", async () => {
    // The audited three-call attack: sign up, list the public stores, grant
    // yourself `manager` on someone else's restaurant.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza A")
    const asCustomer = await seedUser(t, "user:mallory", "customer", [])

    await expect(
      asCustomer.mutation(internal.userProfiles.upsert, {
        userId: "user:mallory",
        role: "manager",
        storeIds: [storeId],
      })
    ).rejects.toThrow(/pas le droit/)
  })

  test("an owner cannot grant access to a store they do not administer", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const storeB = await seedStore(t, "Pizza B")
    const asOwnerOfA = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(
      asOwnerOfA.mutation(internal.userProfiles.upsert, {
        userId: "user:new",
        role: "manager",
        storeIds: [storeB],
      })
    ).rejects.toThrow(/vos propres établissements|administrez/)
  })

  test("an owner cannot mint another admin", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Pizza A")
    const asOwnerOfA = await seedUser(t, "user:a", "client_admin", [storeA])

    await expect(
      asOwnerOfA.mutation(internal.userProfiles.upsert, {
        userId: "user:new",
        role: "client_admin",
        storeIds: [storeA],
      })
    ).rejects.toThrow(/super administrateur/)
  })

  test("a customer cannot create a restaurant", async () => {
    const t = newHarness()
    const asCustomer = await seedUser(t, "user:mallory", "customer", [])

    await expect(
      asCustomer.mutation(api.stores.create, {
        name: "Faux resto",
        slug: "faux-resto",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75002",
          country: "France",
        },
      })
    ).rejects.toThrow(/stores:write/)
  })
})

// ============================================================================
// Reading other people's data
// ============================================================================

/**
 * Proving a public function is GONE takes more care than it looks.
 *
 * The obvious `expect(api.orders).not.toHaveProperty("getByCustomer")` is a
 * tautology. `api` from `_generated/api.js` is `anyApi`, a Proxy carrying a
 * `get` trap and no `has` trap, so `in` is false for every key and
 * `not.toHaveProperty` passes for a live function just as happily as for a
 * deleted one. `expect(api.orders).not.toHaveProperty("getMyOrders")` passes
 * today, and the first test below asserts `getMyOrders` for real, so that
 * example cannot quietly stop being one.
 *
 * Absence is only observable by CALLING through the Proxy: convex-test resolves
 * the module and throws "there is no such export" before it reads a single
 * argument. Hence `anyApi` imported next to `api`. They are the same object at
 * runtime, but `api` is typed from the generated module list, so naming a
 * deleted export on it would not compile — that is the type-level half of the
 * guard, and this is the runtime half.
 *
 * Re-export either function and these two go red on the next run.
 */
describe("identity is never an argument", () => {
  test("a signed-in customer only sees their own orders", async () => {
    // `getByCustomer` took an arbitrary customerId and returned that person's
    // whole history. It is gone; `getMyOrders` derives the customer instead.
    const t = newHarness()
    const asCustomer = await seedUser(t, "user:c1", "customer", [])

    await expect(
      asCustomer.query(anyApi.orders.getByCustomer, { customerId: "user:c1" })
    ).rejects.toThrow(/getByCustomer.*no such export/)

    await expect(asCustomer.query(api.orders.getMyOrders, {})).resolves.toEqual([])
  })

  test("a profile can only be read by its owner", async () => {
    // `getByUserId` performed no identity check at all.
    const t = newHarness()
    const asCustomer = await seedUser(t, "user:c1", "customer", [])

    await expect(
      asCustomer.query(anyApi.userProfiles.getByUserId, { userId: "user:c1" })
    ).rejects.toThrow(/getByUserId.*no such export/)

    const mine = await asCustomer.query(api.userProfiles.getMyProfile, {})
    expect(mine?.userId).toBe("user:c1")
  })
})

/**
 * The guards the 56 actions rely on.
 *
 * The ESLint rule can tell you an action CLAIMS to be guarded — it reads the
 * `@guarded-inline` comment — but it cannot tell you the claim is true. Proving
 * that took neutralising a guard by hand and watching lint stay green. These
 * tests close the gap for the two helpers every guarded action routes through:
 * if either stops refusing, they go red.
 */
describe("action guards", () => {
  test("checkStorePermission refuses a customer on someone else's store", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asCustomer = await seedUser(t, "user:mallory", "customer", [])

    await expect(
      asCustomer.query(internal.authHelpers.checkStorePermission, {
        storeId,
        permission: "kitchen:write",
      })
    ).rejects.toThrow()
  })

  test("checkStorePermission refuses a manager of ANOTHER store", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.query(internal.authHelpers.checkStorePermission, {
        storeId: theirs,
        permission: "kitchen:write",
      })
    ).rejects.toThrow()
  })

  test("checkStorePermission lets the kitchen work its own kitchen", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asKitchen = await seedUser(t, "user:k1", "kitchen", [storeId])

    await expect(
      asKitchen.query(internal.authHelpers.checkStorePermission, {
        storeId,
        permission: "kitchen:write",
      })
    ).resolves.toBe(true)
  })

  test("checkPermission refuses a customer a deployment-wide setting", async () => {
    const t = newHarness()
    const asCustomer = await seedUser(t, "user:mallory", "customer", [])

    await expect(
      asCustomer.query(internal.authHelpers.checkPermission, {
        permission: "settings:write",
      })
    ).rejects.toThrow()
  })

  test("checkPermission refuses the kitchen a deployment-wide setting", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asKitchen = await seedUser(t, "user:k1", "kitchen", [storeId])

    await expect(
      asKitchen.query(internal.authHelpers.checkPermission, {
        permission: "settings:write",
      })
    ).rejects.toThrow()
  })

  test("checkPermission lets a client admin connect a payment provider", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asAdmin = await seedUser(t, "user:a1", "client_admin", [storeId])

    await expect(
      asAdmin.query(internal.authHelpers.checkPermission, {
        permission: "settings:write",
      })
    ).resolves.toBe(true)
  })

  test("an unknown permission string denies rather than grants", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asAdmin = await seedUser(t, "user:a1", "client_admin", [storeId])

    await expect(
      asAdmin.query(internal.authHelpers.checkPermission, {
        permission: "settings:wrtie",
      })
    ).rejects.toThrow()
  })
})

/** An order with only the fields the schema demands. */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  status: "confirmed" | "ready" = "confirmed"
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-0001",
      customerInfo: { name: "Camille" },
      type: "delivery" as const,
      status,
      items: [
        {
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1000,
          selectedOptions: [],
          subtotal: 1000,
        },
      ],
      subtotal: 1000,
      taxAmount: 100,
      total: 1100,
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/**
 * Permissions that named the wrong verb.
 *
 * These call the real mutations, not the permission helper. An earlier version
 * asserted on permission STRINGS, which proved the role table and nothing about
 * the call site: putting `orders:write` back on `orders.updateStatus` left them
 * all green. A test that cannot fail on the change it describes is worse than
 * no test, because it reads as coverage.
 */
describe("permission verbs", () => {
  test("the kitchen can advance an order it is cooking", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    const asKitchen = await seedUser(t, "user:k1", "kitchen", [storeId])

    await expect(
      asKitchen.mutation(api.orders.updateStatus, {
        id: orderId,
        status: "preparing",
      })
    ).resolves.not.toThrow()
  })

  test("the delivery role can advance an order — its entire job", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    // `confirmed -> out_for_delivery` is not a legal transition; the courier
    // picks up an order that is ready.
    const orderId = await seedOrder(t, storeId, "ready")
    const asDelivery = await seedUser(t, "user:d1", "delivery", [storeId])

    await expect(
      asDelivery.mutation(api.orders.updateStatus, {
        id: orderId,
        status: "out_for_delivery",
      })
    ).resolves.not.toThrow()
  })

  test("a customer still cannot advance anyone's order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    const asCustomer = await seedUser(t, "user:mallory", "customer", [])

    await expect(
      asCustomer.mutation(api.orders.updateStatus, {
        id: orderId,
        status: "completed",
      })
    ).rejects.toThrow()
  })

  test("the kitchen of ANOTHER restaurant cannot advance this order", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const orderId = await seedOrder(t, mine)
    const asKitchen = await seedUser(t, "user:k2", "kitchen", [theirs])

    await expect(
      asKitchen.mutation(api.orders.updateStatus, {
        id: orderId,
        status: "preparing",
      })
    ).rejects.toThrow()
  })

  test("an owner can delete an order in their own restaurant", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    const asAdmin = await seedUser(t, "user:a1", "client_admin", [storeId])

    await expect(
      asAdmin.mutation(api.orders.remove, { id: orderId })
    ).resolves.not.toThrow()
  })

  test("the kitchen cannot delete an order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    const asKitchen = await seedUser(t, "user:k1", "kitchen", [storeId])

    await expect(
      asKitchen.mutation(api.orders.remove, { id: orderId })
    ).rejects.toThrow()
  })
})

/**
 * The manager and the marketing module.
 *
 * The team screen has always ticked "Jeux / Marketing" for a manager by
 * default while the role table withheld it. Resolved in favour of the screen —
 * so it has to be the screen's promise these tests hold, not the table's.
 */
describe("manager runs the restaurant", () => {
  test("a manager can create an in-store game", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await expect(
      asManager.mutation(api.games.create, {
        storeId,
        type: "wheel",
        name: "Roue du vendredi",
        winRatio: 30,
        isActive: true,
      })
    ).resolves.not.toThrow()
  })

  test("a manager can create a marketing segment", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asManager = await seedUser(t, "user:m1", "manager", [storeId])

    await expect(
      asManager.mutation(api.emailSegments.create, {
        storeId,
        name: "Habitués",
        rules: [],
        ruleOperator: "and",
      })
    ).resolves.not.toThrow()
  })

  test("a manager of ANOTHER restaurant still cannot", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asManager = await seedUser(t, "user:m1", "manager", [theirs])

    await expect(
      asManager.mutation(api.games.create, {
        storeId: mine,
        type: "wheel",
        name: "Roue pirate",
        winRatio: 100,
        isActive: true,
      })
    ).rejects.toThrow()
  })

  test("widening the manager did not widen the waiter", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asWaiter = await seedUser(t, "user:w1", "waiter", [storeId])

    await expect(
      asWaiter.mutation(api.games.create, {
        storeId,
        type: "scratch_card",
        name: "Ticket",
        winRatio: 50,
        isActive: true,
      })
    ).rejects.toThrow()
  })
})

/**
 * The guest's route to their own order.
 *
 * Sprint 2 put `kitchenTickets.getByOrder` behind `kitchen:read` — correct, and
 * it silently broke live tracking, because the confirmation page read the
 * tracking token from there. The guest was refused, the token came back
 * undefined, and the button never rendered: `/track/[token]` existed with
 * nothing able to reach it. Nothing failed loudly. These tests make that
 * failure loud.
 */
describe("a guest can reach their own order", () => {
  test("the view token yields the tracking token", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    await t.run((ctx) => ctx.db.patch(orderId, { viewToken: "vt-secret" }))
    await t.run((ctx) =>
      ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-2026-0001",
        status: "pending" as const,
        priority: "normal" as const,
        items: [],
        source: "website" as const,
        orderType: "delivery" as const,
        trackingToken: "track-abc",
        printStatus: "not_required" as const,
        printAttempts: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const token = await t.query(api.orders.getTrackingToken, {
      orderId,
      viewToken: "vt-secret",
    })
    expect(token).toBe("track-abc")
  })

  test("a wrong view token yields nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)
    await t.run((ctx) => ctx.db.patch(orderId, { viewToken: "vt-secret" }))
    await t.run((ctx) =>
      ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-2026-0001",
        status: "pending" as const,
        priority: "normal" as const,
        items: [],
        source: "website" as const,
        orderType: "delivery" as const,
        trackingToken: "track-abc",
        printStatus: "not_required" as const,
        printAttempts: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const token = await t.query(api.orders.getTrackingToken, {
      orderId,
      viewToken: "vt-guessed",
    })
    expect(token).toBeNull()
  })

  test("no token and no session yields nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)

    const token = await t.query(api.orders.getTrackingToken, { orderId })
    expect(token).toBeNull()
  })

  test("the payment state is readable, and says only what it should", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)

    const state = await t.query(api.orders.getPaymentState, { orderId })
    expect(state).toEqual({
      paymentStatus: "paid",
      status: "confirmed",
      orderNumber: "ORD-2026-0001",
    })
    // No customer, no address, no amount — the page never needed them.
    expect(Object.keys(state ?? {})).toHaveLength(3)
  })
})

describe("copying a catalogue", () => {
  test("a manager cannot write into a restaurant they do not administer", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    // The seam used to scope to the SOURCE, so proving rights over the store
    // being read was enough to write into any other.
    await expect(
      asManager.mutation(api.products.duplicateCatalog, {
        sourceStoreId: mine,
        targetStoreId: theirs,
      })
    ).rejects.toThrow()
  })

  test("a manager cannot copy a catalogue they may not read", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.products.duplicateCatalog, {
        sourceStoreId: theirs,
        targetStoreId: mine,
      })
    ).rejects.toThrow()
  })

  test("an owner of both may still copy between them", async () => {
    const t = newHarness()
    const a = await seedStore(t, "Chez Luigi")
    const b = await seedStore(t, "Luigi Bis")
    const asAdmin = await seedUser(t, "user:a1", "client_admin", [a, b])

    await expect(
      asAdmin.mutation(api.products.duplicateCatalog, {
        sourceStoreId: a,
        targetStoreId: b,
      })
    ).resolves.not.toThrow()
  })
})

/**
 * The first-administrator path.
 *
 * These assert the property the whole bootstrap exists for: **a clone nobody
 * has configured cannot produce an administrator, by any public route.** The
 * earlier version of this block asserted `rejects.toThrow()` and nothing else,
 * which is satisfied by a schema error as readily as by a refusal, and its
 * success case never checked that a super admin had been minted at all — let
 * alone exactly one. So it would have stayed green through a claim that
 * silently minted two, or one that refused for the wrong reason.
 *
 * Every case below therefore reads the refusal's `code` and counts the
 * super-admin rows afterwards. `mintedSuperAdmins` is the invariant; the codes
 * are what stops a right answer for a wrong reason.
 */
describe("claiming the first admin seat", () => {
  /**
   * The refusal's machine-readable code.
   *
   * convex-test serialises `ConvexError.data` into the message rather than
   * carrying `err.data` across, so read it back out of the JSON. A test that
   * cannot tell "wrong token" from "no such function" is not testing a guard.
   */
  async function refusalCode(call: Promise<unknown>): Promise<string> {
    try {
      await call
      return "__RESOLVED__"
    } catch (err) {
      const raw = String((err as Error).message ?? err)
      const data = (err as { data?: unknown }).data
      if (data && typeof data === "object" && "code" in data) {
        return String((data as { code: unknown }).code)
      }
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as { code?: unknown }
          if (parsed.code !== undefined) return String(parsed.code)
        } catch {
          /* not JSON: fall through and report the raw message */
        }
      }
      return raw
    }
  }

  /** Who actually holds the super-admin seat, straight from the table. */
  async function mintedSuperAdmins(t: ReturnType<typeof convexTest>) {
    return t.run((ctx) =>
      ctx.db
        .query("userProfiles")
        .filter((q) => q.eq(q.field("role"), "super_admin"))
        .collect()
    )
  }

  /** Run `fn` with `ADMIN_BOOTSTRAP_TOKEN` set to `value` (or unset). */
  async function withBootstrapToken<T>(
    value: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = process.env.ADMIN_BOOTSTRAP_TOKEN
    if (value === undefined) delete process.env.ADMIN_BOOTSTRAP_TOKEN
    else process.env.ADMIN_BOOTSTRAP_TOKEN = value
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.ADMIN_BOOTSTRAP_TOKEN
      else process.env.ADMIN_BOOTSTRAP_TOKEN = previous
    }
  }

  test("an unconfigured deployment refuses everyone rather than letting anyone in", async () => {
    // A missing variable that waved callers through would recreate the hole on
    // exactly the deployments nobody has set up yet — every fresh clone.
    await withBootstrapToken(undefined, async () => {
      const t = newHarness()
      const asCustomer = await seedUser(t, "user:mallory", "customer", [])

      expect(
        await refusalCode(
          asCustomer.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "guess",
          })
        )
      ).toBe("bootstrap_not_configured")
      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("an empty bootstrap token is not a configured one", async () => {
    // `ADMIN_BOOTSTRAP_TOKEN=` in a .env file is the shape a half-finished
    // setup leaves behind, and an empty secret matching an empty submission is
    // how it would hand the deployment to the next visitor.
    await withBootstrapToken("", async () => {
      const t = newHarness()
      const asCustomer = await seedUser(t, "user:mallory", "customer", [])

      expect(
        await refusalCode(
          asCustomer.mutation(api.userProfiles.claimFirstAdmin, { bootstrapToken: "" })
        )
      ).toBe("bootstrap_not_configured")
      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("an authenticated stranger cannot claim it without the bootstrap secret", async () => {
    // Sign-up is open on the storefront. "Self-closing once a super admin
    // exists" meant the first stranger through the door took the deployment.
    // The token IS configured here, so this tests the refusal it is named for
    // rather than passing because nothing was ever set.
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      const asCustomer = await seedUser(t, "user:mallory", "customer", [])

      expect(
        await refusalCode(
          asCustomer.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "guess",
          })
        )
      ).toBe("bootstrap_token_invalid")
      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("a correct prefix of the secret is worth no more than a wrong guess", async () => {
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      const asCustomer = await seedUser(t, "user:mallory", "customer", [])

      expect(
        await refusalCode(
          asCustomer.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t",
          })
        )
      ).toBe("bootstrap_token_invalid")
      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("holding the secret is not enough without a session", async () => {
    // The seat is attached to an account, not to the token. A claim that
    // succeeded anonymously would have nobody to attach it to.
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()

      expect(
        await refusalCode(
          t.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t-bootstrap",
          })
        )
      ).toBe("not_authenticated")
      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("the holder of the secret claims the seat, exactly once", async () => {
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      const asOwner = await seedUser(t, "user:owner", "customer", [])

      await asOwner.mutation(api.userProfiles.claimFirstAdmin, {
        bootstrapToken: "s3cr3t-bootstrap",
      })

      // One seat, and it belongs to the caller who claimed it.
      const minted = await mintedSuperAdmins(t)
      expect(minted).toHaveLength(1)
      expect(minted[0]?.userId).toBe("user:owner")

      // Self-closing against a replay by the same holder...
      expect(
        await refusalCode(
          asOwner.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t-bootstrap",
          })
        )
      ).toBe("bootstrap_already_claimed")

      // ...and against a second person who also came by the token.
      const asSecond = await seedUser(t, "user:second", "customer", [])
      expect(
        await refusalCode(
          asSecond.mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t-bootstrap",
          })
        )
      ).toBe("bootstrap_already_claimed")

      expect(await mintedSuperAdmins(t)).toHaveLength(1)
    })
  })

  test("two claims racing for the seat still mint exactly one", async () => {
    // Both callers hold the token and both find an empty table. Only the
    // transaction that commits first may win.
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      const results = await Promise.allSettled([
        t
          .withIdentity({ subject: "user:a" })
          .mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t-bootstrap",
          }),
        t
          .withIdentity({ subject: "user:b" })
          .mutation(api.userProfiles.claimFirstAdmin, {
            bootstrapToken: "s3cr3t-bootstrap",
          }),
      ])

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      expect(await mintedSuperAdmins(t)).toHaveLength(1)
    })
  })

  test("`upsert` is not publicly exported at all", () => {
    // The strongest form of "not a second door onto the seat": the mutation is
    // `internalMutation`, so no client can reach it whatever the policy says.
    //
    // This has to be a source assertion, and the reason is worth recording.
    // Neither of the two things that would normally catch a regression here
    // can see it. `tsconfig.json` excludes `tests`, so the compiler never
    // type-checks these files and a stale `api.userProfiles.upsert` raises
    // nothing. And convex-test resolves `api.` and `anyApi.` by path and runs
    // the function regardless of its visibility — measured: calling
    // `anyApi.userProfiles.upsert` after this change still executed the
    // handler and returned the policy's refusal, not "no such export". The
    // sibling tests above that DO assert "no such export" pass because those
    // functions were deleted outright, which is a different thing.
    //
    // So reverting `internalMutation` to `mutation` would be invisible to the
    // whole suite. This is what notices.
    const sources = import.meta.glob("../../convex/userProfiles.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
    const source = Object.values(sources)[0]

    expect(source).toBeTypeOf("string")
    expect(source).toMatch(/export const upsert = internalMutation\(/)
    expect(source).not.toMatch(/export const upsert = mutation\(/)
  })

  test("the provisioning policy still refuses an escalation from inside", async () => {
    // Internal is the outer wall; the policy is the inner one, and it still
    // runs. Reaching it through `internal.` is how a server function would,
    // and how `seed-users.mts` does through a deploy key.
    await withBootstrapToken(undefined, async () => {
      const t = newHarness()

      // No profile at all — the state of every account on a fresh clone.
      expect(
        await refusalCode(
          t.withIdentity({ subject: "user:nobody" }).mutation(internal.userProfiles.upsert, {
            userId: "user:nobody",
            role: "super_admin",
            storeIds: [],
            permissions: [],
          })
        )
      ).toBe("no_profile")

      // A customer promoting themselves.
      const asCustomer = await seedUser(t, "user:mallory", "customer", [])
      expect(
        await refusalCode(
          asCustomer.mutation(internal.userProfiles.upsert, {
            userId: "user:mallory",
            role: "super_admin",
            storeIds: [],
            permissions: [],
          })
        )
      ).toMatch(/pas le droit/)

      // A restaurant owner promoting themselves the rest of the way.
      const asClientAdmin = await seedUser(t, "user:owner", "client_admin", [])
      expect(
        await refusalCode(
          asClientAdmin.mutation(internal.userProfiles.upsert, {
            userId: "user:owner",
            role: "super_admin",
            storeIds: [],
            permissions: [],
          })
        )
      ).toMatch(/super administrateur/)

      expect(await mintedSuperAdmins(t)).toHaveLength(0)
    })
  })

  test("a client admin cannot demote the super admin out of the seat", async () => {
    // The mirror image of claiming it, and the one `upsert` makes reachable:
    // the requested role is harmless, the target holds no foreign store, and
    // every other check passes. Only reading who the target IS today refuses
    // it — so this covers the seam between `assertCanAssignProfile` and its
    // call site, which the pure-function tests in `convex-functions` cannot.
    // Passing `existingTarget: null` from the handler reopens it, and until
    // this test existed that change kept the whole suite green.
    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      const storeA = await seedStore(t, "Pizza A")
      await seedUser(t, "user:root", "super_admin", [])
      const asOwner = await seedUser(t, "user:owner", "client_admin", [storeA])

      expect(
        await refusalCode(
          asOwner.mutation(internal.userProfiles.upsert, {
            userId: "user:root",
            role: "customer",
            storeIds: [],
            permissions: [],
          })
        )
      ).toMatch(/super administrateur/)

      // Still holds the seat, with the role and stores it had.
      const supers = await mintedSuperAdmins(t)
      expect(supers).toHaveLength(1)
      expect(supers[0]?.userId).toBe("user:root")
    })
  })

  test("the claim is wired to the constant-time comparison, not to `!==`", async () => {
    // `bootstrapTokenMatches` and `!==` agree on every input — they differ only
    // in timing, which no assertion can pin down reliably. So the property is
    // checked structurally instead: reverting the call site to `!==` is
    // otherwise invisible to the entire suite, and it silently reinstates the
    // byte-at-a-time oracle the function exists to close.
    const sources = import.meta.glob("../../convex/userProfiles.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
    const source = Object.values(sources)[0]

    expect(source).toBeTypeOf("string")
    expect(source).toContain("bootstrapTokenMatches(args.bootstrapToken, expected)")
    // No hand-rolled comparison of the token beside it.
    expect(source).not.toMatch(/args\.bootstrapToken\s*[!=]==/)
  })

  test("`bootstrapStatus` tells the setup screen the truth", async () => {
    // `/setup` renders one of three states off this query. If it lied about
    // `configured`, the screen would show a token field on a deployment where
    // no token can work — or hide it on one where the seat is still free.
    await withBootstrapToken(undefined, async () => {
      const t = newHarness()
      expect(await t.query(api.userProfiles.bootstrapStatus, {})).toEqual({
        claimed: false,
        configured: false,
      })
    })

    // `ADMIN_BOOTSTRAP_TOKEN=` — the shape a half-finished setup leaves behind.
    // `claimFirstAdmin` already refuses it; the screen has to agree, or it
    // shows a token field on a deployment where no token can ever work. A
    // `!== undefined` test here reads as correct and reports the opposite.
    await withBootstrapToken("", async () => {
      const t = newHarness()
      expect(await t.query(api.userProfiles.bootstrapStatus, {})).toEqual({
        claimed: false,
        configured: false,
      })
    })

    await withBootstrapToken("s3cr3t-bootstrap", async () => {
      const t = newHarness()
      expect(await t.query(api.userProfiles.bootstrapStatus, {})).toEqual({
        claimed: false,
        configured: true,
      })

      await t
        .withIdentity({ subject: "user:owner" })
        .mutation(api.userProfiles.claimFirstAdmin, {
          bootstrapToken: "s3cr3t-bootstrap",
        })

      expect(await t.query(api.userProfiles.bootstrapStatus, {})).toEqual({
        claimed: true,
        configured: true,
      })
    })
  })
})

