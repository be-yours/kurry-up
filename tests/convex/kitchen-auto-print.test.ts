// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Automatic printing, end to end, through the real functions.
 *
 * Every unit around this was green while the feature was dead product-wide, so
 * these tests deliberately cross the seams the unit tests cannot:
 *
 *  - #164.9 — `printConfig` is written by the real guarded mutation, the one
 *    the store-detail screen calls. Nothing could write it at all: the editor
 *    had been deleted, so every establishment ran with `printConfig` unset,
 *    `create` always wrote `printStatus: "not_required"`, and the print queue
 *    was permanently empty.
 *  - #136 — the ticket appears when the payment lands, not at checkout.
 *  - #135 — a customer's instruction survives the Uber Eats mapper, the webhook
 *    validator and the ticket insert. Each half had a passing test; the seam
 *    between them dropped the note, which on that path can be an allergy.
 *  - #137 — the KDS read stays bounded against a store with 5,000 tickets.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { uberEats } from "@be-yours/integrations"
import { toKitchenTicketItemsFromPlatform } from "@be-yours/convex-functions/orders"
import { ACTIVE_TICKET_LIMIT } from "@be-yours/convex-functions/kitchenTickets"
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

/** Cancel whatever the test left on the scheduler — see `order-lifecycle`. */
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

async function seedAdmin(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:admin",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "user:admin" })
}

/** A dish, in a named category, with allergens and a prep time. */
async function seedDish(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  dish: {
    name: string
    category: string
    allergens: string[]
    preparationTime: number
  }
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: dish.category,
      slug: dish.category.toLowerCase(),
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const productId = await ctx.db.insert("products", {
      storeId,
      categoryId,
      name: dish.name,
      slug: dish.name.toLowerCase().replace(/\s+/g, "-"),
      price: 1_200,
      taxRate: 10,
      images: [],
      options: [],
      allergens: dish.allergens,
      preparationTime: dish.preparationTime,
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return { categoryId, productId }
  })
}

/** Turn printing on the way the store-detail screen does. */
async function enablePrinting(
  admin: Awaited<ReturnType<typeof seedAdmin>>,
  storeId: Id<"stores">
) {
  await admin.mutation(api.stores.updatePrintConfig, {
    id: storeId,
    printConfig: {
      provider: "browser" as const,
      triggers: ["confirmed" as const],
      paperSize: "80mm" as const,
      enabled: true,
    },
  })
}

/** Confirm the payment, which is what puts the slip on the pass. */
async function payOrder(
  t: ReturnType<typeof convexTest>,
  orderId: Id<"orders">
) {
  await t.run((ctx) =>
    ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
      id: orderId,
      paymentStatus: "paid" as const,
    })
  )
}

// ===========================================================================
// The loop the product sells: a paid order prints itself
// ===========================================================================

