// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The configuration of a withdrawn offer type is not writable.
 *
 * WHAT WENT WRONG (#403, then #414 P5-F4). #403 withdrew « Produit offert » and
 * « Offre BOGO » as discount TYPES — `assertHonourableDiscountType` refuses
 * them on create and on update — and took their inputs off the promotion form.
 * It left their five configuration fields on both args validators:
 * `freeProductId`, `bogoTriggerProductId`, `bogoRewardProductId`,
 * `bogoTriggerQuantity`, `bogoRewardQuantity`. Both handlers spread `args`
 * straight into the row, so all five reached the database unexamined.
 *
 * That was not inert. `products.remove` reads the first three to refuse
 * deleting a dish a promotion still points at, so an ordinary `percentage`
 * promotion given a `freeProductId` made that dish undeletable — and the
 * refusal named a promotion that used the product in no way the owner could
 * see, on a form that renders none of the five, through an `update` that has no
 * way to clear an optional field. There was no route back.
 *
 * The unit tests in `@be-yours/convex-functions` hold the type refusal;
 * this holds the args, because a validator is only exercised through the real
 * mutation. `packages/admin/src/__tests__/promotion-discount-types.test.ts`
 * held the form and not the server, which is exactly how the server half
 * survived the cleanup.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import {
  WITHDRAWN_PROMOTION_CONFIG_FIELDS,
  WITHDRAWN_PROMOTION_PRODUCT_FIELDS,
} from "@be-yours/convex-functions/promotionDiscount"
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
 * Cancel whatever the test left on the scheduler — every catalogue write books
 * a platform menu push at a 5s delay, and a pending job firing against a closed
 * transaction arrives as an unhandled rejection that blames another file. Same
 * guard as `product-deletion-integrity.test.ts`.
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
  name = "Tiramisu"
) {
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase(),
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
  )
}

function promotionArgs(storeId: Id<"stores">, overrides: Record<string, unknown> = {}) {
  return {
    storeId,
    name: "Offre du soir",
    triggerMode: "coupon" as const,
    couponCode: "SOIR",
    discountType: "percentage" as const,
    discountValue: 10,
    scope: "order" as const,
    startDate: NOW - 1_000,
    endDate: NOW + 1_000_000,
    isActive: true,
    ...overrides,
  }
}

/** The value each field would carry: an id for the three, a count for the two. */
function sampleFor(field: string, productId: Id<"products">): unknown {
  return field.endsWith("Quantity") ? 2 : productId
}

/**
 * The `{ code, message }` a refusal carries.
 *
 * `convex-test` hands `ConvexError.data` back as a JSON STRING where the
 * browser client hands back the object — the same split `packages/admin`'s
 * `convexErrorPayload` handles, and the reason a test that reads `err.data.code`
 * directly reports `undefined` and proves nothing.
 */
async function refusal(
  run: Promise<unknown>
): Promise<{ code?: string; message: string }> {
  try {
    await run
  } catch (caught) {
    const raw = (caught as { data?: unknown }).data
    const data = typeof raw === "string" ? JSON.parse(raw) : raw
    if (data && typeof data === "object") {
      return {
        code: (data as { code?: string }).code,
        message: (data as { message?: string }).message ?? "",
      }
    }
    return { message: (caught as Error).message ?? "" }
  }
  throw new Error("expected the delete to be refused, but it went through")
}

// ===========================================================================
// The args
// ===========================================================================

describe("promotions.create refuses the withdrawn configuration", () => {
  test.each(WITHDRAWN_PROMOTION_CONFIG_FIELDS)(
    "%s, on an ordinary percentage promotion",
    async (field) => {
      const t = newHarness()
      const store = await seedStore(t)
      const category = await seedCategory(t, store)
      const product = await seedProduct(t, store, category)
      const asOwner = await seedOwner(t, `user:create:${field}`, [store])

      // The refusal is the validator's: a Convex mutation rejects an argument
      // no validator declares, which is why taking the five off `args` is the
      // whole guard and no handler check is needed.
      await expect(
        asOwner.mutation(
          api.promotions.create,
          promotionArgs(store, { [field]: sampleFor(field, product) }) as never
        )
      ).rejects.toThrow(new RegExp(`Unexpected field \`?${field}\`?`))

      // Refused means nothing was written.
      const rows = await t.run((ctx) => ctx.db.query("promotions").collect())
      expect(rows).toEqual([])
    }
  )

  test("still creates a promotion that carries none of them", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:create:clean", [store])

    const id = await asOwner.mutation(api.promotions.create, promotionArgs(store))
    const stored = await t.run((ctx) => ctx.db.get(id))

    expect(stored?.discountType).toBe("percentage")
    for (const field of WITHDRAWN_PROMOTION_CONFIG_FIELDS) {
      expect((stored as Record<string, unknown>)[field]).toBeUndefined()
    }
  })
})

