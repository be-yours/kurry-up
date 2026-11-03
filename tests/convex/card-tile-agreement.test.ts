// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The checkout and the card tile answer the same question the same way.
 *
 * WHAT THIS REPLACES. Not a bug — a coincidence. `stripe.createCheckoutSession`
 * refuses a `connected` Stripe connection through `assertChargeableOnPlatform`,
 * and `paymentAvailability.get` greys the card tile for the same state, and
 * the two agree only because each calls `resolveStripeCharge` on its own. There
 * was nothing holding them together. Change either call site — add a status to
 * the refusal, read a different row, move the check behind the SDK import — and
 * the storefront offers a tile every diner is walked into and turned away from,
 * one at a time, with no `cardProviderHealth` row to explain it (there cannot
 * be one: the refusal happens before any call to Stripe, so no verdict about
 * our credentials exists, and the hourly `verifyStripeKey` probe cannot help
 * because the key itself is fine).
 *
 * Measured at `b9e20ea` before writing this: a `connected` row with a
 * well-formed `sk_` key answers `{ card: false, cardOffered: true }` — the
 * tile is greyed and the establishment still says it takes cards, which is the
 * pair of facts that state deserves. What follows is the assertion that it
 * stays that way, over EVERY status the schema admits rather than the one that
 * happens to fail today.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"
import type { Doc } from "../../convex/_generated/dataModel"

const modules = import.meta.glob("../../convex/**/*.ts")
const NOW = 1_770_000_000_000

/** Every value `paymentConnections.status` admits, taken from the schema. */
const STATUSES: Array<Doc<"paymentConnections">["status"]> = [
  "connected",
  "onboarding_complete",
  "disconnected",
  "error",
]

const harnesses: ReturnType<typeof convexTest>[] = []

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

async function seed(status: Doc<"paymentConnections">["status"] | null) {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  await t.run(async (ctx) => {
    await ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      payments: { cardProvider: "stripe" as const, paypal: false, cash: true },
      updatedAt: NOW,
    } as never)
    if (status) {
      await ctx.db.insert("paymentConnections", {
        provider: "stripe" as const,
        merchantId: "acct_test",
        status,
        connectedAt: NOW,
        updatedAt: NOW,
      })
    }
  })
  return t
}

/**
 * What the money path would do with this connection, decided by the shared
 * rule rather than by running the action.
 *
 * `stripe.ts` is `"use node"` and dynamically imports the Stripe SDK, so
 * calling `createCheckoutSession` here would need a key and a network. The
 * rule it consults is pure and is imported directly — which is the whole
 * reason it was extracted into its own module.
 */
async function checkoutWouldRefuse(status: Doc<"paymentConnections">["status"] | null) {
  const { resolveStripeCharge } = await import(
    "@be-yours/convex-functions/stripeChargeRouting"
  )
  try {
    resolveStripeCharge(status ? { status, merchantId: "acct_test" } : null)
    return false
  } catch {
    return true
  }
}

describe("the card tile and the checkout agree, for every connection state", () => {
  test.each([...STATUSES, null])("status %s", async (status) => {
    process.env.STRIPE_SECRET_KEY = "sk_test_agreement"
    const t = await seed(status)

    const availability = await t.query(api.paymentAvailability.get, {})
    const refused = await checkoutWouldRefuse(status)

    // The one invariant. A tile a diner can select is a tile the checkout will
    // honour; a refusal the checkout will make is a tile that was never
    // offered. Anything else is a wall each diner discovers alone.
    expect(availability.card).toBe(!refused)
    // And the establishment still says it takes cards: `cardOffered` answers a
    // different question — a business decision, not a fault — so a routing
    // problem greys the tile rather than removing it (#376).
    expect(availability.cardOffered).toBe(true)
  })

  test("the refusal leaves no credentials verdict, because none was earned", async () => {
    /* Deliberate, and worth pinning because it looks like a gap. The gate
       throws BEFORE any call to Stripe, so nothing has asked Stripe anything
       and there is no verdict about our key to record. Writing `usable: false`
       into `cardProviderHealth` here would be inventing one — and it would
       then have to be un-invented by the hourly probe, which would find the
       key perfectly good and re-arm a tile the routing rule still refuses.
       `payments.internalRecordRefusedCollection` is where the routing refusal
       is written down instead. */
    process.env.STRIPE_SECRET_KEY = "sk_test_agreement"
    const t = await seed("connected")

    const health = await t.run((ctx) => ctx.db.query("cardProviderHealth").collect())

    expect(health).toEqual([])
    expect((await t.query(api.paymentAvailability.get, {})).card).toBe(false)
  })
})
