// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The admin's queries, at the volume that used to take them down (NEW-P, J-1).
 *
 * WHY AN APP-LEVEL FILE AS WELL. The read-count guard in
 * `packages/convex-functions/src/__tests__/queryBounds.test.ts` proves the
 * queries stop reading; it runs against a double. What it cannot prove is that
 * the indexes those queries now name exist in the schema this app deploys —
 * `by_subscriber_type_occurredAt`, `by_storeId_provider_status` and the
 * re-ordered `by_automation_subscriber_occurrence_step` were all added for this
 * fix, and a `withIndex` on an index the deployment does not carry fails here
 * and nowhere else. The same reasoning as `prize-drain.test.ts`: the unit suite
 * calls the handlers past a hand-rolled `db`, which cannot show that an index
 * is real.
 *
 * Every case seeds more rows than the query under test may read.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

/** Comfortably more rows than any screen below is allowed to materialise. */
const BUSY = 400
const PAGE = 15

/** The zeroed shapes the schema demands; no test below reads them. */
const EMPTY_CAMPAIGN_STATS = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  unsubscribed: 0,
  converted: 0,
  revenue: 0,
}

const EMPTY_SUBSCRIBER_METADATA = {
  totalOrders: 0,
  totalSpent: 0,
  averageOrderValue: 0,
  favoriteProducts: [],
  orderTypes: [],
}

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

async function seedOwner(t: ReturnType<typeof convexTest>, storeIds: Id<"stores">[]) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "marie",
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "marie" })
}

const STATUSES = ["completed", "cancelled", "pending", "delivered"] as const

async function seedOrders(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  count: number,
  spacingMs = 60_000
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("orders", {
        storeId,
        orderNumber: `ORD-${i}`,
        customerInfo: { name: "Camille" },
        type: i % 2 === 0 ? ("delivery" as const) : ("pickup" as const),
        status: STATUSES[i % STATUSES.length],
        items: [],
        subtotal: 1000,
        taxAmount: 100,
        total: 1100,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW - i * spacingMs,
        updatedAt: NOW,
      })
    }
  })
}

/** The seven local midnights the browser sends, ending today. */
function dayStarts(): number[] {
  const midnight = new Date(NOW)
  midnight.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => midnight.getTime() - (6 - i) * DAY)
}

