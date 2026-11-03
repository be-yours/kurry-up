// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The diner's note reaches the kitchen (#376, item 1).
 *
 * Everything on this path existed except the beginning of it: `orders.create`
 * has always taken `notes`, the order row has always carried it,
 * `releaseToKitchen` has always copied it onto the ticket, and the printed
 * slip has always had a line for it. `grep -c notes checkout-form.tsx`
 * answered 0 — in both apps, byte-identically — so the line was forever blank
 * and a diner with a nut allergy had nowhere to say so. Food safety, not
 * convenience.
 *
 * These run the real mutation against the real schema and follow the value the
 * whole way: `orders.create` → the order row → `releaseToKitchen` → the
 * kitchen ticket the printer and the kitchen screen read. The storefront half
 * — that a field exists and hands the page this value — is pinned in
 * `tests/storefront/checkout-notes.test.tsx`.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { FIELD_LIMITS } from "@be-yours/convex-functions/rateLimit"
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
 * Cancel whatever the test left on the scheduler — a job that fires after its
 * transaction closed arrives as an unhandled rejection that fails the run
 * while reporting every test green. Same guard as `order-table-number`.
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
  storeId: Id<"stores">
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

function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
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
    type: "pickup" as const,
    // Cash: `releaseToKitchen` holds a card or PayPal order until its provider
    // confirms, while cash falls straight through to the pass. That is the
    // path that produces a ticket.
    paymentMethod: "cash",
    ...extra,
  }
}

async function setup() {
  const t = newHarness()
  await seedGlobalSettings(t)
  const storeId = await seedStore(t)
  const productId = await seedProduct(t, storeId)
  return { t, storeId, productId }
}

// ============================================================================

describe("orders.create — the note the diner wrote", () => {
  test("stores it on the order", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        notes: "Allergie aux arachides — sauce à part",
      })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.notes).toBe("Allergie aux arachides — sauce à part")
  })

  test("accepts an order without one", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(api.orders.create, orderArgs(storeId, productId))

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.notes).toBeUndefined()
  })

  test("refuses a note longer than the cap the storefront enforces", async () => {
    // The input's `maxLength` reads this same constant, so the two cannot
    // disagree — a note the field accepted and the server refused would fail
    // at the moment of payment, which is the worst place to find out.
    const { t, storeId, productId } = await setup()

    await expect(
      t.mutation(
        api.orders.create,
        orderArgs(storeId, productId, {
          notes: "a".repeat(FIELD_LIMITS.orderNote + 1),
        })
      )
    ).rejects.toThrow(/orderNote/)

    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([])
  })

  test("accepts a note exactly at the cap", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, {
        notes: "a".repeat(FIELD_LIMITS.orderNote),
      })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order?.notes).toHaveLength(FIELD_LIMITS.orderNote)
  })
})

describe("releaseToKitchen — the note reaches the cook", () => {
  test("copies it onto every ticket the order produces", async () => {
    // The assertion this whole item exists for: what the diner typed is in
    // front of the person cooking the dish.
    const { t, storeId, productId } = await setup()

    await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { notes: "Allergie aux arachides" })
    )

    const tickets = await t.run((ctx) =>
      ctx.db.query("kitchenTickets").collect()
    )
    expect(tickets.length).toBeGreaterThan(0)
    for (const ticket of tickets) {
      expect(ticket.deliveryNotes).toBe("Allergie aux arachides")
    }
  })

  test("leaves the ticket's note empty when the diner wrote none", async () => {
    const { t, storeId, productId } = await setup()

    await t.mutation(api.orders.create, orderArgs(storeId, productId))

    const tickets = await t.run((ctx) =>
      ctx.db.query("kitchenTickets").collect()
    )
    expect(tickets.length).toBeGreaterThan(0)
    for (const ticket of tickets) {
      expect(ticket.deliveryNotes).toBeUndefined()
    }
  })
})
