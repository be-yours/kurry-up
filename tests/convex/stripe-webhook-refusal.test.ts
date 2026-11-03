// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A settlement refusal is answered 2xx, recorded, and retired.
 *
 * THE BUG (#411, B2-F2). `handleWebhook`'s catch answered 500 to every throw,
 * and a settlement refusal is permanent: the amount does not match, the order
 * was already collected by another charge, the reference names a different
 * order. Retrying delivers the same answer, so Stripe retried for three days,
 * each attempt re-ran the guard to the same refusal, the delivery stayed
 * `processed: false` and was re-admitted as `in_flight` every time — and the
 * only trace was a `console.error` in one client's Convex dashboard. Nobody
 * was told a diner had been charged twice.
 *
 * WHY THIS FILE EXISTS BESIDE `stripe-event-coverage.test.ts`. That one is a
 * source-level check, and its stated reason for being one — that
 * `handleWebhook` calls a `"use node"` verifier and so cannot run under
 * `edge-runtime` — is not true. convex-test takes a modules MAP, so the
 * verifier can be replaced with a stub that answers what a signed delivery
 * would have carried, and the real route runs end to end. Grepping a catch
 * block proves the branch is written; only this proves it works, and the
 * difference is not academic: the first version of the branch passed every
 * source-level assertion while throwing a validator error out of the route on
 * a payload it could not resolve.
 */

import { convexTest } from "convex-test"
import { v } from "convex/values"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import { internalAction } from "../../convex/_generated/server"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const NOW = 1_700_000_000_000
/** 1 200 € in cents. */
const CHARGE = 120_000

/** What the stub verifier should answer for the next delivery. */
let verified: Record<string, unknown> = {}

/**
 * The real module graph, with the `"use node"` verifier replaced.
 *
 * The route's own logic — the dedup claim, the guard, the settlement, the
 * catch — is the real thing. Only the SDK signature check is stubbed, which is
 * the one part `edge-runtime` genuinely cannot load.
 */
const modules = {
  ...import.meta.glob("../../convex/**/*.ts"),
  "../../convex/stripeWebhookVerify.ts": async () => ({
    verify: internalAction({
      args: { body: v.string(), signature: v.string() },
      handler: async (): Promise<Record<string, unknown>> => verified,
    }),
  }),
}

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
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Probe",
      slug: "chez-probe",
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

async function seedCardOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  orderNumber: string
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber,
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: CHARGE,
      taxAmount: 0,
      total: CHARGE,
      paymentStatus: "pending" as const,
      paymentMethod: "card",
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** Post one `checkout.session.completed` through the real route. */
function deliver(t: ReturnType<typeof convexTest>) {
  return t.fetch("/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=stubbed" },
    body: "{}",
  })
}

function checkoutCompleted(over: Record<string, unknown> = {}) {
  return {
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    paymentStatus: "paid",
    amountTotal: CHARGE,
    currency: "EUR",
    paymentIntent: "pi_second",
    ...over,
  }
}

async function auditRows(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("systemAuditLog").collect())
}

async function eventRows(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("paymentEvents").collect())
}

