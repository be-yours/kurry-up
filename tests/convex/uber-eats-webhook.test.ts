// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Uber Eats webhook, end to end, through the real signed HTTP route.
 *
 * Nothing in this repository named `uberEatsWebhook` before this file, which is
 * why four defects lived on it through five green CI runs:
 *
 *  - #138 — the handler matched `orders.cancel`, `orders.scheduled` and
 *    `eats.order.status_update`. Uber sends none of those; its order events
 *    carry a `.notification` suffix. A customer cancelling got a 200 and an
 *    order that stayed `confirmed`, so the kitchen cooked and bagged it.
 *  - #139 — when the follow-up fetch to Uber failed, the order was assigned to
 *    `allIntegrations[0]`. On a multi-location account that put one owner's
 *    order, priced at zero, into another owner's kitchen.
 *  - #140 — `auto_accept` called Uber inside an `if` and set `confirmed`
 *    outside it, with a `catch` that only logged. The customer was told the
 *    restaurant had accepted while Uber had never been told anything, and Uber
 *    auto-cancelled at 11.5 minutes with the food already made.
 *  - #163.1 — the line total was passed into a slot treated as a unit price and
 *    multiplied by quantity again, storing every line at roughly twice its
 *    price.
 *
 * These drive the signed endpoint rather than the internals, because in every
 * case the defect was at a seam and each half had a passing test.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "../../convex/_generated/dataModel"
import { internal } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const SECRET = "test-uber-webhook-secret"

/** Controls for the Uber API, which no test may reach over the network. */
const uberApi = {
  fetchOrder: vi.fn(),
  acceptOrder: vi.fn(),
  cancelOrder: vi.fn(),
}

// The signature verifier stays REAL: a test that skipped it would prove
// nothing about a signed webhook. Only the network calls are replaced.
vi.mock("@be-yours/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@be-yours/integrations")>()
  return {
    ...actual,
    uberEats: {
      ...actual.uberEats,
      fetchOrder: (...args: unknown[]) => uberApi.fetchOrder(...args),
      acceptOrder: (...args: unknown[]) => uberApi.acceptOrder(...args),
      cancelOrder: (...args: unknown[]) => uberApi.cancelOrder(...args),
    },
  }
})

beforeAll(() => {
  // OPENAI_API_KEY belongs to the same env schema; without it the parse fails
  // and the handler would error for the wrong reason.
  process.env.OPENAI_API_KEY = "sk-test"
  process.env.UBER_EATS_CLIENT_ID = "test-client-id"
  process.env.UBER_EATS_CLIENT_SECRET = "test-client-secret"
  process.env.UBER_EATS_WEBHOOK_SECRET = SECRET
})

beforeEach(() => {
  uberApi.fetchOrder.mockReset()
  uberApi.acceptOrder.mockReset()
  uberApi.cancelOrder.mockReset()
})

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

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

// ===========================================================================
// Signing — the real X-Uber-Signature scheme, so tests use the real door
// ===========================================================================

