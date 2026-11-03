// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A dine-in order carries the table it is served to (NEW-I-1).
 *
 * "Sur place" was offered in the order-type selector and accepted by the
 * server, and nothing anywhere carried a table number: zero hits in
 * `tables/orders.ts`, zero in `tables/kitchen.ts`, zero across the storefront
 * and the kitchen components. The kitchen slip printed a customer name and
 * nothing else, so staff had a plate and nowhere to take it. The tell was
 * `checkout.tableNumber` — shipped and translated into three languages, and
 * read by no code at all.
 *
 * These run the real mutation against the real schema, and follow the value
 * the whole way: `orders.create` → the order row → `releaseToKitchen` → the
 * kitchen ticket the printer reads.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler — catalogue writes queue a
 * menu sync at a 5s delay, and a job that fires after its transaction closed
 * arrives as an unhandled rejection that fails the run while reporting every
 * test green. Same guard, and same reasoning, as `order-service-types.test.ts`.
 */
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

async function seedGlobalSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 20,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: { feeMode: "fixed" as const, fee: 0 },
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  allergens: string[] = []
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
      price: 1200,
      taxRate: 10,
      images: [],
      options: [],
      allergens,
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

function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
  type: "delivery" | "pickup" | "dine_in",
  extra: Record<string, unknown> = {}
) {
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
    type,
    // Cash, deliberately: `releaseToKitchen` holds a card or PayPal order until
    // its provider confirms (an abandoned Stripe tab must not cook a meal
    // nobody is paying for), while cash has no provider to abandon and falls
    // straight through to the pass. That is the path that produces a ticket.
    paymentMethod: "cash",
    ...(type === "delivery"
      ? {
          deliveryAddress: {
            street: "2 rue de Rivoli",
            city: "Paris",
            postalCode: "75001",
            country: "France",
          },
        }
      : {}),
    ...extra,
  }
}

async function setup(allergens: string[] = []) {
  const t = newHarness()
  await seedGlobalSettings(t)
  const storeId = await seedStore(t)
  const productId = await seedProduct(t, storeId, allergens)
  return { t, storeId, productId }
}

// ============================================================================

describe("orders.create — the table a dine-in order is served to", () => {
  test("stores the table number on the order", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "12" })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.tableNumber).toBe("12")
  })

  test("keeps a label that is not a number", async () => {
    // Real dining rooms use `A3` and `Terrasse 4`. Parsing this as an integer
    // would reject half of them.
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "Terrasse 4" })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.tableNumber).toBe("Terrasse 4")
  })

  test("trims and collapses whitespace", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "  Table   4  " })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.tableNumber).toBe("Table 4")
  })

  test("stores nothing when the value is only whitespace", async () => {
    // An empty string on an order is indistinguishable from a real label until
    // something prints it, and then it prints "TABLE" with nothing after it.
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "   " })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.tableNumber).toBeUndefined()
  })

  test("accepts a dine-in order without a table", async () => {
    // The platform webhooks forward `dine_in` orders that carry no table of
    // their own. Refusing those would lose the order outright, which is worse
    // than a slip with no table on it.
    const { t, storeId, productId } = await setup()

    await t.mutation(api.orders.create, orderArgs(storeId, productId, "dine_in"))

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.type).toBe("dine_in")
    expect(order?.tableNumber).toBeUndefined()
  })

  test("refuses a table number on a delivery order", async () => {
    // Catches the order whose type was switched after the table was typed,
    // which would otherwise print a table on a delivery slip and send a
    // courier looking for it.
    const { t, storeId, productId } = await setup()

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, "delivery", { tableNumber: "12" })
      )
    ).rejects.toThrow(/only be set on a dine_in order/)

    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([])
  })

  test("refuses a table number on a pickup order", async () => {
    const { t, storeId, productId } = await setup()

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, "pickup", { tableNumber: "12" })
      )
    ).rejects.toThrow(/only be set on a dine_in order/)
  })

  test("refuses a label too long to print on a ticket", async () => {
    // A slip is 48mm or 72mm wide and the table is one line of it.
    const { t, storeId, productId } = await setup()

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, "dine_in", { tableNumber: "T".repeat(33) })
      )
    ).rejects.toThrow(/at most 32 characters/)
  })
})

describe("releaseToKitchen — the table reaches the printed slip", () => {
  test("copies the table onto every kitchen ticket the order produces", async () => {
    // This is the assertion the whole item exists for: the cook holding the
    // slip can see which table the plate goes to.
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "A3" })
    )

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets.length).toBeGreaterThan(0)
    for (const ticket of tickets) {
      expect(ticket.orderType).toBe("dine_in")
      expect(ticket.tableNumber).toBe("A3")
    }
  })

  test("leaves the ticket's table unset when the order has none", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(api.orders.create, orderArgs(storeId, productId, "pickup"))

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets.length).toBeGreaterThan(0)
    for (const ticket of tickets) {
      expect(ticket.tableNumber).toBeUndefined()
    }
  })

  test("carries the table and the allergens on the same slip", async () => {
    // The two halves of this fix meet here: a dine-in ticket that says where
    // the plate goes and what is in it.
    const { t, storeId, productId } = await setup(["arachides"])

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, "dine_in", { tableNumber: "7" })
    )

    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticket?.tableNumber).toBe("7")
    expect(ticket?.allergens).toEqual(["arachides"])
  })
})
