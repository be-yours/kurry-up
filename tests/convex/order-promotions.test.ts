// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What a promotion actually takes off the order.
 *
 * Four features were configured, stored, and read by no pricing code: the
 * product and category a discount applies to, the hours it runs in, and the
 * automatic offer that needs no code at all. A "−20 % on pizzas" discounted the
 * drinks too; a "Mon–Fri 17:00–19:00" applied on Sunday at 21:00; an "offre
 * automatique" applied never.
 *
 * These run the real mutation against the real schema. The unit tests hold the
 * arithmetic; this holds that `orders.create` hands it what it needs — the
 * lines, and the restaurant's clock.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 3 July 2029, 16:00 UTC — 18:00 in Paris, inside the happy hour. */
const HAPPY_HOUR_UTC = Date.UTC(2029, 6, 3, 16, 0, 0)
/** The same Tuesday at 14:00 Paris — outside it. */
const LUNCH_UTC = Date.UTC(2029, 6, 3, 12, 0, 0)

const SEASON = { start: Date.UTC(2029, 5, 1), end: Date.UTC(2029, 7, 31) }

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
      createdAt: SEASON.start,
      updatedAt: SEASON.start,
    })
  )
}

async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  timezone = "Europe/Paris"
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone,
      taxRate: 10,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: SEASON.start,
    })
  )
}

async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name: string
) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name,
      slug: name.toLowerCase(),
      sortOrder: 0,
      isActive: true,
      createdAt: SEASON.start,
      updatedAt: SEASON.start,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  categoryId: Id<"categories">,
  name: string,
  price: number
) {
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase(),
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
      createdAt: SEASON.start,
      updatedAt: SEASON.start,
    })
  )
}

async function seedPromotion(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  overrides: Record<string, unknown>
) {
  return t.run((ctx) =>
    ctx.db.insert("promotions", {
      storeId,
      name: "Offre",
      triggerMode: "coupon" as const,
      discountType: "percentage" as const,
      discountValue: 20,
      scope: "order" as const,
      startDate: SEASON.start,
      endDate: SEASON.end,
      isActive: true,
      usageCount: 0,
      createdAt: SEASON.start,
      updatedAt: SEASON.start,
      ...overrides,
    })
  )
}

/** A basket of one pizza at 12 € and one drink at 24 € — the reported case. */
async function seedBasket(t: ReturnType<typeof convexTest>) {
  const storeId = await seedStore(t)
  const pizzas = await seedCategory(t, storeId, "Pizzas")
  const drinks = await seedCategory(t, storeId, "Boissons")
  const pizza = await seedProduct(t, storeId, pizzas, "Margherita", 1_200)
  const drink = await seedProduct(t, storeId, drinks, "Coca", 2_400)
  return { storeId, pizzas, drinks, pizza, drink }
}

function items(pizza: Id<"products">, drink: Id<"products">) {
  return [
    {
      productId: pizza,
      productName: "Margherita",
      quantity: 1,
      unitPrice: 1_200,
      selectedOptions: [],
      subtotal: 1_200,
    },
    {
      productId: drink,
      productName: "Coca",
      quantity: 1,
      unitPrice: 2_400,
      selectedOptions: [],
      subtotal: 2_400,
    },
  ]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(HAPPY_HOUR_UTC)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a promotion scoped to part of the menu", () => {
  test("discounts only the products it names", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)

    const promotionId = await seedPromotion(t, storeId, {
      name: "-20 % sur les pizzas",
      couponCode: "PIZZA20",
      scope: "product" as const,
      targetProductIds: [pizza],
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // 20 % of the 12 € pizza. Over the whole basket it took 7,20 €.
    expect(order?.discountAmount).toBe(240)
    expect(order?.total).toBe(3_600 - 240)
  })

  test("discounts only the category it names", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, drinks, pizza, drink } = await seedBasket(t)

    const promotionId = await seedPromotion(t, storeId, {
      name: "-50 % sur les boissons",
      couponCode: "SOIF",
      discountValue: 50,
      scope: "category" as const,
      targetCategoryIds: [drinks],
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(1_200)
  })

  test("is refused when the basket holds none of what it names", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizzas, pizza, drink } = await seedBasket(t)
    const dessert = await seedProduct(t, storeId, pizzas, "Tiramisu", 600)

    const promotionId = await seedPromotion(t, storeId, {
      couponCode: "DESSERT",
      scope: "product" as const,
      targetProductIds: [dessert],
    })

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille", email: "camille@example.com" },
        items: items(pizza, drink),
        type: "pickup" as const,
        promotionId,
      })
    ).rejects.toThrow(/aucun article/)
  })
})

