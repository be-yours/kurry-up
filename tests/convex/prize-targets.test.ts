// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A prize that gives something away says what.
 *
 * WHAT WAS BROKEN (#432.7). `prizes.productId` and `prizes.menuId` were declared
 * in the schema and written by nothing:
 *
 *     $ grep -c menuId packages/convex-functions/src/prizes.ts
 *     0
 *
 * Two consequences, and the second is the one a diner meets.
 *
 * THE GUARDS WERE DEAD. `menus.remove` refuses `menu_in_prize` and
 * `products.remove` refuses a dish a prize gives away, and neither refusal could
 * fire outside its own test — no production path could put a prize in that
 * state. Two green guards over a condition nothing could reach, which is the
 * shape of guard this repository has been bitten by more than once.
 *
 * AND THE PRODUCT LET AN OWNER CREATE A LIE. `type` offered « Produit offert »
 * and « Menu offert » while nothing could say WHICH, so a prize read
 * « Menu offert » on the wheel, on the winning screen and on the QR code the
 * diner brought to the counter — and nobody at the counter could tell what had
 * been promised.
 *
 * The schema's own comment named the fix and it is the one the engine already
 * uses for promotions: the rule lives beside the code that enforces it
 * (`HONOURABLE_DISCOUNT_TYPES`), so the two cannot drift.
 *
 * Driven through the registered mutations, because the point is what an owner
 * can and cannot create.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorPayload } from "../../lib/convex-error"

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

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>, slug = "luigi") {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: `Chez ${slug}`,
      slug,
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
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner-1",
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner-1" })
}

async function seedProduct(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Desserts",
      slug: "desserts",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
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
    })
  })
}

async function seedMenu(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("menus", {
      storeId,
      name: "Formule midi",
      price: 1600,
      sections: [],
      isActive: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const basePrize = {
  name: "Dessert offert",
  validityDays: 7,
  isActive: true,
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise
    return { thrown: false as const, payload: null }
  } catch (error) {
    return { thrown: true as const, payload: convexErrorPayload(error) }
  }
}

// ===========================================================================
// What an owner may create
// ===========================================================================

describe("prizes.create", () => {
  test("refuses « Produit offert » with no product", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    const refusal = await refusalOf(
      owner.mutation(api.prizes.create, { ...basePrize, storeId, type: "free_product" })
    )

    expect(refusal.payload?.code).toBe("prize_target_required")
    // The reason, which is the point: it is not a validation nicety.
    expect(refusal.payload?.message).toMatch(/comptoir/)
    expect(await t.run((ctx) => ctx.db.query("prizes").collect())).toHaveLength(0)
  })

  test("refuses « Menu offert » with no formule", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    const refusal = await refusalOf(
      owner.mutation(api.prizes.create, { ...basePrize, storeId, type: "free_menu" })
    )

    expect(refusal.payload?.code).toBe("prize_target_required")
  })

  test("accepts one that names the product", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const productId = await seedProduct(t, storeId)

    await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId,
      type: "free_product",
      productId,
    })

    const [prize] = await t.run((ctx) => ctx.db.query("prizes").collect())
    expect(prize?.productId).toBe(productId)
  })

  test("accepts one that names the formule", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const menuId = await seedMenu(t, storeId)

    await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId,
      type: "free_menu",
      menuId,
    })

    const [prize] = await t.run((ctx) => ctx.db.query("prizes").collect())
    expect(prize?.menuId).toBe(menuId)
  })

  test("refuses a target on a type that has no place for one", async () => {
    // The same lie in the other direction: the screens would render a target
    // the type does not mean.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const menuId = await seedMenu(t, storeId)

    const refusal = await refusalOf(
      owner.mutation(api.prizes.create, {
        ...basePrize,
        storeId,
        type: "discount_percentage",
        value: 10,
        menuId,
      })
    )

    expect(refusal.payload?.code).toBe("prize_target_not_applicable")
  })

  test("refuses another establishment's dish", async () => {
    // A deployment is one client's and may hold several establishments; a prize
    // is redeemed at a counter. The id arrives from the caller, so `storeId` is
    // checked rather than assumed.
    const t = newHarness()
    const here = await seedStore(t, "luigi")
    const elsewhere = await seedStore(t, "gina")
    const owner = await seedOwner(t, [here, elsewhere])
    const theirProduct = await seedProduct(t, elsewhere)

    const refusal = await refusalOf(
      owner.mutation(api.prizes.create, {
        ...basePrize,
        storeId: here,
        type: "free_product",
        productId: theirProduct,
      })
    )

    expect(refusal.payload?.code).toBe("prize_target_not_found")
  })

  test("leaves the types that give nothing away alone", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId,
      type: "discount_percentage",
      value: 10,
    })

    expect(await t.run((ctx) => ctx.db.query("prizes").collect())).toHaveLength(1)
  })
})

describe("prizes.update", () => {
  test("refuses moving a prize onto another establishment's formule", async () => {
    const t = newHarness()
    const here = await seedStore(t, "luigi")
    const elsewhere = await seedStore(t, "gina")
    const owner = await seedOwner(t, [here, elsewhere])
    const mine = await seedMenu(t, here)
    const theirs = await seedMenu(t, elsewhere)

    const prizeId = await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId: here,
      type: "free_menu",
      menuId: mine,
    })

    const refusal = await refusalOf(
      owner.mutation(api.prizes.update, { id: prizeId, menuId: theirs })
    )

    expect(refusal.payload?.code).toBe("prize_target_not_found")
    expect((await t.run((ctx) => ctx.db.get(prizeId)))?.menuId).toBe(mine)
  })

  test("still allows an edit that does not touch the target", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const menuId = await seedMenu(t, storeId)
    const prizeId = await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId,
      type: "free_menu",
      menuId,
    })

    await owner.mutation(api.prizes.update, { id: prizeId, isActive: false })

    const prize = await t.run((ctx) => ctx.db.get(prizeId))
    expect(prize?.isActive).toBe(false)
    expect(prize?.menuId).toBe(menuId)
  })
})

// ===========================================================================
// And now the guards can fire
// ===========================================================================

describe("the delete guards that could not fire before", () => {
  test("menus.remove refuses a formule a prize gives away", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const menuId = await seedMenu(t, storeId)
    await owner.mutation(api.prizes.create, {
      ...basePrize,
      name: "Formule offerte",
      storeId,
      type: "free_menu",
      menuId,
    })

    const refusal = await refusalOf(owner.mutation(api.menus.remove, { id: menuId }))

    // `menu_in_prize` has existed as a refusal for as long as the function has
    // and could not be reached from anywhere until a prize could name a menu.
    expect(refusal.payload?.code).toBe("menu_in_prize")
    expect(refusal.payload?.message).toMatch(/Formule offerte/)
    expect(await t.run((ctx) => ctx.db.get(menuId))).not.toBeNull()
  })

  test("products.remove refuses a dish a prize gives away", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    const productId = await seedProduct(t, storeId)
    await owner.mutation(api.prizes.create, {
      ...basePrize,
      storeId,
      type: "free_product",
      productId,
    })

    const refusal = await refusalOf(owner.mutation(api.products.remove, { id: productId }))

    expect(refusal.thrown).toBe(true)
    expect(await t.run((ctx) => ctx.db.get(productId))).not.toBeNull()
  })
})