/** Tomorrow's local midnight — the exclusive end of today. */
function todayEnd(): number {
  const tomorrow = new Date(NOW)
  tomorrow.setHours(0, 0, 0, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow.getTime()
}

// ===========================================================================
// P-1 — /dashboard and /dashboard/orders
// ===========================================================================

describe("a restaurant with a year of orders", () => {
  test("the orders list serves one page rather than the history", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedOrders(t, storeId, BUSY)

    const first = await owner.query(api.orders.list, {
      storeId,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(first.page).toHaveLength(PAGE)
    expect(first.isDone).toBe(false)

    const second = await owner.query(api.orders.list, {
      storeId,
      paginationOpts: { numItems: PAGE, cursor: first.continueCursor },
    })
    const firstIds = new Set(first.page.map((order) => order._id))
    expect(second.page.some((order) => firstIds.has(order._id))).toBe(false)
  })

  test("a status tab is an index read, not a filtered download", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedOrders(t, storeId, BUSY)

    const page = await owner.query(api.orders.list, {
      storeId,
      status: "cancelled" as const,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(page.page).toHaveLength(PAGE)
    expect(page.page.every((order) => order.status === "cancelled")).toBe(true)
  })

  test("the dashboard receives its aggregates, not its orders", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedOrders(t, storeId, BUSY)

    const stats = await owner.query(api.orders.dashboardStats, {
      storeId,
      dayStarts: dayStarts(),
      todayEnd: todayEnd(),
      breakdownSince: NOW - 30 * DAY,
    })

    expect(stats.days).toHaveLength(7)
    expect(stats.today.orderCount).toBeGreaterThan(0)
    expect(stats.byType.length).toBeGreaterThan(0)
    // A cancelled order is not takings: a quarter of the seed is cancelled, so
    // the count must be below the number of orders in the window.
    expect(stats.today.orderCount).toBeLessThan(BUSY)
    expect(stats.truncated).toBe(false)
  })

  test("a status tab prints its dates in order, even with a late platform order", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    // Four native orders written as they were placed, then a platform webhook
    // arriving late for an order placed an hour earlier. `by_storeId_status`
    // alone orders by `_creationTime`, which would float the late row to the
    // top of the tab and make the Date column non-monotonic.
    await t.run(async (ctx) => {
      const placedAt = [0, 30, 60, 90].map((m) => NOW - m * 60_000)
      for (const [i, createdAt] of placedAt.entries()) {
        await ctx.db.insert("orders", {
          storeId,
          orderNumber: `NATIVE-${i}`,
          customerInfo: { name: "Camille" },
          type: "pickup" as const,
          status: "pending" as const,
          items: [],
          subtotal: 1000,
          taxAmount: 100,
          total: 1100,
          paymentStatus: "paid" as const,
          source: "website" as const,
          createdAt,
          updatedAt: NOW,
        })
      }
      await ctx.db.insert("orders", {
        storeId,
        orderNumber: "UBER-LATE",
        customerInfo: { name: "Camille" },
        type: "delivery" as const,
        status: "pending" as const,
        items: [],
        subtotal: 1000,
        taxAmount: 100,
        total: 1100,
        paymentStatus: "paid" as const,
        source: "uber_eats" as const,
        createdAt: NOW - 45 * 60_000,
        updatedAt: NOW,
      })
    })

    const page = await owner.query(api.orders.list, {
      storeId,
      status: "pending" as const,
      paginationOpts: { numItems: 10, cursor: null },
    })
    const dates = page.page.map((order) => order.createdAt)
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
    expect(page.page[0]!.orderNumber).toBe("NATIVE-0")
  })

  test("serves a clamped page however large a page the caller asks for", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedOrders(t, storeId, BUSY)

    const page = await owner.query(api.orders.list, {
      storeId,
      paginationOpts: { numItems: 1_000_000, cursor: null },
    })
    expect(page.page.length).toBeLessThanOrEqual(200)
    expect(page.isDone).toBe(false)
  })

  test("the recent-orders table is ten rows whatever the history", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedOrders(t, storeId, BUSY)

    const rows = await owner.query(api.orders.recent, { storeId })
    expect(rows).toHaveLength(10)
    // Newest first: this is "dernières commandes", not "the first ten ever".
    expect(rows[0]!.orderNumber).toBe("ORD-0")
  })

  test("the account page reads a page of the customer's own history", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    // Inserted oldest first, which is the only order a real restaurant writes
    // them in: `by_customerId` carries no timestamp, so "newest" here is
    // Convex's creation order, and for an order that is when it was placed.
    await t.run(async (ctx) => {
      for (let i = 119; i >= 0; i--) {
        await ctx.db.insert("orders", {
          storeId,
          orderNumber: `MINE-${i}`,
          customerId: "camille",
          customerInfo: { name: "Camille" },
          type: "pickup" as const,
          status: "completed" as const,
          items: [],
          subtotal: 1000,
          taxAmount: 100,
          total: 1100,
          paymentStatus: "paid" as const,
          source: "website" as const,
          createdAt: NOW - i * 60_000,
          updatedAt: NOW,
        })
      }
    })

    const mine = await t.withIdentity({ subject: "camille" }).query(api.orders.getMyOrders, {})
    expect(mine).toHaveLength(50)
    expect(mine[0]!.orderNumber).toBe("MINE-0")
  })
})

// ===========================================================================
// P-3 — /dashboard/payments
// ===========================================================================

