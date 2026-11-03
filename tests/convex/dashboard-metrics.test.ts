// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The overview's three new metrics, and who may read any of them (#365).
 *
 * TWO THINGS THIS FILE EXISTS FOR, neither of them provable in the pure module:
 *
 * 1. `analytics:read`. It and `analytics:view_all` were declared in
 *    `packages/core/src/auth/rbac.ts` and consumed by nothing at all, while a
 *    `kitchen` account — which holds `orders:read` so it can work the pass —
 *    could read the establishment's turnover, average basket and best-selling
 *    dishes. Turnover is not pass information.
 *
 * 2. The second read. « Taux de retour » is a question about a diner's FIRST
 *    EVER order, which the orders inside a 30-day window cannot answer: a
 *    regular of two years and somebody's first visit look identical there. The
 *    figure comes from `customers.firstOrderAt`, over the table #364 built, and
 *    a test over the pure function alone would pass while that read was absent.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

/** A local midnight, so the hour buckets read as clock time. */
const MONDAY = new Date("2026-03-16T00:00:00").getTime()
const HOUR = 3_600_000

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

/** A catalogue product, so `items.productId` can hold a real id. */
async function seedProduct(t: ReturnType<typeof convexTest>, storeId: Id<"stores">, name: string) {
  const categoryId = await t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name: "Plats",
      slug: "plats",
      sortOrder: 0,
      isActive: true,
      createdAt: MONDAY,
      updatedAt: MONDAY,
    })
  )
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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
      createdAt: MONDAY,
      updatedAt: MONDAY,
    })
  )
}

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizza Napoli",
      slug: "pizza-napoli",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: MONDAY,
      updatedAt: MONDAY,
    })
  )
}

type Role = "client_admin" | "manager" | "kitchen" | "waiter" | "delivery"

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
  storeIds: Id<"stores">[],
  permissions: string[] = []
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions,
      language: "fr",
      twoFactorEnabled: false,
      createdAt: MONDAY,
      updatedAt: MONDAY,
    })
  )
  return t.withIdentity({ subject })
}

let orderSeq = 0

async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: {
    createdAt?: number
    total?: number
    email?: string
    productId?: Id<"products">
    productName?: string
    quantity?: number
    subtotal?: number
    status?: "completed" | "cancelled" | "pending"
    paymentStatus?: "paid" | "pending"
  } = {}
) {
  orderSeq += 1
  const email = over.email ?? "marie@example.fr"
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `ORD-${String(orderSeq).padStart(4, "0")}`,
      customerInfo: {
        name: "Marie Dupont",
        ...(email === "" ? {} : { email }),
      },
      ...(email === "" ? {} : { customerEmailKey: email }),
      type: "pickup" as const,
      status: over.status ?? ("completed" as const),
      items: [
        {
          ...(over.productId ? { productId: over.productId } : {}),
          productName: over.productName ?? "Margherita",
          quantity: over.quantity ?? 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: over.subtotal ?? 1_200,
        },
      ],
      subtotal: 1_200,
      taxAmount: 120,
      total: over.total ?? 1_320,
      paymentStatus: over.paymentStatus ?? ("paid" as const),
      source: "website" as const,
      createdAt: over.createdAt ?? MONDAY + 12 * HOUR,
      updatedAt: over.createdAt ?? MONDAY + 12 * HOUR,
    })
  )
}

/** A seven-day period ending on the Monday the orders are on. */
function windows(days = 7) {
  const dayStarts: number[] = []
  for (let back = days - 1; back >= 0; back--) {
    dayStarts.push(MONDAY - back * 24 * HOUR)
  }
  return {
    dayStarts,
    todayEnd: MONDAY + 24 * HOUR,
    breakdownSince: dayStarts[0] as number,
  }
}

// ============================================================================
// Who may read the establishment's figures
// ============================================================================

describe("the analytics gate", () => {
  test("an owner may read them", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await expect(
      asOwner.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).resolves.toBeDefined()
  })

  test("a manager may read them", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asManager = await seedUser(t, "boss", "manager", [storeId])

    await expect(
      asManager.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).resolves.toBeDefined()
  })

  test("a kitchen account may not, though it holds orders:read", async () => {
    // The defect this closes: `orders:read` is what lets the pass see the
    // tickets, and it was the whole of the gate on the takings.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(
      asKitchen.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).rejects.toThrow()
  })

  test("nor may a waiter or a driver", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asWaiter = await seedUser(t, "server", "waiter", [storeId])
    const asDriver = await seedUser(t, "driver", "delivery", [storeId])

    await expect(
      asWaiter.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).rejects.toThrow()
    await expect(
      asDriver.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).rejects.toThrow()
  })

  test("the recent-orders table stays open to them", async () => {
    // The screen is where every login lands. Gating the figures must not take
    // the page away from the people who work from it.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(asKitchen.query(api.orders.recent, { storeId })).resolves.toBeDefined()
  })

  test("a manager whose owner unticked the analytics module may not", async () => {
    // The server's second gate. A role that permits it and a profile that does
    // not is a refusal, and it is the reason the permission NAME matters.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asManager = await seedUser(t, "boss", "manager", [storeId], ["orders"])

    await expect(
      asManager.query(api.orders.dashboardStats, { storeId, ...windows() })
    ).rejects.toThrow()
  })
})

