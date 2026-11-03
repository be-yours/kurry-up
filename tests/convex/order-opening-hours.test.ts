// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The restaurant's opening hours, enforced where they can hold.
 *
 * `isOrderableStore` answers for the status an owner sets by hand and says so
 * itself: hours are "a separate question, answered in the storefront". Nothing
 * flips `status` on a schedule — there is no such cron — so the weekly week the
 * dashboard writes was honoured by exactly one thing: a `toast.error` on the
 * checkout page. A tab left open past closing, a cart restored from
 * localStorage, or a direct call to the mutation each produced an order at 4
 * a.m. in an empty building.
 *
 * The rule itself is `isWithinBusinessHours` in `@be-yours/convex-schema`,
 * covered by `openingHours.test.ts` there — the same function `useStoreStatus`
 * calls, so the browser's toast and this refusal cannot drift apart. What is
 * held here is that the mutation actually asks it.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorCode } from "../../lib/convex-error"

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 3 July 2029, 12:00 UTC — 14:00 in Paris. */
const TUESDAY_NOON_UTC = Date.UTC(2029, 6, 3, 12, 0, 0)
/** 04:00 the same morning, in Paris. */
const TUESDAY_0400_PARIS = Date.UTC(2029, 6, 3, 2, 0, 0)

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

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
  vi.setSystemTime(TUESDAY_NOON_UTC)
})

afterEach(() => {
  vi.useRealTimers()
})

const week = (open: string, close: string, isClosed = false) =>
  Array.from({ length: 7 }, (_, day) => ({ day, open, close, isClosed }))

const LUNCH_ONLY = week("11:00", "14:00")

async function seedStore(
  t: ReturnType<typeof convexTest>,
  hours = LUNCH_ONLY,
  extra: Record<string, unknown> = {}
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
      createdAt: TUESDAY_NOON_UTC,
      updatedAt: TUESDAY_NOON_UTC,
      ...extra,
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
      updatedAt: TUESDAY_NOON_UTC,
      ...overrides,
    })
  )
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: TUESDAY_NOON_UTC,
      updatedAt: TUESDAY_NOON_UTC,
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
      createdAt: TUESDAY_NOON_UTC,
      updatedAt: TUESDAY_NOON_UTC,
    })
  })
}

function orderArgs(storeId: Id<"stores">, productId: Id<"products">) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: 1,
        unitPrice: 1200,
        selectedOptions: [],
        subtotal: 1200,
      },
    ],
    type: "pickup" as const,
  }
}

/** Place the order and report what happened, without letting a throw escape. */
async function attempt(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  productId: Id<"products">
) {
  let code: string | null = null
  let accepted = false
  try {
    await t.mutation(api.orders.create, orderArgs(storeId, productId))
    accepted = true
  } catch (error) {
    code = convexErrorCode(error)
  }
  const written = await t.run(async (ctx) => ({
    orders: (await ctx.db.query("orders").collect()).length,
    tickets: (await ctx.db.query("kitchenTickets").collect()).length,
  }))
  return { accepted, code, written }
}