describe("a ledger with a year of payments", () => {
  const PROVIDERS = ["stripe", "sumup", "paypal", "cash"] as const
  const PAYMENT_STATUSES = ["succeeded", "pending", "refunded", "failed"] as const

  async function seedPayments(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "LEDGER",
        customerInfo: { name: "Camille" },
        type: "pickup" as const,
        status: "completed" as const,
        items: [],
        subtotal: 1000,
        taxAmount: 100,
        total: 1100,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < BUSY; i++) {
        await ctx.db.insert("payments", {
          orderId,
          storeId,
          amount: 1100,
          currency: "EUR",
          provider: PROVIDERS[i % PROVIDERS.length],
          status: PAYMENT_STATUSES[i % PAYMENT_STATUSES.length],
          createdAt: NOW - i * 60_000,
          updatedAt: NOW,
        })
      }
    })
  }

  test("serves one page", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedPayments(t, storeId)

    const page = await owner.query(api.payments.getByStore, {
      storeId,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(page.page).toHaveLength(PAGE)
    expect(page.isDone).toBe(false)
  })

  test("resolves the status filter through `by_storeId_status`", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedPayments(t, storeId)

    const page = await owner.query(api.payments.getByStore, {
      storeId,
      status: "refunded" as const,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(page.page).toHaveLength(PAGE)
    expect(page.page.every((payment) => payment.status === "refunded")).toBe(true)
  })

  test("resolves both filters through `by_storeId_provider_status`", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedPayments(t, storeId)

    const page = await owner.query(api.payments.getByStore, {
      storeId,
      provider: "cash" as const,
      status: "succeeded" as const,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(
      page.page.every((p) => p.provider === "cash" && p.status === "succeeded")
    ).toBe(true)
  })
})

// ===========================================================================
// P-2 — the gamification screens
// ===========================================================================

describe("a QR game that has been scanned all year", () => {
  async function seedPlays(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    await t.run(async (ctx) => {
      const gameId = await ctx.db.insert("games", {
        storeId,
        type: "wheel" as const,
        name: "Roue",
        winRatio: 50,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const prizeId = await ctx.db.insert("prizes", {
        storeId,
        name: "Café offert",
        type: "free_product" as const,
        validityDays: 30,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < BUSY; i++) {
        // Half of them a year old: outside the window the screens describe.
        const playedAt = i % 2 === 0 ? NOW - i * 60_000 : NOW - 300 * DAY
        const gamePlayId = await ctx.db.insert("gamePlays", {
          storeId,
          gameId,
          completedActions: [],
          didWin: i % 2 === 0,
          playedAt,
          createdAt: playedAt,
          updatedAt: playedAt,
        })
        // Every fourth play wins, split evenly between the recent half of the
        // seed and the year-old half — so half the prizes below are expired.
        if (i % 4 === 0 || i % 4 === 1) {
          // A prize is valid for a month from the play that won it: the old
          // half of this seed is expired, which is what makes the live count
          // worth asserting.
          await ctx.db.insert("prizeRedemptions", {
            storeId,
            gamePlayId,
            prizeId,
            redemptionCode: `CODE${i}`,
            status: "pending" as const,
            expiresAt: playedAt + 30 * DAY,
            createdAt: playedAt,
            updatedAt: playedAt,
          })
        }
      }
    })
  }

  test("counts the window rather than every scan ever taken", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedPlays(t, storeId)

    const stats = await owner.query(api.prizeRedemptions.getStats, { storeId })

    // Only the recent half is inside the thirty-day window.
    expect(stats.totalPlays).toBe(BUSY / 2)
    expect(stats.totalWins).toBe(BUSY / 2)
    expect(stats.winRate).toBe(100)
    expect(stats.since).toBeLessThan(NOW)
    expect(stats.truncated).toBe(false)
  })

  test("counts the prizes still waiting at the till whatever their age", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedPlays(t, storeId)

    const stats = await owner.query(api.prizeRedemptions.getStats, { storeId })
    // 200 redemptions exist; only the 100 from the recent half are still
    // claimable. The expired ones are never read at all — `expiresAt` is in the
    // index, not a filter applied to a year of dead rows.
    expect(await t.run((ctx) => ctx.db.query("prizeRedemptions").collect())).toHaveLength(
      BUSY / 2
    )
    expect(stats.pendingRedemptions).toBe(BUSY / 4)
  })
})

// ===========================================================================
// P-4 and J-1 — the email dispatcher
// ===========================================================================

describe("an automation with a mailing list behind it", () => {
  async function seedAutomation(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    return t.run(async (ctx) => {
      const automationId = await ctx.db.insert("emailAutomations", {
        storeId,
        name: "Merci",
        trigger: "post_order" as const,
        status: "active" as const,
        steps: [],
        stats: EMPTY_CAMPAIGN_STATS,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const subscriberIds: Id<"emailSubscribers">[] = []
      for (let s = 0; s < 30; s++) {
        const subscriberId = await ctx.db.insert("emailSubscribers", {
          storeId,
          email: `diner${s}@example.fr`,
          status: "active" as const,
          source: "order" as const,
          tags: [],
          consentAt: NOW,
          consentSource: "checkout",
          bounceCount: 0,
          metadata: EMPTY_SUBSCRIBER_METADATA,
          createdAt: NOW,
          updatedAt: NOW,
        })
        subscriberIds.push(subscriberId)
        for (const stepId of ["welcome", "reminder", "offer"]) {
          await ctx.db.insert("emailAutomationRuns", {
            automationId,
            subscriberId,
            storeId,
            stepId,
            occurrenceKey: "orders:1",
            sentAt: NOW,
          })
        }
      }
      return { automationId, subscriberIds }
    })
  }

  test("`stepsSentTo` answers for one subscriber's firing", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const { automationId, subscriberIds } = await seedAutomation(t, storeId)

    const steps = await t.run((ctx) =>
      ctx.runQuery(internal.emailAutomationRuns.stepsSentTo, {
        automationId,
        subscriberId: subscriberIds[7]!,
        occurrenceKey: "orders:1",
      })
    )
    expect([...steps].sort()).toEqual(["offer", "reminder", "welcome"])
  })

  test("a second order gets a sequence that has not already run", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const { automationId, subscriberIds } = await seedAutomation(t, storeId)

    const steps = await t.run((ctx) =>
      ctx.runQuery(internal.emailAutomationRuns.stepsSentTo, {
        automationId,
        subscriberId: subscriberIds[7]!,
        occurrenceKey: "orders:2",
      })
    )
    expect(steps).toEqual([])
  })

  test("`record` stays idempotent on the re-ordered index", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const { automationId, subscriberIds } = await seedAutomation(t, storeId)

    await t.run((ctx) =>
      ctx.runMutation(internal.emailAutomationRuns.record, {
        automationId,
        subscriberId: subscriberIds[3]!,
        storeId,
        stepId: "welcome",
        occurrenceKey: "orders:1",
      })
    )
    const rows = await t.run((ctx) => ctx.db.query("emailAutomationRuns").collect())
    // 30 subscribers × 3 steps, and the duplicate send wrote nothing.
    expect(rows).toHaveLength(90)
  })

  test("`sentCountsSince` counts the week, not the lifetime", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const subscriberId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("emailSubscribers", {
        storeId,
        email: "loyal@example.fr",
        status: "active" as const,
        source: "order" as const,
        tags: [],
        consentAt: NOW,
        consentSource: "checkout",
        bounceCount: 0,
        metadata: EMPTY_SUBSCRIBER_METADATA,
        createdAt: NOW,
        updatedAt: NOW,
      })
      // A loyal customer: hundreds of events, two of them inside the week.
      for (let i = 0; i < BUSY; i++) {
        await ctx.db.insert("emailEvents", {
          storeId,
          subscriberId: id,
          type: i % 2 === 0 ? ("sent" as const) : ("opened" as const),
          occurredAt: NOW - 30 * DAY - i * 1_000,
        })
      }
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("emailEvents", {
          storeId,
          subscriberId: id,
          type: "sent" as const,
          occurredAt: NOW - i * 1_000,
        })
      }
      return id
    })

    const counts = await t.run((ctx) =>
      ctx.runQuery(internal.emailEvents.sentCountsSince, {
        subscriberIds: [subscriberId],
        since: NOW - 7 * DAY,
        countLimit: 3,
      })
    )
    expect(counts).toEqual([{ subscriberId, count: 2 }])
  })

  /**
   * One subscriber and the events that decide their cap verdict.
   *
   * The four cases below are about `sentCountsSince` alone, so the fixture is a
   * subscriber and their events and nothing else: an automation or a campaign
   * would only add rows this query never looks at.
   */
  async function seedSubscriberWithEvents(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    email: string,
    events: Array<{
      type: "sent" | "delivered" | "opened" | "clicked"
      occurredAt: number
    }>
  ) {
    return t.run(async (ctx) => {
      const subscriberId = await ctx.db.insert("emailSubscribers", {
        storeId,
        email,
        status: "active" as const,
        source: "order" as const,
        tags: [],
        consentAt: NOW,
        consentSource: "checkout",
        bounceCount: 0,
        metadata: EMPTY_SUBSCRIBER_METADATA,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (const event of events) {
        await ctx.db.insert("emailEvents", { storeId, subscriberId, ...event })
      }
      return subscriberId
    })
  }

  /** `n` sends, all inside the week the cap is measured over. */
  const sendsThisWeek = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "sent" as const,
      occurredAt: NOW - i * 1_000,
    }))

  test("`sentCountsSince` stops at the cap, however much went out this week", async () => {
    /*
     * The case above bounds the read by the WEEK. This one bounds it by the
     * CAP, and the two are not the same guarantee: a week is only a few rows
     * while the store behaves, and a store mailing its whole list daily is
     * precisely the one the cap exists for — so the unbounded read would come
     * back exactly when it is least affordable.
     *
     * Six sends, a cap of three, and the answer is three. `withinWeeklyCap`
     * asks `count < cap` and nothing else, so 3 and 6 fail it identically. The
     * number is a verdict, not a statistic; do not repurpose it as one.
     */
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriberWithEvents(
      t,
      storeId,
      "everyday@example.fr",
      sendsThisWeek(6)
    )

    const counts = await t.run((ctx) =>
      ctx.runQuery(internal.emailEvents.sentCountsSince, {
        subscriberIds: [subscriberId],
        since: NOW - 7 * DAY,
        countLimit: 3,
      })
    )
    expect(counts).toEqual([{ subscriberId, count: 3 }])
  })

  test("a countLimit of zero does not report a mailed subscriber as unmailed", async () => {
    /*
     * The floor inside `clampPageSize`, load-bearing in the direction that is
     * easy to miss. A zero reaching `.take(0)` returns no rows, the count comes
     * back as zero for somebody who HAS been mailed, and `withinWeeklyCap(0,
     * cap)` then waves every subscriber through — the guard switched off by the
     * one value that looks like it should tighten it hardest.
     *
     * `resolveWeeklyCap` is why the real caller cannot send a zero: it is the
     * single definition of a cap and it refuses a non-positive one. This pins
     * the behaviour for everything else that can reach the query.
     */
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriberWithEvents(
      t,
      storeId,
      "mailed@example.fr",
      sendsThisWeek(2)
    )

    const counts = await t.run((ctx) =>
      ctx.runQuery(internal.emailEvents.sentCountsSince, {
        subscriberIds: [subscriberId],
        since: NOW - 7 * DAY,
        countLimit: 0,
      })
    )
    // One, not zero, and one is enough: the caller compares it against the real
    // cap, so a saturated count is never mistaken for "never mailed".
    expect(counts).toEqual([{ subscriberId, count: 1 }])
  })

  test("a delivery, an open or a click inside the week is not a send", async () => {
    /*
     * The type filter, tested INSIDE the window rather than outside it. The
     * case above puts its `opened` rows a month back, so an index that had lost
     * its `type` column would still answer correctly there — the window alone
     * would hide the fault. Here every row is inside the week and only one of
     * them is a send.
     */
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriberWithEvents(
      t,
      storeId,
      "engaged@example.fr",
      [
        { type: "sent" as const, occurredAt: NOW - 3 * DAY },
        { type: "delivered" as const, occurredAt: NOW - 3 * DAY + 1_000 },
        { type: "opened" as const, occurredAt: NOW - 2 * DAY },
        { type: "clicked" as const, occurredAt: NOW - 2 * DAY + 1_000 },
      ]
    )

    const counts = await t.run((ctx) =>
      ctx.runQuery(internal.emailEvents.sentCountsSince, {
        subscriberIds: [subscriberId],
        since: NOW - 7 * DAY,
        countLimit: 3,
      })
    )
    expect(counts).toEqual([{ subscriberId, count: 1 }])
  })

  test("each subscriber is counted from their own events", async () => {
    /*
     * Asked once for the whole page, so the answers have to come back
     * attributed. A query that counted the batch rather than each subscriber
     * would hold the quiet ones back on the busy ones' behalf, and nothing else
     * here would notice: every other case asks about a single subscriber.
     */
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const busy = await seedSubscriberWithEvents(
      t,
      storeId,
      "busy@example.fr",
      sendsThisWeek(2)
    )
    const quiet = await seedSubscriberWithEvents(
      t,
      storeId,
      "quiet@example.fr",
      sendsThisWeek(1)
    )

    const counts = await t.run((ctx) =>
      ctx.runQuery(internal.emailEvents.sentCountsSince, {
        subscriberIds: [busy, quiet],
        since: NOW - 7 * DAY,
        countLimit: 3,
      })
    )
    expect(counts).toEqual([
      { subscriberId: busy, count: 2 },
      { subscriberId: quiet, count: 1 },
    ])
  })
})

