/**
 * Every path that opens a card charge asks the floor first.
 *
 * WHAT WAS BROKEN. `assertCardChargeable` refuses an amount no card provider
 * will take — below the provider minimum, zero, negative, not a number — before
 * one is asked to. Its own docblock names the three callers:
 *
 *     Called by `stripe.createCheckoutSession`, `sumup.createCheckout` and
 *     `paypal.createPayPalOrder`.
 *
 * Nothing checked that. The function had a thorough unit suite in
 * `packages/convex-functions/src/__tests__/cardChargeFloor.test.ts` — which
 * proves the rule and says nothing about whether anybody applies it — and the
 * call sites had no guard at all. Measured on this tree: replacing the call in
 * `stripe.createCheckoutSession` with a comment left `apps/themes/tests/convex`
 * at **82 files, 1181 tests, all green**.
 *
 * That is the identical shape `settlement-binding.test.ts` was written for, one
 * guard over: an annotation claiming a protection, in a module that had stopped
 * applying it. A caller list that lives only in prose is a caller list nothing
 * maintains.
 *
 * WHY SOURCE ASSERTIONS. `stripe.ts`, `sumup.ts` and `paypal.ts` are all
 * `"use node"` and dynamically import provider SDKs, so none of them loads
 * under the `edge-runtime` environment these suites run in. The rule's own
 * logic is unit-tested where it lives; what is asserted here is that the three
 * call sites actually reach it.
 *
 * Comments are stripped before matching, because the defect being guarded
 * against IS a comment that names the guard.
 */

import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { APP_ROOT, enginePackageFile } from "../lib/repo-layout"

const CONVEX_DIR = join(APP_ROOT, "convex")

const FLOOR = "assertCardChargeable"

/**
 * Where a card charge is opened, and by whom.
 *
 * Cash and the platform integrations are deliberately absent: the floor is a
 * property of what a CARD network will accept, and an order settled in cash or
 * pushed from Uber Eats never reaches one.
 */
const CARD_CHARGE_ENTRY_POINTS: Array<{ module: string; fn: string }> = [
  { module: "stripe", fn: "createCheckoutSession" },
  { module: "stripe", fn: "createPaymentIntent" },
  { module: "sumup", fn: "createCheckout" },
  { module: "paypal", fn: "createPayPalOrder" },
]

/**
 * The same rows, each carrying the dotted name of its call site.
 *
 * `test.each` resolves `$module.$fn` as the property PATH `module.$fn` — one
 * lookup, not two interpolations joined by a dot — and that property does not
 * exist, so all three titles rendered `undefined calls the floor`. A failure
 * then named no call site, which is the only thing a per-case title is for.
 * Measured: `$module.$fn` prints `undefined`, `$module.fn=$fn` prints
 * `undefined='createCheckoutSession'`, and a single property prints its value.
 * So the dot is joined here, where it is an ordinary string.
 */
const NAMED_ENTRY_POINTS = CARD_CHARGE_ENTRY_POINTS.map((entry) => ({
  ...entry,
  callSite: `${entry.module}.${entry.fn}`,
}))

/** Source with comments removed, so a claim about the guard cannot pass for it. */
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
 * The two Stripe charge paths share their guards through one local helper
 * (`openCardCharge`) rather than each carrying a copy, so a guard reached
 * THROUGH a helper the export calls is a guard the export applies. One level
 * deep, and only functions declared in the same module: an import is not
 * followed, so naming the guard in another file cannot satisfy this.
 */
function reachableBody(module: string, name: string): string {
  const source = code(module)
  const body = exportBody(module, name)
  const called = [...source.matchAll(/\n(?:async )?function (\w+)\s*\(/g)]
    .map((m) => m[1] as string)
    .filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(body))
  return [body, ...called.map((fn) => localFunctionBody(source, fn))].join("\n")
}

