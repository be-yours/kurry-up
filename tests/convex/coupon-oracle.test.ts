// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What an anonymous caller learns from a coupon code (#108).
 *
 * `promotions.getByCouponCode` and `listActiveAuto` are public by design — a
 * coupon is applied before the diner has an account — and they returned the WHOLE
 * row. So a guessed code did not merely say "this exists": it said
 * `usageCount` against `maxTotalUsage`, which is how much of the campaign's
 * budget is left. `listActiveAuto` needed no code at all and handed over every
 * automatic campaign the same way.
 *
 * WHAT THIS FILE DOES NOT CLAIM TO FIX. A public lookup is still an existence
 * oracle: codes remain guessable one request at a time. A Convex query cannot
 * write and therefore cannot be rate-limited, so closing that needs the lookup to
 * become a mutation or an action — a larger change than narrowing a payload.
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

async function seedPromotion(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("promotions", {
      storeId,
      // The name IS diner-facing: `order-summary.tsx:207` prints it on the
      // applied-coupon line. It is the budget that is not.
      name: "Bienvenue -20%",
      triggerMode: "coupon" as const,
      couponCode: "BIENVENUE",
      discountType: "percentage" as const,
      discountValue: 20,
      scope: "order" as const,
      startDate: NOW - 86_400_000,
      endDate: NOW + 30 * 86_400_000,
      maxTotalUsage: 500,
      maxUsagePerCustomer: 1,
      usageCount: 437,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    })
  )
}

describe("promotions.getByCouponCode, read with no session", () => {
  test("answers the rule, so the storefront can preview the discount", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "bienvenue",
    })
    expect(promo).toMatchObject({
      discountType: "percentage",
      discountValue: 20,
      scope: "order",
      isActive: true,
    })
  })

  test("says nothing about the campaign's budget", async () => {
    /*
     * THE LEAK. 437 of 500 used is how much is left, and that is a number a
     * competitor and a coupon-sharing forum both find interesting.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "BIENVENUE",
    })
    expect(promo.maxTotalUsage).toBeUndefined()
    // Zero, not the real 437: `PromotionForDiscount` requires the field, so it
    // cannot be dropped — it is emitted deliberately uninformative, and
    // `exhausted` below carries the only decision it used to carry.
    expect(promo.usageCount).toBe(0)
  })

  test("says nothing about the per-customer cap", async () => {
    // The client cannot enforce it — there is no email until the form is
    // submitted — so publishing it only tells a sharer how many times to share.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "BIENVENUE",
    })
    expect(promo.maxUsagePerCustomer).toBeUndefined()
  })

  test("still says the campaign has run out", async () => {
    // The storefront has to tell the diner why the code was refused, and
    // « atteint sa limite » is the honest reason.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId, { maxTotalUsage: 10, usageCount: 10 })

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "BIENVENUE",
    })
    expect(promo.exhausted).toBe(true)
  })

  test("says it has not run out when it has not", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "BIENVENUE",
    })
    expect(promo.exhausted).toBe(false)
  })

  test("says nothing about the withdrawn product fields", async () => {
    // `freeProductId` and the three BOGO fields are legacy configuration for two
    // discount types the order path refuses. They are still on rows written
    // before the withdrawal, and they are nobody's business.
    const t = newHarness()
    const storeId = await seedStore(t)
    const productId = await t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        storeId, name: "Carte", slug: "carte", sortOrder: 0, isActive: true,
        createdAt: NOW, updatedAt: NOW,
      })
      return ctx.db.insert("products", {
        storeId, categoryId, name: "Margherita", slug: "margherita",
        price: 1_200, taxRate: 10, images: [], options: [], allergens: [], tags: [],
        isActive: true, isFeatured: false, sortOrder: 0, source: "manual" as const,
        createdAt: NOW, updatedAt: NOW,
      })
    })
    await seedPromotion(t, storeId, { freeProductId: productId })

    const promo = await t.query(api.promotions.getByCouponCode, {
      storeId,
      couponCode: "BIENVENUE",
    })
    expect(promo.freeProductId).toBeUndefined()
  })

  test("answers null for a code that does not exist", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)

    await expect(
      t.query(api.promotions.getByCouponCode, { storeId, couponCode: "NOPE" })
    ).resolves.toBeNull()
  })
})

describe("promotions.listActiveAuto, read with no session", () => {
  test("narrows every row the same way", async () => {
    // This one needs no code at all, so the whole list of automatic campaigns
    // with their budgets was one anonymous request away.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId, {
      triggerMode: "auto",
      couponCode: undefined,
      name: "Happy hour",
      usageCount: 91,
      maxTotalUsage: 200,
    })

    const list = await t.query(api.promotions.listActiveAuto, { storeId })
    expect(list).toHaveLength(1)
    expect(list[0].maxTotalUsage).toBeUndefined()
    expect(list[0].usageCount).toBe(0)
    expect(list[0].maxUsagePerCustomer).toBeUndefined()
  })

  test("leaves a switched-off campaign out", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId, {
      triggerMode: "auto",
      couponCode: undefined,
      isActive: false,
    })

    await expect(t.query(api.promotions.listActiveAuto, { storeId })).resolves.toEqual([])
  })
})

describe("the admin still sees everything", () => {
  test("promotions.list carries the usage counts", async () => {
    // The owner needs the budget: it is their campaign. `list` is guarded with
    // `marketing:read`, which is why it can say so.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedPromotion(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "owner",
        role: "client_admin" as const,
        storeIds: [storeId],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const rows = await t
      .withIdentity({ subject: "owner" })
      .query(api.promotions.list, { storeId })
    expect(rows[0]).toMatchObject({ usageCount: 437, maxTotalUsage: 500 })
  })
})
