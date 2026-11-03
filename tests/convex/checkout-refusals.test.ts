// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A diner who is refused has to be able to read why.
 *
 * Convex redacts a thrown `Error` in production — the browser receives "Server
 * Error" and nothing else. `orders.create` and `orderLine` between them wrote
 * eight careful French sentences and threw every one of them as a plain
 * `Error`, so a sold-out dish, a missing required option, a basket under the
 * minimum and an address outside the delivery zone all reached the customer as
 * two English words at the moment of payment. The whole server-side validation
 * effort was invisible.
 *
 * The rule was already known here — `auth.ts` and `invitation-acceptance.test.ts`
 * both explain it — and had been applied to the authorisation path only.
 *
 * These tests assert the `data.code` a browser reads, through
 * `lib/convex-error.ts`, which is the reader the storefront uses. Asserting the
 * message would pass on a plain `Error` under `convex-test`, where nothing is
 * redacted: the code is the half that only a `ConvexError` can carry.
 *
 * Also here: the two guards that could not fire. Tracked stock was never
 * decremented by an order, and the weekly opening hours were enforced in the
 * browser alone.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorMessage, convexErrorPayload } from "../../lib/convex-error"
import { updateStatus as updateStatusDef } from "@be-yours/convex-functions/orders"

/** Advance an order without going through the permissioned wrapper. */
const internalUpdateStatus = (
  ctx: unknown,
  args: { id: Id<"orders">; status: string }
) => updateStatusDef.handler(ctx as never, args)

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 3 July 2029, 12:00 UTC — 14:00 in Paris, service is on. */
const NOON_UTC = Date.UTC(2029, 6, 3, 12, 0, 0)

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/** Cancel whatever the catalogue writes left on the scheduler. */
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOON_UTC)
})

afterEach(() => {
  vi.useRealTimers()
})

/** A week that is open when these tests run, so hours never decide by accident. */
const OPEN_ALL_WEEK = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: "00:00",
  close: "23:59",
  isClosed: false,
}))

async function seedStore(
  t: ReturnType<typeof convexTest>,
  hours = OPEN_ALL_WEEK
) {
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
      hours,
      status: "open" as const,
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
    })
  )
}

async function seedGlobalSettings(
  t: ReturnType<typeof convexTest>,
  overrides: Record<string, unknown> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 0,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOON_UTC,
      ...overrides,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  overrides: Record<string, unknown> = {}
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
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
      source: "manual",
      createdAt: NOON_UTC,
      updatedAt: NOON_UTC,
      ...overrides,
    })
  })
}

function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
  item: {
    quantity?: number
    selectedOptions?: Array<{
      optionName: string
      choiceName?: string
      priceModifier: number
    }>
  } = {}
) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: item.quantity ?? 1,
        unitPrice: 1200,
        selectedOptions: item.selectedOptions ?? [],
        subtotal: 1200,
      },
    ],
    type: "pickup" as const,
  }
}

/** The platform menu uploads this harness has on the scheduler, sorted. */
async function bookedMenuSyncs(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs
      .map((job) => job.name)
      .filter((name) => name.endsWith("MenuSync:internalSyncStore"))
      .sort()
  })
}

/** What the thrown value gives the browser, read exactly as the storefront does. */
async function refusal(call: Promise<unknown>) {
  try {
    await call
    throw new Error("expected the order to be refused, and it was not")
  } catch (error) {
    return {
      error,
      payload: convexErrorPayload(error),
      shown: convexErrorMessage(error, {}, "GENERIC FALLBACK"),
    }
  }
}

