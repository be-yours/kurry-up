// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A second establishment's own figures are the ones its orders are checked
 * against (#623).
 *
 * WHAT SHIPPED. Établissements → Réglages offers four overrides, each behind a
 * « Personnalisé » switch, each persisted by `stores.updateOverrides`. The
 * order path read the deployment-wide values unconditionally, and
 * `store.overrides` had exactly ONE reader repo-wide — `resolveStoreServices`,
 * which reads `services` and nothing else. So a multi-location owner set a
 * 40 € minimum for their second restaurant, saw it saved with a badge, and
 * every order there was still checked against the first one's 15 €.
 * `apps/docs/guides/multi-store.md:11` sells per-location pricing by name.
 *
 * These drive the real `orders.create` through the real mutation, because the
 * defect was in the seam between a saved value and the path that should read
 * it — which is exactly what a unit test of the resolver cannot see.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorPayload } from "../../lib/convex-error"

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 3 July 2029, 12:00 UTC — 14:00 in Paris, service is on. */
const NOON_UTC = Date.UTC(2029, 6, 3, 12, 0, 0)

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOON_UTC)
})

afterEach(() => {
  vi.useRealTimers()
})

const OPEN_ALL_WEEK = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: "00:00",
  close: "23:59",
  isClosed: false,
}))

async function seedStore(t: ReturnType<typeof convexTest>, overrides?: Record<string, unknown>) {
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
      hours: OPEN_ALL_WEEK,
      status: "open" as const,
      ...(overrides ? { overrides } : {}),
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
    } as never)
  )
}

async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  settings: Record<string, unknown> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 0,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOON_UTC,
      ...settings,
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
      source: "manual" as const,
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
    } as never)
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

async function refusalCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
    return undefined
  } catch (error) {
    return convexErrorPayload(error)?.code as string | undefined
  }
}

describe("the minimum order", () => {
  test("is the establishment's own when it has set one", async () => {
    // A 12 € basket against a 15 € global and a 25 € override. Before #623 this
    // order went through: the global was the only figure consulted, and 12 € is
    // below both — so the assertion that catches the defect has to be the one
    // where the two disagree in the other direction.
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 1_000 })
    const storeId = await seedStore(t, { minimumOrderAmount: 2_500 })
    const productId = await seedProduct(t, storeId)

    expect(await refusalCode(t.mutation(api.orders.create, orderArgs(storeId, productId)))).toBe(
      "below_minimum",
    )
  })

  test("and the global is ignored when the establishment overrides it downwards", async () => {
    // The mirror case, and the one that proves the override is READ rather than
    // merely also-checked: a 12 € basket, a 25 € global, a 10 € override. It
    // must succeed.
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 2_500 })
    const storeId = await seedStore(t, { minimumOrderAmount: 1_000 })
    const productId = await seedProduct(t, storeId)

    expect(
      await refusalCode(t.mutation(api.orders.create, orderArgs(storeId, productId))),
    ).toBeUndefined()
  })

  test("falls back to the deployment's when the establishment has none", async () => {
    // Anti-vacuity: an override-only reader would take every deployment's
    // minimum out at once.
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 2_500 })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    expect(await refusalCode(t.mutation(api.orders.create, orderArgs(storeId, productId)))).toBe(
      "below_minimum",
    )
  })
})

describe("the delivery fee and the free-delivery threshold", () => {
  test("come from the establishment when it has set them", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, {
      delivery: { feeMode: "fixed" as const, fee: 300, freeAbove: 10_000 },
    })
    const storeId = await seedStore(t, { deliveryFee: 550 })
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(api.orders.create, {
      ...orderArgs(storeId, productId),
      type: "delivery" as const,
      deliveryAddress: {
        street: "2 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
    } as never)

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.deliveryFee).toBe(550)
  })

  test("and the establishment's threshold makes delivery free", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, {
      delivery: { feeMode: "fixed" as const, fee: 300, freeAbove: 10_000 },
    })
    // 12 € basket, 10 € threshold at this restaurant, 100 € globally.
    const storeId = await seedStore(t, { deliveryFreeAbove: 1_000 })
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(api.orders.create, {
      ...orderArgs(storeId, productId),
      type: "delivery" as const,
      deliveryAddress: {
        street: "2 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
    } as never)

    /* `orders.create` stores `deliveryFee` only when it is above zero
       (`orders.ts:1538`), so free delivery is an ABSENT fee rather than a zero
       one. Asserted as absence, and against the total, so the case cannot pass
       because the field was simply never written. */
    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.deliveryFee).toBeUndefined()
    // Prices are tax-inclusive here, so with no fee the total IS the subtotal.
    expect(order?.total).toBe(order?.subtotal)
  })

  test("and without the override the global threshold does not reach, so the fee is charged", async () => {
    // Anti-vacuity for the case above: the free delivery has to come FROM the
    // override, not from the fee being absent for some other reason.
    const t = newHarness()
    await seedGlobalSettings(t, {
      delivery: { feeMode: "fixed" as const, fee: 300, freeAbove: 10_000 },
    })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(api.orders.create, {
      ...orderArgs(storeId, productId),
      type: "delivery" as const,
      deliveryAddress: {
        street: "2 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
    } as never)

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.deliveryFee).toBe(300)
  })
})
