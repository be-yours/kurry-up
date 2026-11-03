// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A "Stripe connected" row must not be able to lie again — ISSUE #162, sub-point 4.
 *
 * `convex/stripe.ts` builds its client from the PLATFORM secret key and sends no
 * `stripeAccount`, no `on_behalf_of` and no `transfer_data`, so every euro paid
 * by card lands in the platform balance. For a while the connect flow wrote
 * `paymentConnections.status: "connected"` the moment Stripe reported
 * `charges_enabled`, and the admin showed a green "Connecté" to an owner whose
 * takings were going somewhere else. The flow was corrected to write
 * `onboarding_complete`, the honest literal.
 *
 * Nothing stopped the next person writing `"connected"` again: `grep -c
 * paymentConnections convex/stripe.ts` returned 0 — the charge path never read
 * the row at all. These tests are the tripwire. `connected` is unreachable
 * today, so refusing it costs nothing and makes reintroducing the deception
 * impossible to do quietly.
 *
 * THE RULE IS NARROW, AND THE WIDE VERSION IS A TRAP. "Refuse whenever a Stripe
 * connection exists" would mean finishing Connect onboarding breaks card
 * payments outright for that restaurant. Only `connected` is refused; every
 * other state charges on the platform key exactly as before.
 *
 * WHY THERE IS A SOURCE-LEVEL HALF: `stripe.ts` is `"use node"` and dynamically
 * imports the Stripe SDK. The behavioural half below does reach both money
 * paths, but it can only observe that they refused — not that they refused for
 * the right reason at the right moment, before anything is sent to Stripe. The
 * source check states that, and it strips comments before matching: the first
 * detector of this shape in this repository (`settlement-binding.test.ts`)
 * passed against a lying comment, because the comment contained the word it was
 * looking for.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { api, internal } from "../../convex/_generated/api"
import schema from "../../convex/schema"
import type { Doc, Id } from "../../convex/_generated/dataModel"

const modules = import.meta.glob("../../convex/**/*.ts")
const CONVEX_DIR = join(__dirname, "../../convex")
const NOW = 1_770_000_000_000

// ---------------------------------------------------------------------------
// Source-level: the two money paths reach the gate, before anything is sent
// ---------------------------------------------------------------------------

/** The gate itself, in the package where its logic is unit-tested. */
const GUARD = "resolveStripeCharge"
/** The local helper in `stripe.ts` that reads the row and calls the gate. */
const GATE = "assertChargeableOnPlatform"

