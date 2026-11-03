// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What a storefront visitor can spend of the restaurant's money without a
 * session.
 *
 * WHAT WAS BROKEN (#430.5). Every public-by-design *mutation* in this
 * deployment was bounded and every public-by-design **action** was not:
 *
 * ```
 * $ for f in uberDirect stripe sumup paypal; do
 *     printf "%-12s %s\n" $f $(grep -c consumeRateLimit convex/$f.ts); done
 * uberDirect   0
 * stripe       0
 * sumup        0
 * paypal       0
 * ```
 *
 * Not an oversight in one file — a consequence of how the limiter is built.
 * `consumeRateLimit` reads and writes the `rateLimits` table, deliberately in
 * the same transaction as the write it protects, and an action has no
 * `ctx.db` at all. So the bound could not be written where these callers are,
 * and was not written anywhere.
 *
 * The actions are the expensive half. Each of the five below is reachable with
 * no account — they have to be, a diner sees a delivery fee and pays before
 * they have one — and each calls a third party the restaurant is billed by or
 * quota'd by. A script could burn an establishment's Uber Direct quota until
 * real deliveries stopped being quotable, at no cost to whoever ran it.
 *
 * These drive the registered actions with no identity, which is how they are
 * reached, and assert the refusal arrives BEFORE the provider is called.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexTest } from "convex-test"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

beforeAll(() => {
  // The env schema is parsed as a whole, so what it requires has to be there
  // or the handler fails for the wrong reason and the assertion passes on a
  // lie. No provider credentials: nothing here should reach a network, and
  // the point of the test is that the refusal arrives before one would.
  process.env.OPENAI_API_KEY = "sk-test"
  delete process.env.STRIPE_SECRET_KEY
})

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

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
        latitude: 48.8686,
        longitude: 2.3316,
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedOrder(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-00001",
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: 2000,
      taxAmount: 0,
      total: 2000,
      paymentStatus: "pending" as const,
      paymentMethod: "card",
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** The message a refusal carries, whatever shape the error arrived in. */
function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data
    if (typeof data === "string") return data
    if (data && typeof data === "object") return JSON.stringify(data)
  }
  return error instanceof Error ? error.message : String(error)
}

/** How many units of a named limit have been spent against a subject. */
async function spent(
  t: ReturnType<typeof convexTest>,
  name: string,
  subject: string
): Promise<number> {
  const row = await t.run((ctx) =>
    ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", `${name}:${subject}`))
      .first()
  )
  return row?.count ?? 0
}

/**
 * Call an action and swallow whatever it throws, returning the message.
 *
 * These actions all fail after the limiter — no Stripe key, no Uber
 * credentials — and that is deliberate: what is being measured is that the
 * unit was spent BEFORE the failure, i.e. before the provider would have been
 * called on a configured deployment.
 */
async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return ""
  } catch (error) {
    return messageOf(error)
  }
}

// ===========================================================================
// The limiter is reachable from an action at all
// ===========================================================================

describe("the limiter an action can reach", () => {
  test("refuses a name that is not in RATE_LIMITS, rather than doing nothing", async () => {
    // A typo must be a loud refusal. A limiter that never fires looks exactly
    // like one that is never reached, which is how this whole class of hole
    // stays invisible.
    const t = newHarness()
    await expect(
      t.run(async (ctx) => {
        await ctx.runMutation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (await import("../../convex/_generated/api")).internal.rateLimits.consume as any,
          { name: "notARealLimit", subject: "x" }
        )
      })
    ).rejects.toThrow(/Unknown rate limit/)
  })
})

// ===========================================================================
// Uber Direct — the one with a measurable bill attached
// ===========================================================================

describe("uberDirect.getDeliveryQuote", () => {
  test("spends a unit before it asks Uber anything", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await attempt(() =>
      t.action(api.uberDirect.getDeliveryQuote, {
        storeId,
        dropoffLatitude: 48.87,
        dropoffLongitude: 2.33,
      })
    )

    expect(await spent(t, "deliveryQuotePerStore", storeId)).toBe(1)
  })

  test("refuses past the window, anonymously, with no store account involved", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    // Exhaust the window by hand rather than by 600 calls: the rule under test
    // is the refusal, and 600 round trips would make this file the slowest in
    // the suite for no extra proof.
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", {
        key: `deliveryQuotePerStore:${storeId}`,
        // `Date.now()`, not the fixture clock: `checkRateLimit` starts a fresh
        // window once `now - windowStart >= windowMs`, and a 2023 fixture is
        // an hour-old window in every real run — the counter would be reset
        // rather than read, and this test would pass while proving nothing.
        windowStart: Date.now(),
        count: 600,
      })
    )

    const message = await attempt(() =>
      t.action(api.uberDirect.getDeliveryQuote, {
        storeId,
        dropoffLatitude: 48.87,
        dropoffLongitude: 2.33,
      })
    )

    expect(message).toMatch(/rate_limited|Trop de requêtes/)
  })
})

// ===========================================================================
// The three payment providers
// ===========================================================================

