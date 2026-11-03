// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The catalogue belongs to one establishment at a time.
 *
 * Every id in this domain is public — the catalogue *is* the storefront, and
 * `products.list` and `categories.list` are open by design. Open, not
 * unfiltered: since #443 they answer with what is ON SALE, and the drafts moved
 * to the store-scoped `listAll` (see draft-catalogue-is-private.test.ts). The writes were
 * scoped to the store named in the arguments and then followed a reference out
 * of it: propagation patched twins in restaurants the caller does not
 * administer, a platform mapping was found by product alone and overwritten,
 * a product could be filed under another restaurant's category, a combo built
 * from another restaurant's dishes, an imported item matched to a product the
 * caller has never seen.
 *
 * These tests run the real mutations against the real schema, in memory. They
 * pin the refusals, and the mirrors: the owner of both establishments may
 * still do all of it.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Role =
  | "super_admin"
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "delivery"
  | "customer"

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


async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
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

async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name = "Pizzas"
) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name,
      slug: name.toLowerCase(),
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
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  )
}

// ============================================================================
// Propagation across stores
// ============================================================================

describe("products.updateWithPropagation", () => {
  test("refuses to write into a store the caller does not administer", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")

    const mineCat = await seedCategory(t, mine)
    const theirsCat = await seedCategory(t, theirs)
    const root = await seedProduct(t, mine, mineCat)
    const twin = await seedProduct(t, theirs, theirsCat, {
      linkedProductId: root,
      name: "Margherita (Marco)",
      price: 1400,
    })

    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.products.updateWithPropagation, {
        productId: root,
        updates: { price: 100 },
        scope: "all",
      })
    ).rejects.toThrow(/Access denied/)

    // And the other restaurant's price is untouched.
    const untouched = await t.run((ctx) => ctx.db.get(twin))
    expect(untouched?.price).toBe(1400)
  })

  test("lets the owner of both establishments propagate", async () => {
    const t = newHarness()
    const a = await seedStore(t, "Chez Luigi")
    const b = await seedStore(t, "Luigi Bis")
    const aCat = await seedCategory(t, a)
    const bCat = await seedCategory(t, b)
    const root = await seedProduct(t, a, aCat)
    const twin = await seedProduct(t, b, bCat, { linkedProductId: root })

    const asOwner = await seedUser(t, "user:a1", "client_admin", [a, b])

    // `storeIds` is what the wrapper schedules the platform menu push against:
    // both establishments here, and no others. A propagation that reported only
    // the named product's store would leave every twin stale on Uber Eats and
    // Deliveroo the moment the sync stopped sweeping every restaurant.
    await expect(
      asOwner.mutation(api.products.updateWithPropagation, {
        productId: root,
        updates: { price: 1500 },
        scope: "all",
      })
    ).resolves.toEqual({ updated: 2, storeIds: [a, b] })

    const updated = await t.run((ctx) => ctx.db.get(twin))
    expect(updated?.price).toBe(1500)
  })

  test("refuses a negative price, like every other write does", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const productId = await seedProduct(t, store, categoryId)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await expect(
      asOwner.mutation(api.products.updateWithPropagation, {
        productId,
        updates: { price: -500 },
        scope: "self",
      })
    ).rejects.toThrow(/negative/)

    const untouched = await t.run((ctx) => ctx.db.get(productId))
    expect(untouched?.price).toBe(1200)
  })
})

// ============================================================================
// Platform mappings
// ============================================================================

describe("externalProductMappings.upsert", () => {
  test("refuses a product that belongs to another store", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirsCat = await seedCategory(t, theirs)
    const theirProduct = await seedProduct(t, theirs, theirsCat)

    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.externalProductMappings.upsert, {
        storeId: mine,
        platform: "uberEats" as const,
        internalProductId: theirProduct,
        externalId: "uber-1",
      })
    ).rejects.toThrow(/another store/)
  })

  test("cannot overwrite a mapping another store already owns", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirsCat = await seedCategory(t, theirs)
    const theirProduct = await seedProduct(t, theirs, theirsCat)

    await t.run((ctx) =>
      ctx.db.insert("externalProductMappings", {
        storeId: theirs,
        platform: "uberEats" as const,
        internalProductId: theirProduct,
        externalId: "their-uber-item",
        lastSyncAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.externalProductMappings.upsert, {
        storeId: mine,
        platform: "uberEats" as const,
        internalProductId: theirProduct,
        externalId: "my-uber-item",
      })
    ).rejects.toThrow(/another store/)

    const mapping = await t.run((ctx) =>
      ctx.db.query("externalProductMappings").first()
    )
    expect(mapping?.externalId).toBe("their-uber-item")
  })

  test("still maps a product of its own store", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, mine)
    const productId = await seedProduct(t, mine, categoryId)
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.externalProductMappings.upsert, {
        storeId: mine,
        platform: "uberEats" as const,
        internalProductId: productId,
        externalId: "uber-1",
      })
    ).resolves.toBeTruthy()
  })
})

// ============================================================================
// Copying a catalogue
// ============================================================================