describe("a refusal reaches the browser", () => {
  test("as a ConvexError, with the French sentence intact", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 0, lowStockThreshold: 0 },
    })

    const { error, payload, shown } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    )

    // `instanceof ConvexError` is what makes Convex send `data` instead of
    // redacting the whole thing. Without it none of the rest can be true.
    expect(error).toBeInstanceOf(ConvexError)
    expect(payload?.code).toBe("insufficient_stock")
    expect(shown).toBe("« Margherita » est épuisé.")
  })

  test.each([
    [
      "a dish the owner switched off",
      { isActive: false },
      "inactive",
      /n'est plus disponible/,
    ],
    [
      "a dish with only some of its stock left",
      { stock: { tracked: true, quantity: 1, lowStockThreshold: 0 } },
      "insufficient_stock",
      /il n'en reste que 1/,
    ],
    [
      "a dish outside its serving window",
      { scheduling: { availableFrom: "18:00", availableUntil: "22:00" } },
      "outside_window",
      /pas servi à cette heure-ci/,
    ],
  ])("%s: code and sentence both survive", async (_name, overrides, code, sentence) => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, overrides)

    const { payload, shown } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 2 }))
    )

    expect(payload?.code).toBe(code)
    expect(shown).toMatch(sentence)
  })

  test("naming the option group the customer still has to pick", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      options: [
        {
          id: "opt_size",
          name: "Taille",
          required: true,
          maxSelections: 1,
          choices: [
            { id: "ch_small", name: "Petite", priceModifier: 0 },
            { id: "ch_large", name: "Grande", priceModifier: 300 },
          ],
        },
      ],
    })

    const { payload, shown } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    )

    expect(payload?.code).toBe("missing_required_option")
    expect(shown).toBe("« Margherita » exige un choix : Taille.")
  })

  test("for a basket below the establishment's minimum", async () => {
    const t = newHarness()
    await seedGlobalSettings(t, { minimumOrderAmount: 2500 })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const { payload, shown } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    )

    expect(payload?.code).toBe("below_minimum")
    expect(shown).toMatch(/Commande minimum de 25,00 € requise/)
  })

  test("for a service the restaurant does not run, in French", async () => {
    // This one used to read "This store does not offer delivery orders" — the
    // only English copy a diner could be shown on this path.
    const t = newHarness()
    await seedGlobalSettings(t, {
      services: {
        dineIn: true,
        takeaway: true,
        delivery: false,
        clickAndCollect: true,
      },
    })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const { payload, shown } = await refusal(
      t.mutation(api.orders.create, {
        ...orderArgs(storeId, productId),
        type: "delivery" as const,
        deliveryAddress: {
          street: "2 rue de Rivoli",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      })
    )

    expect(payload?.code).toBe("service_not_offered")
    expect(shown).toBe("Ce restaurant ne propose pas la livraison.")
  })

  test("never as the screen's own generic fallback", async () => {
    // The fallback is what the checkout shows when there is genuinely nothing
    // left to say. Reaching it on a refusal the server explained is the defect.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { isActive: false })

    const { shown } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    )

    expect(shown).not.toBe("GENERIC FALLBACK")
  })

  test("a card attempt on a deployment with no card provider says why", async () => {
    // The #374 opening move: card was the pre-selected tile on a fresh
    // deployment, the provider action threw a plain `Error`, and production
    // redacted it to "Server Error" behind the checkout's generic retry
    // toast — so the diner retried a payment that could never work. The
    // refusal must cross the wire like every other one in this file.
    const t = newHarness()
    await seedGlobalSettings(t, {
      payments: { cardProvider: "sumup" as const, paypal: false, cash: true },
    })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId)
    )

    const { payload, shown } = await refusal(
      t.action(api.sumup.createCheckout, {
        orderId: orderId as Id<"orders">,
        redirectUrl: "https://exemple.test/retour",
      })
    )

    expect(payload?.code).toBe("card_payment_unavailable")
    expect(shown).toBe(
      "Le paiement par carte est indisponible pour le moment. Choisissez un autre moyen de paiement."
    )
  })
})

describe("tracked stock falls when a dish sells", () => {
  const stockOf = (t: ReturnType<typeof convexTest>, productId: Id<"products">) =>
    t.run(async (ctx) => (await ctx.db.get(productId))?.stock)

  test("by the quantity ordered, in the same transaction as the order", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 10, lowStockThreshold: 2 },
    })

    await t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 3 }))

    expect((await stockOf(t, productId))?.quantity).toBe(7)
  })

  test("so the sold-out guard eventually fires on its own", async () => {
    // The guard has been correct since P0-09 and unreachable: nothing moved the
    // number except an owner retyping it in the Inventaire screen, so a
    // restaurant tracking ten portions sold fifty.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 2, lowStockThreshold: 0 },
    })

    await t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 2 }))
    expect((await stockOf(t, productId))?.quantity).toBe(0)

    const { payload } = await refusal(
      t.mutation(api.orders.create, orderArgs(storeId, productId))
    )
    expect(payload?.code).toBe("insufficient_stock")
  })

  test("counting every line of the basket, not each one on its own", async () => {
    // Two lines of the same dish — one with extra cheese, one without — were
    // each checked against the stored quantity, so a stock of 3 accepted 2 + 2.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 3, lowStockThreshold: 0 },
    })

    const twoLines = {
      ...orderArgs(storeId, productId),
      items: [
        { ...orderArgs(storeId, productId).items[0]!, quantity: 2 },
        { ...orderArgs(storeId, productId).items[0]!, quantity: 2 },
      ],
    }

    const { payload } = await refusal(t.mutation(api.orders.create, twoLines))
    expect(payload?.code).toBe("insufficient_stock")

    // And it refused before writing anything: the order is one transaction.
    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(0)
    expect((await stockOf(t, productId))?.quantity).toBe(3)
  })

  test("taking the dish off the menu when the owner asked for that", async () => {
    // `autoDisableWhenEmpty` was reachable from the manual `updateStock`
    // mutation and no other, so a dish that ran out stayed on the menu.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: {
        tracked: true,
        quantity: 1,
        lowStockThreshold: 0,
        autoDisableWhenEmpty: true,
      },
    })

    await t.mutation(api.orders.create, orderArgs(storeId, productId))

    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.stock?.quantity).toBe(0)
    expect(product?.isActive).toBe(false)
  })

