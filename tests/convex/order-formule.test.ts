// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A diner buys a *formule* (#352).
 *
 * WHAT WAS MISSING. An owner is told, in three places in the product, that they
 * can sell formules — the menus tab's empty state, the products page heading,
 * and the guided tour auto-launched on first login. No customer could ever order
 * one: `orders.create` refused any line with no `productId`, which is exactly
 * what a fixed-price bundle is, and `api.menus` had zero call sites in either
 * app's `app/` or `components/`.
 *
 * WHAT THIS FILE PINS, and why it is an integration test rather than a unit one:
 * the two money rules only exist across the seam.
 *
 * 1. The bundle price is split across the dishes, pro rata on à-la-carte value,
 *    and the VAT is then owed per rate. A formule of food at 10 % and wine at
 *    20 % cannot be described by one rate, and an even split would move taxable
 *    base from one to the other — silently, on a numbered fiscal document.
 *
 * 2. A formule's dishes are NOT discountable by product- or category-scoped
 *    promotions. The bundle price IS the owner's discount; letting « -20 % sur
 *    les desserts » reach the dessert inside it discounts the same dish twice
 *    without the owner having asked. Order-level promotions still apply.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

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

/** The deployment-wide rate, the one every order used to be taxed at. */
async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  taxRate = 20
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

/** A category, so `pick_category` sections can be exercised. */
async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name: string
) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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
  name: string,
  price: number,
  taxRate: number,
  over: { isActive?: boolean; stock?: { tracked: boolean; quantity: number } } = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      price,
      taxRate,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: over.isActive ?? true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      // `lowStockThreshold` is required by the schema whenever `stock` is set.
      ...(over.stock
        ? { stock: { ...over.stock, lowStockThreshold: 0 } }
        : {}),
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedMenu(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  price: number,
  sections: Array<Record<string, unknown>>,
  over: { isActive?: boolean; name?: string } = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("menus", {
      storeId,
      name: over.name ?? "Formule Midi",
      price,
      sections: sections as never,
      isActive: over.isActive ?? true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** A formule line, as the checkout sends one. */
function formuleLine(
  menuId: Id<"menus">,
  price: number,
  choices: Array<{ sectionId: string; productId: Id<"products">; quantity?: number }>,
  lineId = "line-1"
) {
  return {
    productName: "Formule Midi",
    quantity: 1,
    unitPrice: price,
    selectedOptions: [],
    subtotal: price,
    menu: { menuId, lineId, choices },
  }
}

// ============================================================================
// The money
// ============================================================================

describe("a formule on the order", () => {
  test("charges the formule's price, not the sum of its dishes", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const entree = await seedProduct(t, storeId, categoryId, "Burrata", 800, 10)
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Entrée", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [entree] },
      { sectionId: "s2", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 1, productIds: [plat] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(menuId, 1_800, [
          { sectionId: "s1", productId: entree },
          { sectionId: "s2", productId: plat },
        ]),
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    // 24,00 € à la carte, 18,00 € as a formule. The client sent 18,00 € and the
    // server recomputed it from the `menus` row; both agree, which is the point.
    expect(order?.subtotal).toBe(1_800)
    expect(order?.total).toBe(1_800)
  })

  test("ignores the prices the client sent", async () => {
    // The rule the à-la-carte path already applies to `unitPrice`. A client that
    // said the formule cost 1 € must be charged what the owner set.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        {
          ...formuleLine(menuId, 100, [{ sectionId: "s1", productId: plat }]),
          unitPrice: 100,
          subtotal: 100,
        },
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.total).toBe(1_800)
  })

  test("splits the VAT across the rates inside the bundle", async () => {
    /*
     * THE REASON THE SPLIT EXISTS. 20,00 € for a 15,00 € dish at 10 % and a
     * 5,00 € glass of wine at 20 %.
     *
     * Pro rata: 15,00 € of the à-la-carte 20,00 € is 75 %, so 15,00 € of the
     * bundle is food and 5,00 € is wine. VAT contained: 15,00 × 10/110 = 1,36 €
     * and 5,00 × 20/120 = 0,83 €.
     *
     * Split evenly it would have been 10,00 € each: 0,91 € + 1,67 € = 2,58 €,
     * declaring 0,39 € more VAT than is owed, on an invoice in a fiscal series.
     */
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_500, 10)
    const vin = await seedProduct(t, storeId, categoryId, "Verre de rouge", 500, 20)

    const menuId = await seedMenu(t, storeId, 2_000, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
      { sectionId: "s2", label: "Vin", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 1, productIds: [vin] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(menuId, 2_000, [
          { sectionId: "s1", productId: plat },
          { sectionId: "s2", productId: vin },
        ]),
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.total).toBe(2_000)
    expect(order?.taxAmount).toBe(136 + 83)

    // And the two bases are declared separately, which is what an invoice needs.
    const rates = (order?.taxBreakdown ?? []).map((entry: { ratePercent: number }) => entry.ratePercent)
    expect(rates.sort()).toEqual([10, 20])
  })

  test("writes one row per dish, grouped by the cart's line id", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const entree = await seedProduct(t, storeId, categoryId, "Burrata", 800, 10)
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Entrée", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [entree] },
      { sectionId: "s2", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 1, productIds: [plat] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(
          menuId,
          1_800,
          [
            { sectionId: "s1", productId: entree },
            { sectionId: "s2", productId: plat },
          ],
          "cart-line-7"
        ),
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.items).toHaveLength(2)
    for (const item of order!.items) {
      expect(item.menuId).toBe(menuId)
      expect(item.menuName).toBe("Formule Midi")
      expect(item.menuLineId).toBe("cart-line-7")
    }
    expect(order!.items.map((i: { menuSectionLabel?: string }) => i.menuSectionLabel)).toEqual([
      "Entrée",
      "Plat",
    ])
    // The shares sum to the price, so nothing downstream needs to know a formule
    // was involved to get the money right.
    expect(order!.items.reduce((sum: number, i: { subtotal: number }) => sum + i.subtotal, 0)).toBe(1_800)
  })

  test("keeps two differently-composed formules apart", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const risotto = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    const burrata = await seedProduct(t, storeId, categoryId, "Burrata", 800, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [risotto, burrata] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: risotto }], "line-a"),
        formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: burrata }], "line-b"),
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.total).toBe(3_600)
    expect(
      order!.items.map((i: { menuLineId?: string }) => i.menuLineId).sort()
    ).toEqual(["line-a", "line-b"])
  })

  test("takes a formule beside an à-la-carte dish", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    const cafe = await seedProduct(t, storeId, categoryId, "Café", 200, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }]),
        {
          productId: cafe,
          productName: "Café",
          quantity: 1,
          unitPrice: 200,
          selectedOptions: [],
          subtotal: 200,
        },
      ],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.total).toBe(2_000)
    expect(order!.items).toHaveLength(2)
    // The à-la-carte row carries no formule fields at all.
    const alaCarte = order!.items.find((i: { productName: string }) => i.productName === "Café")
    expect(alaCarte.menuId).toBeUndefined()
    expect(alaCarte.menuLineId).toBeUndefined()
  })

  test("resolves a pick_category section against the category, not a stored list", async () => {
    // The section means "anything currently in this category", and the
    // category's contents move.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const desserts = await seedCategory(t, storeId, "Desserts")
    const tiramisu = await seedProduct(t, storeId, desserts, "Tiramisu", 700, 10)

    const menuId = await seedMenu(t, storeId, 1_500, [
      { sectionId: "s1", label: "Dessert", type: "pick_category", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, categoryId: desserts },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [formuleLine(menuId, 1_500, [{ sectionId: "s1", productId: tiramisu }])],
      type: "pickup" as const,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.total).toBe(1_500)
  })
})