/** Source with comments removed, so a claim about the gate cannot pass for it. */
function code(module: string): string {
  return readFileSync(join(CONVEX_DIR, `${module}.ts`), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
}

/** The body of one named export, up to the next top-level export. */
function exportBody(module: string, name: string): string {
  const source = code(module)
  const start = source.indexOf(`export const ${name} =`)
  if (start === -1) return ""
  const next = source.indexOf("\nexport const ", start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

/** The body of the module-level helper, up to the first export after it. */
function helperBody(module: string, name: string): string {
  const source = code(module)
  const start = source.indexOf(`async function ${name}(`)
  if (start === -1) return ""
  const next = source.indexOf("\nexport const ", start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

/**
 * The module-level `function` / `async function` NAME, up to the next
 * top-level declaration. Empty when there is none.
 */
function localFunctionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\s*\\(`))
  if (start === -1) return ""
  const rest = source.slice(start + 1)
  const next = rest.slice(1).search(/\n(?:export |async function |function |const |let |interface |type )/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/**
 * An export's body plus the bodies of the module-level functions it calls.
 *
 * `createCheckoutSession` and `createPaymentIntent` share their guards through
 * one local helper (`openCardCharge`) rather than each carrying a copy, so a
 * gate reached THROUGH a helper the export calls is a gate the export applies.
 * One level deep, same module only, and the export's own body comes first — so
 * the "before the key" ordering below still reads the order the code runs in.
 */
function reachableBody(module: string, name: string): string {
  const source = code(module)
  const body = exportBody(module, name)
  const called = [...source.matchAll(/\n(?:async )?function (\w+)\s*\(/g)]
    .map((m) => m[1] as string)
    .filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(body))
  return [body, ...called.map((fn) => localFunctionBody(source, fn))].join("\n")
}

/** The Stripe paths that START a movement of money. */
const MONEY_PATHS = ["createCheckoutSession", "createPaymentIntent", "internalRefund"]

describe("stripe money paths reach the charge gate", () => {
  test("both money paths exist", () => {
    // Guards the guard: a renamed export would make every assertion below
    // vacuously true, because an empty body matches no pattern.
    for (const fn of MONEY_PATHS) {
      expect(exportBody("stripe", fn), `stripe.${fn}`).not.toBe("")
    }
  })

  test("stripe.ts imports the charge gate", () => {
    expect(
      new RegExp(
        `import\\s*\\{[^}]*\\b${GUARD}\\b[^}]*\\}\\s*from\\s*["'][^"']*stripeChargeRouting["']`
      ).test(code("stripe"))
    ).toBe(true)
  })

  test("the gate reads the connection and asks the shared rule", () => {
    const body = helperBody("stripe", GATE)

    expect(body).not.toBe("")
    // Reading the row is half the point: before this, `stripe.ts` mentioned
    // `paymentConnections` nowhere at all.
    expect(body).toContain("paymentConnections.internalGetByProvider")
    expect(body).toMatch(new RegExp(`\\b${GUARD}\\s*\\(`))
  })

  test.each(MONEY_PATHS)("stripe.%s calls the gate", (fn) => {
    expect(reachableBody("stripe", fn)).toMatch(new RegExp(`\\b${GATE}\\s*\\(`))
  })

  test.each(MONEY_PATHS)(
    "stripe.%s calls the gate BEFORE it reads the platform key",
    (fn) => {
      // A gate placed after the SDK import and the key lookup still refuses,
      // but it refuses late — after the module has done work on behalf of a
      // routing claim it cannot honour. Refuse first, then charge.
      const body = reachableBody("stripe", fn)
      expect(body.indexOf(GATE)).toBeGreaterThan(-1)
      expect(body.indexOf(GATE)).toBeLessThan(body.indexOf("STRIPE_SECRET_KEY"))
    }
  )

  test("the settlement paths deliberately do NOT call the gate", () => {
    // This is the other half of guarding the guard — a detector that answers
    // yes for everything is not a detector — and it is also a decision worth
    // pinning. `verifyCheckoutSession`, the webhook and the reconcile sweep
    // record money that has ALREADY moved. Refusing there would leave a real
    // charge with no payment row and no order marked paid, which is worse than
    // the mis-routing being complained about.
    expect(exportBody("stripe", "verifyCheckoutSession")).not.toMatch(
      new RegExp(`\\b${GATE}\\s*\\(`)
    )
    expect(exportBody("stripe", "reconcilePendingCheckouts")).not.toMatch(
      new RegExp(`\\b${GATE}\\s*\\(`)
    )
    // Followed through local helpers too: the native sheet's settlement is a
    // settlement, and must not reach the gate by any route.
    expect(reachableBody("stripe", "verifyPaymentIntent")).not.toMatch(
      new RegExp(`\\b${GATE}\\s*\\(`)
    )
  })

  test("a comment that merely names the gate does not satisfy the detector", () => {
    // The exact shape of the defect `settlement-binding.test.ts` was written
    // for: an annotation claiming a guard, in a module that never called it.
    const claimOnly = [
      `// @guarded-inline: ${GATE} refuses a connected account`,
      "export const chargeSomething = action({ handler: async () => {} });",
    ].join("\n")

    const stripped = claimOnly
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")

    expect(stripped).not.toMatch(new RegExp(`\\b${GATE}\\b`))
  })

  test("the bodies the detector runs against are not empty strings", () => {
    for (const fn of MONEY_PATHS) {
      expect(exportBody("stripe", fn).length, `stripe.${fn}`).toBeGreaterThan(200)
    }
    expect(helperBody("stripe", GATE).length).toBeGreaterThan(80)
  })
})

// ---------------------------------------------------------------------------
// Behavioural: what a caller actually gets back
// ---------------------------------------------------------------------------

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler — same block and same reasoning
 * as `oauth-state.test.ts`. Pending `ctx.scheduler.runAfter` work fires against a
 * closed transaction and arrives as an unhandled rejection, which turns a fully
 * green run into an exit code of 1 blaming an unrelated file.
 */
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

/** The `paymentConnections.status` union, taken from the schema rather than retyped. */
type ConnectionStatus = Doc<"paymentConnections">["status"]

/**
 * Write the connection row directly.
 *
 * `"connected"` has to be inserted rather than produced: nothing writes it for
 * Stripe any more, which is exactly why the charge path forgetting to read it
 * went unnoticed.
 */
async function seedStripeConnection(
  t: ReturnType<typeof convexTest>,
  status: ConnectionStatus
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("paymentConnections", {
      provider: "stripe" as const,
      merchantId: "acct_test",
      status,
      connectedAt: NOW,
      updatedAt: NOW,
    })
  })
}

async function seedOrder(t: ReturnType<typeof convexTest>): Promise<Id<"orders">> {
  const storeId = await t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Test",
      slug: "chez-test",
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

  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "T-001",
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: 11500,
      taxAmount: 0,
      total: 11500,
      paymentStatus: "pending" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** Whatever the action threw, as a string. */
async function thrownBy(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return String(error)
  }
  return "(nothing was thrown)"
}

function checkout(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
  return () =>
    t.action(api.stripe.createCheckoutSession, {
      orderId,
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/ko",
    })
}

function refund(t: ReturnType<typeof convexTest>) {
  return () =>
    t.action(internal.stripe.internalRefund, { externalId: "pi_test", amount: 11500 })
}

/** Only the gate produces this. */
const REFUSAL = /StripeChargeRouteError/

describe("a stripe connection claiming the charge is routed", () => {
  test("createCheckoutSession refuses, in the diner's own words", async () => {
    // This used to surface `StripeChargeRouteError` itself — an operator
    // sentence pointing at a runbook, thrown on the DINER's action, which
    // production redacted to "Server Error" behind the checkout's generic
    // retry toast (#374). The gate still stops the charge; the diner-facing
    // action now translates it to the readable card-unavailable refusal.
    // The routing detail keeps its full voice on the staff path below.
    const t = newHarness()
    await seedStripeConnection(t, "connected")
    const orderId = await seedOrder(t)

    const message = await thrownBy(checkout(t, orderId))

    expect(message).toContain("CardPaymentUnavailableError")
    expect(message).toContain("indisponible pour le moment")
    expect(message).not.toMatch(REFUSAL)
  })

  test("internalRefund refuses too", async () => {
    // A refund honouring a rule that checkout ignores — or the reverse — is the
    // same split this repository keeps hitting. Both halves of one charge have
    // to agree about which account they belong to.
    const t = newHarness()
    await seedStripeConnection(t, "connected")

    expect(await thrownBy(refund(t))).toMatch(REFUSAL)
  })
})

describe("every other connection state charges exactly as before", () => {
  /**
   * The load-bearing point of this block: it is the half that would be broken by
   * the tempting wide rule, "refuse when a Stripe connection exists".
   *
   * These assertions say the call was NOT stopped by the gate. They are not
   * vacuous on their own — an absent gate would also pass them — which is what
   * the `connected` cases above and the source checks at the top are for. What
   * they catch is a gate that refuses too much, and that is a defect no other
   * test in this repository would see: card payments would simply stop for
   * every restaurant that finished Connect onboarding.
   */
  const PROCEEDS: ConnectionStatus[] = ["onboarding_complete", "disconnected", "error"]

  test.each(PROCEEDS)("createCheckoutSession is not refused for %s", async (status) => {
    const t = newHarness()
    await seedStripeConnection(t, status)
    const orderId = await seedOrder(t)

    expect(await thrownBy(checkout(t, orderId))).not.toMatch(REFUSAL)
  })

  test.each(PROCEEDS)("internalRefund is not refused for %s", async (status) => {
    const t = newHarness()
    await seedStripeConnection(t, status)

    expect(await thrownBy(refund(t))).not.toMatch(REFUSAL)
  })

  test("no connection row at all is not refused", async () => {
    // The overwhelmingly common case: a restaurant that never touched Connect.
    const t = newHarness()
    const orderId = await seedOrder(t)

    expect(await thrownBy(checkout(t, orderId))).not.toMatch(REFUSAL)
    expect(await thrownBy(refund(t))).not.toMatch(REFUSAL)
  })

  test("a SumUp connection at connected does not stop a Stripe charge", async () => {
    // `connected` is CORRECT for SumUp — that token really does charge the
    // merchant's own account, and `sumup.ts` requires it. The gate reads the
    // Stripe row and only the Stripe row.
    const t = newHarness()
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentConnections", {
        provider: "sumup" as const,
        merchantId: "MC_TEST",
        status: "connected" as const,
        connectedAt: NOW,
        updatedAt: NOW,
      })
    })
    const orderId = await seedOrder(t)

    expect(await thrownBy(checkout(t, orderId))).not.toMatch(REFUSAL)
  })
})
