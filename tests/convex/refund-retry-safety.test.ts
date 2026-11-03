/**
 * A refund whose outcome we do not know must not hand the operator a retry.
 *
 * THE BUG. `payments.refundPayment` commits the amount before calling the
 * provider and gives it back in a `catch` so the restaurant can retry. The
 * `catch` was unconditional — `grep -c catch` over the range returned 1, with
 * no classification anywhere — while `sumup.ts` carried a comment asserting the
 * opposite in as many words:
 *
 *     released only when the provider REFUSES. A timeout is not a refusal, so
 *     the release does not run and the balance stays committed.
 *
 * SumUp takes no idempotency key. So: a 48 € refund times out, the release
 * runs, the balance says nothing was returned, the operator presses the button
 * again, and 96 € leaves the account. The comment was the entire protection and
 * it described code that was never written.
 *
 * WHY THESE ARE SOURCE ASSERTIONS. `sumup.ts` is `"use node"` and dynamically
 * imports provider SDKs, so it does not load under the `edge-runtime`
 * environment these suites run in — the same limit `settlement-binding.test.ts`
 * documents, and the same answer: the decision's own logic is unit-tested
 * below, and what is checked at the source is that the call sites reach it.
 *
 * Comments are stripped before matching, because the defect being guarded
 * against here IS a comment that claims a guard exists.
 */

import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ConvexError } from "convex/values"

import {
  IDEMPOTENT_REFUND_PROVIDERS,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REFUSED,
  mayReleaseRefundReservation,
  providerRefusedOutright,
  refundErrorCode,
  refundFailure,
} from "../../convex/lib/refundOutcome"

const CONVEX_DIR = join(__dirname, "../../convex")

/** Source with comments removed, so a claim about a guard cannot pass for it. */
function code(module: string): string {
  return readFileSync(join(CONVEX_DIR, `${module}.ts`), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
}

describe("what counts as the provider having decided", () => {
  test("a 4xx is a refusal — it arrived and was rejected, so no money moved", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(providerRefusedOutright(status)).toBe(true)
    }
  })

  test("a 5xx is not — it may have refunded and failed to say so", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(providerRefusedOutright(status)).toBe(false)
    }
  })

  test("no response at all is not a refusal", () => {
    // A dropped connection, a DNS failure, a timeout. This is the case the
    // comment in `sumup.ts` named and the code did not handle.
    expect(providerRefusedOutright(null)).toBe(false)
  })

  test("the two ambiguous 4xx are counted with the unknowns", () => {
    // A proxy can emit either after the origin has already processed the
    // request. The bias is deliberate: a wrong "unknown" costs the operator a
    // look at SumUp's dashboard, a wrong "refused" refunds the diner twice.
    expect(providerRefusedOutright(408)).toBe(false)
    expect(providerRefusedOutright(425)).toBe(false)
  })

  test("a success status is never a refusal", () => {
    for (const status of [200, 201, 204]) {
      expect(providerRefusedOutright(status)).toBe(false)
    }
  })
})

describe("reading the code back off a thrown ConvexError", () => {
  test("across a real deployment, where data arrives as an object", () => {
    expect(refundErrorCode(new ConvexError({ code: REFUND_REFUSED }))).toBe(REFUND_REFUSED)
  })

  test("under convex-test, where data arrives as a JSON string", () => {
    // A rule that worked under only one of the two would be wrong on precisely
    // the side nobody exercises.
    expect(refundErrorCode({ data: JSON.stringify({ code: REFUND_REFUSED }) })).toBe(REFUND_REFUSED)
  })

  test("a plain Error carries nothing — Convex redacts its message in production", () => {
    expect(refundErrorCode(new Error("SumUp refund failed: 500"))).toBeNull()
    expect(refundErrorCode(undefined)).toBeNull()
    expect(refundErrorCode({ data: "not json" })).toBeNull()
  })

  test("refundFailure stamps the outcome onto the error the caller will read", () => {
    expect(refundErrorCode(refundFailure(404, "no such transaction"))).toBe(REFUND_REFUSED)
    expect(refundErrorCode(refundFailure(503, "upstream"))).toBe(REFUND_OUTCOME_UNKNOWN)
    expect(refundErrorCode(refundFailure(null, "socket hang up"))).toBe(REFUND_OUTCOME_UNKNOWN)
  })
})

