// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Draft establishments must not be storefronts.
 *
 * `stores.create` opens every new establishment in `draft`, and `stores.list` —
 * the query behind the selector page, the header dropdown, the automatic
 * selection and the sitemap — returned it alongside the published ones. A
 * restaurant whose owner had not finished setting it up was offered to
 * visitors with an active "Commander ici" button, and could take a real order
 * into a kitchen that was not waiting for it.
 *
 * These tests run the real Convex functions against the real schema, in memory.
 * They pin both halves of the rule: what the public list must not return, and
 * what the order mutation must refuse — because a list is only a list, and a
 * stale tab or a persisted selection reaches the mutation without it.
 *
 * The mirror assertions matter as much: the admin still sees its drafts, and
 * the kitchen role still reads the list `StoreGuard` renders the KDS behind.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorCode } from "../../lib/convex-error"

/**
 * The refusal code a call produced, as the browser reads it off `data`.
 *
 * These assertions matched the thrown message, and the messages are French
 * customer copy now — copy gets edited, the `code` is the contract, and only
 * `ConvexError.data` survives Convex's production redaction. See
 * `packages/convex-functions/src/refusal.ts`.
 */
async function refusalCode(call: Promise<unknown>): Promise<string | null> {
  try {
    await call
    return null
  } catch (error) {
    return convexErrorCode(error)
  }
}


const modules = import.meta.glob("../../convex/**/*.ts")

type Role =
  | "super_admin"
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "delivery"
  | "customer"

type StoreStatus = "draft" | "open" | "closed" | "temporarily_unavailable"

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


async function seedStore(
  t: ReturnType<typeof convexTest>,
  name: string,
  status: StoreStatus,
  extra: Record<string, unknown> = {}
) {
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
      status,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
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

/** A sellable product in `storeId`, priced in cents. */
async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  price = 1200
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
      storeId,
      categoryId,
      name: "Margherita",
      slug: "margherita",
      price,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual",
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

function orderArgs(storeId: Id<"stores">, productId: Id<"products">) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: 1,
        unitPrice: 1200,
        selectedOptions: [],
        subtotal: 1200,
      },
    ],
    type: "pickup" as const,
  }
}

// ============================================================================
// The public list
// ============================================================================

describe("stores.list", () => {
  test("omits a draft establishment", async () => {
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")
    await seedStore(t, "Pizza Open", "open")

    const stores = await t.query(api.stores.list, {})

    expect(stores.map((s) => s.name)).toEqual(["Pizza Open"])
  })

  test("keeps every published status", async () => {
    // `closed` and `temporarily_unavailable` are states of a published
    // restaurant — outside its hours, or paused for the evening. Hiding those
    // would be a different bug: a visitor could no longer find the place at
    // all, nor read its menu before it reopens.
    const t = newHarness()
    await seedStore(t, "Open", "open")
    await seedStore(t, "Closed", "closed")
    await seedStore(t, "Paused", "temporarily_unavailable")
    await seedStore(t, "Draft", "draft")

    const stores = await t.query(api.stores.list, {})

    expect(stores.map((s) => s.name).sort()).toEqual(["Closed", "Open", "Paused"])
  })

  test("stays readable without a session", async () => {
    // It is the storefront's list: a visitor who has never signed in has to be
    // able to choose a restaurant.
    const t = newHarness()
    await seedStore(t, "Pizza Open", "open")

    await expect(t.query(api.stores.list, {})).resolves.toHaveLength(1)
  })

  test("returns nothing at all when every establishment is a draft", async () => {
    // The storefront shows "Aucun restaurant disponible" rather than an
    // orderable half-built one. This is the case a brand-new account is in.
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")

    await expect(t.query(api.stores.list, {})).resolves.toEqual([])
  })
})

// ============================================================================
// The administration list
// ============================================================================

