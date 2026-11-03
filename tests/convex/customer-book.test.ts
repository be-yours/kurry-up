// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Clients screen, end to end (#364, #98).
 *
 * WHAT WAS MISSING: `/dashboard/customers` rendered a "coming soon"
 * placeholder while three surfaces sold the screen — the sales page, the guided
 * tour and the nav. The data had been collected all along and grouped nowhere:
 * one row per ORDER in `orders.customerInfo`, a second aggregate on
 * `emailSubscribers.metadata` that only covers people who opted into marketing,
 * and nothing at all for a diner who ordered twice and subscribed to nothing.
 *
 * These tests drive the REAL chain, not the aggregate in isolation: an order
 * moves to `confirmed` through `orders.internalUpdateStatus`, which is the
 * single transition every payment path funnels through, and the book is read
 * back through `customers.list` with a real identity holding a real role. A
 * test that called `recordOrder` directly would pass while the wiring between
 * them was missing, which is the defect this issue is about.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
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
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: "client_admin" | "waiter" | "kitchen",
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
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

let orderSeq = 0

/**
 * One order, in whatever state the test needs it.
 *
 * Inserted rather than placed through the storefront: `orders.create` runs the
 * whole checkout — stock, promotions, opening hours, a payment intent — and
 * none of that is what this file is about. The status TRANSITION is driven
 * through the real mutation, which is the part that has to work.
 */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: {
    /** `""` for the walk-in who gave no address. */
    email?: string
    name?: string
    phone?: string
    total?: number
    type?: "delivery" | "pickup" | "dine_in"
    status?: "pending" | "confirmed" | "cancelled" | "completed"
    productId?: string
    createdAt?: number
  } = {}
) {
  orderSeq += 1
  const number = String(orderSeq).padStart(4, "0")
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `ORD-2026-${number}`,
      customerInfo: {
        // `name` is required by the schema even for a walk-in — the counter
        // asks for one to call the order out. The ADDRESS is what an anonymous
        // order lacks, and it is the address the book is keyed on.
        name: over.name ?? "Marie Dupont",
        ...(over.email === "" ? {} : { email: over.email ?? "Marie.Dupont@Example.FR" }),
        phone: over.phone ?? "+33612345678",
      },
      type: over.type ?? "pickup",
      status: over.status ?? "pending",
      items: [
        {
          productId: over.productId,
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1200,
          selectedOptions: [],
          subtotal: 1200,
        },
      ],
      subtotal: 1200,
      taxAmount: 120,
      total: over.total ?? 1320,
      paymentStatus: "pending" as const,
      source: "website" as const,
      createdAt: over.createdAt ?? NOW,
      updatedAt: over.createdAt ?? NOW,
    })
  )
}

const confirm = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, { id, status: "confirmed" })

const cancel = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, { id, status: "cancelled" })

// ============================================================================
// The book is written by the order path, not by hand
// ============================================================================

describe("an order reaching the kitchen", () => {
  test("puts the person in the book", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await confirm(t, await seedOrder(t, storeId))

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers).toHaveLength(1)
    expect(page.customers[0]).toMatchObject({
      // Folded, whatever the storefront stored. The order keeps the address as
      // the diner typed it; the book is the thing that has to match itself.
      email: "marie.dupont@example.fr",
      name: "Marie Dupont",
      totalOrders: 1,
      totalSpent: 1320,
      averageOrderValue: 1320,
    })
  })

  test("counts a second order against the same person", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await confirm(t, await seedOrder(t, storeId, { total: 1000 }))
    // The same diner, typed differently — the case fold is the whole identity.
    await confirm(t, await seedOrder(t, storeId, { email: "marie.dupont@EXAMPLE.fr", total: 3000 }))

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers).toHaveLength(1)
    expect(page.customers[0]).toMatchObject({
      totalOrders: 2,
      totalSpent: 4000,
      averageOrderValue: 2000,
    })
  })

  test("gives it back when the order is cancelled", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    const orderId = await seedOrder(t, storeId, { total: 2500 })
    await confirm(t, orderId)
    await cancel(t, orderId)

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers[0]).toMatchObject({ totalOrders: 0, totalSpent: 0 })
  })

  test("leaves a pending order out of the book entirely", async () => {
    // Money not taken is not a sale, and a screen that counted it would tell
    // the owner they have customers who have never bought anything.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId)

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers).toHaveLength(0)
  })

  test("does not write a person for an order with no address", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await confirm(t, await seedOrder(t, storeId, { email: "" }))

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers).toHaveLength(0)
  })
})

// ============================================================================
// What the screen reads back
// ============================================================================