describe("a second card charge arriving on a collected order", () => {
  async function collectedOrder(t: ReturnType<typeof convexTest>) {
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-WH1")
    await t.mutation(internal.payments.internalSettle, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: "pi_first",
    })
    return { storeId, orderId }
  }

  test("is answered 2xx, not 500", async () => {
    const t = newHarness()
    const { storeId, orderId } = await collectedOrder(t)
    verified = checkoutCompleted({ orderId, storeId })

    const response = await deliver(t)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      received: true,
      refused: "order_already_collected",
    })
  })

  test("writes one succeeded row, not two", async () => {
    const t = newHarness()
    const { storeId, orderId } = await collectedOrder(t)
    verified = checkoutCompleted({ orderId, storeId })

    await deliver(t)

    const rows = await t.run((ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
        .collect()
    )
    expect(rows.filter((r) => r.status === "succeeded")).toHaveLength(1)
  })

  test("tells an operator, naming the order and the charge", async () => {
    const t = newHarness()
    const { storeId, orderId } = await collectedOrder(t)
    verified = checkoutCompleted({ orderId, storeId })

    await deliver(t)

    const entry = (await auditRows(t)).find(
      (e) => e.action === "payment_collection_refused"
    )
    expect(entry).toBeDefined()
    expect(entry?.result).toBe("failure")
    expect(entry?.targetStoreId).toBe(storeId)
    const details = JSON.parse(entry!.details!)
    expect(details).toMatchObject({
      code: "order_already_collected",
      provider: "stripe",
      orderId,
      externalId: "pi_second",
      eventType: "checkout.session.completed",
    })
  })

  test("retires the delivery, so Stripe stops retrying a permanent answer", async () => {
    const t = newHarness()
    const { storeId, orderId } = await collectedOrder(t)
    verified = checkoutCompleted({ orderId, storeId })

    await deliver(t)

    const events = await eventRows(t)
    expect(events).toHaveLength(1)
    expect(events[0].processed).toBe(true)
  })

  test("a retry of the same delivery is a no-op, not a second audit row", async () => {
    const t = newHarness()
    const { storeId, orderId } = await collectedOrder(t)
    verified = checkoutCompleted({ orderId, storeId })

    await deliver(t)
    const second = await deliver(t)

    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ received: true, duplicate: true })
    expect(
      (await auditRows(t)).filter((e) => e.action === "payment_collection_refused")
    ).toHaveLength(1)
  })

  test("does not leave the order reading « Payé » with nothing against it", async () => {
    // The settlement is written BEFORE the order status, so a refusal cannot
    // commit a `paid` order and then fail to record the payment behind it.
    // With a 500 that state was at least visible — the endpoint showed red in
    // the Stripe dashboard and the delivery stayed open. Answering 200 makes
    // it final, so the write order has to be right.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-WH2")
    // A charge that already settles a DIFFERENT order.
    const other = await seedCardOrder(t, storeId, "A-411-WH3")
    await t.mutation(internal.payments.internalSettle, {
      storeId,
      orderId: other,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: "pi_second",
    })

    verified = checkoutCompleted({ orderId, storeId })
    const response = await deliver(t)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      received: true,
      refused: "charge_settles_another_order",
    })
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("pending")
  })

  test("survives a storeId the metadata made up", async () => {
    // The recording call takes the order and the store as STRINGS. They used
    // to be `v.id()` validators, and Convex validates arguments BEFORE the
    // handler runs — so a value from provider metadata that is not a real id
    // threw out of the catch block itself, past the 200, and straight back
    // into the three-day retry loop, with nothing recorded. The branch whose
    // whole contract is "this can never fail its caller" was the one that
    // failed it.
    const t = newHarness()
    const { orderId } = await collectedOrder(t)
    verified = checkoutCompleted({
      orderId,
      storeId: "acct_1PfakeStripeAccount",
    })

    const response = await deliver(t)

    expect(response.status).toBe(200)
    const entry = (await auditRows(t)).find(
      (e) => e.action === "payment_collection_refused"
    )
    expect(entry).toBeDefined()
    // Not a dangling reference — but kept where a human can still read it.
    expect(entry?.targetStoreId).toBeUndefined()
    expect(JSON.parse(entry!.details!).storeId).toBe("acct_1PfakeStripeAccount")
    expect((await eventRows(t))[0].processed).toBe(true)
  })
})

describe("a settlement that genuinely succeeds", () => {
  test("is answered 2xx and marks the order paid", async () => {
    // The rule must not be satisfiable by refusing everything.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-WH4")
    verified = checkoutCompleted({ orderId, storeId })

    const response = await deliver(t)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true })
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe(
      "paid"
    )
    expect(
      (await auditRows(t)).filter((e) => e.action === "payment_collection_refused")
    ).toEqual([])
  })
})

describe("a failure that is not a refusal", () => {
  test("still answers 500, so the provider retries it", async () => {
    // The half that must not regress. A bug, an outage or a timeout is
    // transient: reading one as a refusal would mark a lost delivery processed
    // and never look at it again.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedCardOrder(t, storeId, "A-411-WH5")
    // A malformed order id. `internal.orders.internalGetById` takes
    // `v.id("orders")`, and a validator error is a genuine failure rather than
    // a decision — nothing about it says the settlement was refused, and
    // swallowing it would retire a delivery nobody ever looked at.
    verified = checkoutCompleted({ orderId: "not-an-order-id", storeId })

    const response = await deliver(t)

    expect(response.status).toBe(500)
    expect(await response.text()).toBe("Processing error")
    // Left open on purpose: Stripe's retry has to be let through.
    expect((await eventRows(t))[0].processed).toBe(false)
  })
})
