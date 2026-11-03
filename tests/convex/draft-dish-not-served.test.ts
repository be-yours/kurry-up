// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * `isActive: false` means the dish is not on sale, and the public queries say so.
 *
 * WHAT WAS BROKEN (#443). `products.list` returned every row of the table and
 * `products.getById` returned any document whose id you held, both to anyone,
 * with no account. A dish the owner had not published was therefore on the
 * public carte, on its own `/product/<id>` page, and in the JSON-LD of that
 * page — and then refused at the checkout, because `orders.create` has always
 * checked. The diner met the refusal, not the draft.
 *
 * `sitemap.ts` and `structured-data.ts` had each grown their own `isActive`
 * filter downstream, which is why the hole was easy to mistake for closed: the
 * two surfaces that had been noticed were patched and the query underneath
 * them was not, so the menu page — which had no filter of its own — kept
 * serving drafts. The filter belongs in the query, once, where nothing new can
 * be built on top of it and forget.
 *
 * AND THE OTHER HALF. The owner still has to see their own drafts, so each
 * public query has a guarded counterpart (`listAll`, `getAnyById`) that a
 * signed-in account with `products:read` can call and an anonymous visitor
 * cannot. Both halves are tested here: a filter that also hid the catalogue
 * from the person writing it would not be a fix.
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
 * Catalogue writes queue a menu sync at `runAfter(5s)`. Left pending they fire
 * against a closed transaction and surface as an unhandled rejection that
 * reddens whichever file is running at the time — see the long note in
 * `catalogue-scope.test.ts`, which reached this the hard way.
 */
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

async function seedOwner(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner-1",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner-1" })
}

async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name: string,
  isActive: boolean
) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name,
      slug: name.toLowerCase(),
      sortOrder: 0,
      isActive,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  categoryId: Id<"categories">,
  name: string,
  isActive: boolean
) {
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase(),
      price: 1200,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedCatalogue(t: ReturnType<typeof convexTest>) {
  const storeId = await seedStore(t)
  const onSale = await seedCategory(t, storeId, "Pizzas", true)
  const retired = await seedCategory(t, storeId, "Hiver", false)
  const published = await seedProduct(t, storeId, onSale, "Margherita", true)
  const draft = await seedProduct(t, storeId, onSale, "Truffe", false)
  return { storeId, onSale, retired, published, draft }
}

describe("what an anonymous visitor is served", () => {
  test("products.list leaves out a dish that is not on sale", async () => {
    const t = newHarness()
    const { storeId } = await seedCatalogue(t)

    const names = (await t.query(api.products.list, { storeId })).map((p) => p.name)

    expect(names).toEqual(["Margherita"])
    expect(names).not.toContain("Truffe")
  })

  test("products.getById answers nothing for a draft, holding its id", async () => {
    const t = newHarness()
    const { draft, published } = await seedCatalogue(t)

    // An id is not a secret: it is in the DOM of the page that linked here.
    expect(await t.query(api.products.getById, { id: draft })).toBeNull()
    // And the published one still resolves, or the fix would be a 404 machine.
    expect(await t.query(api.products.getById, { id: published })).not.toBeNull()
  })

  test("categories.list leaves out a section the owner switched off", async () => {
    const t = newHarness()
    const { storeId } = await seedCatalogue(t)

    const names = (await t.query(api.categories.list, { storeId })).map((c) => c.name)

    expect(names).toEqual(["Pizzas"])
  })

  test("the owner's own catalogue queries refuse an anonymous caller", async () => {
    const t = newHarness()
    const { storeId, draft } = await seedCatalogue(t)

    // Filtering the public query would be worthless if the unfiltered one
    // beside it answered anyone who asked for it by name.
    await expect(t.query(api.products.listAll, { storeId })).rejects.toThrow()
    await expect(t.query(api.categories.listAll, { storeId })).rejects.toThrow()
    await expect(t.query(api.menus.list, { storeId })).rejects.toThrow()
    await expect(t.query(api.products.getAnyById, { id: draft })).rejects.toThrow()
  })
})

describe("what the owner is served", () => {
  test("listAll returns the whole catalogue, drafts included", async () => {
    const t = newHarness()
    const { storeId } = await seedCatalogue(t)
    const owner = await seedOwner(t, storeId)

    const products = (await owner.query(api.products.listAll, { storeId })).map((p) => p.name)
    const categories = (await owner.query(api.categories.listAll, { storeId })).map((c) => c.name)

    expect(products.sort()).toEqual(["Margherita", "Truffe"])
    expect(categories.sort()).toEqual(["Hiver", "Pizzas"])
  })

  test("getAnyById opens a draft, which is the point of a draft", async () => {
    const t = newHarness()
    const { storeId, draft } = await seedCatalogue(t)
    const owner = await seedOwner(t, storeId)

    const product = await owner.query(api.products.getAnyById, { id: draft })

    expect(product).not.toBeNull()
    expect(product!.name).toBe("Truffe")
    expect(product!.isActive).toBe(false)
  })
})