// ============================================================================
// What the kitchen receives
// ============================================================================

describe("the kitchen slip", () => {
  test("says which formule and which row each dish belongs to", async () => {
    // A cook who cannot see that the risotto and the burrata are the same cover
    // will plate them apart.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const entree = await seedProduct(t, storeId, categoryId, "Burrata", 800, 10)
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Entrée", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [entree] },
      { sectionId: "s2", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 1, productIds: [plat] },
    ])

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        formuleLine(menuId, 1_800, [
          { sectionId: "s1", productId: entree },
          { sectionId: "s2", productId: plat },
        ]),
      ],
      type: "pickup" as const,
      paymentMethod: "cash" as const,
    })

    // The internal transport rather than `markCashPaid`: that one is staff-facing
    // and needs a session, and the seam this test is about is `releaseToKitchen`,
    // which both paths reach through `recordPaymentStatus`.
    await t.mutation(internal.orders.internalUpdatePaymentStatus, {
      id: orderId as Id<"orders">,
      paymentStatus: "paid" as const,
    })

    const ticket = await t.run((ctx) =>
      ctx.db
        .query("kitchenTickets")
        .withIndex("by_orderId", (q) => q.eq("orderId", orderId as Id<"orders">))
        .first()
    )
    expect(ticket?.items.map((i: { productName: string }) => i.productName)).toEqual([
      "Formule Midi · Entrée — Burrata",
      "Formule Midi · Plat — Risotto",
    ])
  })
})