describe("opening a payment session", () => {
  test.each([
    ["stripe", (orderId: Id<"orders">) => ({ action: api.stripe.createCheckoutSession, args: { orderId, successUrl: "https://x/ok", cancelUrl: "https://x/no" } })],
    ["stripe (native sheet)", (orderId: Id<"orders">) => ({ action: api.stripe.createPaymentIntent, args: { orderId } })],
    ["sumup", (orderId: Id<"orders">) => ({ action: api.sumup.createCheckout, args: { orderId, redirectUrl: "https://x/ok" } })],
    ["paypal", (orderId: Id<"orders">) => ({ action: api.paypal.createPayPalOrder, args: { orderId, returnUrl: "https://x/ok", cancelUrl: "https://x/no" } })],
  ])("%s spends a unit before the provider is called", async (_name, build) => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)
    const { action, args } = build(orderId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await attempt(() => t.action(action as any, args as any))

    expect(await spent(t, "paymentSessionPerOrder", orderId)).toBe(1)
  })

  test.each([
    ["stripe", (orderId: Id<"orders">) => ({ action: api.stripe.createCheckoutSession, args: { orderId, successUrl: "https://x/ok", cancelUrl: "https://x/no" } })],
    ["stripe (native sheet)", (orderId: Id<"orders">) => ({ action: api.stripe.createPaymentIntent, args: { orderId } })],
    ["sumup", (orderId: Id<"orders">) => ({ action: api.sumup.createCheckout, args: { orderId, redirectUrl: "https://x/ok" } })],
    ["paypal", (orderId: Id<"orders">) => ({ action: api.paypal.createPayPalOrder, args: { orderId, returnUrl: "https://x/ok", cancelUrl: "https://x/no" } })],
  ])("%s refuses an eleventh session on one order", async (_name, build) => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", {
        key: `paymentSessionPerOrder:${orderId}`,
        windowStart: Date.now(),
        count: 10,
      })
    )
    const { action, args } = build(orderId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await attempt(() => t.action(action as any, args as any))

    expect(message).toMatch(/rate_limited|Trop de requêtes/)
  })
})

describe("asking a provider about a payment", () => {
  test("sumup.verifyCheckout is bounded per order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await attempt(() =>
      t.action(api.sumup.verifyCheckout, { checkoutId: "chk_1", orderId })
    )

    expect(await spent(t, "paymentSessionPerOrder", orderId)).toBe(1)
  })

  test("paypal.capturePayPalOrder is bounded per order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await attempt(() =>
      t.action(api.paypal.capturePayPalOrder, { paypalOrderId: "PAY-1", orderId })
    )

    expect(await spent(t, "paymentSessionPerOrder", orderId)).toBe(1)
  })

  test("stripe.verifyCheckoutSession is bounded on the session id it is given", async () => {
    // Stated rather than overclaimed: this bounds a LOOP on one session id.
    // Nothing here can bound invented ids — there is no order and no store to
    // key on until Stripe answers — and an invented id is refused by Stripe on
    // the spot and creates nothing.
    const t = newHarness()

    await attempt(() =>
      t.action(api.stripe.verifyCheckoutSession, { sessionId: "cs_test_1" })
    )

    expect(await spent(t, "paymentSessionPerOrder", "cs_test_1")).toBe(1)
  })

  test("stripe.verifyPaymentIntent is bounded on the intent id it is given", async () => {
    // The native sheet's return path, bounded the same way and for the same
    // reason as the hosted one above.
    const t = newHarness()

    await attempt(() =>
      t.action(api.stripe.verifyPaymentIntent, { paymentIntentId: "pi_test_1" })
    )

    expect(await spent(t, "paymentSessionPerOrder", "pi_test_1")).toBe(1)
  })
})

// ===========================================================================
// The durable half: a NEW public action cannot arrive unbounded
// ===========================================================================

/**
 * Every public action in the modules that call a paid third party is either
 * bounded or authorised.
 *
 * The tests above pin the five that exist. This one is about the sixth: the
 * hole was not a mistake in one handler, it was that nothing looked — the
 * limiter could not be written where these callers are, so it was written
 * nowhere and nobody noticed for as long as the modules have existed.
 *
 * Two ways to satisfy it, because there are two honest answers. A public
 * action either meters an anonymous caller, or it refuses one:
 * `uberDirect.createDelivery` takes the second route and checks
 * `orders:update_status`, which is right — booking a courier spends the
 * restaurant's money and is staff work.
 */
describe("the modules that call a paid third party", () => {
  const MODULES = ["stripe", "sumup", "paypal", "uberDirect"] as const

  test.each(MODULES)("%s: every public action is bounded or authorised", async (name) => {
    const source = readFileSync(
      join(__dirname, "..", "..", "convex", `${name}.ts`),
      "utf8"
    )

    // Split on the public builder only. `internalAction` is not reachable from
    // outside the deployment and is not what this rule is about.
    const bodies = source
      .split(/^export const (\w+) = action\(\{/m)
      .slice(1)

    const unbounded: string[] = []
    for (let i = 0; i < bodies.length; i += 2) {
      const fn = bodies[i]!
      // Up to the next export, or the end of the file.
      const body = bodies[i + 1]!.split(/^export const /m)[0]!
      const metered = /rateLimits\.consume/.test(body)
      const authorised = /checkStorePermission|checkPermission|requireStorePermission/.test(body)
      if (!metered && !authorised) unbounded.push(fn)
    }

    expect(unbounded).toEqual([])
  })

  test("the scan finds the actions, so it cannot pass vacuously", async () => {
    // If the builder is ever renamed out from under the split above, every
    // assertion here goes green over an empty set — which is the shape of
    // guard this repository has been bitten by more than once.
    const found = MODULES.flatMap((name) => {
      const source = readFileSync(
        join(__dirname, "..", "..", "convex", `${name}.ts`),
        "utf8"
      )
      return [...source.matchAll(/^export const (\w+) = action\(\{/gm)].map(
        (m) => `${name}.${m[1]}`
      )
    })

    expect(found).toEqual([
      "stripe.createCheckoutSession",
      "stripe.createPaymentIntent",
      "stripe.verifyCheckoutSession",
      "stripe.verifyPaymentIntent",
      "sumup.createCheckout",
      "sumup.verifyCheckout",
      "paypal.createPayPalOrder",
      "paypal.capturePayPalOrder",
      "uberDirect.getDeliveryQuote",
      "uberDirect.createDelivery",
      "uberDirect.cancelDelivery",
    ])
  })
})