describe("orders.create — the weekly schedule", () => {
  test("refuses an order at 04:00 against an 11:00-14:00 service", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    vi.setSystemTime(TUESDAY_0400_PARIS)
    const { accepted, code, written } = await attempt(t, storeId, productId)

    expect(accepted).toBe(false)
    expect(code).toBe("outside_opening_hours")
    // Nothing reached the kitchen, and nothing reached the orders table: the
    // whole mutation is one transaction.
    expect(written).toEqual({ orders: 0, tickets: 0 })
  })

  test("refuses an order on a day the owner marked closed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t, week("11:00", "14:00", true))
    const productId = await seedProduct(t, storeId)

    const { accepted, code, written } = await attempt(t, storeId, productId)

    expect(accepted).toBe(false)
    expect(code).toBe("outside_opening_hours")
    expect(written).toEqual({ orders: 0, tickets: 0 })
  })

  test("accepts an order inside the service", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    // 14:00 Paris is the closing minute of LUNCH_ONLY, so widen the service.
    const storeId = await seedStore(t, week("11:00", "23:00"))
    const productId = await seedProduct(t, storeId)

    const { accepted } = await attempt(t, storeId, productId)

    expect(accepted).toBe(true)
  })

  test("reads the restaurant's clock, not the server's", async () => {
    // Convex runs in UTC. At 12:00 UTC it is 14:00 in Paris — past the close of
    // an 11:00-13:00 service that the server clock would still call open.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t, week("11:00", "13:00"))
    const productId = await seedProduct(t, storeId)

    const { accepted, code } = await attempt(t, storeId, productId)

    expect(accepted).toBe(false)
    expect(code).toBe("outside_opening_hours")
  })

  test("serves a 22:00-02:00 late menu at 01:00", async () => {
    // The midnight crossing, on the order path. A food truck declaring
    // 18:00-02:00 must be able to sell at one in the morning.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t, week("18:00", "02:00"))
    const productId = await seedProduct(t, storeId)

    // 01:00 on Wednesday in Paris — still Tuesday's service.
    vi.setSystemTime(Date.UTC(2029, 6, 3, 23, 0, 0))
    const { accepted } = await attempt(t, storeId, productId)

    expect(accepted).toBe(true)
  })

  test("follows the global week when the location is set to", async () => {
    // `useGlobalHours` is a per-store flag the dashboard writes. An owner who
    // edits the global week and leaves every location on "horaires globaux"
    // expects it to reach the order path too.
    const t = newHarness()
    await seedGlobalSettings(t, { hours: week("11:00", "14:00") })
    const storeId = await seedStore(t, week("00:00", "23:59"), {
      useGlobalHours: true,
    })
    const productId = await seedProduct(t, storeId)

    vi.setSystemTime(TUESDAY_0400_PARIS)
    const { accepted, code } = await attempt(t, storeId, productId)

    expect(accepted).toBe(false)
    expect(code).toBe("outside_opening_hours")
  })

  test("keeps its own week when the store row was never saved", async () => {
    // THE 4 A.M. CASE, and the direction it was settled in.
    //
    // `useGlobalHours` is `v.optional(v.boolean())`, so a store nobody has
    // opened since the column landed carries NO value — and the dashboard read
    // that as `?? true` (switch ON, « Cet établissement utilise les horaires
    // globaux ») while this order path read it as falsy and served the store's
    // own week. Two answers to one question: an owner could set the global week
    // to 02:00–03:00, watch the screen agree, and have the storefront go on
    // serving 09:00–22:00.
    //
    // #446 settled it at `FOLLOWS_GLOBAL_HOURS_BY_DEFAULT = false` and moved
    // the SCREEN to match, which is the safer half: `false` is what this path
    // has always enforced, so no establishment's real hours moved. Making the
    // default `true` instead — which this branch first did — would have put
    // every legacy store onto the deployment-wide week unasked, and on a narrow
    // global week that is a restaurant that quietly stops taking orders.
    //
    // So an unwritten flag serves the location's own week, and the owner who
    // wants the global one now sees a switch that is honestly OFF.
    const t = newHarness()
    await seedGlobalSettings(t, { hours: week("02:00", "03:00") })
    const storeId = await seedStore(t, week("09:00", "22:00"))
    const productId = await seedProduct(t, storeId)

    // 18:29 Paris, far outside 02:00–03:00 and squarely inside 09:00–22:00.
    vi.setSystemTime(Date.UTC(2029, 6, 3, 16, 29, 0))
    const { accepted } = await attempt(t, storeId, productId)

    expect(accepted).toBe(true)
  })

  test("keeps the location's own week when the flag is explicitly off", async () => {
    // The other direction, so the fix above cannot be read as "global always
    // wins". An owner who turns the switch OFF has said so, and that store
    // keeps serving on its own hours whatever the deployment-wide week says.
    const t = newHarness()
    await seedGlobalSettings(t, { hours: week("02:00", "03:00") })
    const storeId = await seedStore(t, week("09:00", "22:00"), {
      useGlobalHours: false,
    })
    const productId = await seedProduct(t, storeId)

    vi.setSystemTime(Date.UTC(2029, 6, 3, 16, 29, 0))
    const { accepted } = await attempt(t, storeId, productId)

    expect(accepted).toBe(true)
  })

  /**
   * The clock when nothing has said which clock to use.
   *
   * `globalSettings` is a singleton the team writes; NOTHING seeds it, so a
   * deployment that has never had its settings saved has no row, and
   * `globalSettings?.timezone` is `undefined` all the way down to
   * `restaurantClock`, which then reads `getUTCDay()`/`getUTCHours()`. Every
   * other case in this file calls `seedGlobalSettings`, so none of them could
   * ever see it — the blind spot is the fixture, not the code.
   *
   * Measured on a store open 11:00–14:00, with no settings row: an order at
   * 23:30 Paris was ACCEPTED and written, and one at 09:30 Paris was refused
   * `outside_opening_hours`. Orders taken nine hours after closing; refused
   * during service.
   */
  describe("with no globalSettings row at all", () => {
    test("refuses an order after closing, on the restaurant's clock", async () => {
      const t = newHarness()
      // Deliberately no seedGlobalSettings: this is a deployment whose settings
      // have never been saved.
      const storeId = await seedStore(t, week("11:00", "14:00"))
      const productId = await seedProduct(t, storeId)

      // 21:30 UTC is 23:30 in Paris in July — long after a 14:00 close. Read on
      // the server clock it is 21:30, which is also shut, so the hour has to be
      // one where the two disagree.
      vi.setSystemTime(Date.UTC(2029, 6, 3, 12, 30, 0)) // 14:30 Paris, 12:30 UTC
      const { accepted, code, written } = await attempt(t, storeId, productId)

      expect(accepted).toBe(false)
      expect(code).toBe("outside_opening_hours")
      expect(written).toEqual({ orders: 0, tickets: 0 })
    })

    test("accepts an order during service, on the restaurant's clock", async () => {
      const t = newHarness()
      const storeId = await seedStore(t, week("11:00", "14:00"))
      const productId = await seedProduct(t, storeId)

      // 09:30 UTC is 11:30 in Paris — inside the service. On the server clock
      // it is 09:30, ninety minutes before opening, and the order was refused.
      vi.setSystemTime(Date.UTC(2029, 6, 3, 9, 30, 0))
      const { accepted } = await attempt(t, storeId, productId)

      expect(accepted).toBe(true)
    })
  })

  test("does not refuse a location that has declared no week at all", async () => {
    // `hours` is required by the schema and `stores.create` seeds a full week,
    // so an empty array means nobody declared anything — and there is nothing
    // to be outside of. `status` is what decides then, as it always has.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t, [])
    const productId = await seedProduct(t, storeId)

    vi.setSystemTime(TUESDAY_0400_PARIS)
    const { accepted } = await attempt(t, storeId, productId)

    expect(accepted).toBe(true)
  })
})