describe("whether the committed amount may be given back", () => {
  test("SumUp: yes when it refused, because a retry starts from the same place", () => {
    expect(mayReleaseRefundReservation("sumup", refundFailure(400, ""))).toBe(true)
  })

  test("SumUp: NO on a lost response — this is the 96 € case", () => {
    expect(mayReleaseRefundReservation("sumup", refundFailure(null, "timeout"))).toBe(false)
    expect(mayReleaseRefundReservation("sumup", refundFailure(500, ""))).toBe(false)
  })

  test("SumUp: NO for an error it does not recognise", () => {
    // The default matters more than the rules. An unrecognised error is an
    // error whose outcome is unknown, and guessing "refused" is the guess that
    // costs money.
    expect(mayReleaseRefundReservation("sumup", new Error("boom"))).toBe(false)
    expect(mayReleaseRefundReservation("sumup", undefined)).toBe(false)
  })

  test("Stripe and PayPal: always, because their retry carries the same key", () => {
    for (const provider of IDEMPOTENT_REFUND_PROVIDERS) {
      expect(mayReleaseRefundReservation(provider, new Error("timeout"))).toBe(true)
      expect(mayReleaseRefundReservation(provider, refundFailure(null, ""))).toBe(true)
    }
  })
})

/**
 * The list and the call sites must agree, or the list is just an opinion.
 *
 * This is the assertion that makes the rest self-maintaining. Give SumUp's
 * `internalRefund` a key and add it to the list, and the two move together;
 * add it to the list ALONE and this fails, which is the mistake that would
 * reinstate the bug in one line.
 */
describe("the idempotent-provider list is the truth about the call sites", () => {
  /** Every `internal.<provider>.internalRefund` call in payments.ts, with its arguments. */
  function refundCallSites(): Array<{ provider: string; args: string }> {
    return [...code("payments").matchAll(/internal\.(\w+)\.internalRefund,\s*\{([^}]*)\}/g)].map(
      (match) => ({ provider: match[1] as string, args: match[2] as string }),
    )
  }

  test("the scan itself found the call sites", () => {
    // Without this, a refactor that renames the actions turns every assertion
    // below into a vacuous pass.
    expect(refundCallSites().length).toBeGreaterThanOrEqual(3)
  })

  test("every provider on the list is sent an idempotency key", () => {
    const withoutKey = refundCallSites()
      .filter((site) => (IDEMPOTENT_REFUND_PROVIDERS as readonly string[]).includes(site.provider))
      .filter((site) => !site.args.includes("idempotencyKey"))
      .map((site) => site.provider)

    expect(withoutKey).toEqual([])
  })

  test("every provider sent an idempotency key is on the list", () => {
    const unlisted = refundCallSites()
      .filter((site) => site.args.includes("idempotencyKey"))
      .filter((site) => !(IDEMPOTENT_REFUND_PROVIDERS as readonly string[]).includes(site.provider))
      .map((site) => site.provider)

    expect(unlisted).toEqual([])
  })

  test("SumUp is not on it", () => {
    // Stated as its own case rather than left implicit: SumUp's absence is the
    // whole reason this module exists, and a list that quietly gained it would
    // otherwise pass everything above.
    expect(IDEMPOTENT_REFUND_PROVIDERS as readonly string[]).not.toContain("sumup")
  })
})

describe("the release is reached through the decision, not around it", () => {
  test("payments.ts asks before releasing", () => {
    expect(code("payments")).toMatch(
      /if\s*\(\s*mayReleaseRefundReservation\([^)]*\)\s*\)\s*\{[^}]*internalReleaseRefund/,
    )
  })

  test("there is no second, unguarded release in the refund path", () => {
    // The guard above proves ONE release is conditional. It says nothing about
    // a second one added beside it, which is how this class of fix is usually
    // undone.
    const source = code("payments")
    const releases = [...source.matchAll(/internalReleaseRefund/g)]
    // Two: the mutation's own declaration, and the single guarded call site.
    expect(releases.length).toBe(2)
  })

  test("sumup.ts reports failures through refundFailure and never a bare Error", () => {
    const refund = code("sumup").slice(code("sumup").indexOf("export const internalRefund ="))
    const body = refund.slice(0, refund.indexOf("\nexport const ") + 1 || undefined)
    expect(body).toContain("refundFailure(")
    // A `throw new Error` here is a message Convex redacts in production and a
    // code `mayReleaseRefundReservation` cannot read — which defaults to "do
    // not release" and would strand every refund instead of double-paying it.
    // Wrong in the safe direction is still wrong.
    expect(body).not.toMatch(/throw new Error\(/)
  })

  test("the fetch itself is inside the try, or a lost connection never reaches the classifier", () => {
    const source = code("sumup")
    const refund = source.slice(source.indexOf("export const internalRefund ="))
    const tryAt = refund.indexOf("try {")
    const fetchAt = refund.indexOf("await fetch(")
    expect(tryAt).toBeGreaterThan(-1)
    expect(fetchAt).toBeGreaterThan(tryAt)
  })
})