// ===========================================================================
// B4 — the mailing list, and the homepage that reads the order book
// ===========================================================================

describe("a mailing list that has succeeded", () => {
  const SUBSCRIBER_STATUSES = [
    "active",
    "pending",
    "unsubscribed",
    "bounced",
    "complained",
  ] as const

  async function seedSubscribers(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    count = BUSY
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("emailSubscribers", {
          storeId,
          email: `diner${i}@example.fr`,
          status: SUBSCRIBER_STATUSES[i % SUBSCRIBER_STATUSES.length]!,
          source: i % 3 === 0 ? ("import" as const) : ("storefront_form" as const),
          tags: i % 4 === 0 ? ["vip"] : [],
          consentAt: NOW,
          consentSource: "checkout",
          bounceCount: 0,
          metadata: {
            ...EMPTY_SUBSCRIBER_METADATA,
            totalSpent: (i % 10) * 1_000,
          },
          createdAt: NOW - i * 1_000,
          updatedAt: NOW,
        })
      }
    })
  }

  test("the audience page serves one page rather than the list", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedSubscribers(t, storeId)

    const first = await owner.query(api.emailSubscribers.list, {
      storeId,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(first.page).toHaveLength(PAGE)
    expect(first.isDone).toBe(false)

    const second = await owner.query(api.emailSubscribers.list, {
      storeId,
      paginationOpts: { numItems: PAGE, cursor: first.continueCursor },
    })
    const firstIds = new Set(first.page.map((s) => s._id))
    expect(second.page.some((s) => firstIds.has(s._id))).toBe(false)
  })

  test("a status tab is an index read on `by_storeId_status`", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedSubscribers(t, storeId)

    const page = await owner.query(api.emailSubscribers.list, {
      storeId,
      status: "bounced" as const,
      paginationOpts: { numItems: PAGE, cursor: null },
    })
    expect(page.page).toHaveLength(PAGE)
    expect(page.page.every((s) => s.status === "bounced")).toBe(true)
  })

  test("serves a clamped page however large a page the caller asks for", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedSubscribers(t, storeId)

    const page = await owner.query(api.emailSubscribers.list, {
      storeId,
      paginationOpts: { numItems: 1_000_000, cursor: null },
    })
    expect(page.page.length).toBeLessThanOrEqual(200)
  })

  test("the dashboard counts through the index rather than downloading the list", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedSubscribers(t, storeId)

    const counts = await owner.query(api.emailSubscribers.countByStatus, { storeId })
    // Five equal slices of the seed, and the cap is far above them: exact.
    expect(counts.active).toBe(BUSY / SUBSCRIBER_STATUSES.length)
    expect(counts.total).toBe(BUSY)
    expect(counts.truncated).toBe(false)
  })

  test("the segment preview says which population its count describes", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])
    await seedSubscribers(t, storeId)

    const preview = await owner.query(api.emailSegments.countMatchingSubscribers, {
      storeId,
      rules: [
        { id: "r1", field: "metadata.totalSpent", operator: "gte" as const, value: "5000" },
      ],
      ruleOperator: "and" as const,
    })
    // Only the active fifth of the seed is an audience at all.
    expect(preview.scanned).toBe(BUSY / SUBSCRIBER_STATUSES.length)
    expect(preview.count).toBeGreaterThan(0)
    expect(preview.count).toBeLessThanOrEqual(preview.scanned)
    expect(preview.truncated).toBe(false)
  })
})