async function sign(rawBody: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function postWebhook(
  t: ReturnType<typeof convexTest>,
  body: Record<string, unknown>,
  opts: { secret?: string } = {}
) {
  const raw = JSON.stringify(body)
  const signature = await sign(raw, opts.secret ?? SECRET)
  return t.fetch("/webhooks/uber-eats", {
    method: "POST",
    headers: { "content-type": "application/json", "x-uber-signature": signature },
    body: raw,
  })
}

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>, name: string, slug: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug,
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedIntegration(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  platformStoreId: string,
  orderMode: "auto_accept" | "auto_reject" | "manual"
) {
  return t.run((ctx) =>
    ctx.db.insert("storeIntegrations", {
      storeId,
      platform: "uberEats" as const,
      platformStoreId,
      syncMenu: false,
      autoAccept: orderMode === "auto_accept",
      orderMode,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** An Uber order as the API returns it: 2 burgers at 10.00 + cheese 1.50. */
function uberOrder(storeExternalId: string, orderId = "ue-order-1") {
  return {
    id: orderId,
    display_id: "ABC123",
    store: { id: storeExternalId },
    current_state: "CREATED",
    cart: {
      items: [
        {
          id: "item-1",
          title: "Burger",
          quantity: 2,
          price: { amount: 1000 },
          customer_request: { allergy: { instructions: "arachides" } },
          selected_modifier_groups: [
            {
              id: "g1",
              title: "Extras",
              selected_items: [{ id: "m1", title: "Cheese", quantity: 1, price: { amount: 150 } }],
            },
          ],
        },
      ],
    },
    payment: { charges: { total: { amount: 2300 }, sub_total: { amount: 2300 } } },
    placed_at: "2026-01-01T12:00:00Z",
  }
}

function event(eventType: string, resourceId = "ue-order-1") {
  return {
    event_type: eventType,
    event_id: `evt-${resourceId}`,
    meta: { resource_id: resourceId, status: "pos" },
  }
}

// ===========================================================================
// #139 — routing. The failure that costs a customer relationship.
// ===========================================================================

describe("#139 · an order goes to the establishment that sold it", () => {
  test("routes to the named store, not the first one on the list", async () => {
    const t = newHarness()
    const pizzeria = await seedStore(t, "Chez Luigi", "chez-luigi")
    const burger = await seedStore(t, "Le Burger", "le-burger")
    await seedIntegration(t, pizzeria, "uber-store-pizzeria", "manual")
    await seedIntegration(t, burger, "uber-store-burger", "manual")

    // The order belongs to the SECOND establishment.
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-burger"))

    const res = await postWebhook(t, event("orders.notification"))
    expect(res.status).toBe(200)

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(1)
    expect(orders[0].storeId).toBe(burger)
    expect(orders[0].storeId).not.toBe(pizzeria)

    // And so does its ticket — the ticket is what prints in a kitchen.
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
    expect(tickets[0].storeId).toBe(burger)
  })

  test("an unfetchable order creates NOTHING and is kept for a human", async () => {
    const t = newHarness()
    const pizzeria = await seedStore(t, "Chez Luigi", "chez-luigi")
    const burger = await seedStore(t, "Le Burger", "le-burger")
    await seedIntegration(t, pizzeria, "uber-store-pizzeria", "manual")
    await seedIntegration(t, burger, "uber-store-burger", "manual")

    // 429, timeout, or sandbox credentials meeting a production order.
    uberApi.fetchOrder.mockRejectedValue(new Error("429 Too Many Requests"))

    const res = await postWebhook(t, event("orders.notification"))

    // No order anywhere — least of all on the first establishment.
    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(0)
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(0)

    // It is not lost either: it is kept, with the body, so it can be replayed.
    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("fetch_failed")
    expect(failures[0].platform).toBe("uberEats")
    expect(failures[0].rawBody).toContain("orders.notification")

    // 500 so Uber retries — the usual cause recovers on its own.
    expect(res.status).toBe(500)
  })

  test("an order for a store we do not serve is refused, not reassigned", async () => {
    const t = newHarness()
    const pizzeria = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, pizzeria, "uber-store-pizzeria", "manual")

    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-somebody-else"))

    const res = await postWebhook(t, event("orders.notification"))
    expect(res.status).toBe(200) // nothing to retry: the integration is absent

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(0)

    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("unknown_store")
    expect(failures[0].platformStoreId).toBe("uber-store-somebody-else")
  })
})

// ===========================================================================
// #163.1 — money
// ===========================================================================

describe("#163.1 · a line is stored at the price the customer paid", () => {
  test("stores the unit price, and a subtotal that matches the order total", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))

    await postWebhook(t, event("orders.notification"))

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    const line = order.items[0]
    expect(line.unitPrice).toBe(1000)
    // (1000 + 150) * 2 = 2300 — and 2300 is what Uber charged.
    expect(line.subtotal).toBe(2300)
    expect(line.subtotal).toBe(order.total)
  })

  test("the customer's allergy reaches the kitchen ticket", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))

    await postWebhook(t, event("orders.notification"))

    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticket.items[0].notes).toBe("Allergie: arachides")
  })
})

// ===========================================================================
// #138 — the event names Uber actually sends
// ===========================================================================