// ============================================================================
// The figures themselves, over the real read
// ============================================================================

describe("the three metrics", () => {
  test("rank the dishes over the whole period", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    const margherita = await seedProduct(t, storeId, "Margherita")
    const burger = await seedProduct(t, storeId, "Burger")

    await seedOrder(t, storeId, {
      productId: margherita,
      productName: "Margherita",
      quantity: 1,
      subtotal: 1_200,
      createdAt: MONDAY - 3 * 24 * HOUR + 12 * HOUR,
    })
    await seedOrder(t, storeId, {
      productId: burger,
      productName: "Burger",
      quantity: 4,
      subtotal: 3_600,
    })

    const stats = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(),
    })
    expect(stats.topProducts.map((p: { name: string }) => p.name)).toEqual([
      "Burger",
      "Margherita",
    ])
  })

  test("profile the trading day in local hours", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { createdAt: MONDAY + 12 * HOUR })
    await seedOrder(t, storeId, { createdAt: MONDAY + 12 * HOUR + 40 * 60_000 })
    await seedOrder(t, storeId, { createdAt: MONDAY + 20 * HOUR })

    const stats = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(),
    })
    expect(stats.hourly).toHaveLength(24)
    expect(stats.hourly[12].orders).toBe(2)
    expect(stats.hourly[20].orders).toBe(1)
  })

  test("read the return rate from the customer book, not from the window", async () => {
    /*
     * THE READ THIS FILE EXISTS FOR. Both diners have exactly one order inside
     * the period, so nothing in the orders distinguishes them. `customers`
     * does: one has been coming for three months, the other arrived today.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { email: "regular@example.fr" })
    await seedOrder(t, storeId, { email: "firsttime@example.fr" })

    await t.run(async (ctx) => {
      const base = {
        storeId,
        totalOrders: 1,
        totalSpent: 1_320,
        averageOrderValue: 1_320,
        orderTypes: ["pickup"],
        favoriteProducts: [],
        createdAt: MONDAY,
        updatedAt: MONDAY,
      }
      await ctx.db.insert("customers", {
        ...base,
        email: "regular@example.fr",
        name: "Régulier",
        firstOrderAt: MONDAY - 90 * 24 * HOUR,
        lastOrderAt: MONDAY + 12 * HOUR,
      })
      await ctx.db.insert("customers", {
        ...base,
        email: "firsttime@example.fr",
        name: "Nouveau",
        firstOrderAt: MONDAY + 12 * HOUR,
        lastOrderAt: MONDAY + 12 * HOUR,
      })
    })

    const stats = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(),
    })
    expect(stats.diners).toMatchObject({
      identified: 2,
      returning: 1,
      newcomers: 1,
      returningRate: 0.5,
    })
  })

  test("do not count a diner whose last order predates the period", async () => {
    // The read walks `by_storeId_lastOrderAt` descending and stops. Somebody
    // who has not been in for a year is not a diner of this period.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await t.run((ctx) =>
      ctx.db.insert("customers", {
        storeId,
        email: "gone@example.fr",
        name: "Parti",
        totalOrders: 5,
        totalSpent: 6_600,
        averageOrderValue: 1_320,
        orderTypes: ["pickup"],
        favoriteProducts: [],
        firstOrderAt: MONDAY - 400 * 24 * HOUR,
        lastOrderAt: MONDAY - 300 * 24 * HOUR,
        createdAt: MONDAY,
        updatedAt: MONDAY,
      })
    )

    const stats = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(),
    })
    expect(stats.diners.identified).toBe(0)
    expect(stats.diners.returningRate).toBe(0)
  })

  test("name the orders no diner can be attributed to", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { email: "" })
    await seedOrder(t, storeId, { email: "" })

    const stats = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(),
    })
    expect(stats.diners.anonymousOrders).toBe(2)
    expect(stats.diners.identified).toBe(0)
  })
})

// ============================================================================
// The period
// ============================================================================

describe("the period", () => {
  test("a 30-day period reads a 30-day window", async () => {
    // The literal this replaces was seven, and nothing could change it.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { createdAt: MONDAY - 20 * 24 * HOUR + 12 * HOUR })

    const week = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(7),
    })
    const month = await asOwner.query(api.orders.dashboardStats, {
      storeId,
      ...windows(30),
    })

    expect(week.days).toHaveLength(7)
    expect(month.days).toHaveLength(30)
    expect(week.topProducts).toEqual([])
    expect(month.topProducts[0].quantity).toBe(1)
  })

  test("refuses a period longer than the chart can bucket", async () => {
    // `MAX_DAY_BUCKETS` is 31, and the hour buckets are derived from these same
    // boundaries — so an unbounded list is not a bigger chart, it is a
    // transaction that reads more than it should.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await expect(
      asOwner.query(api.orders.dashboardStats, { storeId, ...windows(40) })
    ).rejects.toThrow()
  })
})