describe("promotions.update refuses the withdrawn configuration", () => {
  test.each(WITHDRAWN_PROMOTION_CONFIG_FIELDS)("%s, on a live promotion", async (field) => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, `user:update:${field}`, [store])

    const id = await asOwner.mutation(api.promotions.create, promotionArgs(store))

    await expect(
      asOwner.mutation(api.promotions.update, {
        id,
        [field]: sampleFor(field, product),
      } as never)
    ).rejects.toThrow(new RegExp(`Unexpected field \`?${field}\`?`))

    const stored = await t.run((ctx) => ctx.db.get(id))
    expect((stored as Record<string, unknown>)[field]).toBeUndefined()
  })

  test("a legacy row keeps its fields through an edit that does not mention them", async () => {
    // The schema still declares the five, for exactly this row. An owner
    // renaming a legacy promotion must not have it rejected by the storage
    // layer — only by the discount-type guard, which speaks French.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:update:legacy", [store])

    const id = await t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId: store,
        name: "Ancienne offre",
        triggerMode: "auto" as const,
        // A row written while the fields were writable, on a type that works.
        discountType: "percentage" as const,
        discountValue: 10,
        bogoRewardQuantity: 1,
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

    await asOwner.mutation(api.promotions.update, { id, name: "Nouveau nom" })

    const stored = await t.run((ctx) => ctx.db.get(id))
    expect(stored?.name).toBe("Nouveau nom")
    expect(stored?.freeProductId).toBe(product)
    expect(stored?.bogoRewardQuantity).toBe(1)
  })
})

// ===========================================================================
// The one thing that still reads them
// ===========================================================================

describe("products.remove still protects a legacy reference", () => {
  test.each(WITHDRAWN_PROMOTION_PRODUCT_FIELDS)(
    "refuses while a legacy row points at the dish through %s",
    async (field) => {
      const t = newHarness()
      const store = await seedStore(t)
      const category = await seedCategory(t, store)
      const product = await seedProduct(t, store, category)
      const asOwner = await seedOwner(t, `user:remove:${field}`, [store])

      await t.run((ctx) =>
        ctx.db.insert("promotions", {
          storeId: store,
          name: "Dessert offert",
          triggerMode: "auto" as const,
          discountType: "free_product" as const,
          [field]: product,
          scope: "order" as const,
          startDate: NOW,
          endDate: NOW + 86_400_000,
          isActive: true,
          usageCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        } as never)
      )

      await expect(
        asOwner.mutation(api.products.remove, { id: product })
      ).rejects.toThrow(/Dessert offert/)

      const survivor = await t.run((ctx) => ctx.db.get(product))
      expect(survivor).not.toBeNull()
    }
  )

  test("tells the owner the one thing they can actually do about it", async () => {
    // « Modifiez ou supprimez cette promotion » was the old sentence, and half
    // of it was an instruction nobody could follow: the reference is on no
    // form, and `update` cannot clear an optional field. Deleting the promotion
    // is the action that exists, so it is the action the message names.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:remove:message", [store])

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

    const { code, message } = await refusal(
      asOwner.mutation(api.products.remove, { id: product })
    )

    expect(code).toBe("product_in_promotion")
    expect(message).toContain("Dessert offert")
    expect(message).toContain("supprimez cette promotion")
    expect(message).toContain("n'apparaît pas dans le formulaire")
    // It must not promise an edit that the form cannot offer.
    expect(message).not.toContain("Modifiez")
  })

  test("keeps the editable wording for a reference the form does render", async () => {
    // `targetProductIds` is the promotion's product scope: the owner picked the
    // dish on the form and can go and unpick it. That sentence stays true.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:remove:scoped", [store])

    await asOwner.mutation(
      api.promotions.create,
      promotionArgs(store, { scope: "product", targetProductIds: [product] })
    )

    const { message } = await refusal(
      asOwner.mutation(api.products.remove, { id: product })
    )

    expect(message).toContain("Offre du soir")
    expect(message).toContain("Modifiez ou supprimez cette promotion")
  })

  test("names both causes when both are present, counting each promotion once", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:remove:both", [store])

    await asOwner.mutation(
      api.promotions.create,
      promotionArgs(store, { scope: "product", targetProductIds: [product] })
    )
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

    const { message } = await refusal(
      asOwner.mutation(api.products.remove, { id: product })
    )

    expect(message).toContain("Modifiez ou supprimez cette promotion")
    expect(message).toContain("supprimez cette promotion pour libérer le produit")
    // One promotion per cause, not two counted twice on either side.
    expect(message.match(/Offre du soir/g)).toHaveLength(1)
    expect(message.match(/Dessert offert/g)).toHaveLength(1)
  })

  test("deleting the legacy promotion frees the dish", async () => {
    // The way out the message names, end to end.
    const t = newHarness()
    const store = await seedStore(t)
    const category = await seedCategory(t, store)
    const product = await seedProduct(t, store, category)
    const asOwner = await seedOwner(t, "user:remove:freed", [store])

    const promotion = await t.run((ctx) =>
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

    await asOwner.mutation(api.promotions.remove, { id: promotion })
    await asOwner.mutation(api.products.remove, { id: product })

    expect(await t.run((ctx) => ctx.db.get(product))).toBeNull()
  })
})