describe("#138 · a cancellation cancels", () => {
  async function seedConfirmedOrder(t: ReturnType<typeof convexTest>) {
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId: store,
        orderNumber: "CMD-1",
        externalOrderId: "ue-order-1",
        type: "delivery" as const,
        status: "confirmed" as const,
        customerInfo: { name: "Client" },
        items: [],
        subtotal: 2300,
        taxAmount: 0,
        total: 2300,
        source: "uber_eats" as const,
        paymentStatus: "paid" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    return store
  }

  test("orders.cancel.notification — the name Uber really sends — cancels", async () => {
    const t = newHarness()
    await seedConfirmedOrder(t)

    const res = await postWebhook(t, event("orders.cancel.notification"))
    expect(res.status).toBe(200)

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("cancelled")
    expect(order.cancelledAt).toBeTypeOf("number")
  })

  test("cancelling the order takes its ticket OFF the pass", async () => {
    // The half of this defect that actually burns food. `updateStatus` (the
    // staff path) cancelled the tickets; `updateFromWebhook` (the path a
    // platform cancellation takes) is a different handler and did not — so the
    // order read `cancelled` while the kitchen went on cooking it, because the
    // ticket on the display never moved.
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    await postWebhook(t, event("orders.notification"))

    const liveBefore = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(liveBefore).toHaveLength(1)
    expect(liveBefore[0].status).not.toBe("cancelled")

    await postWebhook(t, event("orders.cancel.notification"))

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(order.status).toBe("cancelled")
    expect(ticket.status).toBe("cancelled")
  })

  test.each(["preparing", "ready", "out_for_delivery"] as const)(
    "a cancellation is honoured for an order already at %s",
    async (stage) => {
      // The narrow window that survived the first fix. The order lifecycle
      // stops the cancellation window at `confirmed` for an OUTBOUND reason —
      // Deliveroo refuses to cancel food already being made. Applying that to
      // an INBOUND notification meant the customer cancelled, Uber told us, and
      // the handler answered 200 while the kitchen carried on cooking.
      const t = newHarness()
      const store = await seedStore(t, "Chez Luigi", "chez-luigi")
      await seedIntegration(t, store, "uber-store-1", "manual")
      uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
      await postWebhook(t, event("orders.notification"))

      const [created] = await t.run((ctx) => ctx.db.query("orders").collect())
      await t.run((ctx) => ctx.db.patch(created._id, { status: stage }))

      const res = await postWebhook(t, event("orders.cancel.notification"))
      expect(res.status).toBe(200)

      const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
      const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
      expect(order.status).toBe("cancelled")
      expect(order.cancelledAt).toBeTypeOf("number")
      // And off the pass, so the kitchen stops.
      expect(ticket.status).toBe("cancelled")
    }
  )

  test("a cancellation arriving after delivery is refused, and RECORDED", async () => {
    // The food was handed over. Rewriting the order would lose that, so this
    // one is a refund question — but it must not vanish in a 200.
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    await postWebhook(t, event("orders.notification"))

    const [created] = await t.run((ctx) => ctx.db.query("orders").collect())
    await t.run((ctx) => ctx.db.patch(created._id, { status: "delivered" as const }))

    const res = await postWebhook(t, event("orders.cancel.notification"))
    expect(res.status).toBe(200)

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("delivered")

    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].detail).toContain("already_delivered")
  })

  test("two establishments sharing an Uber store id route NOWHERE", async () => {
    // An owner adding a second location and pasting the same Uber store id used
    // to get a router that was 50% wrong, silently. Refusing is the only safe
    // answer, and it has to leave a trace naming the id to fix.
    const t = newHarness()
    const first = await seedStore(t, "Chez Luigi", "chez-luigi")
    const second = await seedStore(t, "Luigi Bis", "luigi-bis")
    await seedIntegration(t, first, "uber-store-shared", "manual")
    await seedIntegration(t, second, "uber-store-shared", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-shared"))

    await postWebhook(t, event("orders.notification"))

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(orders).toHaveLength(0)
    expect(tickets).toHaveLength(0)

    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("ambiguous_store")
    expect(failures[0].platformStoreId).toBe("uber-store-shared")
  })

  test("a non-string store id is recorded, not crashed on", async () => {
    // `store: { id: 12345 }` threw `trim is not a function` into the outer
    // catch: HTTP 500, nothing recorded, seven Uber retries, order gone.
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    const malformed = uberOrder("uber-store-1")
    ;(malformed.store as unknown as { id: number }).id = 12345
    uberApi.fetchOrder.mockResolvedValue(malformed)

    const res = await postWebhook(t, event("orders.notification"))
    expect(res.status).toBe(200)

    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("unidentified_store")
  })

  test("the bare orders.cancel spelling still works", async () => {
    const t = newHarness()
    await seedConfirmedOrder(t)
    await postWebhook(t, event("orders.cancel"))
    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("cancelled")
  })

  test("orders.scheduled.notification persists the order without accepting it", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "auto_accept")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))

    const res = await postWebhook(t, event("orders.scheduled.notification"))
    expect(res.status).toBe(200)

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("pending")
    expect(order.notes).toContain("SCHEDULED")
    // Accepting an order an hour before it is cooked would be a promise we
    // cannot keep; Uber sends orders.notification again nearer the time.
    expect(uberApi.acceptOrder).not.toHaveBeenCalled()
  })

  test("an unrecognised event is acknowledged AND kept, not silently dropped", async () => {
    const t = newHarness()
    // `eats.order.status_update` was the handler's own invention. Keeping a
    // record of unknown names is how the next wrong one gets noticed.
    const res = await postWebhook(t, event("eats.order.status_update"))
    expect(res.status).toBe(200)

    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe("processing_failed")
    expect(failures[0].eventType).toBe("eats.order.status_update")
  })

  test("a forged signature is refused before the payload is read", async () => {
    const t = newHarness()
    const res = await postWebhook(t, event("orders.cancel.notification"), { secret: "wrong-secret" })
    expect(res.status).toBe(401)
    const failures = await t.run((ctx) => ctx.db.query("platformWebhookFailures").collect())
    expect(failures).toHaveLength(0)
  })
})

