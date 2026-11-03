/**
 * Every provider's reconciliation sweep records a refusal where somebody reads it.
 *
 * WHAT WAS WRONG (#520). #475 made all three 15-minute sweeps ask what became of
 * a checkout, and #438 taught Stripe's to record a deliberate refusal through
 * `internalRecordRefusedCollection`. SumUp's and PayPal's reached a
 * `console.error` and stopped.
 *
 * That is not a cosmetic difference. A deliberate refusal means the PROVIDER
 * holds a real charge for an order this deployment will not record — the diner
 * has been debited, the restaurant has the money, and the ledger says nothing.
 * The sweep runs unattended at 3am, so a line in one client's Convex dashboard
 * is nobody being told, and no screen prompts the refund. Two of the three
 * providers dropped it, which is the case the title of #475 set out to close.
 *
 * WHY SOURCE-LEVEL. `stripe.ts`, `sumup.ts` and `paypal.ts` are all `"use node"`
 * and dynamically import provider SDKs, so none of them loads under the
 * `edge-runtime` environment these suites run in — the same reason
 * `settlement-binding.test.ts` gives for its own shape. A behavioural test
 * cannot reach the catch block; what can be proved is that the call is in it.
 */

import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PROVIDERS = ["stripe", "sumup", "paypal"] as const

function source(provider: string): string {
  return readFileSync(join(__dirname, "..", "..", "convex", `${provider}.ts`), "utf8")
}

/** The body of the reconcile action, from its export to the end of the file. */
function reconcileBody(provider: string): string {
  const src = source(provider)
  const start = src.search(/export const reconcile\w*/)
  return start === -1 ? "" : src.slice(start)
}

describe("a refused settlement during reconciliation", () => {
  test.each(PROVIDERS)("%s records it, not only logs it", (provider) => {
    const body = reconcileBody(provider)

    // Stripe calls the mutation directly; SumUp and PayPal go through
    // `recordSettlementRefusal`, which is the same write with the sweep's
    // control flow — it does not rethrow, because one order that cannot be
    // settled must not stop the rest.
    expect(
      /recordSettlementRefusal\(|internalRecordRefusedCollection/.test(body),
      `${provider}'s sweep drops a deliberate refusal on the floor`
    ).toBe(true)
  })

  test.each(PROVIDERS)("%s tags the row with the sweep it came from", (provider) => {
    // `eventType` is how an operator tells a refusal on the return page from one
    // the 3am sweep found. Both exist, and they need different words.
    expect(reconcileBody(provider)).toContain("reconcilePendingCheckouts")
  })

  test.each(PROVIDERS)("%s has a reconcile action to read at all", (provider) => {
    // Anti-vacuity: `reconcileBody` returns "" when the regex misses, and every
    // `.toContain` above would then fail loudly — but `/x/.test("")` is false,
    // which would read as a real defect rather than as a broken test. This says
    // which it is.
    expect(reconcileBody(provider).length).toBeGreaterThan(500)
  })

  test("the helper the two share does not rethrow", () => {
    // The difference from `settleOrRecordRefusal`, and the reason there are two:
    // a return page must rethrow so the diner sees an error, and a sweep must
    // not, so one unsettleable order does not stop the others.
    const helper = readFileSync(join(__dirname, "..", "..", "convex", "settlementReturn.ts"), "utf8")
    const start = helper.indexOf("export async function recordSettlementRefusal")
    expect(start).toBeGreaterThan(-1)

    const body = helper.slice(start)
    expect(body).not.toMatch(/\bthrow\b/)
  })
})