describe("products.duplicateCatalog", () => {
  test("copies a catalogue that actually has categories", async () => {
    // The insert wrote `image` — not a column — and omitted the required
    // `createdAt`/`updatedAt`, so this threw on every real catalogue. The
    // existing authorisation test passed only because its source store was
    // empty.
    const t = newHarness()
    const source = await seedStore(t, "Chez Luigi")
    const target = await seedStore(t, "Luigi Bis")
    const categoryId = await seedCategory(t, source, "Pizzas")
    await seedProduct(t, source, categoryId)

    const asOwner = await seedUser(t, "user:a1", "client_admin", [source, target])

    await expect(
      asOwner.mutation(api.products.duplicateCatalog, {
        sourceStoreId: source,
        targetStoreId: target,
      })
    ).resolves.toEqual({ categoriesCreated: 1, productsCreated: 1 })

    const copiedCategory = await t.run((ctx) =>
      ctx.db
        .query("categories")
        .withIndex("by_storeId", (q) => q.eq("storeId", target))
        .first()
    )
    expect(copiedCategory?.name).toBe("Pizzas")
    expect(copiedCategory?.createdAt).toBeTypeOf("number")

    const copiedProduct = await t.run((ctx) =>
      ctx.db
        .query("products")
        .withIndex("by_storeId", (q) => q.eq("storeId", target))
        .first()
    )
    expect(copiedProduct?.categoryId).toBe(copiedCategory?._id)
  })

  test("carries the category image across", async () => {
    const t = newHarness()
    const source = await seedStore(t, "Chez Luigi")
    const target = await seedStore(t, "Luigi Bis")
    await t.run((ctx) =>
      ctx.db.insert("categories", {
        storeId: source,
        name: "Desserts",
        slug: "desserts",
        imageUrl: "https://example.test/desserts.jpg",
        sortOrder: 1,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const asOwner = await seedUser(t, "user:a1", "client_admin", [source, target])
    await asOwner.mutation(api.products.duplicateCatalog, {
      sourceStoreId: source,
      targetStoreId: target,
    })

    const copied = await t.run((ctx) =>
      ctx.db
        .query("categories")
        .withIndex("by_storeId", (q) => q.eq("storeId", target))
        .first()
    )
    expect(copied?.imageUrl).toBe("https://example.test/desserts.jpg")
  })
})

// ============================================================================
// Deleting a category
// ============================================================================

describe("categories.remove", () => {
  test("refuses while the category still holds products", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const productId = await seedProduct(t, store, categoryId)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await expect(
      asOwner.mutation(api.categories.remove, { id: categoryId })
    ).rejects.toThrow(/1 produit/)

    // The product keeps a category that exists, rather than a dead id.
    const category = await t.run((ctx) => ctx.db.get(categoryId))
    expect(category).not.toBeNull()
    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.categoryId).toBe(categoryId)
  })

  test("deletes an empty category", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await expect(
      asOwner.mutation(api.categories.remove, { id: categoryId })
    ).resolves.toBeNull()

    expect(await t.run((ctx) => ctx.db.get(categoryId))).toBeNull()
  })

  test("counts only the products of that category", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const pizzas = await seedCategory(t, store, "Pizzas")
    const desserts = await seedCategory(t, store, "Desserts")
    await seedProduct(t, store, pizzas)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await expect(
      asOwner.mutation(api.categories.remove, { id: desserts })
    ).resolves.toBeNull()
  })
})

// ============================================================================
// A product's category
// ============================================================================

describe("a product's category", () => {
  test("cannot be created under another store's category", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirCategory = await seedCategory(t, theirs)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    await expect(
      asOwner.mutation(api.products.create, {
        storeId: mine,
        categoryId: theirCategory,
        name: "Margherita",
        slug: "margherita",
        price: 1200,
        taxRate: 10,
        images: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
      })
    ).rejects.toThrow(/another store/)
  })

  test("cannot be moved to another store's category", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const mineCat = await seedCategory(t, mine)
    const theirCategory = await seedCategory(t, theirs)
    const productId = await seedProduct(t, mine, mineCat)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    await expect(
      asOwner.mutation(api.products.update, {
        id: productId,
        categoryId: theirCategory,
      })
    ).rejects.toThrow(/another store/)
  })

  test("is still free to move inside its own store", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const pizzas = await seedCategory(t, store, "Pizzas")
    const desserts = await seedCategory(t, store, "Desserts")
    const productId = await seedProduct(t, store, pizzas)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await asOwner.mutation(api.products.update, {
      id: productId,
      categoryId: desserts,
    })

    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.categoryId).toBe(desserts)
  })
})

// ============================================================================
// Menus
// ============================================================================