// ===========================================================================
// #163.4 — the index, against the REAL Convex engine
// ===========================================================================

describe("#163.4 · the by_external_order index, not a table scan", () => {
  // `createFromWebhook` and `updateFromWebhook` used `.filter()` with no index,
  // which in Convex is a full scan of `orders`. Past Convex's ~16k
  // per-transaction read ceiling that stops order ingestion permanently, with
  // no alert. They now read through `by_external_order`.
  //
  // That index is on `externalOrderId` ALONE while both lookups also match on
  // `source`, so these run against the real engine rather than the in-memory
  // stub the package tests use — a hand-written stub cannot prove an index
  // behaves the way Convex's does.

  test("the same external id from two platforms stays two distinct orders", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")

    const shared = "SHARED-ID-1"
    const base = {
      storeId: store,
      externalOrderId: shared,
      status: "pending" as const,
      type: "delivery" as const,
      customerName: "Client",
      items: [{ externalId: "i1", name: "Pizza", quantity: 1, price: 1200 }],
      subtotal: 1200,
      total: 1200,
      createdAt: NOW,
    }
    const a = await t.mutation(internal.orders.createFromWebhook, { ...base, platform: "uberEats" as const })
    const b = await t.mutation(internal.orders.createFromWebhook, { ...base, platform: "deliveroo" as const })

    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(a.orderId).not.toBe(b.orderId)

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(2)
  })

  test("a status update reaches the right platform's order, not the other one", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    const shared = "SHARED-ID-2"
    const base = {
      storeId: store, externalOrderId: shared, status: "pending" as const,
      type: "delivery" as const, customerName: "Client",
      items: [{ externalId: "i1", name: "Pizza", quantity: 1, price: 1200 }],
      subtotal: 1200, total: 1200, createdAt: NOW,
    }
    const uber = await t.mutation(internal.orders.createFromWebhook, { ...base, platform: "uberEats" as const })
    const deliveroo = await t.mutation(internal.orders.createFromWebhook, { ...base, platform: "deliveroo" as const })

    await t.mutation(internal.orders.updateFromWebhook, {
      externalOrderId: shared, platform: "deliveroo" as const,
      status: "confirmed" as const, updatedAt: NOW + 1,
    })

    const uberOrderRow = await t.run((ctx) => ctx.db.get(uber.orderId))
    const deliverooRow = await t.run((ctx) => ctx.db.get(deliveroo.orderId))
    expect(deliverooRow?.status).toBe("confirmed")
    // The Uber order shares the external id and must be untouched.
    expect(uberOrderRow?.status).toBe("pending")
  })

  test("a webhook retry is still idempotent through the index", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    const args = {
      storeId: store, externalOrderId: "RETRY-1", platform: "uberEats" as const,
      status: "pending" as const, type: "delivery" as const, customerName: "Client",
      items: [{ externalId: "i1", name: "Pizza", quantity: 1, price: 1200 }],
      subtotal: 1200, total: 1200, createdAt: NOW,
    }
    const first = await t.mutation(internal.orders.createFromWebhook, args)
    const second = await t.mutation(internal.orders.createFromWebhook, args)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.orderId).toBe(first.orderId)
    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(1)
  })
})

