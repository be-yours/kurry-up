// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A shop left in percentage mode without Uber Direct still sells (#161).
 *
 * Percentage pricing bills a share of an Uber Direct quote. The settings page
 * only offers the mode while the integration is on, so nobody chose this state
 * deliberately — it is reached the other way round, by configuring percentage
 * mode and then switching Uber Direct off. That save never mentions delivery,
 * so the mode stayed behind with nothing left to price it.
 *
 * From then on `orders.create` reached the percentage branch, found no
 * `uberDirectEstimateId`, and threw "Un devis de livraison est requis" at every
 * delivery customer. The storefront could not supply one: `decideOrderQuote`
 * returns `kind: "none"` precisely because Uber Direct is off, so no quote was
 * ever requested. The shop was closed to delivery orders and the settings page
 * showed nothing wrong.
 *
 * Both halves are here: the order path honours the mode the shop can actually
 * serve, and the write path stops leaving the orphaned one behind.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Delivery = {
  feeMode?: "fixed" | "percentage"
  fee?: number
  percentage?: number
  maxFee?: number
  freeAbove?: number
}

type Integrations = {
  uberDirect?: { enabled: boolean; customerId?: string }
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
 * Mutations here queue work through `ctx.scheduler.runAfter`. A test finishes
 * in milliseconds and leaves it pending; whatever fires it next writes against
 * a transaction that closed, and because nothing awaits it that arrives as an
 * unhandled rejection — every assertion green and the run still exiting 1,
 * blaming whichever file happened to be running.
 *
 * Cancel rather than run: several of these hand off to actions, and an action
 * has no transaction for convex-test to record its completion in.
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
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})


async function seedSettings(
  t: ReturnType<typeof convexTest>,
  delivery: Delivery,
  integrations: Integrations
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 20,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery,
      integrations,
      updatedAt: NOW,
    })
  )
}

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
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

async function seedProduct(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
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
      price: 1200,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

function deliveryOrder(storeId: Id<"stores">, productId: Id<"products">) {
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
    type: "delivery" as const,
    deliveryAddress: {
      street: "2 rue de Rivoli",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  }
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

async function storedDelivery(t: ReturnType<typeof convexTest>) {
  const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())
  return settings?.delivery
}

// ============================================================================

describe("orders.create — percentage mode with Uber Direct off", () => {
  test("takes the order and charges the fixed fee", async () => {
    // The replay. Before the fix this threw "Un devis de livraison est requis"
    // and the shop could not take a single delivery order.
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "percentage", percentage: 70, fee: 350 },
      { uberDirect: { enabled: false } }
    )
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(
      api.orders.create,
      deliveryOrder(storeId, productId)
    )

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.deliveryFee).toBe(350)
    // Stamped as what was actually applied, so the order does not claim a
    // pricing basis it was never charged on.
    expect(order?.deliveryFeeMode).toBe("fixed")
  })

  test("does the same when the integration was never configured at all", async () => {
    const t = newHarness()
    await seedSettings(t, { feeMode: "percentage", percentage: 70, fee: 350 }, {})
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(
      api.orders.create,
      deliveryOrder(storeId, productId)
    )
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.deliveryFee).toBe(350)
  })

  test("charges nothing when no fixed fee was ever configured", async () => {
    // Percentage mode leaves `fee` unset, so a shop that never used fixed
    // pricing has no amount to fall back to. Free delivery is a poor outcome;
    // refusing every order was a worse one, and the owner can see and fix a
    // fee of zero. Pinned so the fallback is a decision, not a surprise.
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "percentage", percentage: 70 },
      { uberDirect: { enabled: false } }
    )
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(
      api.orders.create,
      deliveryOrder(storeId, productId)
    )
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.deliveryFee).toBeUndefined()
    expect(order?.deliveryFeeMode).toBe("fixed")
  })
})

describe("orders.create — the quote requirement that still holds", () => {
  test("refuses a percentage order with no quote while Uber Direct is on", async () => {
    // The mirror. Falling back to a fixed fee must not become a way to skip
    // the quote: with the integration on, the fee is a share of a quote we
    // issued, and an order without one would be billed from nothing.
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "percentage", percentage: 70, fee: 350 },
      { uberDirect: { enabled: true, customerId: "cus_42" } }
    )
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, deliveryOrder(storeId, productId))
    ).rejects.toThrow(/devis de livraison est requis/)

    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([])
  })
})

describe("globalSettings.upsert — the mode left behind", () => {
  test("drops percentage when the integrations tab switches Uber Direct off", async () => {
    // The save that created the state: it never mentions delivery at all.
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "percentage", percentage: 70, fee: 350 },
      { uberDirect: { enabled: true, customerId: "cus_42" } }
    )
    const asAdmin = await seedAdmin(t)

    await asAdmin.mutation(api.globalSettings.upsert, {
      integrations: { uberDirect: { enabled: false } },
    })

    const delivery = await storedDelivery(t)
    expect(delivery?.feeMode).toBe("fixed")
    // Only the mode gives way; the amounts the owner configured stay put.
    expect(delivery?.fee).toBe(350)
    expect(delivery?.percentage).toBe(70)
  })

  test("refuses to store percentage while Uber Direct is off", async () => {
    const t = newHarness()
    await seedSettings(t, { feeMode: "fixed", fee: 350 }, { uberDirect: { enabled: false } })
    const asAdmin = await seedAdmin(t)

    await asAdmin.mutation(api.globalSettings.upsert, {
      delivery: { feeMode: "percentage", percentage: 70 },
    })

    expect((await storedDelivery(t))?.feeMode).toBe("fixed")
  })

  test("leaves percentage alone when Uber Direct is on", async () => {
    // The mirror. A guard that always wrote "fixed" would pass the two above.
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "fixed", fee: 350 },
      { uberDirect: { enabled: true, customerId: "cus_42" } }
    )
    const asAdmin = await seedAdmin(t)

    await asAdmin.mutation(api.globalSettings.upsert, {
      delivery: { feeMode: "percentage", percentage: 70 },
    })

    expect((await storedDelivery(t))?.feeMode).toBe("percentage")
  })

  test("keeps percentage when the integrations tab saves with Uber Direct still on", async () => {
    const t = newHarness()
    await seedSettings(
      t,
      { feeMode: "percentage", percentage: 70 },
      { uberDirect: { enabled: true, customerId: "cus_42" } }
    )
    const asAdmin = await seedAdmin(t)

    await asAdmin.mutation(api.globalSettings.upsert, {
      integrations: { uberEats: { enabled: true } },
    })

    expect((await storedDelivery(t))?.feeMode).toBe("percentage")
  })
})