describe("menus", () => {
  const section = (overrides: Record<string, unknown>) => ({
    sectionId: "s1",
    label: "Le plat",
    type: "fixed" as const,
    required: true,
    minChoices: 1,
    maxChoices: 1,
    allowDuplicates: false,
    sortOrder: 0,
    ...overrides,
  })

  test("cannot be built from another store's product", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirCat = await seedCategory(t, theirs)
    const theirProduct = await seedProduct(t, theirs, theirCat)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    await expect(
      asOwner.mutation(api.menus.create, {
        storeId: mine,
        name: "Formule midi",
        price: 1500,
        sections: [section({ productId: theirProduct })],
        isActive: true,
        sortOrder: 0,
      })
    ).rejects.toThrow(/another store/)
  })

  test("cannot pick from another store's category", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirCat = await seedCategory(t, theirs)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    await expect(
      asOwner.mutation(api.menus.create, {
        storeId: mine,
        name: "Formule midi",
        price: 1500,
        sections: [
          section({
            sectionId: "s2",
            label: "Une boisson",
            type: "pick_category" as const,
            categoryId: theirCat,
          }),
        ],
        isActive: true,
        sortOrder: 0,
      })
    ).rejects.toThrow(/another store/)
  })

  test("is still built from its own catalogue", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const productId = await seedProduct(t, store, categoryId)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await expect(
      asOwner.mutation(api.menus.create, {
        storeId: store,
        name: "Formule midi",
        price: 1500,
        sections: [section({ productId })],
        isActive: true,
        sortOrder: 0,
      })
    ).resolves.toBeTruthy()
  })

  test("cannot be edited to point at another store's product", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const mineCat = await seedCategory(t, mine)
    const theirCat = await seedCategory(t, theirs)
    const mineProduct = await seedProduct(t, mine, mineCat)
    const theirProduct = await seedProduct(t, theirs, theirCat)
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    const menuId = await asOwner.mutation(api.menus.create, {
      storeId: mine,
      name: "Formule midi",
      price: 1500,
      sections: [section({ productId: mineProduct })],
      isActive: true,
      sortOrder: 0,
    })

    await expect(
      asOwner.mutation(api.menus.update, {
        id: menuId,
        sections: [section({ productId: theirProduct })],
      })
    ).rejects.toThrow(/another store/)
  })
})

// ============================================================================
// Orphan products
// ============================================================================

describe("orphanProducts.match", () => {
  async function seedOrphan(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">
  ) {
    return t.run((ctx) =>
      ctx.db.insert("orphanProducts", {
        storeId,
        platform: "uberEats" as const,
        externalId: "uber-1",
        name: "Pizza inconnue",
        price: 1200,
        rawData: "{}",
        status: "pending" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  test("refuses a product from another store", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const theirCat = await seedCategory(t, theirs)
    const theirProduct = await seedProduct(t, theirs, theirCat)
    const orphanId = await seedOrphan(t, mine)
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await expect(
      asManager.mutation(api.orphanProducts.match, {
        id: orphanId,
        matchedProductId: theirProduct,
      })
    ).rejects.toThrow(/another store/)
  })

  test("matches a product of its own store", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, mine)
    const productId = await seedProduct(t, mine, categoryId)
    const orphanId = await seedOrphan(t, mine)
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    await asManager.mutation(api.orphanProducts.match, {
      id: orphanId,
      matchedProductId: productId,
    })

    const orphan = await t.run((ctx) => ctx.db.get(orphanId))
    expect(orphan?.status).toBe("matched")
  })
})

// ============================================================================
// Ordering the catalogue
// ============================================================================

describe("products.reorder", () => {
  test("writes the position of each product", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const first = await seedProduct(t, store, categoryId, { slug: "a" })
    const second = await seedProduct(t, store, categoryId, { slug: "b" })
    const third = await seedProduct(t, store, categoryId, { slug: "c" })
    const asOwner = await seedUser(t, "user:a1", "client_admin", [store])

    await asOwner.mutation(api.products.reorder, {
      storeId: store,
      ids: [third, first, second],
    })

    const orders = await t.run(async (ctx) => ({
      first: (await ctx.db.get(first))?.sortOrder,
      second: (await ctx.db.get(second))?.sortOrder,
      third: (await ctx.db.get(third))?.sortOrder,
    }))
    expect(orders).toEqual({ third: 0, first: 1, second: 2 })
  })

  test("refuses a product from another store, and writes nothing", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const mineCat = await seedCategory(t, mine)
    const theirCat = await seedCategory(t, theirs)
    const mineProduct = await seedProduct(t, mine, mineCat)
    const theirProduct = await seedProduct(t, theirs, theirCat, { sortOrder: 7 })
    const asOwner = await seedUser(t, "user:a1", "client_admin", [mine])

    await expect(
      asOwner.mutation(api.products.reorder, {
        storeId: mine,
        ids: [theirProduct, mineProduct],
      })
    ).rejects.toThrow(/same store/)

    const untouched = await t.run((ctx) => ctx.db.get(theirProduct))
    expect(untouched?.sortOrder).toBe(7)
  })

  test("refuses a role without products:write", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi")
    const categoryId = await seedCategory(t, store)
    const productId = await seedProduct(t, store, categoryId)
    const asKitchen = await seedUser(t, "user:k1", "kitchen", [store])

    await expect(
      asKitchen.mutation(api.products.reorder, {
        storeId: store,
        ids: [productId],
      })
    ).rejects.toThrow(/Access denied/)
  })
})
