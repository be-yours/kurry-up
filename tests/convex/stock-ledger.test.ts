// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Why the stock number changed (#99).
 *
 * WHAT WAS MISSING. `products.stock.quantity` was a number with no history. An
 * owner opening Inventaire saw "3 portions" and had no way to learn whether that
 * was three sold and two cancelled or five sold and four restocked by hand — and
 * when the number is wrong, which it is the first time anybody miscounts, there
 * was nothing to reconcile against.
 *
 * FOUR PATHS MOVE STOCK and each one patched the quantity and said nothing:
 * `orders.create` sells it, `orders.updateStatus` gives it back on a
 * cancellation, `products.updateStock` is an owner retyping it, and
 * `products.toggleStockTracking` turns the number on and off. This file drives
 * all four through the real mutations.
 *
 * WHAT THIS IS NOT. Not a reservation system. The product sells stock when the
 * order is created and gives it back if it is cancelled, which is the honest
 * model for a restaurant where the gap is minutes. The ledger records that
 * model; it does not change it.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
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

afterEach(async () => {
  for (const t of harnesses) {
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

async function seedGlobalSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: "client_admin" | "kitchen",
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

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: { quantity?: number; tracked?: boolean; name?: string } = {}
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Carte",
      slug: "carte",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
      storeId,
      categoryId,
      name: over.name ?? "Margherita",
      slug: "margherita",
      price: 1_200,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      stock: {
        tracked: over.tracked ?? true,
        quantity: over.quantity ?? 10,
        lowStockThreshold: 2,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

const movements = (t: ReturnType<typeof convexTest>, storeId: Id<"stores">) =>
  t.run((ctx) =>
    ctx.db
      .query("stockMovements")
      .withIndex("by_storeId_createdAt", (q) => q.eq("storeId", storeId))
      .collect()
  )

const orderLine = (productId: Id<"products">, quantity = 1) => ({
  productId,
  productName: "Margherita",
  quantity,
  unitPrice: 1_200,
  selectedOptions: [],
  subtotal: 1_200 * quantity,
})

// ============================================================================
// The order path
// ============================================================================

describe("selling stock", () => {
  test("records the sale, with the order that caused it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { quantity: 10 })

    await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [orderLine(productId, 3)],
      type: "pickup" as const,
    })

    const rows = await movements(t, storeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      reason: "sale",
      before: 10,
      after: 7,
      delta: -3,
      productName: "Margherita",
    })
    // The order number, so a row reads without a second lookup.
    expect(rows[0]!.orderNumber).toBeTruthy()
  })

  test("records the restock when the order is cancelled", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { quantity: 10 })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [orderLine(productId, 3)],
      type: "pickup" as const,
    })
    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId as Id<"orders">,
      status: "cancelled" as const,
    })

    const rows = await movements(t, storeId)
    expect(rows.map((r) => r.reason)).toEqual(["sale", "restock"])
    expect(rows[1]).toMatchObject({ before: 7, after: 10, delta: 3 })
  })

  test("says nothing about the diner", async () => {
    /*
     * A sale records the ORDER NUMBER and no `actorId`. The diner is not staff,
     * and putting who bought the last portion into a table the whole team reads
     * would make a dish screen into a purchase history.
     */
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille Dupont", email: "camille@example.fr" },
      items: [orderLine(productId)],
      type: "pickup" as const,
    })

    const rows = await movements(t, storeId)
    expect(rows[0]!.actorId).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain("Camille")
    expect(JSON.stringify(rows)).not.toContain("camille@example.fr")
  })

  test("writes nothing for an untracked dish", async () => {
    // Its number means nothing, so a movement of it would too.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { tracked: false })

    await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [orderLine(productId)],
      type: "pickup" as const,
    })

    expect(await movements(t, storeId)).toEqual([])
  })

  test("records one movement for a dish ordered on two lines", async () => {
    // The quantity is summed per product before the patch, and the ledger
    // follows the patch rather than the lines.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { quantity: 10 })

    await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [orderLine(productId, 2), orderLine(productId, 3)],
      type: "pickup" as const,
    })

    const rows = await movements(t, storeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ before: 10, after: 5, delta: -5 })
  })
})