// ===========================================================================
// #140 — confirmed means Uber said yes
// ===========================================================================

describe("#140 · the local status follows the platform, never leads it", () => {
  test("a successful accept confirms the order and marks it synced", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "auto_accept")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    uberApi.acceptOrder.mockResolvedValue({ ok: true })

    await postWebhook(t, event("orders.notification"))

    expect(uberApi.acceptOrder).toHaveBeenCalledTimes(1)
    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("confirmed")
    expect(order.platformSyncStatus).toBe("synced")
  })

  test("a FAILED accept leaves the order unconfirmed, flagged, and retried", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "auto_accept")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    uberApi.acceptOrder.mockRejectedValue(new Error("503 Service Unavailable"))

    const res = await postWebhook(t, event("orders.notification"))
    expect(res.status).toBe(200)

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    // The customer was never told the restaurant accepted, because it did not.
    expect(order.status).not.toBe("confirmed")
    expect(order.status).toBe("pending")
    // And the KDS can see that this one needs a human.
    expect(order.platformSyncStatus).toBe("failed")

    // A bounded retry is queued — a 503 usually clears.
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(scheduled.length).toBeGreaterThan(0)
  })

  test("a stale retry is abandoned when staff have already acted", async () => {
    // Minutes pass between attempts. If the restaurant cancelled the order in
    // the meantime, accepting it on Uber now would contradict them — and
    // pushing `confirmed` onto a cancelled order is a transition the state
    // machine refuses, so it would throw inside a scheduled action too.
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "auto_accept")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    uberApi.acceptOrder.mockRejectedValue(new Error("503 Service Unavailable"))

    await postWebhook(t, event("orders.notification"))
    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())

    // Staff cancel it while the retry is still queued.
    await t.run((ctx) => ctx.db.patch(order._id, { status: "cancelled" as const }))
    uberApi.acceptOrder.mockClear()

    await t.action(internal.uberEatsWebhook.retrySettleWithUber, {
      action: "accept" as const,
      orderId: order._id,
      externalOrderId: "ue-order-1",
      attempt: 2,
    })

    expect(uberApi.acceptOrder).not.toHaveBeenCalled()
    const [after] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(after.status).toBe("cancelled")
  })

  test("a manual order promises Uber nothing and stays pending", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "manual")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))

    await postWebhook(t, event("orders.notification"))

    expect(uberApi.acceptOrder).not.toHaveBeenCalled()
    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order.status).toBe("pending")
    expect(order.platformSyncStatus).toBe("pending")
  })

  test("a duplicate webhook does not accept twice or double-ticket", async () => {
    const t = newHarness()
    const store = await seedStore(t, "Chez Luigi", "chez-luigi")
    await seedIntegration(t, store, "uber-store-1", "auto_accept")
    uberApi.fetchOrder.mockResolvedValue(uberOrder("uber-store-1"))
    uberApi.acceptOrder.mockResolvedValue({ ok: true })

    await postWebhook(t, event("orders.notification"))
    await postWebhook(t, event("orders.notification"))

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(orders).toHaveLength(1)
    expect(tickets).toHaveLength(1)
    expect(uberApi.acceptOrder).toHaveBeenCalledTimes(1)
  })
})