function importsFloor(module: string): boolean {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${FLOOR}\\b[^}]*\\}\\s*from\\s*["'][^"']*cardChargeFloor["']`
  ).test(code(module))
}

function callsFloor(module: string, name: string): boolean {
  return new RegExp(`\\b${FLOOR}\\s*\\(`).test(reachableBody(module, name))
}

describe("the card floor is applied where a charge is opened", () => {
  test("every entry point exists", () => {
    // Guards the guard: a renamed export makes every assertion below vacuously
    // true, because an empty body matches no pattern.
    for (const { module, fn } of CARD_CHARGE_ENTRY_POINTS) {
      expect(exportBody(module, fn), `${module}.${fn}`).not.toBe("")
      expect(exportBody(module, fn).length, `${module}.${fn}`).toBeGreaterThan(200)
    }
  })

  test.each(CARD_CHARGE_ENTRY_POINTS)("$module imports the floor", ({ module }) => {
    expect(importsFloor(module), `${module}.ts must import ${FLOOR}`).toBe(true)
  })

  test.each(NAMED_ENTRY_POINTS)("$callSite calls the floor", ({ module, fn }) => {
    // The rendered title is part of the guard, so it is asserted rather than
    // trusted: this reads back what vitest actually produced, which is what
    // `$module.$fn` silently got wrong while every case still passed.
    expect(expect.getState().currentTestName).toContain(`${module}.${fn}`)
    expect(callsFloor(module, fn), `${module}.${fn} must call ${FLOOR}`).toBe(true)
  })

  test("the floor is asked about the order's own total", () => {
    // Not a constant, and not some other field: the amount actually being sent
    // to the provider is the one that has to clear the minimum.
    for (const { module, fn } of CARD_CHARGE_ENTRY_POINTS) {
      expect(reachableBody(module, fn), `${module}.${fn}`).toMatch(
        /assertCardChargeable\(\s*\{\s*amountMinor:\s*order\.total\b/
      )
    }
  })

  test("the detector can also say no", () => {
    // The other half of guarding the guard: a detector that answers true for
    // everything is not a detector. `orders.ts` opens no card charge.
    expect(importsFloor("orders")).toBe(false)
    // And a settlement is not a charge being opened — the floor belongs at the
    // moment the amount is offered to the provider, not when it comes back.
    expect(callsFloor("stripe", "verifyCheckoutSession")).toBe(false)
    expect(callsFloor("stripe", "verifyPaymentIntent")).toBe(false)
  })

  test("a guard reached through a local helper is found, and only through a call", () => {
    // The two Stripe charge paths share their guards through `openCardCharge`.
    // The detector follows a helper the export CALLS; a helper merely declared
    // in the module is not followed, or every export in `stripe.ts` would pass.
    expect(exportBody("stripe", "createCheckoutSession")).not.toMatch(
      new RegExp(`\\b${FLOOR}\\s*\\(`)
    )
    expect(reachableBody("stripe", "createCheckoutSession")).toMatch(/\bopenCardCharge\s*\(/)
    expect(reachableBody("stripe", "reconcilePendingCheckouts")).not.toMatch(
      new RegExp(`\\b${FLOOR}\\s*\\(`)
    )
  })

  test("a comment naming the floor does not satisfy either detector", () => {
    // The exact shape of the original defect, one guard over: an annotation
    // claiming the protection in a module that never applies it.
    const claimOnly = [
      "// assertCardChargeable refuses an amount below the provider minimum",
      "export const createSomething = action({ handler: async () => {} });",
    ].join("\n")
    const stripped = claimOnly
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
    expect(stripped).not.toMatch(new RegExp(`\\b${FLOOR}\\b`))
  })
})

describe("the engine still exports what these call sites import", () => {
  /**
   * A rename in the engine is invisible to the checks above: they match the
   * NAME at the call site, and a call site importing a symbol the package no
   * longer has fails at build rather than here — but only once the release
   * carrying the rename is installed. Reading the engine says so at the source.
   */
  test("assertCardChargeable is exported by the package the call sites name", () => {
    const file = enginePackageFile("convex-functions", "src/cardChargeFloor.ts")
    expect(file, "packages/convex-functions/src/cardChargeFloor.ts is missing").not.toBeNull()
    const source = readFileSync(file as string, "utf8")
    expect(source).toMatch(new RegExp(`export function ${FLOOR}\\s*\\(`))
  })

  test("its docblock still names the callers this file checks", () => {
    // The prose that was the only record of the caller list. It stays true now
    // because a test reads it — and if a fourth provider is added, this fails
    // until both the list above and the docblock name it.
    const file = enginePackageFile("convex-functions", "src/cardChargeFloor.ts")
    const source = readFileSync(file as string, "utf8")
    for (const { module, fn } of CARD_CHARGE_ENTRY_POINTS) {
      expect(source, `${module}.${fn} is not named in the floor's docblock`).toContain(
        `${module}.${fn}`
      )
    }
  })
})
