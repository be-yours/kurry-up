// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Every card provider can be asked what became of a checkout.
 *
 * WHAT WAS BROKEN (#431.2). Only Stripe could:
 *
 *     $ grep -n "path:" convex/http.ts | grep -iE "sumup|paypal"
 *     (nothing)
 *     $ grep -n "reconcile" convex/crons.ts
 *     only internal.stripe.reconcilePendingCheckouts
 *
 * So a diner who paid with SumUp, or approved with PayPal, and closed the tab
 * before the redirect completed left the charge with the provider, the order at
 * `pending` and the kitchen blind. Permanently — no path in the product ever
 * asked again. The restaurant had the money and no order to cook.
 *
 * Three things are held here, and they are the three a copy-paste of the Stripe
 * sweep would get wrong: the reference is written at checkout time (a sweep with
 * nothing to ask about is no sweep), each sweep asks its OWN provider, and
 * neither throws on a deployment that does not take that provider — which is
 * most of them, and a sweep that threw there would be red every quarter of an
 * hour for ever.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexTest } from "convex-test"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

beforeAll(() => {
  process.env.OPENAI_API_KEY = "sk-test"
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

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedStrandedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  provider: "stripe" | "sumup" | "paypal",
  reference: string
) {
  return t.run(async (ctx) => {
    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-00001",
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: 2_000,
      taxAmount: 0,
      total: 2_000,
      paymentStatus: "pending" as const,
      paymentMethod: "card",
      source: "website" as const,
      // Old enough for the sweep's window, which is 10 minutes by default.
      createdAt: Date.now() - 30 * 60_000,
      updatedAt: Date.now() - 30 * 60_000,
    })
    await ctx.db.patch(orderId, {
      providerCheckoutRef: { provider, reference, attachedAt: Date.now() - 30 * 60_000 },
    })
    return orderId
  })
}

// ===========================================================================
// The reference is written where the sweep can find it
// ===========================================================================

describe("the checkout reference", () => {
  test("is attached to the order, per provider", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedStrandedOrder(t, storeId, "sumup", "chk_1")

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.providerCheckoutRef).toMatchObject({ provider: "sumup", reference: "chk_1" })
    // And NOT in the Stripe field, which would send a SumUp id to Stripe's API
    // on the next sweep and to `checkout.sessions.expire` on the next checkout.
    expect(order?.stripeCheckoutSessionId).toBeUndefined()
  })

  test("is written by each provider's checkout creation", async () => {
    // The seam a sweep depends on entirely: no reference, nothing to ask about.
    // Read from the source, because reaching the write needs a live connection
    // and a network round trip to the provider.
    for (const [file, provider] of [
      ["sumup.ts", "sumup"],
      ["paypal.ts", "paypal"],
    ] as const) {
      const source = readFileSync(join(__dirname, "..", "..", "convex", file), "utf8")
      expect(source, `${file} never attaches its reference`).toMatch(
        new RegExp(`internalAttachCheckoutSession[\\s\\S]{0,200}provider: "${provider}"`)
      )
    }
  })
})

// ===========================================================================
// A deployment that does not take the provider
// ===========================================================================

describe("a deployment with no connection", () => {
  test("the SumUp sweep does nothing rather than throwing", async () => {
    // Most deployments. A sweep that threw here would be red every quarter of
    // an hour for ever, which is how a monitor gets muted.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedStrandedOrder(t, storeId, "sumup", "chk_1")

    await expect(
      t.action(internal.sumup.reconcilePending, {})
    ).resolves.toEqual({ examined: 0, settled: 0 })
  })

  test("and the order is untouched", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedStrandedOrder(t, storeId, "sumup", "chk_1")

    await t.action(internal.sumup.reconcilePending, {})

    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe("pending")
  })

  test("the PayPal sweep does nothing rather than throwing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedStrandedOrder(t, storeId, "paypal", "PAY-1")

    const previous = process.env.PAYPAL_CLIENT_ID
    delete process.env.PAYPAL_CLIENT_ID
    try {
      await expect(
        t.action(internal.paypal.reconcilePendingOrders, {})
      ).resolves.toEqual({ examined: 0, settled: 0, captured: 0 })
    } finally {
      if (previous !== undefined) process.env.PAYPAL_CLIENT_ID = previous
    }
  })
})

// ===========================================================================
// Each sweep asks its own provider
// ===========================================================================

describe("the sweeps", () => {
  test("each passes its OWN provider to the stranded query", async () => {
    // The copy-paste bug, and the one that matters most: a SumUp reference read
    // against Stripe's API answers "unknown", which a sweep would take for
    // "never paid".
    for (const [file, provider] of [
      ["stripe.ts", "stripe"],
      ["sumup.ts", "sumup"],
      ["paypal.ts", "paypal"],
    ] as const) {
      const source = readFileSync(join(__dirname, "..", "..", "convex", file), "utf8")
      const sweep = source.slice(source.indexOf("internalListStrandedCheckouts"))
      if (provider === "stripe") {
        // Stripe's predates the argument and defaults to it; asserting a literal
        // there would pin a call it does not make.
        expect(sweep).toMatch(/internalListStrandedCheckouts/)
      } else {
        expect(sweep.slice(0, 400), `${file} does not name its provider`).toMatch(
          new RegExp(`provider: "${provider}"`)
        )
      }
    }
  })

  test("all three are registered as crons", async () => {
    const source = readFileSync(join(__dirname, "..", "..", "convex", "crons.ts"), "utf8")
    expect(source).toMatch(/internal\.stripe\.reconcilePendingCheckouts/)
    expect(source).toMatch(/internal\.sumup\.reconcilePending\b/)
    expect(source).toMatch(/internal\.paypal\.reconcilePendingOrders/)
  })
})