describe("a homepage carousel on a busy month", () => {
  async function seedSoldOrders(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    distinctProducts = 12
  ) {
    return t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        storeId,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const productIds: Id<"products">[] = []
      for (let i = 0; i < distinctProducts; i++) {
        productIds.push(
          await ctx.db.insert("products", {
            storeId,
            categoryId,
            name: `Plat ${i}`,
            slug: `plat-${i}`,
            price: 1_200,
            taxRate: 10,
            images: [],
            options: [],
            allergens: [],
            tags: [],
            // The last one is de-listed: a carousel must not offer a dish the
            // kitchen has taken off the menu, however well it sold.
            isActive: i < distinctProducts - 1,
            isFeatured: false,
            sortOrder: i,
            source: "manual",
            createdAt: NOW,
            updatedAt: NOW,
          })
        )
      }

      for (let i = 0; i < BUSY; i++) {
        await ctx.db.insert("orders", {
          storeId,
          orderNumber: `SOLD-${i}`,
          customerInfo: { name: "Camille" },
          type: "pickup" as const,
          // A cancelled order sold nothing, and a pending one has not sold yet.
          status: i % 9 === 0 ? ("cancelled" as const) : ("completed" as const),
          items: [
            {
              productId: productIds[i % distinctProducts]!,
              productName: `Plat ${i % distinctProducts}`,
              quantity: 1,
              unitPrice: 1_200,
              selectedOptions: [],
              subtotal: 1_200,
            },
          ],
          subtotal: 1_200,
          taxAmount: 120,
          total: 1_320,
          paymentStatus: "paid" as const,
          source: "website" as const,
          createdAt: NOW - i * 60_000,
          updatedAt: NOW,
        })
      }
      return productIds
    })
  }

  test("ranks a window of recent orders, and skips what is off the menu", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const productIds = await seedSoldOrders(t, storeId)

    // No identity: this is the storefront's own query, on the public homepage.
    const trending = await t.query(api.products.getTrending, { storeId })

    expect(trending.length).toBeGreaterThan(0)
    expect(trending.length).toBeLessThanOrEqual(8)
    expect(trending.every((p) => p.isActive)).toBe(true)
    expect(trending.some((p) => p._id === productIds[productIds.length - 1])).toBe(false)
  })

  test("refuses a carousel the size of the catalogue because a visitor asked", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    await seedSoldOrders(t, storeId)

    const trending = await t.query(api.products.getTrending, { storeId, limit: 1_000_000 })
    expect(trending.length).toBeLessThanOrEqual(24)
  })
})

