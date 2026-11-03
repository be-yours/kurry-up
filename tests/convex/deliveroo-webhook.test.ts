// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Deliveroo order webhook, end to end, through the real HTTP route.
 *
 * Three defects lived here, all of them invisible to the unit tests around
 * them:
 *
 *  - #134 — a Deliveroo order was written to the database and stopped there.
 *    No kitchen ticket, so no slip, no screen, no printer, and the accept
 *    button in `TicketCard` unreachable because it acts on a ticket. The Uber
 *    Eats path had always created one. Nothing compared the two.
 *  - #163.2 — the status map spoke a vocabulary Deliveroo does not: it matched
 *    `cancelled` (two l) where Deliveroo sends `canceled`, had no `confirmed`
 *    case, invented four statuses that are prep stages we push rather than
 *    events we receive, and defaulted the rest to `pending` — dragging orders
 *    backwards.
 *  - #163.8 — every outcome was acknowledged with 200, including failure.
 *    Deliveroo retries only on a non-2xx, so a failed order was lost in
 *    silence.
 *
 * These drive the signed HTTP endpoint rather than the internals, because the
 * bug in each case was at a seam: between the processor and its caller, or
 * between our vocabulary and Deliveroo's.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexTest } from "convex-test"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { _resetEnvCache } from "@be-yours/core/env"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { mapDeliverooStatus } from "../../convex/deliverooWebhook"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const SECRET = "test-deliveroo-webhook-secret"
const GUID = "11111111-2222-3333-4444-555555555555"
const SITE_ID = "site-42"

beforeAll(() => {
  // The handler reads its signing secret from the platform env. OPENAI_API_KEY
  // is required by the same schema, so it has to be present for the parse to
  // succeed at all — without it the handler fails for the wrong reason and a
  // response-policy assertion passes on a lie.
  process.env.OPENAI_API_KEY = "sk-test"
  process.env.DELIVEROO_WEBHOOK_SECRET = SECRET
  // No client credentials: the webhook must reach the kitchen whether or not
  // we can talk back to Deliveroo, and no test should depend on the network.
  delete process.env.DELIVEROO_CLIENT_ID
  delete process.env.DELIVEROO_CLIENT_SECRET
})

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

// ===========================================================================
// Signing — the real header scheme, so the tests go through the real door
// ===========================================================================