// ============================================================================
// The manual paths
// ============================================================================

describe("an owner moving stock by hand", () => {
  test("records the correction, and who made it", async () => {
    /*
     * The movement that most needs recording: it is the one with no order behind
     * it, and the one a reconciliation later has to account for.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { quantity: 4 })

    await asOwner.mutation(api.products.updateStock, { id: productId, quantity: 12 })

    const rows = await movements(t, storeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      reason: "adjustment",
      before: 4,
      after: 12,
      delta: 8,
      actorId: "owner",
    })
    expect(rows[0]!.orderNumber).toBeUndefined()
  })

  test("writes nothing when the number did not move", async () => {
    // A patch that sets 4 to 4 is not a movement, and a ledger padded with them
    // is a ledger nobody reads.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { quantity: 4 })

    await asOwner.mutation(api.products.updateStock, { id: productId, quantity: 4 })

    expect(await movements(t, storeId)).toEqual([])
  })

  test("records the tracking switch, even at an unchanged quantity", async () => {
    // The switch IS the movement: the number stops meaning anything until it is
    // turned back on, and a reader needs to see where the ledger went quiet.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { quantity: 4, tracked: true })

    await asOwner.mutation(api.products.toggleStockTracking, {
      id: productId,
      tracked: false,
    })

    const rows = await movements(t, storeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      reason: "tracking_off",
      before: 4,
      after: 4,
      delta: 0,
      actorId: "owner",
    })
  })

  test("writes nothing when the switch was already in that position", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { tracked: true })

    await asOwner.mutation(api.products.toggleStockTracking, {
      id: productId,
      tracked: true,
    })

    expect(await movements(t, storeId)).toEqual([])
  })
})

// ============================================================================
// Reading it back
// ============================================================================

describe("the ledger screen", () => {
  test("answers newest first", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { quantity: 10 })

    await asOwner.mutation(api.products.updateStock, { id: productId, quantity: 8 })
    await asOwner.mutation(api.products.updateStock, { id: productId, quantity: 20 })

    const page = await asOwner.query(api.stockMovements.list, { storeId })
    expect(page.movements.map((m: { after: number }) => m.after)).toEqual([20, 8])
  })

  test("narrows to one dish", async () => {
    // The question an owner actually asks — "where did the six go?" — is about
    // one dish, not about the establishment.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const margherita = await seedProduct(t, storeId, { quantity: 10 })
    const regina = await seedProduct(t, storeId, { quantity: 10, name: "Regina" })

    await asOwner.mutation(api.products.updateStock, { id: margherita, quantity: 8 })
    await asOwner.mutation(api.products.updateStock, { id: regina, quantity: 3 })

    const page = await asOwner.query(api.stockMovements.list, {
      storeId,
      productId: margherita,
    })
    expect(page.movements).toHaveLength(1)
    expect(page.movements[0].productName).toBe("Margherita")
  })

  test("is bounded", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const productId = await seedProduct(t, storeId, { quantity: 100 })

    for (let i = 0; i < 5; i++) {
      await asOwner.mutation(api.products.updateStock, { id: productId, quantity: 90 - i })
    }

    const page = await asOwner.query(api.stockMovements.list, { storeId, numItems: 2 })
    expect(page.movements).toHaveLength(2)
    expect(page.isDone).toBe(false)
  })

  test("does not show another establishment's movements", async () => {
    const t = newHarness()
    const mine = await seedStore(t)
    const theirs = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Sushi Bar",
        slug: "sushi-bar",
        address: { street: "2 rue B", city: "Paris", postalCode: "75011", country: "France" },
        hours: [],
        status: "open" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const asOwner = await seedUser(t, "owner", "client_admin", [mine])

    await expect(
      asOwner.query(api.stockMovements.list, { storeId: theirs })
    ).rejects.toThrow()
  })

  test("is refused to a role without products:read", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    // `kitchen` holds `kitchen:read` and `orders:read`, not `products:read`.
    await expect(
      asKitchen.query(api.stockMovements.list, { storeId })
    ).rejects.toThrow()
  })
})