describe("a happy hour", () => {
  const scheduling = {
    activeDays: [1, 2, 3, 4, 5],
    activeTimeFrom: "17:00",
    activeTimeTo: "19:00",
  }

  test("applies inside its hours, on the restaurant's clock", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, "Europe/Paris")
    const { storeId, pizza, drink } = await seedBasket(t)
    const promotionId = await seedPromotion(t, storeId, {
      couponCode: "HAPPY",
      scheduling,
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(720)
  })

  test("is refused outside them", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, "Europe/Paris")
    const { storeId, pizza, drink } = await seedBasket(t)
    const promotionId = await seedPromotion(t, storeId, {
      couponCode: "HAPPY",
      scheduling,
    })

    vi.setSystemTime(LUNCH_UTC)

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille", email: "camille@example.com" },
        items: items(pizza, drink),
        type: "pickup" as const,
        promotionId,
      })
    ).rejects.toThrow(/à cette heure-ci/)
  })

  test("follows the timezone the restaurant is configured with", async () => {
    // 16:00 UTC is 18:00 in Paris and 16:00 in London: the same instant is
    // inside the happy hour in one and outside it in the other.
    const t = newHarness()
    await seedGlobalSettings(t, "UTC")
    const { storeId, pizza, drink } = await seedBasket(t)
    const promotionId = await seedPromotion(t, storeId, {
      couponCode: "HAPPY",
      scheduling,
    })

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille", email: "camille@example.com" },
        items: items(pizza, drink),
        type: "pickup" as const,
        promotionId,
      })
    ).rejects.toThrow(/à cette heure-ci/)
  })
})

describe("an automatic offer", () => {
  test("applies with no code typed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)
    const promotionId = await seedPromotion(t, storeId, {
      name: "Offre du soir",
      triggerMode: "auto" as const,
      discountValue: 10,
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(360)
    expect(order?.promotionId).toBe(promotionId)
    expect(order?.total).toBe(3_600 - 360)
  })

  test("counts its use, like a coupon", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)
    const promotionId = await seedPromotion(t, storeId, {
      triggerMode: "auto" as const,
      discountValue: 10,
    })

    await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
    })

    const promotion = await t.run((ctx) => ctx.db.get(promotionId))
    expect(promotion?.usageCount).toBe(1)
  })

  test("takes the best of several", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)
    await seedPromotion(t, storeId, {
      name: "Petite offre",
      triggerMode: "auto" as const,
      discountValue: 5,
    })
    const generous = await seedPromotion(t, storeId, {
      name: "Grande offre",
      triggerMode: "auto" as const,
      discountValue: 25,
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(900)
    expect(order?.promotionId).toBe(generous)
  })

  test("stands aside for a coupon the customer typed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)
    await seedPromotion(t, storeId, {
      name: "Offre automatique",
      triggerMode: "auto" as const,
      discountValue: 25,
    })
    const coupon = await seedPromotion(t, storeId, {
      name: "Bienvenue",
      couponCode: "BIENVENUE",
      discountValue: 10,
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
      promotionId: coupon,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // One promotion per order, and the customer's own choice wins — even when
    // the automatic offer was worth more.
    expect(order?.promotionId).toBe(coupon)
    expect(order?.discountAmount).toBe(360)
  })

  test("passes over an offer that does not fit, in silence", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const { storeId, pizza, drink } = await seedBasket(t)
    await seedPromotion(t, storeId, {
      name: "Offre du midi",
      triggerMode: "auto" as const,
      scheduling: {
        activeDays: [1, 2, 3, 4, 5],
        activeTimeFrom: "11:00",
        activeTimeTo: "14:00",
      },
    })

    // Nobody asked for it by name, so it must not refuse the order.
    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: items(pizza, drink),
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBeUndefined()
    expect(order?.total).toBe(3_600)
  })
})