// ============================================================================
// Promotions
// ============================================================================

describe("promotions and formules", () => {
  const seedPromotion = (
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    over: Record<string, unknown>
  ) =>
    t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId,
        name: "Offre",
        triggerMode: "coupon" as const,
        couponCode: "OFFRE",
        discountType: "percentage" as const,
        discountValue: 20,
        scope: "order" as const,
        // `Date.now()`, not `NOW`: the resolver reads the real clock, and a
        // window built around the 2023 constant is always already expired — a
        // refusal that would have made every test below pass vacuously.
        startDate: Date.now() - 86_400_000,
        endDate: Date.now() + 30 * 86_400_000,
        usageCount: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      })
    )

  test("a category promotion does not reach the dish inside a formule", async () => {
    /*
     * THE DECISION, TESTED. The bundle price IS the owner's discount — they set
     * 18,00 € against 24,00 € à la carte deliberately. Letting « -20 % sur les
     * desserts » also apply to the dessert inside it discounts the same dish
     * twice without the owner having asked for that.
     *
     * Enforced by the formule's rows never entering `discountableLines`, which
     * has a consequence worth pinning on its own: a basket holding ONLY formules
     * matches no line, so the coupon is REFUSED with a sentence rather than
     * granted at zero. That is the better of the two — a diner who typed a
     * dessert code and was charged full price with no explanation would have no
     * way to tell a rule from a bug.
     */
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const desserts = await seedCategory(t, storeId, "Desserts")
    const tiramisu = await seedProduct(t, storeId, desserts, "Tiramisu", 700, 10)

    const menuId = await seedMenu(t, storeId, 1_500, [
      { sectionId: "s1", label: "Dessert", type: "pick_category", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, categoryId: desserts },
    ])
    const promotionId = await seedPromotion(t, storeId, {
      scope: "category",
      targetCategoryIds: [desserts],
    })

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille", email: "camille@example.fr" },
        items: [formuleLine(menuId, 1_500, [{ sectionId: "s1", productId: tiramisu }])],
        type: "pickup" as const,
        promotionId,
      })
    ).rejects.toThrow(/ne s'applique à aucun article/)
  })

  test("but it still reaches the same dish bought à la carte", async () => {
    // The rule is about the BUNDLE, not about the dish. A tiramisu ordered on its
    // own is discounted exactly as before — which is what makes this a decision
    // about double-discounting rather than a dish becoming ineligible.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const desserts = await seedCategory(t, storeId, "Desserts")
    const tiramisu = await seedProduct(t, storeId, desserts, "Tiramisu", 700, 10)
    const promotionId = await seedPromotion(t, storeId, {
      scope: "category",
      targetCategoryIds: [desserts],
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.fr" },
      items: [
        {
          productId: tiramisu,
          productName: "Tiramisu",
          quantity: 1,
          unitPrice: 700,
          selectedOptions: [],
          subtotal: 700,
        },
      ],
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(140)
  })

  test("a product promotion does not reach it either", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])
    const promotionId = await seedPromotion(t, storeId, {
      scope: "product",
      targetProductIds: [plat],
    })

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille", email: "camille@example.fr" },
        items: [formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }])],
        type: "pickup" as const,
        promotionId,
      })
    ).rejects.toThrow(/ne s'applique à aucun article/)
  })

  test("an order promotion does apply to it", async () => {
    // Those are about the order, not about a dish, and they see the formule
    // through the subtotal like everything else.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)

    const menuId = await seedMenu(t, storeId, 2_000, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])
    const promotionId = await seedPromotion(t, storeId, { scope: "order" })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.fr" },
      items: [formuleLine(menuId, 2_000, [{ sectionId: "s1", productId: plat }])],
      type: "pickup" as const,
      promotionId,
    })

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.discountAmount).toBe(400)
    expect(order?.total).toBe(1_600)
  })
})

// ============================================================================
// Refusals that need the database
// ============================================================================

