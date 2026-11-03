// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The server must refuse what the kitchen cannot serve.
 *
 * `orders.create` re-fetched every product and recomputed its price, and then
 * accepted everything else: a dish switched off, a sold-out plate, a lunch
 * menu ordered at midnight, a pizza without the size the owner marked
 * required, the same discount option replayed a hundred times, `quantity: -3`.
 * The browser refused most of it — the browser is a courtesy, not a rule. A
 * cart survives an owner switching a dish off, and the mutation is reachable
 * with no page at all.
 *
 * These tests run the real mutation against the real schema, in memory. They
 * are the half `orderLine.test.ts` cannot cover: that the rule is actually
 * wired into the mutation the checkout calls, through the validator that
 * accepts its arguments and the schema that stores its result.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 3 July 2029, 12:00 UTC — 14:00 in Paris, service is on. */
const NOON_UTC = Date.UTC(2029, 6, 3, 12, 0, 0)

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


type ProductOverrides = {
  isActive?: boolean
  price?: number
  stock?: { tracked: boolean; quantity: number; lowStockThreshold: number }
  scheduling?: {
    availableFrom?: string
    availableUntil?: string
    availableDays?: number[]
  }
  options?: Array<{
    id: string
    name: string
    required: boolean
    maxSelections?: number
    choices: Array<{ id: string; name: string; priceModifier: number }>
  }>
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
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
    })
  )
}

/** The kitchen's clock. Every serving window is read against it. */
async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  timezone = "Europe/Paris"
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone,
      taxRate: 0,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOON_UTC,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  overrides: ProductOverrides = {}
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
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
      source: "manual",
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
      ...overrides,
    })
  })
}

/** What the checkout sends: names, no ids, and prices the server ignores. */
function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
  item: {
    quantity?: number
    selectedOptions?: Array<{
      optionName: string
      choiceName?: string
      priceModifier: number
    }>
  } = {}
) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: item.quantity ?? 1,
        unitPrice: 1200,
        selectedOptions: item.selectedOptions ?? [],
        subtotal: 1200,
      },
    ],
    type: "pickup" as const,
  }
}

const SIZE_OPTION = {
  id: "opt_size",
  name: "Taille",
  required: true,
  maxSelections: 1,
  choices: [
    { id: "ch_small", name: "Petite", priceModifier: 0 },
    { id: "ch_large", name: "Grande", priceModifier: 300 },
  ],
}

const EXTRAS_OPTION = {
  id: "opt_extras",
  name: "Suppléments",
  required: false,
  maxSelections: 2,
  choices: [
    { id: "ch_cheese", name: "Extra fromage", priceModifier: 150 },
    { id: "ch_no_onion", name: "Sans oignon", priceModifier: -100 },
  ],
}

beforeEach(() => {
  // Only `Date` is faked: convex-test's own scheduling must keep running.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOON_UTC)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a dish the owner switched off", () => {
  test("is refused, however long the cart has held it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { isActive: false })

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow(/Margherita/)

    // Nothing reached the kitchen either.
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(0)
  })
})

describe("stock", () => {
  test("a sold-out plate is not sent to the kitchen", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 0, lowStockThreshold: 2 },
    })

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow(/épuisé/)
  })

  test("more than the shelf holds is refused", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 2, lowStockThreshold: 1 },
    })

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 3 }))
    ).rejects.toThrow()

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 2 }))
    ).resolves.toBeTruthy()
  })
})

describe("the serving window", () => {
  test("a lunch menu is refused in the evening", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      scheduling: { availableFrom: "11:00", availableUntil: "14:00" },
    })

    vi.setSystemTime(Date.UTC(2029, 6, 3, 20, 0, 0)) // 22:00 in Paris

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow(/pas servi/)
  })

  test("is read on the restaurant's clock, not the server's", async () => {
    // 12:01 UTC is 14:01 in Paris in July. The lunch menu has just closed
    // there, and the server's own clock still says early afternoon.
    const t = newHarness()
    await seedGlobalSettings(t, "Europe/Paris")
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      scheduling: { availableFrom: "11:00", availableUntil: "14:00" },
    })

    vi.setSystemTime(NOON_UTC + 60_000)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow(/pas servi/)
  })

  test("the same instant is inside the window for a restaurant in UTC", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, "UTC")
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      scheduling: { availableFrom: "11:00", availableUntil: "14:00" },
    })

    vi.setSystemTime(NOON_UTC + 60_000)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).resolves.toBeTruthy()
  })
})

describe("required options", () => {
  test("a pizza without its mandatory size is refused", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { options: [SIZE_OPTION] })

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).rejects.toThrow(/Taille/)
  })

  test("the same pizza with the size goes through, priced by the server", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { options: [SIZE_OPTION] })

    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        selectedOptions: [
          // The client's own price modifier is read for nothing.
          { optionName: "Taille", choiceName: "Grande", priceModifier: -5000 },
        ],
      })
    )

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.subtotal).toBe(1500)
    expect(order?.items[0]?.selectedOptions[0]?.choiceId).toBe("ch_large")
  })
})

describe("duplicated options", () => {
  test("a discount option replayed a hundred times is counted once", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      options: [SIZE_OPTION, EXTRAS_OPTION],
    })

    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        selectedOptions: [
          { optionName: "Taille", choiceName: "Petite", priceModifier: 0 },
          ...Array.from({ length: 100 }, () => ({
            optionName: "Suppléments",
            choiceName: "Sans oignon",
            priceModifier: -100,
          })),
        ],
      })
    )

    // 12,00 € − 1,00 €, not 12,00 € − 100,00 €.
    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.subtotal).toBe(1100)
    expect(order?.items[0]?.selectedOptions).toHaveLength(2)
  })
})

describe("quantity", () => {
  test.each([0, -3, 2.5])("%p is refused", async (quantity) => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity }))
    ).rejects.toThrow()
  })
})

describe("an order that is entirely serviceable", () => {
  test("still reaches the kitchen", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      options: [SIZE_OPTION, EXTRAS_OPTION],
      stock: { tracked: true, quantity: 10, lowStockThreshold: 2 },
      scheduling: { availableFrom: "11:00", availableUntil: "23:00" },
    })

    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        quantity: 2,
        selectedOptions: [
          { optionName: "Taille", choiceName: "Grande", priceModifier: 300 },
          { optionName: "Suppléments", choiceName: "Extra fromage", priceModifier: 150 },
        ],
      })
    )

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.subtotal).toBe((1200 + 300 + 150) * 2)

    // The slip goes on the pass when the payment lands, not at checkout (#136).
    await t.run((ctx) =>
      ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
        id: orderId as Id<"orders">,
        paymentStatus: "paid" as const,
      })
    )

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
  })

  test("is unaffected by a store with no global settings row", async () => {
    // A fresh deployment has no settings row at all; the catalogue must still
    // be orderable rather than fall into a window nobody configured.
    const t = newHarness()
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    ).resolves.toBeTruthy()
  })
})