describe("the Clients screen", () => {
  test("sorts by most recent, and by spend on demand", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await confirm(t, await seedOrder(t, storeId, { email: "big@example.fr", total: 9000 }))
    await confirm(t, await seedOrder(t, storeId, { email: "recent@example.fr", total: 100 }))

    const recent = await asAdmin.query(api.customers.list, { storeId, order: "recent" })
    expect(recent.customers[0]!.email).toBe("recent@example.fr")

    const spend = await asAdmin.query(api.customers.list, { storeId, order: "spend" })
    expect(spend.customers[0]!.email).toBe("big@example.fr")
  })

  test("shows one person's own orders", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    const hers = await seedOrder(t, storeId)
    await confirm(t, hers)
    await confirm(t, await seedOrder(t, storeId, { email: "someone.else@example.fr" }))

    const detail = await asAdmin.query(api.customers.get, {
      storeId,
      email: "marie.dupont@example.fr",
    })
    expect(detail?.customer.totalOrders).toBe(1)
    // Hers, and not the other diner's — the point of the derived key.
    expect(detail?.orders).toHaveLength(1)
    expect(detail?.orders[0]!._id).toBe(hers)
  })

  test("is honest about the orders it cannot attribute", async () => {
    // A walk-in who paid cash and gave no address is a real sale and not a
    // person here. The footnote is the difference between a total that is
    // wrong and a total that says what it left out.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await confirm(t, await seedOrder(t, storeId, { email: "" }))
    await confirm(t, await seedOrder(t, storeId))

    const anonymous = await asAdmin.query(api.customers.anonymousOrderCount, { storeId })
    expect(anonymous.count).toBe(1)
    expect(anonymous.atLeast).toBe(false)
  })

  test("does not show one establishment's customers to another", async () => {
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
    const asAdmin = await seedUser(t, "owner", "client_admin", [mine])

    await confirm(t, await seedOrder(t, theirs, { email: "their.diner@example.fr" }))

    await expect(asAdmin.query(api.customers.list, { storeId: theirs })).rejects.toThrow()
  })
})

// ============================================================================
// Who may look
// ============================================================================

describe("the gate", () => {
  test("a waiter may look a customer up", async () => {
    // `customers:read`, deliberately: the person is standing at the counter.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asWaiter = await seedUser(t, "server", "waiter", [storeId])

    await expect(asWaiter.query(api.customers.list, { storeId })).resolves.toBeDefined()
  })

  test("a kitchen account may not", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(asKitchen.query(api.customers.list, { storeId })).rejects.toThrow()
  })

  test("an anonymous caller may not", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await expect(t.query(api.customers.list, { storeId })).rejects.toThrow(/Not authenticated/)
  })
})

// ============================================================================
// The history that predates the book
// ============================================================================

describe("the backfill", () => {
  test("builds the book from orders already there", async () => {
    // The reason this migration exists: the aggregate is maintained on the
    // status transition, so without it an establishment trading for two years
    // opens the screen on whoever ordered that afternoon.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { status: "completed", total: 1000 })
    await seedOrder(t, storeId, { status: "completed", total: 3000 })
    await seedOrder(t, storeId, { status: "cancelled", total: 5000 })
    await seedOrder(t, storeId, { status: "pending", total: 7000 })

    const result = await t.mutation(internal.customers.backfillCustomers, {
      storeId,
      cursor: null,
    })
    expect(result.written).toBe(2)
    expect(result.isDone).toBe(true)

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers[0]).toMatchObject({ totalOrders: 2, totalSpent: 4000 })
  })

  test("run again from the start, counts everybody once", async () => {
    // A paged migration is a migration that can be interrupted, and the honest
    // way to recover from that is to run it again from the beginning — which
    // is why the migration empties the book before it accumulates. Without the
    // reset this is 4 orders and 8000, silently.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { status: "completed", total: 1000 })
    await seedOrder(t, storeId, { status: "completed", total: 3000 })

    const rebuild = async () => {
      for (;;) {
        const wipe = await t.mutation(internal.customers.resetCustomerBook, { storeId })
        if (wipe.isDone) break
      }
      await t.mutation(internal.customers.backfillCustomers, { storeId, cursor: null })
    }
    await rebuild()
    await rebuild()

    const page = await asAdmin.query(api.customers.list, { storeId })
    expect(page.customers[0]).toMatchObject({ totalOrders: 2, totalSpent: 4000 })
  })

  test("empties the book a page at a time", async () => {
    // The reset is what makes the line above true, and it is paged for the
    // same reason the backfill is.
    const t = newHarness()
    const storeId = await seedStore(t)

    for (let i = 0; i < 3; i++) {
      await confirm(t, await seedOrder(t, storeId, { email: `d${i}@example.fr` }))
    }

    const first = await t.mutation(internal.customers.resetCustomerBook, {
      storeId,
      numItems: 2,
    })
    expect(first).toMatchObject({ deleted: 2, isDone: false })

    const second = await t.mutation(internal.customers.resetCustomerBook, {
      storeId,
      numItems: 2,
    })
    expect(second).toMatchObject({ deleted: 1, isDone: true })
  })

  test("gives the old orders the key the detail view looks them up by", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asAdmin = await seedUser(t, "owner", "client_admin", [storeId])

    await seedOrder(t, storeId, { status: "completed" })

    const result = await t.mutation(internal.customers.backfillCustomers, {
      storeId,
      cursor: null,
    })
    expect(result.keyed).toBe(1)

    const detail = await asAdmin.query(api.customers.get, {
      storeId,
      email: "marie.dupont@example.fr",
    })
    expect(detail?.orders).toHaveLength(1)
  })

  test("pages, because orders is the biggest table a restaurant has", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    for (let i = 0; i < 3; i++) {
      await seedOrder(t, storeId, { status: "completed", email: `d${i}@example.fr` })
    }

    const first = await t.mutation(internal.customers.backfillCustomers, {
      storeId,
      cursor: null,
      numItems: 2,
    })
    expect(first.isDone).toBe(false)
    expect(first.written).toBe(2)

    const second = await t.mutation(internal.customers.backfillCustomers, {
      storeId,
      cursor: first.cursor,
      numItems: 2,
    })
    expect(second.isDone).toBe(true)
    expect(second.written).toBe(1)
  })
})