describe("a formule the establishment cannot serve", () => {
  test("a deleted formule is refused", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])
    await t.run((ctx) => ctx.db.delete(menuId))

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille" },
        items: [formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }])],
        type: "pickup" as const,
      })
    ).rejects.toThrow(/n'existe plus/)
  })

  test("a formule from another establishment is refused", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
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
    const theirCategory = await seedCategory(t, theirs, "Carte")
    const theirPlat = await seedProduct(t, theirs, theirCategory, "Sashimi", 1_600, 10)
    const theirMenu = await seedMenu(t, theirs, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [theirPlat] },
    ])

    await expect(
      t.mutation(api.orders.create, {
        storeId: mine,
        customerInfo: { name: "Camille" },
        items: [formuleLine(theirMenu, 1_800, [{ sectionId: "s1", productId: theirPlat }])],
        type: "pickup" as const,
      })
    ).rejects.toThrow(/autre restaurant/)
  })

  test("a deactivated formule is refused", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    const menuId = await seedMenu(
      t,
      storeId,
      1_800,
      [{ sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] }],
      { isActive: false }
    )

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille" },
        items: [formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }])],
        type: "pickup" as const,
      })
    ).rejects.toThrow(/n'est plus proposée/)
  })

  test("a dish the section does not offer is refused", async () => {
    // Without this a diner puts the 38 € plateau into an 18 € formule.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    const plateau = await seedProduct(t, storeId, categoryId, "Plateau de fruits de mer", 3_800, 10)
    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille" },
        items: [formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plateau }])],
        type: "pickup" as const,
      })
    ).rejects.toThrow(/n'est pas proposé/)
  })

  test("two formules cannot between them oversell one dish", async () => {
    // The basket-wide stock ledger. Each formule was checked on its own against
    // a stock of 1, and a per-line check would have accepted both.
    const t = newHarness()
    await seedGlobalSettings(t, 10)
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10, {
      stock: { tracked: true, quantity: 1 },
    })
    const menuId = await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])

    await expect(
      t.mutation(api.orders.create, {
        storeId,
        customerInfo: { name: "Camille" },
        items: [
          formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }], "line-a"),
          formuleLine(menuId, 1_800, [{ sectionId: "s1", productId: plat }], "line-b"),
        ],
        type: "pickup" as const,
      })
    ).rejects.toThrow(/reste|épuisé/)
  })
})

// ============================================================================
// What the storefront is offered
// ============================================================================

describe("menus.listActive", () => {
  test("offers an active formule with its sections resolved", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const desserts = await seedCategory(t, storeId, "Desserts")
    const tiramisu = await seedProduct(t, storeId, desserts, "Tiramisu", 700, 10)
    const menuId = await seedMenu(t, storeId, 1_500, [
      { sectionId: "s1", label: "Dessert", type: "pick_category", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, categoryId: desserts },
    ])

    const offered = await t.query(api.menus.listActive, { storeId })
    expect(offered).toHaveLength(1)
    expect(offered[0]._id).toBe(menuId)
    expect(offered[0].sections[0].choices.map((c: { productId: string }) => c.productId)).toEqual([
      tiramisu,
    ])
  })

  test("needs no session, because a diner has none", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await expect(t.query(api.menus.listActive, { storeId })).resolves.toEqual([])
  })

  test("never shows a deactivated formule", async () => {
    // `list` is unfiltered and guarded, which is right for the screen with the
    // on/off switch and wrong for a carte.
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10)
    await seedMenu(
      t,
      storeId,
      1_800,
      [{ sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] }],
      { isActive: false }
    )

    await expect(t.query(api.menus.listActive, { storeId })).resolves.toEqual([])
  })

  test("leaves out a formule whose mandatory dish has been switched off", async () => {
    // Offering it means a diner composes the whole thing and is refused at the
    // checkout.
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10, {
      isActive: false,
    })
    await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat du jour", type: "fixed", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productId: plat },
    ])

    await expect(t.query(api.menus.listActive, { storeId })).resolves.toEqual([])
  })

  test("still offers a formule whose dish is merely sold out, and says so", async () => {
    // Sold out is true now and false in an hour. A formule that vanished from
    // the carte at 14:31 is worse than one that says which dish is gone.
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId, "Carte")
    const plat = await seedProduct(t, storeId, categoryId, "Risotto", 1_600, 10, {
      stock: { tracked: true, quantity: 0 },
    })
    await seedMenu(t, storeId, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [plat] },
    ])

    const offered = await t.query(api.menus.listActive, { storeId })
    expect(offered).toHaveLength(1)
    expect(offered[0].sections[0].choices[0].isAvailable).toBe(false)
  })

  test("does not offer another establishment's formules", async () => {
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
    const theirCategory = await seedCategory(t, theirs, "Carte")
    const theirPlat = await seedProduct(t, theirs, theirCategory, "Sashimi", 1_600, 10)
    await seedMenu(t, theirs, 1_800, [
      { sectionId: "s1", label: "Plat", type: "pick_products", required: true, minChoices: 1, maxChoices: 1, allowDuplicates: false, sortOrder: 0, productIds: [theirPlat] },
    ])

    await expect(t.query(api.menus.listActive, { storeId: mine })).resolves.toEqual([])
  })
})