describe("the scheduled-campaign sweep", () => {
  test("finds the due campaign through `by_storeId_status`, not by scanning the archive", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)

    const dueId = await t.run(async (ctx) => {
      const templateId = await ctx.db.insert("emailTemplates", {
        storeId,
        name: "Nouveautés",
        subject: "Du nouveau chez Luigi",
        blocks: [],
        category: "marketing" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const campaign = (
        status: "draft" | "scheduled" | "sent",
        scheduledAt: number | undefined,
        name: string
      ) =>
        ctx.db.insert("emailCampaigns", {
          storeId,
          name,
          subject: "Du nouveau chez Luigi",
          templateId,
          status,
          scheduledAt,
          abTestEnabled: false,
          stats: EMPTY_CAMPAIGN_STATS,
          createdAt: NOW,
          updatedAt: NOW,
        })

      // An archive of campaigns that have already gone out, which the sweep
      // used to read in full once a minute for ever.
      for (let i = 0; i < BUSY; i++) {
        await campaign(i % 2 === 0 ? "sent" : "draft", NOW - DAY, `ARCHIVE-${i}`)
      }
      await campaign("scheduled", NOW + DAY, "PLUS TARD")
      return campaign("scheduled", NOW - 60_000, "MAINTENANT")
    })

    const due = await t.run((ctx) =>
      ctx.runQuery(internal.emailCampaigns.dueForSending, { now: NOW })
    )
    expect(due).toEqual([dueId])
  })
})