/** HMAC-SHA256 over `sequence_guid + " " + raw_body`, hex, as Deliveroo signs. */
async function sign(body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${GUID} ${body}`))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function postSigned(t: ReturnType<typeof convexTest>, body: string) {
  return t.fetch("/webhooks/deliveroo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-deliveroo-hmac-sha256": await sign(body),
      "x-deliveroo-sequence-guid": GUID,
    },
    body,
  })
}

// ===========================================================================
// Fixtures
// ===========================================================================

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

async function seedIntegration(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.run((ctx) =>
    ctx.db.insert("storeIntegrations", {
      storeId,
      platform: "deliveroo" as const,
      platformStoreId: SITE_ID,
      syncMenu: false,
      autoAccept: false,
      // Manual: the staff decides in the KDS, which is precisely the screen a
      // Deliveroo order never reached.
      orderMode: "manual" as const,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** An `order.new` payload shaped as Deliveroo sends it. */
function newOrderPayload(
  overrides: {
    id?: string
    siteId?: string
    itemNotes?: string
  } = {}
) {
  return JSON.stringify({
    event: "order.new",
    body: {
      order: {
        id: overrides.id ?? "gb:deliveroo:order:ABC12345",
        order_number: "D-1234",
        location_id: overrides.siteId ?? SITE_ID,
        status: "placed",
        fulfillment_type: "delivery",
        asap: true,
        items: [
          {
            pos_item_id: "prod-1",
            name: "Margherita",
            quantity: 2,
            unit_price: { fractional: 1200, currency_code: "EUR" },
            modifiers: [
              {
                pos_item_id: "mod-1",
                name: "Extra basilic",
                unit_price: { fractional: 100, currency_code: "EUR" },
              },
            ],
            notes: overrides.itemNotes ?? "allergie arachides — sauce à part",
          },
        ],
        customer: {
          first_name: "Camille",
          last_name: "Roy",
          phone_number: "0600000000",
        },
        notes: "Sonner deux fois",
        total_price: { fractional: 2500, currency_code: "EUR" },
      },
    },
  })
}

// ===========================================================================
// #134 — the order reaches the kitchen
// ===========================================================================

describe("a signed Deliveroo order.new", () => {
  test("produces both an order and a kitchen ticket", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const response = await postSigned(t, newOrderPayload())
    expect(response.status).toBe(200)

    const orders = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(orders).toHaveLength(1)
    expect(orders[0]!.source).toBe("deliveroo")

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets, "a Deliveroo order never reached the kitchen").toHaveLength(1)

    const ticket = tickets[0]!
    expect(ticket.orderId).toEqual(orders[0]!._id)
    expect(ticket.storeId).toEqual(storeId)
    expect(ticket.source).toBe("deliveroo")
    expect(ticket.orderType).toBe("delivery")
    expect(ticket.customerName).toBe("Camille Roy")
    // `dl-` so a token found in a log or a URL names its platform, the way
    // the Uber Eats path uses `ue-`.
    expect(ticket.trackingToken.startsWith("dl-")).toBe(true)
  })

  test("keeps the line's instruction all the way to the slip", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    await postSigned(t, newOrderPayload())

    // An instruction on a line can be an allergy. It has to survive the item
    // mapping, the order validator and the ticket insert — the exact seam that
    // lost it on the Uber Eats path.
    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(order!.items[0]!.notes).toContain("arachides")

    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(ticket!.items[0]!.notes).toContain("arachides")
    expect(ticket!.items[0]!.productName).toBe("Margherita")
    expect(ticket!.items[0]!.quantity).toBe(2)
    expect(ticket!.items[0]!.options).toContain("Extra basilic")
  })

  test("does not print the same order twice when Deliveroo retries", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const payload = newOrderPayload({ id: "gb:deliveroo:order:RETRY" })
    expect((await postSigned(t, payload)).status).toBe(200)
    expect((await postSigned(t, payload)).status).toBe(200)

    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toHaveLength(1)
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(1)
  })
})

// ===========================================================================
// A Deliveroo order whose slip never made it to the pass
// ===========================================================================

describe("a Deliveroo order that reached the kitchen nowhere", () => {
  /**
   * THE SHAPE OF THE DEFECT. The ticket was created inside a `try` whose
   * `catch` was a bare `console.error`, in an 854-line file with zero
   * `captureBackendError` calls — while its Uber Eats twin had three, one of
   * them on exactly this step. So a ticket that failed to be created left the
   * order in the database, a 200 going back to Deliveroo, and no slip on the
   * pass: no screen, no printer, and the accept button in `TicketCard`
   * unreachable because it acts on a ticket.
   *
   * And no retry could repair it. The duplicate short-circuit — `if (!created)
   * return` — sat BEFORE the ticket block, so the one event that could have
   * fixed this returned without reaching it. None of the eleven crons looked
   * for a ticketless order either.
   *
   * `tasks/sales-readiness-backlog.md` marks P0-10 "Deliveroo orders never
   * reach the kitchen — RESOLVED". It was resolved for the path that was
   * measured; the same outcome was reachable by this one.
   */
  test("gets its slip when Deliveroo redelivers", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const payload = newOrderPayload({ id: "gb:deliveroo:order:LOSTTICKET" })
    expect((await postSigned(t, payload)).status).toBe(200)

    // The state the bare `catch` used to leave behind: the order exists, the
    // ticket does not. Deleting the ticket reproduces it exactly.
    await t.run(async (ctx) => {
      for (const ticket of await ctx.db.query("kitchenTickets").collect()) {
        await ctx.db.delete(ticket._id)
      }
    })
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(0)

    // Deliveroo retries. This used to return at the duplicate check.
    expect((await postSigned(t, payload)).status).toBe(200)

    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.source).toBe("deliveroo")
    // Still one order: repairing the slip must not duplicate the order.
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toHaveLength(1)
  })

  test("is given one by the sweep when no redelivery ever comes", async () => {
    // The backstop, for a platform that retries once and gives up. Every
    // fifteen minutes from `crons.ts`.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    expect(
      (await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:NORETRY" }))).status
    ).toBe(200)
    await t.run(async (ctx) => {
      for (const ticket of await ctx.db.query("kitchenTickets").collect()) {
        await ctx.db.delete(ticket._id)
      }
    })

    const result = await t.mutation(
      internal.orders.sweepTicketlessPlatformOrders,
      {}
    )

    expect(result.repaired).toBe(1)
    expect(result.failed).toBe(0)
    const tickets = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.source).toBe("deliveroo")
  })

  test("the sweep leaves an order that already has its slip alone", async () => {
    // Otherwise the backstop becomes the defect: a second slip for a dish the
    // kitchen is already cooking.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    expect(
      (await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:HASTICKET" }))).status
    ).toBe(200)

    const result = await t.mutation(
      internal.orders.sweepTicketlessPlatformOrders,
      {}
    )

    expect(result.repaired).toBe(0)
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(1)
  })

  test("the sweep does not put a website order on the pass", async () => {
    // A `website` order gets its ticket from the settlement path and a `pos`
    // one from the counter. Giving either a slip from here would put UNPAID
    // orders in front of the kitchen.
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId,
        orderNumber: "WEB-1",
        status: "pending" as const,
        paymentStatus: "pending" as const,
        paymentMethod: "card" as const,
        type: "delivery" as const,
        source: "website" as const,
        customerInfo: { name: "Client web" },
        items: [
          {
            productName: "Margherita",
            quantity: 1,
            unitPrice: 1200,
            selectedOptions: [],
            subtotal: 1200,
          },
        ],
        subtotal: 1200,
        taxAmount: 0,
        total: 1200,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const result = await t.mutation(
      internal.orders.sweepTicketlessPlatformOrders,
      {}
    )

    expect(result.repaired).toBe(0)
    expect(await t.run((ctx) => ctx.db.query("kitchenTickets").collect())).toHaveLength(0)
  })
})

// ===========================================================================
// #163.2 — the status vocabulary is Deliveroo's, not one we invented
// ===========================================================================

describe("mapDeliverooStatus", () => {
  // The whole vocabulary an order event can carry, from the Order API
  // contract: pending, placed, accepted, confirmed, rejected, canceled.
  // `canceled` has ONE l — matching the British spelling meant a cancellation
  // never cancelled anything.
  const vocabulary = [
    ["pending", "pending"],
    ["placed", "pending"],
    ["accepted", "confirmed"],
    ["confirmed", "confirmed"],
    ["rejected", "cancelled"],
    ["canceled", "cancelled"],
  ] as const

  test.each(vocabulary)("maps %s to %s", (deliverooStatus, expected) => {
    expect(mapDeliverooStatus(deliverooStatus)).toBe(expected)
  })

  test("tolerates the British spelling as an alias", () => {
    // Deliveroo sends "canceled". Our own fixtures and sandbox scenarios were
    // written against "cancelled", and accepting both costs nothing because
    // Deliveroo owns the other spelling.
    expect(mapDeliverooStatus("cancelled")).toBe("cancelled")
  })

  // Pushed by us to `/prep_stage`; never received as an order status. Mapping
  // them here is what let a Deliveroo webhook claim an order was `preparing`,
  // `ready`, `out_for_delivery` or `completed` on a vocabulary Deliveroo does
  // not speak.
  const prepStages = [
    "started_preparing",
    "ready_for_collection",
    "out_for_delivery",
    "delivered",
  ]

  test.each(prepStages)("refuses to read the prep stage %s as a status", (stage) => {
    expect(mapDeliverooStatus(stage)).toBeNull()
  })

  test("returns null rather than guessing at an unknown status", () => {
    // The old default was `pending`, which moved orders BACKWARDS: a confirmed
    // order answered "pending" and the kitchen was told to start again.
    expect(mapDeliverooStatus("some_status_added_in_2027")).toBeNull()
    expect(mapDeliverooStatus("")).toBeNull()
  })
})

describe("a status update the mapper does not recognise", () => {
  async function seedConfirmedOrder(t: ReturnType<typeof convexTest>, id: string) {
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    await postSigned(t, newOrderPayload({ id }))
    const [created] = await t.run((ctx) => ctx.db.query("orders").collect())
    await t.run((ctx) => ctx.db.patch(created!._id, { status: "confirmed" as const }))
  }

  async function statusUpdate(
    t: ReturnType<typeof convexTest>,
    id: string,
    status: string
  ) {
    return postSigned(
      t,
      JSON.stringify({
        event: "order.status_update",
        body: { order: { id, location_id: SITE_ID, status } },
      })
    )
  }

  test("leaves the order where it was", async () => {
    const t = newHarness()
    await seedConfirmedOrder(t, "gb:deliveroo:order:STATUS")

    expect(
      (await statusUpdate(t, "gb:deliveroo:order:STATUS", "some_status_added_in_2027")).status
    ).toBe(200)

    const [after] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(after!.status).toBe("confirmed")
  })

  test("does not let a prep stage move the order", async () => {
    const t = newHarness()
    await seedConfirmedOrder(t, "gb:deliveroo:order:STAGE")

    // `started_preparing` is a stage we PUSH, never an order status we
    // receive — and `confirmed -> preparing` is a legal internal move, so the
    // status machine would happily accept the guess. Nothing downstream can
    // catch this one: the mapper has to refuse it here or the order advances
    // on an event Deliveroo never sent.
    expect(
      (await statusUpdate(t, "gb:deliveroo:order:STAGE", "started_preparing")).status
    ).toBe(200)

    const [after] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(after!.status).toBe("confirmed")
  })

  test("still applies a status it does recognise", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:CANCEL" }))

    const cancel = JSON.stringify({
      event: "order.status_update",
      body: {
        order: {
          id: "gb:deliveroo:order:CANCEL",
          location_id: SITE_ID,
          // One l, as Deliveroo spells it.
          status: "canceled",
          cancellation_reason: "customer_request",
        },
      },
    })
    expect((await postSigned(t, cancel)).status).toBe(200)

    const [after] = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(after!.status).toBe("cancelled")
    expect(after!.cancellationReason).toBe("customer_request")
  })
})

// ===========================================================================
// The batch's own acceptance criteria, for this platform
// ===========================================================================

describe("a Deliveroo order is priced the way the storefront prices one", () => {
  test("stores the unit price and multiplies modifiers per unit", async () => {
    // Deliveroo sends a genuine `unit_price`, which is why this platform never
    // showed the ~2x inflation the Uber path had. It is asserted here anyway:
    // the two platforms feed the same mutation, and the whole point of the
    // pricing fix is that they now agree with each other AND with
    // `verifyOrderLine`, which computes `(price + options) * quantity`.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:PRICE" }))

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    const line = order!.items[0]!
    // 2 x Margherita @ 1200 with "Extra basilic" @ 100.
    expect(line.unitPrice).toBe(1200)
    expect(line.subtotal).toBe((1200 + 100) * 2)
  })
})

describe("a Deliveroo cancellation stops the kitchen", () => {
  test("takes the ticket off the pass, not just the order", async () => {
    // Cancelling the order row is not enough: the kitchen reads tickets. The
    // staff-facing `updateStatus` cascaded to the ticket; `updateFromWebhook` —
    // the path every platform cancellation takes — did not, so the order read
    // `cancelled` while the slip stayed live on the display and in the print
    // queue.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:KDS" }))

    const before = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(before).toHaveLength(1)
    expect(before[0]!.status).not.toBe("cancelled")

    await postSigned(
      t,
      JSON.stringify({
        event: "order.status_update",
        body: {
          order: {
            id: "gb:deliveroo:order:KDS",
            location_id: SITE_ID,
            status: "canceled",
          },
        },
      })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(order!.status).toBe("cancelled")
    expect(order!.cancelledAt).toBeTypeOf("number")
    expect(ticket!.status).toBe("cancelled")
  })

  test("is honoured for an order the kitchen has already started", async () => {
    // The narrow window: the order lifecycle stops the cancellation window at
    // `confirmed` for an OUTBOUND reason (Deliveroo refuses to cancel food
    // already being made). Applied to an INBOUND notification it silently
    // dropped real cancellations for anything past that point.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    await postSigned(t, newOrderPayload({ id: "gb:deliveroo:order:COOKING" }))

    const [created] = await t.run((ctx) => ctx.db.query("orders").collect())
    await t.run((ctx) => ctx.db.patch(created!._id, { status: "preparing" as const }))

    await postSigned(
      t,
      JSON.stringify({
        event: "order.status_update",
        body: {
          order: {
            id: "gb:deliveroo:order:COOKING",
            location_id: SITE_ID,
            status: "canceled",
          },
        },
      })
    )

    const [order] = await t.run((ctx) => ctx.db.query("orders").collect())
    const [ticket] = await t.run((ctx) => ctx.db.query("kitchenTickets").collect())
    expect(order!.status).toBe("cancelled")
    expect(ticket!.status).toBe("cancelled")
  })
})

// ===========================================================================
// #163.8 — 200 acknowledges, 500 asks for a retry
// ===========================================================================

describe("the HTTP response the webhook returns", () => {
  test("is 500 when the order could not be processed, so Deliveroo retries", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    // A real order for a site we cannot route. A 200 here loses it outright:
    // Deliveroo treats the event as delivered and never sends it again.
    const response = await postSigned(t, newOrderPayload({ siteId: "site-not-ours" }))
    expect(response.status, "a lost order was acknowledged as handled").toBe(500)
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toHaveLength(0)
  })

  test("is 200 for a duplicate, which must never be retried", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const payload = newOrderPayload({ id: "gb:deliveroo:order:DUP" })
    expect((await postSigned(t, payload)).status).toBe(200)
    expect((await postSigned(t, payload)).status).toBe(200)
  })

  test("is 200 for an event type we do not handle", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    // Nothing was lost and a redelivery would be ignored again. Answering 500
    // would spend retries — and the Order API success rate — on a no-op.
    const rider = JSON.stringify({
      event: "rider.status_update",
      rider: { status: "assigned" },
    })
    expect((await postSigned(t, rider)).status).toBe(200)
  })

  test("is 200 for an order event we do not handle", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const unknown = JSON.stringify({
      event: "order.some_future_event",
      body: { order: { id: "gb:deliveroo:order:X", location_id: SITE_ID, status: "placed" } },
    })
    expect((await postSigned(t, unknown)).status).toBe(200)
  })

  test("is 200 for a payload no redelivery could fix", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    // An `order.` event carrying no order. The same bytes come back on every
    // retry, so asking for one only burns attempts against the 98% Order API
    // success rate.
    const empty = JSON.stringify({ event: "order.new" })
    expect((await postSigned(t, empty)).status).toBe(200)
  })

  test("is 401 for an unsigned request, before any processing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const response = await t.fetch("/webhooks/deliveroo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: newOrderPayload(),
    })
    expect(response.status).toBe(401)
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toHaveLength(0)
  })
})

// ===========================================================================
// The PLU check — what Deliveroo is told about a dish we cannot cook
// ===========================================================================

/**
 * `sync_status` is the answer to "did your POS take this order?", and Deliveroo
 * acts on it: `succeeded` means the food is being made and the rider is coming.
 * Two ways the handler used to answer `succeeded` for a line no kitchen can
 * produce.
 *
 * A DELETED DISH. `products.remove` was a bare `ctx.db.delete`, so the
 * `externalProductMappings` row survived holding a REQUIRED product id that
 * resolved to nothing, and `getByExternal` returned that row without ever
 * dereferencing it. The PLU therefore still "matched", `unmatchedCount` stayed
 * at zero, and Deliveroo was told the order was accepted — for a dish the owner
 * had deleted from the menu. Both halves are fixed, and both are pinned below:
 * the delete cascades the mapping away, and the lookup dereferences. The second
 * test is not redundant, because a mapping can outlive its dish by a path that
 * never runs `products.remove` — a store cascade, a restore, a hand-run
 * mutation — and the lookup is the only guard those paths meet.
 *
 * AN IDENTIFIER IN THE OTHER FIELD. Deliveroo sends the POS identifier as
 * `pos_item_id`, `plu` or `external_reference_id` depending on how the
 * integration was set up. The "no identifier at all" test accepted all three,
 * while the lookup that follows read `pos_item_id` alone — so a line
 * identified by either of the other two skipped the database check entirely
 * (`unmatchedCount` was never computed for it) and was answered `succeeded`
 * against no mapping at all. Same customer-visible outcome as a stale mapping,
 * reached without deleting anything. `posItemId()` is now the single resolver
 * every one of those sites uses, and the happy path is pinned alongside the
 * refusal so the check cannot be "fixed" by refusing everything.
 *
 * These four need what the rest of this file deliberately does without: client
 * credentials, because `if (credentials && isAccepted)` gates the whole
 * sync-status block. They are set for this block alone and removed afterwards,
 * with the env cache reset on both edges since `getPackageEnv()` parses once
 * and memoises. `globalThis.fetch` is stubbed over the same span, so this still
 * depends on no network: it stands in for Deliveroo's OAuth and sync-status
 * endpoints and records what we sent them.
 */
describe("the sync status a Deliveroo order is answered with", () => {
  interface RecordedCall {
    url: string
    body: string | null
  }

  const httpCalls: RecordedCall[] = []
  const realFetch = globalThis.fetch

  beforeAll(() => {
    process.env.DELIVEROO_CLIENT_ID = "test-deliveroo-client-id"
    process.env.DELIVEROO_CLIENT_SECRET = "test-deliveroo-client-secret"
    process.env.DELIVEROO_IS_SANDBOX = "true"
    _resetEnvCache()

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      httpCalls.push({ url, body: typeof init?.body === "string" ? init.body : null })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      if (url.includes("/oauth2/token")) {
        return json({ access_token: "test-token", token_type: "bearer", expires_in: 300 })
      }
      // The order fetch the handler falls back to when a status update carries
      // no items. Ours always do, so this is only a safety net.
      if (/\/v1\/orders\/[^/]+$/.test(url)) return json({ order: { items: [] } })
      return json({ ok: true })
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    delete process.env.DELIVEROO_CLIENT_ID
    delete process.env.DELIVEROO_CLIENT_SECRET
    delete process.env.DELIVEROO_IS_SANDBOX
    _resetEnvCache()
  })

  /** What we last told Deliveroo about this order, as it went over the wire. */
  function syncStatusSent(): { status?: string; reason?: string } {
    const calls = httpCalls.filter((call) => call.url.includes("/sync_status"))
    expect(calls, "no sync status was sent at all").not.toHaveLength(0)
    return JSON.parse(calls[calls.length - 1]!.body ?? "{}")
  }

  async function seedProductWithPLU(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    plu: string
  ) {
    const categoryId = await t.run((ctx) =>
      ctx.db.insert("categories", {
        storeId,
        name: "Desserts",
        slug: "desserts",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId,
        categoryId,
        name: "Tiramisu",
        slug: "tiramisu",
        price: 600,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        source: "manual" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("externalProductMappings", {
        storeId,
        platform: "deliveroo" as const,
        internalProductId: productId,
        externalId: plu,
        lastSyncAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    return productId
  }

  async function seedOwner(
    t: ReturnType<typeof convexTest>,
    subject: string,
    storeId: Id<"stores">
  ) {
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: subject,
        role: "client_admin" as const,
        storeIds: [storeId],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    return t.withIdentity({ subject })
  }

  /**
   * The order, then the acceptance carrying the line under test.
   *
   * Deliveroo re-sends the order on the status update, and that is the copy the
   * sync decision reads — so the line being probed goes here, not in
   * `order.new`, and order creation stays out of the way.
   */
  async function acceptWithLine(
    t: ReturnType<typeof convexTest>,
    id: string,
    item: Record<string, unknown>
  ) {
    expect((await postSigned(t, newOrderPayload({ id }))).status).toBe(200)
    httpCalls.length = 0
    const accepted = JSON.stringify({
      event: "order.status_update",
      body: {
        order: {
          id,
          location_id: SITE_ID,
          status: "accepted",
          items: [item],
        },
      },
    })
    expect((await postSigned(t, accepted)).status).toBe(200)
  }

  test("is failed once the ordered dish has been deleted from the menu", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    const productId = await seedProductWithPLU(t, storeId, "PLU-TIRAMISU")
    const asOwner = await seedOwner(t, "user:deliveroo-owner", storeId)

    await asOwner.mutation(api.products.remove, { id: productId })

    await acceptWithLine(t, "gb:deliveroo:order:DELETED", {
      pos_item_id: "PLU-TIRAMISU",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    // `succeeded` here is Deliveroo being told the kitchen is making a dish
    // that no longer exists.
    expect(syncStatusSent()).toEqual(
      expect.objectContaining({ status: "failed", reason: "pos_item_id_mismatched" })
    )
  })

  test("is failed when the PLU is only mapped in another establishment", async () => {
    // A PLU is unique inside one restaurant, not across a deployment. The
    // lookup used to span every establishment on it, so an order this kitchen
    // cannot cook was answered as producible because a DIFFERENT restaurant had
    // that PLU on its menu.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    const neighbour = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Chez Marco",
        slug: "chez-marco",
        address: {
          street: "2 rue de la Paix",
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
    await seedProductWithPLU(t, neighbour, "PLU-NEIGHBOUR")

    await acceptWithLine(t, "gb:deliveroo:order:CROSSTENANT", {
      pos_item_id: "PLU-NEIGHBOUR",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    expect(syncStatusSent()).toEqual(
      expect.objectContaining({ status: "failed", reason: "pos_item_id_mismatched" })
    )
  })

  test("is succeeded when two establishments share a PLU string and ours has it", async () => {
    // The mirror of the case above, and the one a chain actually runs into: one
    // menu across several locations means the same PLU in several rows. The
    // deployment-wide lookup used `.unique()`, which threw on the second row —
    // and the caller counts a throw as an unmatched item, so a correct
    // multi-store deployment refused its own orders.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    await seedProductWithPLU(t, storeId, "PLU-SHARED")

    const neighbour = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Chez Luigi Bis",
        slug: "chez-luigi-bis",
        address: {
          street: "3 rue de la Paix",
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
    await seedProductWithPLU(t, neighbour, "PLU-SHARED")

    await acceptWithLine(t, "gb:deliveroo:order:SHAREDPLU", {
      pos_item_id: "PLU-SHARED",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    expect(syncStatusSent()).toEqual(expect.objectContaining({ status: "succeeded" }))
  })

  test("is failed when a mapping outlives its dish by some other path", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    const productId = await seedProductWithPLU(t, storeId, "PLU-ORPHANED")
    // Straight out of the table, the way a cascade or a restore removes one —
    // the mapping row is left behind holding an id that resolves to nothing.
    await t.run((ctx) => ctx.db.delete(productId))
    expect(await t.run((ctx) => ctx.db.query("externalProductMappings").collect())).toHaveLength(1)

    await acceptWithLine(t, "gb:deliveroo:order:ORPHANED", {
      pos_item_id: "PLU-ORPHANED",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    expect(syncStatusSent()).toEqual(
      expect.objectContaining({ status: "failed", reason: "pos_item_id_mismatched" })
    )
  })

  test("is failed for a line identified by `plu` that maps to nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)

    // No `pos_item_id`. This line used to skip the database check entirely and
    // be answered `succeeded` against a mapping table that has never heard of
    // it.
    await acceptWithLine(t, "gb:deliveroo:order:PLUFIELD", {
      plu: "PLU-UNKNOWN",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    expect(syncStatusSent()).toEqual(
      expect.objectContaining({ status: "failed", reason: "pos_item_id_mismatched" })
    )
  })

  test("is still succeeded for a line identified by `plu` that maps to a live dish", async () => {
    // The other half of the same change: reading the alternative fields must
    // resolve them, not merely refuse everything that arrives in one.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedIntegration(t, storeId)
    await seedProductWithPLU(t, storeId, "PLU-LIVE")

    await acceptWithLine(t, "gb:deliveroo:order:PLULIVE", {
      plu: "PLU-LIVE",
      name: "Tiramisu",
      quantity: 1,
      unit_price: { fractional: 600, currency_code: "EUR" },
    })

    expect(syncStatusSent().status).toBe("succeeded")
  })
})


/**
 * The kitchen-ticket failure is REPORTED, not just logged.
 *
 * WHAT WAS BROKEN, and it is the guard rather than the code. `deliverooWebhook.ts`
 * was an 854-line file with zero `captureBackendError` calls while its Uber Eats
 * twin had three, so the one failure that silently costs a restaurant a meal —
 * an order accepted with no ticket on the pass — was visible only to whoever
 * thought to open that client's Convex logs. The fix added the report and said
 * so in a comment: "REPORTED, not just logged."
 *
 * Nothing held it. Measured on this tree, replacing that one call with a no-op
 * left `deliveroo-webhook.test.ts` and `error-reporting.test.ts` at **51/51
 * green** — the exact figure the 10 September audit published. The two calls in
 * `deliverooWebhookHandler.ts` ARE held, behaviourally, by
 * `error-reporting.test.ts`; this third one, the one the ticket fix added, was
 * the one nobody was watching.
 *
 * A SOURCE ASSERTION, deliberately. Driving this branch needs a signed
 * `order.new`, a store, an integration row, a mapped product and then a forced
 * failure inside `kitchenTickets.create` — a fixture whose own weight is the
 * reason this went unguarded. What must not silently disappear is the call, and
 * that is what is checked. Comments are stripped first, because the defect this
 * class of test exists for is a comment claiming what the code stopped doing.
 *
 * NOT a blanket rule over the module. `deliverooWebhook.ts` has ten `catch`
 * blocks that log, and one reports. Whether the other nine should is a real
 * question and a larger one; asserting it here would fail nine sites today and
 * get this test deleted rather than answered.
 */
describe("a Deliveroo order that reaches no kitchen is reported", () => {
  const source = readFileSync(
    join(__dirname, "../../convex/deliverooWebhook.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")

  test("the module reaches the reporter at all", () => {
    // Guards the guard: an import that goes means every assertion below is
    // about a symbol the file no longer has.
    expect(source).toMatch(
      /import\s*\{[^}]*\bcaptureBackendError\b[^}]*\}\s*from\s*["']\.\/errorReporting["']/
    )
  })

  test("the kitchen-ticket catch reports rather than only logging", () => {
    const at = source.indexOf("Failed to create kitchen ticket:")
    expect(at, "the kitchen-ticket catch is not where this test expects it").toBeGreaterThan(-1)
    // The report belongs in the same catch, right after the log — not somewhere
    // else in an 854-line file that happens to mention the name.
    const afterLog = source.slice(at, at + 600)
    expect(afterLog).toMatch(/captureBackendError\s*\(\s*ctx\s*,/)
  })

  test("it is reported with enough to find the order", () => {
    const at = source.indexOf("Failed to create kitchen ticket:")
    const afterLog = source.slice(at, at + 600)
    // `source` and `step` are what an on-call engineer filters on; the external
    // id and the order number are what they search for once they have.
    expect(afterLog).toContain('source: "deliverooWebhook"')
    expect(afterLog).toContain('step: "kitchen-ticket"')
    expect(afterLog).toMatch(/externalOrderId/)
    expect(afterLog).toMatch(/orderNumber/)
  })

  test("the detector can say no", () => {
    // The other half: a window with no report in it must not read as reported.
    const noReport = 'console.error("Failed to create kitchen ticket:", error);'
    expect(noReport).not.toMatch(/captureBackendError\s*\(\s*ctx\s*,/)
  })
})
