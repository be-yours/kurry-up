// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A diner telephones while the kitchen is cooking (#111).
 *
 * WHAT WAS IMPOSSIBLE. `ORDER_STATUS_TRANSITIONS` let `cancelled` be reached from
 * `pending` and `confirmed` and from nowhere else, so once an order was
 * `preparing` it could never be cancelled. The staff's only recourse was to
 * COMPLETE an order that never happened — money in the takings, an invoice in a
 * fiscal series, a sale in the customer book, for food nobody received.
 *
 * The reason given for the narrow window was Deliveroo, and it is a good reason
 * about ONE KIND OF ORDER: the platform refuses a cancellation at those stages, so
 * honouring it on our side alone leaves the restaurant reading « annulée » while
 * a rider is still coming. The table is global and could not express that, so the
 * constraint moved to `orders.updateStatus`, which has `order.source`.
 *
 * This file holds both halves, and the consequences of the wider window: the
 * stock goes back, the ticket leaves the pass, and each happens exactly once.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
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

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  stock?: { tracked: boolean; quantity: number }
) {
  const categoryId = await t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name: "Carte",
      slug: "carte",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.run((ctx) =>
    ctx.db.insert("products", {
      storeId,
      categoryId,
      name: "Margherita",
      slug: "margherita",
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
      ...(stock ? { stock: { ...stock, lowStockThreshold: 0 } } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

let seq = 0

async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: {
    status?: string
    source?: "website" | "uber_eats" | "deliveroo" | "pos"
    productId?: Id<"products">
    quantity?: number
  } = {}
) {
  seq += 1
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `ORD-2026-${String(seq).padStart(4, "0")}`,
      customerInfo: { name: "Camille", email: "camille@example.fr" },
      type: "pickup" as const,
      status: (over.status ?? "preparing") as never,
      items: [
        {
          ...(over.productId ? { productId: over.productId } : {}),
          productName: "Margherita",
          quantity: over.quantity ?? 1,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 1_200,
        },
      ],
      subtotal: 1_200,
      taxAmount: 120,
      total: 1_320,
      paymentStatus: "paid" as const,
      source: over.source ?? ("website" as const),
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const cancel = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, {
    id,
    status: "cancelled",
    cancellationReason: "Le client a téléphoné",
  })

// ============================================================================
// The establishment's own orders
// ============================================================================

describe("cancelling an order the establishment took itself", () => {
  for (const status of ["preparing", "ready", "out_for_delivery"] as const) {
    test(`is allowed from ${status}`, async () => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedOrder(t, storeId, { status })

      await cancel(t, orderId)

      const order = await t.run((ctx) => ctx.db.get(orderId))
      expect(order?.status).toBe("cancelled")
      expect(order?.cancellationReason).toBe("Le client a téléphoné")
    })
  }

  test("is still refused once the diner has the food", async () => {
    // Not the same question: money comes back through `payments.refundPayment`,
    // which calls the provider. A cancellation would claim the food never left.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { status: "delivered" })

    await expect(cancel(t, orderId)).rejects.toThrow(/Invalid order status transition/)
  })

  test("records that money is owed back, not that it was sent", async () => {
    // The order was paid. `refund_pending` says the till still holds it; only
    // `payments.refundPayment` moves money, and it calls the provider first.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { status: "preparing" })

    await cancel(t, orderId)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("refund_pending")
  })

  test("gives the tracked stock back, once", async () => {
    /*
     * The consequence of the wider window that had to be checked rather than
     * assumed. `updateStatus`'s cancel branch restores stock, and its comment
     * argued the restore is once-only because `cancelled` was reachable from
     * `pending` and `confirmed` alone. Adding incoming edges does not break that:
     * `cancelled` still has no outgoing transition, so an order can only enter it
     * once — and a replayed cancellation returns at `from === to` before reaching
     * the branch.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId, { tracked: true, quantity: 3 })
    const orderId = await seedOrder(t, storeId, {
      status: "preparing",
      productId,
      quantity: 2,
    })

    await cancel(t, orderId)
    // Replayed: a double-clicked button, a retried webhook.
    await cancel(t, orderId)

    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.stock?.quantity).toBe(5)
  })

  test("takes the kitchen ticket off the pass", async () => {
    // The whole point from the kitchen's side: without it, a cancelled order is
    // still being cooked and bagged.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { status: "preparing" })
    await t.run((ctx) =>
      ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-2026-9999",
        items: [{ productName: "Margherita", quantity: 1, options: [] }],
        status: "in_progress" as const,
        priority: "normal" as const,
        source: "website" as const,
        orderType: "pickup" as const,
        printStatus: "printed" as const,
        printAttempts: 1,
        trackingToken: "tok-cancel-test",
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await cancel(t, orderId)

    const ticket = await t.run((ctx) =>
      ctx.db
        .query("kitchenTickets")
        .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
        .first()
    )
    expect(ticket?.status).toBe("cancelled")
  })
})

// ============================================================================
// Platform orders keep the narrow window
// ============================================================================

describe("cancelling a platform order", () => {
  for (const source of ["deliveroo", "uber_eats"] as const) {
    test(`is refused once ${source} has it in the kitchen`, async () => {
      /*
       * The constraint the old table expressed globally, now expressed where the
       * platform is known. Deliveroo and Uber Eats refuse a cancellation at this
       * stage and keep their own state; cancelling only on our side leaves the
       * restaurant reading « annulée » while the rider is still coming.
       */
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedOrder(t, storeId, { status: "preparing", source })

      await expect(cancel(t, orderId)).rejects.toThrow(/plateforme/)
    })
  }

  test("is still allowed before it is made, which is the auto-reject path", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const pending = await seedOrder(t, storeId, {
      status: "pending",
      source: "deliveroo",
    })
    const confirmed = await seedOrder(t, storeId, {
      status: "confirmed",
      source: "deliveroo",
    })

    await expect(cancel(t, pending)).resolves.not.toThrow()
    await expect(cancel(t, confirmed)).resolves.not.toThrow()
  })

  test("tells the operator where to cancel it instead", async () => {
    // A refusal an operator cannot act on is a dead end; this one names the
    // platform's own dashboard.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, {
      status: "ready",
      source: "uber_eats",
    })

    await expect(cancel(t, orderId)).rejects.toThrow(
      /tableau de bord de la plateforme/
    )
  })

  test("leaves the order exactly as it was", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, {
      status: "preparing",
      source: "deliveroo",
    })

    await expect(cancel(t, orderId)).rejects.toThrow()

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.status).toBe("preparing")
    expect(order?.cancellationReason).toBeUndefined()
  })
})
