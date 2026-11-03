// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The price on the menu is the price charged.
 *
 * The server added VAT on top of it: a pizza shown at 12,00 € was billed
 * 14,40 € at the default rate of 20, under an order summary labelled "TVA
 * incluse". French B2C sale requires the displayed price to be the one paid, so
 * the tax is *extracted* from it — and the amount extracted follows each
 * product's own rate, a field the form has always collected and the order path
 * never read.
 *
 * Stripe charges `order.total` verbatim (`convex/stripe.ts`), so what this file
 * pins is the amount the card is debited.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

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

/** The deployment-wide rate, the one every order used to be taxed at. */
async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  taxRate = 20
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name: string,
  price: number,
  taxRate: number
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Carte",
      slug: `carte-${name.toLowerCase()}`,
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase(),
      price,
      taxRate,
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

function line(productId: Id<"products">, productName: string, price: number) {
  return {
    productId,
    productName,
    quantity: 1,
    unitPrice: price,
    selectedOptions: [],
    subtotal: price,
  }
}

describe("what the customer is charged", () => {
  test("is the price on the menu, at every rate", async () => {
    for (const rate of [0, 5.5, 10, 20]) {
      const t = newHarness()
      await seedGlobalSettings(t, rate)
      const storeId = await seedStore(t)
      const productId = await seedProduct(t, storeId, "Margherita", 1_200, rate)

      const orderId = await t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille" },
        items: [line(productId, "Margherita", 1_200)],
        type: "pickup" as const,
      })

      const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
      expect(order?.total).toBe(1_200)
      expect(order?.subtotal).toBe(1_200)
    }
  })

  test("carries the VAT contained in that price, not added to it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, "Margherita", 1_200, 10)

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [line(productId, "Margherita", 1_200)],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // 12,00 € TTC at 10 % contains 1,09 €. Added on top it was 1,20 €, and the
    // card was debited 13,20 € for a dish advertised at 12,00 €.
    expect(order?.taxAmount).toBe(109)
    expect(order?.total).toBe(1_200)
  })

  test("uses each product's own rate, not one rate for the basket", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const food = await seedProduct(t, storeId, "Menu", 2_400, 10)
    const wine = await seedProduct(t, storeId, "Côtes-du-Rhône", 1_800, 20)

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [line(food, "Menu", 2_400), line(wine, "Côtes-du-Rhône", 1_800)],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // 2,18 € of VAT in the food at 10 %, 3,00 € in the wine at 20 %. Taxed at
    // the single global 10 %, the same basket declared 3,82 €.
    expect(order?.taxAmount).toBe(218 + 300)
    expect(order?.total).toBe(4_200)
  })

  test("adds delivery and subtracts the discount, and nothing else", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, "Margherita", 2_000, 10)

    const promotionId = await t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId,
        name: "Bienvenue",
        triggerMode: "coupon" as const,
        couponCode: "BIENVENUE",
        scope: "order" as const,
        discountType: "percentage" as const,
        discountValue: 10,
        startDate: NOW - 1_000,
        endDate: NOW + 100_000_000_000,
        isActive: true,
        usageCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: [line(productId, "Margherita", 2_000)],
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // 20,00 € − 2,00 € of discount. No tax line in the sum.
    expect(order?.discountAmount).toBe(200)
    expect(order?.total).toBe(1_800)
  })
})