test("a sale tells the delivery platforms the dish is going", async () => {
    // `stock.quantity` is what `isProductOutOfStock` reads before suspending an
    // item on Uber Eats, and the Inventaire screen has booked this push on
    // every manual stock edit since the beginning. The order path moves the
    // same number; without the push, a dish sold out on the restaurant's own
    // site stays orderable on the platforms, and nothing sweeps for it.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 3, lowStockThreshold: 0 },
    })

    await t.mutation(api.orders.create, orderArgs(storeId, productId))

    expect(await bookedMenuSyncs(t)).toEqual([
      "deliverooMenuSync:internalSyncStore",
      "uberEatsMenuSync:internalSyncStore",
    ])
  })

  test("an order of nothing tracked books no menu upload", async () => {
    // Most baskets hold no tracked dish, and a full menu upload per order is a
    // full menu upload per order.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await t.mutation(api.orders.create, orderArgs(storeId, productId))

    expect(await bookedMenuSyncs(t)).toEqual([])
  })

  test("leaving an untracked dish alone", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: false, quantity: 4, lowStockThreshold: 0 },
    })

    await t.mutation(api.orders.create, orderArgs(storeId, productId, { quantity: 3 }))

    expect((await stockOf(t, productId))?.quantity).toBe(4)
  })
})

describe("stock the restaurant gets back", () => {
  const stockOf = (t: ReturnType<typeof convexTest>, productId: Id<"products">) =>
    t.run(async (ctx) => (await ctx.db.get(productId))?.stock)

  const place = async (
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    productId: Id<"products">,
    quantity: number
  ): Promise<Id<"orders">> =>
    (await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId, { quantity })
    )) as Id<"orders">

  test("a cancelled order returns what it took", async () => {
    // The sale was one-way: a restaurant that cancelled three orders was left
    // showing three portions it still had.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 5, lowStockThreshold: 0 },
    })

    const orderId = await place(t, storeId, productId, 2)
    expect((await stockOf(t, productId))?.quantity).toBe(3)

    await t.run((ctx) =>
      internalUpdateStatus(ctx, { id: orderId, status: "cancelled" })
    )

    expect((await stockOf(t, productId))?.quantity).toBe(5)
  })

  test("and puts the dish back on the menu it took off", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: {
        tracked: true,
        quantity: 1,
        lowStockThreshold: 0,
        autoDisableWhenEmpty: true,
      },
    })

    const orderId = await place(t, storeId, productId, 1)
    expect((await t.run((ctx) => ctx.db.get(productId)))?.isActive).toBe(false)

    await t.run((ctx) =>
      internalUpdateStatus(ctx, { id: orderId, status: "cancelled" })
    )

    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.stock?.quantity).toBe(1)
    expect(product?.isActive).toBe(true)
  })

  test("a marketplace order credits nothing, because it took nothing", async () => {
    // `createFromWebhook` has no stock path — the platform keeps its own count,
    // and crediting here would invent stock the restaurant does not have.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, {
      stock: { tracked: true, quantity: 4, lowStockThreshold: 0 },
    })

    const orderId = await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId,
        orderNumber: "UE-1",
        customerInfo: { name: "Camille" },
        type: "delivery" as const,
        status: "pending" as const,
        items: [
          {
            productId,
            productName: "Margherita",
            quantity: 3,
            unitPrice: 1200,
            selectedOptions: [],
            subtotal: 3600,
          },
        ],
        subtotal: 3600,
        taxAmount: 0,
        total: 3600,
        paymentStatus: "paid" as const,
        source: "uber_eats" as const,
        createdAt: NOON_UTC,
        updatedAt: NOON_UTC,
      })
    )

    await t.run((ctx) =>
      internalUpdateStatus(ctx, { id: orderId, status: "cancelled" })
    )

    expect((await stockOf(t, productId))?.quantity).toBe(4)
  })
})