describe("a paid order prints automatically", () => {
  test("reaches the print queue, carrying its allergens and its prep time", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    const { productId } = await seedDish(t, storeId, {
      name: "Margherita",
      category: "Pizzas",
      allergens: ["gluten", "lait"],
      preparationTime: 15,
    })

    await enablePrinting(admin, storeId)

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: [
        {
          productId,
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
          notes: "bien cuite, sans basilic",
        },
      ],
      type: "pickup" as const,
    })

    // Nothing on the pass while the payment is outstanding.
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(0)

    await payOrder(t, orderId as Id<"orders">)

    // The queue the tablet actually subscribes to.
    const queue = await admin.query(api.kitchenTickets.getPrintQueue, { storeId })
    expect(queue).toHaveLength(1)

    const slip = queue[0]!
    expect(slip.printStatus).toBe("pending")
    expect(slip.printTrigger).toBe("confirmed")
    expect(slip.printRequestedAt).toBeDefined()
    expect(slip.allergens).toEqual(expect.arrayContaining(["gluten", "lait"]))
    expect(slip.estimatedPrepTime).toBe(15)
    expect(slip.estimatedReadyAt).toBeDefined()
    expect(slip.items[0]!.notes).toBe("bien cuite, sans basilic")
  })

  test("stays off the queue when the establishment has not configured printing", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    const { productId } = await seedDish(t, storeId, {
      name: "Margherita",
      category: "Pizzas",
      allergens: [],
      preparationTime: 10,
    })

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        {
          productId,
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
        },
      ],
      type: "pickup" as const,
    })
    await payOrder(t, orderId as Id<"orders">)

    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticket!.printStatus).toBe("not_required")
    expect(await admin.query(api.kitchenTickets.getPrintQueue, { storeId })).toHaveLength(0)
  })

  test("only one tablet may take the slip", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    const { productId } = await seedDish(t, storeId, {
      name: "Margherita",
      category: "Pizzas",
      allergens: [],
      preparationTime: 10,
    })
    await enablePrinting(admin, storeId)

    const orderId = await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        {
          productId,
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
        },
      ],
      type: "pickup" as const,
    })
    await payOrder(t, orderId as Id<"orders">)

    const [slip] = await admin.query(api.kitchenTickets.getPrintQueue, { storeId })

    // Two tablets, same pass, same queue row.
    const first = await admin.mutation(api.kitchenTickets.claimForPrint, { id: slip!._id })
    const second = await admin.mutation(api.kitchenTickets.claimForPrint, { id: slip!._id })

    expect([first, second].filter(Boolean)).toHaveLength(1)
    // And the queue no longer offers it while the claim is live.
    expect(await admin.query(api.kitchenTickets.getPrintQueue, { storeId })).toHaveLength(0)
  })
})

// ===========================================================================
// #164.1 — stations, and what the customer is told while they are cooking
// ===========================================================================

describe("an order routed across two stations", () => {
  test("is split per station and still tracks as one order", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const pizza = await seedDish(t, storeId, {
      name: "Margherita",
      category: "Pizzas",
      allergens: ["gluten", "lait"],
      preparationTime: 15,
    })
    const salad = await seedDish(t, storeId, {
      name: "Cesar",
      category: "Salades",
      allergens: ["moutarde"],
      preparationTime: 5,
    })

    await admin.mutation(api.stores.updateStationMapping, {
      id: storeId,
      kitchenStations: ["chaud", "froid"],
      stationMapping: [
        { categoryId: pizza.categoryId, station: "chaud" },
        { categoryId: salad.categoryId, station: "froid" },
      ],
    })

    const orderId = (await t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille" },
      items: [
        {
          productId: pizza.productId,
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
        },
        {
          productId: salad.productId,
          productName: "Cesar",
          quantity: 1,
          unitPrice: 900,
          selectedOptions: [],
          subtotal: 900,
        },
      ],
      type: "pickup" as const,
    })) as Id<"orders">
    await payOrder(t, orderId)

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(2)

    // Each slip carries its own food, and its own allergens.
    const byStation = Object.fromEntries(tickets.map((x) => [x.station, x]))
    expect(byStation.chaud!.items[0]!.productName).toBe("Margherita")
    expect(byStation.chaud!.allergens).toEqual(["gluten", "lait"])
    expect(byStation.froid!.items[0]!.productName).toBe("Cesar")
    expect(byStation.froid!.allergens).toEqual(["moutarde"])

    // One order, one tracking token.
    const order = await t.run((ctx) => ctx.db.get(orderId))
    const token = await t.query(api.orders.getTrackingToken, {
      orderId,
      viewToken: order!.viewToken as string,
    })
    expect(new Set(tickets.map((x) => x.trackingToken)).size).toBe(1)

    // The cold station plates the salad. The pizza is still in the oven, so
    // the customer must NOT be told their order is ready.
    await admin.mutation(api.kitchenTickets.updateStatus, {
      id: byStation.froid!._id,
      status: "ready" as const,
    })

    const view = await t.query(api.kitchenTickets.getByTrackingToken, {
      token: token as string,
    })
    expect(view!.status).not.toBe("ready")
    expect(view!.readyAt).toBeUndefined()

    // And the dining-room screen shows the order once, not once per station.
    const display = await admin.query(api.kitchenTickets.getForDisplay, { storeId })
    const shown = [...display.preparing, ...display.ready]
    expect(shown.filter((r) => r.orderNumber === order!.orderNumber)).toHaveLength(1)
    // The cold station goes all the way to completed. The pizza has still not
    // been started, so neither "prête" nor "Terminée" is the truth.
    await admin.mutation(api.kitchenTickets.updateStatus, {
      id: byStation.froid!._id,
      status: "completed" as const,
    })

    const afterCompleted = await t.query(api.kitchenTickets.getByTrackingToken, {
      token: token as string,
    })
    expect(afterCompleted!.status).toBe("pending")
    expect(afterCompleted!.completedAt).toBeUndefined()

    // And one late order is one late order, however many stations it touches.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("kitchenTickets").collect()) {
        await ctx.db.patch(row._id, { estimatedReadyAt: NOW - 60_000 })
      }
    })
    expect(await admin.query(api.kitchenTickets.getOverdueCount, { storeId })).toBe(1)
  })
})