// ===========================================================================
// The sweep — a coupon that worked is kept, not swept
// ===========================================================================

/**
 * REWRITTEN for #412 P3-F4. This case asserted that deleting a coupon with 600
 * redemptions removed the offer in the first transaction and drained its ledger
 * afterwards. It was green, and what it was pinning was the defect: the same
 * delete left every order that coupon had discounted naming a promotion that no
 * longer resolved, with the discount still on the order and on its invoice.
 * `promotions.remove` refuses a redeemed coupon now, and the way out —
 * deactivation — was already on the screen.
 */
describe("deleting a promotion that was used all year", () => {
  test("refuses, and keeps both the coupon and its usage record", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    const promotionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("promotions", {
        storeId,
        name: "Bienvenue",
        triggerMode: "coupon" as const,
        couponCode: "BIENVENUE",
        discountType: "percentage" as const,
        discountValue: 10,
        scope: "order" as const,
        startDate: NOW - DAY,
        endDate: NOW + 30 * DAY,
        usageCount: 600,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert("promotionUsages", {
          promotionId: id,
          storeId,
          customerEmail: `diner${i}@example.fr`,
          usedAt: NOW,
        })
      }
      return id
    })

    await expect(
      owner.mutation(api.promotions.remove, { id: promotionId })
    ).rejects.toThrow(/Désactivez-la/)

    // Refused means refused, on both sides of the reference.
    expect(await t.run((ctx) => ctx.db.get(promotionId))).not.toBeNull()
    expect(await t.run((ctx) => ctx.db.query("promotionUsages").collect())).toHaveLength(600)
  })

  test("still deletes a coupon nobody ever redeemed", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    const promotionId = await t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId,
        name: "Jamais utilisée",
        triggerMode: "coupon" as const,
        couponCode: "OOPS",
        discountType: "percentage" as const,
        discountValue: 10,
        scope: "order" as const,
        startDate: NOW - DAY,
        endDate: NOW + 30 * DAY,
        usageCount: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await owner.mutation(api.promotions.remove, { id: promotionId })
    expect(await t.run((ctx) => ctx.db.get(promotionId))).toBeNull()
  })
})