describe("stores.listAll", () => {
  test("refuses an anonymous caller", async () => {
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")

    await expect(t.query(api.stores.listAll, {})).rejects.toThrow(
      /Not authenticated/
    )
  })

  test("refuses a customer", async () => {
    // Signing up on the storefront must not become a way to enumerate the
    // establishments their owner has not published.
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")
    const asCustomer = await seedUser(t, "user:c", "customer", [])

    await expect(asCustomer.query(api.stores.listAll, {})).rejects.toThrow(
      /Access denied/
    )
  })

  test("returns the drafts to the owner who has to publish them", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const open = await seedStore(t, "Pizza Open", "open")
    // Both stores are granted to this owner: the point of the test is that a
    // DRAFT is visible to whoever is about to publish it, not that an admin
    // sees establishments they were never given (see #94 below).
    const asOwner = await seedUser(t, "user:a", "client_admin", [draft, open])

    const stores = await asOwner.query(api.stores.listAll, {})

    expect(stores.map((s) => s.name).sort()).toEqual(["Pizza Draft", "Pizza Open"])
  })

  test("is readable by a kitchen role", async () => {
    // The whole admin renders behind `StoreGuard`, which is built from this
    // list — the KDS included. Gating it on `stores:read`, which kitchen and
    // delivery do not hold, would lock the kitchen out of its own screen.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Open", "open")
    const asKitchen = await seedUser(t, "user:k", "kitchen", [storeId])

    await expect(asKitchen.query(api.stores.listAll, {})).resolves.toHaveLength(1)
  })

  // #94: staff-only was ALL this checked. Membership was never applied, so an
  // employee of one restaurant could enumerate every other restaurant its
  // owner runs — name, address, phone, email, hours, delivery radius.
  test("does not show a member the establishments they were never given", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Pizza Mine", "open")
    await seedStore(t, "Pizza Theirs", "open")
    const asKitchen = await seedUser(t, "user:k", "kitchen", [mine])

    const stores = await asKitchen.query(api.stores.listAll, {})

    expect(stores.map((s) => s.name)).toEqual(["Pizza Mine"])
  })

  test("does not widen for a client admin either", async () => {
    // The chain owner's remit is the establishments on their profile, which is
    // the same list `requireStoreAccess` and `assertCanManageMember` read.
    const t = newHarness()
    const mine = await seedStore(t, "Pizza Mine", "open")
    await seedStore(t, "Pizza Theirs", "draft")
    const asAdmin = await seedUser(t, "user:a", "client_admin", [mine])

    await expect(asAdmin.query(api.stores.listAll, {})).resolves.toHaveLength(1)
  })

  test("a super admin still sees the whole chain", async () => {
    // Their remit IS the chain — and on a fresh deployment the first
    // administrator holds no store at all, so scoping them to `storeIds` would
    // leave the back office empty for the one account meant to set it up.
    const t = newHarness()
    await seedStore(t, "Pizza A", "open")
    await seedStore(t, "Pizza B", "draft")
    const asSuper = await seedUser(t, "user:s", "super_admin", [])

    await expect(asSuper.query(api.stores.listAll, {})).resolves.toHaveLength(2)
  })

  test("survives a profile naming an establishment that has been deleted", async () => {
    // One stale id must not blank the whole administration.
    const t = newHarness()
    const kept = await seedStore(t, "Pizza Kept", "open")
    const removed = await seedStore(t, "Pizza Removed", "open")
    const asManager = await seedUser(t, "user:m", "manager", [kept, removed])
    await t.run((ctx) => ctx.db.delete(removed))

    const stores = await asManager.query(api.stores.listAll, {})

    expect(stores.map((s) => s.name)).toEqual(["Pizza Kept"])
  })

  test("does not hand out the printer API key", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Open", "open", {
      printConfig: {
        provider: "star_cloud",
        apiKey: "sk-printer-secret",
        triggers: ["confirmed"],
        paperSize: "80mm",
        enabled: true,
      },
    })
    const asKitchen = await seedUser(t, "user:k", "kitchen", [storeId])

    const [store] = await asKitchen.query(api.stores.listAll, {})

    expect(store?.printConfig).toBeDefined()
    expect(store?.printConfig).not.toHaveProperty("apiKey")
  })
})

// ============================================================================
// The order itself
// ============================================================================

describe("orders.create", () => {
  test("refuses a draft establishment", async () => {
    // The list is what stops a draft being *reached*. This is what stops one
    // being *ordered from*: a tab opened before the owner unpublished the
    // place, a store id left in localStorage, or a direct call all arrive here
    // without ever reading the list.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Draft", "draft")
    const productId = await seedProduct(t, storeId)

    await expect(
      refusalCode(t.mutation(api.orders.create, orderArgs(storeId, productId)))
    ).resolves.toBe("store_not_published")
  })

  test("writes no order and no kitchen ticket when it refuses", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Draft", "draft")
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow()

    const written = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").collect(),
      tickets: await ctx.db.query("kitchenTickets").collect(),
    }))

    expect(written.orders).toEqual([])
    expect(written.tickets).toEqual([])
  })

  test("still takes an order for a published establishment", async () => {
    // The mirror of the test above: the guard must not refuse the customers it
    // exists to protect.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Open", "open")
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(api.orders.create, orderArgs(storeId, productId))

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.storeId).toBe(storeId)
    expect(order?.status).toBe("pending")
  })

  test.each(["closed", "temporarily_unavailable"] as const)(
    "refuses a %s establishment, though it stays published",
    async (status) => {
      // This used to pass an order through, on the reading that a closed
      // restaurant is published and so takes orders for later. It does not:
      // "Fermé" and "Indisponible" are the two ways an owner says "not
      // tonight" from the dashboard, and the storefront already greys out
      // every button on them. Only the browser did — a stale tab, a cart
      // restored from localStorage or a direct call reached the mutation with
      // no page in between (#224).
      //
      // Publication is still the wider rule: both statuses keep the restaurant
      // listed and its menu readable. That is asserted in `stores.list` above.
      const t = newHarness()
      const storeId = await seedStore(t, "Pizza Closed", status)
      const productId = await seedProduct(t, storeId)

      await expect(
        refusalCode(t.mutation(api.orders.create, orderArgs(storeId, productId)))
      ).resolves.toBe("store_not_accepting")

      const written = await t.run((ctx) => ctx.db.query("orders").collect())
      expect(written).toEqual([])
    }
  )
})