// ===========================================================================
// #135 — the instruction survives the whole platform path
// ===========================================================================

describe("an Uber Eats customer's instruction", () => {
  test("survives the mapper, the webhook validator and the ticket insert", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    // The payload as Uber Eats sends it, through the real mapper.
    const unified = uberEats.mapUberEatsOrderToUnified({
      id: "UE-ORDER-1",
      display_id: "A1B2",
      current_state: "CREATED",
      placed_at: new Date(NOW).toISOString(),
      eater_info: { first_name: "Camille", last_name: "Roy", phone: "0600000000" },
      cart: {
        items: [
          {
            id: "item-1",
            title: "Margherita",
            quantity: 1,
            price: { unit_price: { amount: 1_200, currency_code: "EUR" } },
            customer_request: {
              allergy: { instructions: "arachides — sauce à part" },
            },
          },
        ],
      },
      payment: { charges: { total: { amount: 1_200, currency_code: "EUR" } } },
    } as never)

    // The mapper does its half.
    expect(unified.items[0]!.notes).toContain("arachides")

    const { orderId } = (await t.run((ctx) =>
      ctx.runMutation(internal.orders.createFromWebhook, {
        storeId,
        externalOrderId: unified.externalOrderId,
        platform: "uberEats" as const,
        status: "pending" as const,
        type: "delivery" as const,
        customerName: unified.customer.name,
        items: unified.items.map((item) => ({
          externalId: item.externalId,
          name: item.name,
          quantity: item.quantity,
          price: item.totalPrice,
          modifiers: item.modifiers.map((mod) => ({
            externalId: mod.externalId,
            name: mod.name,
            price: mod.price,
          })),
          notes: item.notes,
        })),
        subtotal: unified.subtotal,
        total: unified.total,
        createdAt: NOW,
      })
    )) as { orderId: Id<"orders">; created: boolean }

    // The order keeps it — the validator used to reject the field outright.
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order!.items[0]!.notes).toContain("arachides")

    // And so does the slip. This is the exact call the webhook makes — same
    // mapping function, same internal mutation — so the assertion covers the
    // seam rather than one side of it.
    await t.run((ctx) =>
      ctx.runMutation(internal.kitchenTickets.internalCreate, {
        storeId,
        orderId,
        orderNumber: unified.displayId ?? "A1B2",
        orderType: "delivery" as const,
        items: toKitchenTicketItemsFromPlatform(unified.items),
        priority: "normal" as const,
        source: "uber_eats" as const,
        trackingToken: "ue-test-token",
        customerName: unified.customer.name,
      })
    )

    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticket, "a platform order never reached the kitchen").toBeDefined()
    expect(ticket!.items[0]!.notes).toContain("arachides")
  })
})

// ===========================================================================
// #137 — the screen survives a busy year
// ===========================================================================

