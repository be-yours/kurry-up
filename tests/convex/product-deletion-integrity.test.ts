// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Deleting a dish, and what points at it.
 *
 * `products.remove` was `await ctx.db.delete(args.id)` and nothing else, while
 * thirteen columns across nine tables pointed at `products`. Two of them —
 * `externalProductMappings.internalProductId` and `favorites.productId` — are
 * required, so the rows survived holding an id that resolves to nothing and
 * could not be repaired field by field. A routine catalogue tidy-up left:
 *
 *  - a Deliveroo mapping that still answered for the deleted PLU, so the
 *    webhook's check counted zero unmatched items and told Deliveroo the order
 *    had synced — for a dish the kitchen no longer has;
 *  - a formule holding a dead id, which `menus.update` re-validates as a whole,
 *    so the owner could not even delete the offending section.
 *
 * The split is by authorship, and these tests pin both halves of it: what the
 * owner wrote refuses, what the machine kept is cleaned up, and the receipt is
 * left exactly as it was.
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

/**
 * Cancel whatever the test left on the scheduler — every catalogue write books
 * a platform menu push at a 5s delay, and a pending job firing against a closed
 * transaction arrives as an unhandled rejection that blames another file. Same
 * guard as `catalogue-scope.test.ts`.
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

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>, name = "Chez Luigi") {
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

async function seedOwner(
  t: ReturnType<typeof convexTest>,
  subject: string,
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role: "client_admin" as const,
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

async function seedCategory(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name: "Desserts",
      slug: "desserts",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  categoryId: Id<"categories">,
  overrides: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name: "Tiramisu",
      slug: "tiramisu",
      price: 600,
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
      ...overrides,
    })
  )
}

function fixedSection(productId: Id<"products">) {
  return {
    sectionId: "s1",
    label: "Dessert",
    type: "fixed" as const,
    required: true,
    minChoices: 1,
    maxChoices: 1,
    allowDuplicates: false,
    sortOrder: 0,
    productId,
  }
}

async function seedMenu(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  sections: unknown[],
  name = "Formule Midi"
) {
  return t.run((ctx) =>
    ctx.db.insert("menus", {
      storeId,
      name,
      price: 1500,
      sections: sections as never,
      isActive: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

// ===========================================================================
// Refused: what the owner wrote
// ===========================================================================

describe("products.remove refuses while owner-authored content names the dish", () => {
  test("a formule that serves it, and says which", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:menu", [store])

    await seedMenu(t, store, [fixedSection(product)])

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/Formule Midi/)

    // Refused means refused: the dish is still on the catalogue.
    expect(await t.run((ctx) => ctx.db.get(product))).not.toBeNull()
  })

  test("a formule that offers it as one choice among several", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const other = await seedProduct(t, store, category, { name: "Panna cotta", slug: "panna-cotta" })
    const asOwner = await seedOwner(t, "user:picks", [store])

    await seedMenu(t, store, [
      {
        sectionId: "s1",
        label: "Dessert au choix",
        type: "pick_products" as const,
        required: true,
        minChoices: 1,
        maxChoices: 1,
        allowDuplicates: false,
        sortOrder: 0,
        productIds: [other, product],
      },
    ])

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/formule/i)
  })

  test("a formule that only adjusts its price", async () => {
    // The deepest reference: required inside an optional array, so there is no
    // field to null out even if a cascade wanted to.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const other = await seedProduct(t, store, category, { name: "Panna cotta", slug: "panna-cotta" })
    const asOwner = await seedOwner(t, "user:adj", [store])

    await seedMenu(t, store, [
      { ...fixedSection(other), priceAdjustments: [{ productId: product, adjustment: 200 }] },
    ])

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/formule/i)
  })

  test("a promotion that gives it away", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:promo", [store])

    await t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId: store,
        name: "Dessert offert",
        triggerMode: "auto" as const,
        discountType: "free_product" as const,
        freeProductId: product,
        scope: "order" as const,
        startDate: NOW,
        endDate: NOW + 86_400_000,
        isActive: true,
        usageCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/Dessert offert/)
  })

  test("a game prize that hands it over", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:prize", [store])

    await t.run((ctx) =>
      ctx.db.insert("prizes", {
        storeId: store,
        name: "Tiramisu gratuit",
        type: "free_product" as const,
        productId: product,
        validityDays: 30,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/Tiramisu gratuit/)
  })

  test("and the refusal lifts once the owner unpicks the dish", async () => {
    // The refusal has to be an instruction, not a dead end. `menus.update`
    // requires at least one section, so the way out is to point the formule at
    // another dish — which is what the message asks for.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const replacement = await seedProduct(t, store, category, {
      name: "Panna cotta",
      slug: "panna-cotta",
    })
    const asOwner = await seedOwner(t, "user:unpick", [store])

    const menuId = await seedMenu(t, store, [fixedSection(product)])

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/Formule Midi/)

    await asOwner.mutation(api.menus.update, {
      id: menuId,
      name: "Formule Midi",
      sections: [fixedSection(replacement)] as never,
    })

    await asOwner.mutation(api.products.remove, { id: product })
    expect(await t.run((ctx) => ctx.db.get(product))).toBeNull()
  })
})

// ===========================================================================
// Cascaded: what the machine kept
// ===========================================================================

describe("products.remove cleans up the rows that mean nothing without the dish", () => {
  test("BLOCKER: Deliveroo can no longer be told a deleted dish synced", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:deliveroo", [store])

    await t.run((ctx) =>
      ctx.db.insert("externalProductMappings", {
        storeId: store,
        platform: "deliveroo" as const,
        internalProductId: product,
        externalId: "PLU-TIRAMISU",
        lastSyncAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asOwner.mutation(api.products.remove, { id: product })

    expect(await t.run((ctx) => ctx.db.query("externalProductMappings").collect())).toEqual([])

    // This is the exact predicate `deliverooWebhook` branches on: a truthy
    // mapping means zero unmatched PLUs, which means `sendSyncStatus(...,
    // "succeeded")` for an order the kitchen cannot cook.
    const seenByTheWebhook = await t.run((ctx) =>
      ctx.runQuery(internal.externalProductMappings.internalGetByExternal, {
        storeId: store,
        externalId: "PLU-TIRAMISU",
        platform: "deliveroo" as const,
      })
    )
    expect(seenByTheWebhook).toBeNull()
  })

  test("and a mapping orphaned by any other route is not answered either", async () => {
    // The delete is not the only way a product can leave the table — a store
    // cascade, a restore, a hand-run mutation all arrive at this same query.
    // The guarantee belongs to the lookup, not only to the caller that has
    // been fixed.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)

    await t.run((ctx) =>
      ctx.db.insert("externalProductMappings", {
        storeId: store,
        platform: "deliveroo" as const,
        internalProductId: product,
        externalId: "PLU-ORPHAN",
        lastSyncAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) => ctx.db.delete(product))

    const seenByTheWebhook = await t.run((ctx) =>
      ctx.runQuery(internal.externalProductMappings.internalGetByExternal, {
        storeId: store,
        externalId: "PLU-ORPHAN",
        platform: "deliveroo" as const,
      })
    )
    expect(seenByTheWebhook).toBeNull()
  })

  test("a customer's favourite goes with the dish", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const kept = await seedProduct(t, store, category, { name: "Panna cotta", slug: "panna-cotta" })
    const asOwner = await seedOwner(t, "user:fav", [store])

    await t.run(async (ctx) => {
      await ctx.db.insert("favorites", {
        userId: "cust:1",
        productId: product,
        storeId: store,
        createdAt: NOW,
      })
      await ctx.db.insert("favorites", {
        userId: "cust:1",
        productId: kept,
        storeId: store,
        createdAt: NOW,
      })
    })

    await asOwner.mutation(api.products.remove, { id: product })

    const left = await t.run((ctx) => ctx.db.query("favorites").collect())
    expect(left).toHaveLength(1)
    expect(left[0]?.productId).toBe(kept)
  })

  test("an imported platform item goes back into the review queue", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:orphan", [store])

    const orphanId = await t.run((ctx) =>
      ctx.db.insert("orphanProducts", {
        storeId: store,
        platform: "deliveroo" as const,
        externalId: "PLU-TIRAMISU",
        name: "Tiramisu",
        price: 600,
        rawData: "{}",
        status: "matched" as const,
        matchedProductId: product,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asOwner.mutation(api.products.remove, { id: product })

    const orphan = await t.run((ctx) => ctx.db.get(orphanId))
    expect(orphan?.status).toBe("pending")
    expect(orphan?.matchedProductId).toBeUndefined()
  })

  test("a twin in another establishment keeps the dish and loses only the link", async () => {
    const t = newHarness()
    const source = await seedStore(t, "Chez Luigi")
    const target = await seedStore(t, "Luigi Bis")
    const sourceCategory = await seedCategory(t, source)
    const targetCategory = await seedCategory(t, target)
    const product = await seedProduct(t, source, sourceCategory)
    const twin = await seedProduct(t, target, targetCategory, { linkedProductId: product })
    const asOwner = await seedOwner(t, "user:twin", [source, target])

    await asOwner.mutation(api.products.remove, { id: product })

    const survivor = await t.run((ctx) => ctx.db.get(twin))
    expect(survivor).not.toBeNull()
    expect(survivor?.linkedProductId).toBeUndefined()
  })
})

// ===========================================================================
// Left alone: the receipt
// ===========================================================================

describe("products.remove leaves the sales record alone", () => {
  test("a past order still says what was sold", async () => {
    // `orders.items[].productId` is history. Rewriting it would falsify the
    // receipt, and the column is already optional for external orders.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:order", [store])

    const orderId = await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId: store,
        orderNumber: "A17",
        customerInfo: { name: "Camille" },
        type: "dine_in" as const,
        status: "completed" as const,
        items: [
          {
            productId: product,
            productName: "Tiramisu",
            quantity: 1,
            unitPrice: 600,
            selectedOptions: [],
            subtotal: 600,
          },
        ],
        subtotal: 600,
        taxAmount: 60,
        total: 660,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asOwner.mutation(api.products.remove, { id: product })

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.items[0]?.productId).toBe(product)
    expect(order?.items[0]?.productName).toBe("Tiramisu")
  })
})

// ===========================================================================
// Unreferenced
// ===========================================================================

describe("products.remove", () => {
  test("deletes a dish nothing points at", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:plain", [store])

    await asOwner.mutation(api.products.remove, { id: product })

    expect(await t.run((ctx) => ctx.db.get(product))).toBeNull()
  })

  test("refuses an id that resolves to nothing", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:gone", [store])

    await t.run((ctx) => ctx.db.delete(product))

    await expect(
      asOwner.mutation(api.products.remove, { id: product })
    ).rejects.toThrow(/not found/i)
  })
})