describe("a store with 5,000 tickets", () => {
  async function seedTickets(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    count: number
  ) {
    await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "ARCHIVE",
        type: "pickup" as const,
        status: "completed" as const,
        customerInfo: { name: "Camille" },
        items: [],
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        source: "website" as const,
        paymentStatus: "paid" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("kitchenTickets", {
          storeId,
          orderId,
          orderNumber: `T-${i}`,
          orderType: "pickup" as const,
          items: [],
          priority: "normal" as const,
          source: "website" as const,
          status: "completed" as const,
          trackingToken: `tok-${i}`,
          printStatus: "not_required" as const,
          printAttempts: 0,
          createdAt: NOW - i * 60_000,
          updatedAt: NOW,
        })
      }
    })
  }

  test("does not hand the kitchen display its whole history", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    await seedTickets(t, storeId, 5_000)

    const live = await admin.query(api.kitchenTickets.getByStore, { storeId })
    // Completed tickets are history: the pass does not subscribe to them.
    expect(live).toHaveLength(0)
  })

  test("serves the completed tab one page at a time", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    await seedTickets(t, storeId, 5_000)

    const first = await admin.query(api.kitchenTickets.getByStatus, {
      storeId,
      status: "completed" as const,
      paginationOpts: { numItems: 50, cursor: null },
    })
    expect(first.page.length).toBeLessThanOrEqual(50)
    expect(first.isDone).toBe(false)

    const second = await admin.query(api.kitchenTickets.getByStatus, {
      storeId,
      status: "completed" as const,
      paginationOpts: { numItems: 50, cursor: first.continueCursor },
    })
    // The page moves rather than repeating itself.
    const firstIds = new Set(first.page.map((ticket) => ticket._id))
    expect(second.page.some((ticket) => firstIds.has(ticket._id))).toBe(false)
  })

  test("is pruned back by the retention sweep the cron runs", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedTickets(t, storeId, 10)

    // Age them past the window.
    await t.run(async (ctx) => {
      for (const ticket of await ctx.db.query("kitchenTickets").collect()) {
        await ctx.db.patch(ticket._id, { createdAt: NOW - 90 * 86_400_000 })
      }
    })

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.kitchenTickets.purgeExpiredTickets, {})
    )
    expect(result.deleted).toBe(10)
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(0)
  })
})

/**
 * The cap, as opposed to the status filter.
 *
 * The 5,000-ticket case above seeds `completed` rows, so `getByStore` answers
 * with nothing and the assertion passes on the status filter alone — the read
 * stayed green with `.take(ACTIVE_TICKET_LIMIT)` replaced by `.collect()`.
 * That leaves the cap itself unheld, and it is not redundant: the retention
 * sweep deliberately never deletes a ticket still on the pass, so an
 * establishment that leaves slips open has nothing else bounding the
 * subscription every tablet re-reads on every write.
 */
describe("a pass nobody ever cleared", () => {
  /** More live slips than the cap, so the cap is what decides the answer. */
  const OVERFLOW = 50

  async function seedLiveTickets(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    count: number
  ) {
    await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "OPEN",
        type: "pickup" as const,
        status: "pending" as const,
        customerInfo: { name: "Camille" },
        items: [],
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        source: "website" as const,
        paymentStatus: "paid" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("kitchenTickets", {
          storeId,
          orderId,
          orderNumber: `LIVE-${i}`,
          orderType: "pickup" as const,
          items: [],
          priority: "normal" as const,
          source: "website" as const,
          status: "pending" as const,
          trackingToken: `live-${i}`,
          printStatus: "not_required" as const,
          printAttempts: 0,
          createdAt: NOW - i * 60_000,
          updatedAt: NOW,
        })
      }
    })
  }

  test("is capped rather than served whole to every open tablet", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    await seedLiveTickets(t, storeId, ACTIVE_TICKET_LIMIT + OVERFLOW)

    const live = await admin.query(api.kitchenTickets.getByStore, { storeId })
    expect(live).toHaveLength(ACTIVE_TICKET_LIMIT)
  })

  test("keeps the oldest slips, which are the orders people are waiting for", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    await seedLiveTickets(t, storeId, ACTIVE_TICKET_LIMIT + OVERFLOW)

    const live = await admin.query(api.kitchenTickets.getByStore, { storeId })
    // Seeded newest-first, so the highest index is the oldest slip. Keeping the
    // newest instead would drop the longest-waiting orders off the screen, and
    // nobody would ever cook them.
    expect(live[0].orderNumber).toBe(`LIVE-${ACTIVE_TICKET_LIMIT + OVERFLOW - 1}`)
    expect(live[live.length - 1].orderNumber).toBe(`LIVE-${OVERFLOW}`)
  })
})
