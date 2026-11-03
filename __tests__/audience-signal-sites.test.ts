import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { SIGNAL_KEYS } from "@be-yours/convex-functions/audienceKeys"

/**
 * Every named interaction has somewhere that emits it, and every door into the
 * cart emits one.
 *
 * WHY THIS IS NEEDED AT ALL. The cart store lives in `@be-yours/restaurant`,
 * which knows nothing about the storefront's collector, so `add_to_cart` cannot
 * be emitted from the one place every path goes through. It is emitted at each
 * call site instead — three of them today — and a fourth added without one
 * would make « Ajouts au panier » quietly under-count for ever, with nothing on
 * the screen to say so.
 *
 * The other half is the one this feature's ethic turns on: a key in
 * `SIGNAL_KEYS` that nothing emits is a row of permanent zeros on an owner's
 * screen, which reads as a broken panel rather than as a feature that does not
 * exist. `directions` and `menu_download` were removed for exactly that reason.
 */

const ROOT = join(__dirname, "..")
const SEARCHED = ["app", "components", "lib"]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

const FILES = SEARCHED.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
  path: path.slice(ROOT.length + 1),
  source: readFileSync(path, "utf8"),
}))

describe("audience signal call sites", () => {
  it.each([...SIGNAL_KEYS])("something in the app emits %s", (signal) => {
    const emitters = FILES.filter(({ source }) =>
      source.includes(`recordSignal("${signal}")`)
    ).map(({ path }) => path)

    expect(
      emitters,
      `nothing emits "${signal}" — either wire it, or take it out of SIGNAL_KEYS rather than showing an owner a permanent zero`
    ).not.toEqual([])
  })

  it("every door into the cart counts the visitor who used it", () => {
    const missing = FILES.filter(
      ({ path, source }) =>
        path.startsWith("components/storefront/") &&
        /\baddItem\(\{/.test(source) &&
        !source.includes('recordSignal("add_to_cart")')
    ).map(({ path }) => path)

    expect(
      missing,
      "these add to the cart without counting it — the cart store is in an engine package and cannot do it for them"
    ).toEqual([])
  })

  /*
   * The emitter is the only import a component needs for this. A component
   * reaching for the Convex mutation directly would bypass the buffer, make one
   * network call per interaction, and spend the establishment's whole hourly
   * batch budget on a busy Friday.
   *
   * The one legitimate caller is the shell, which hands the mutation to
   * `useAudienceCollector` — the collector itself lives in
   * `@be-yours/restaurant` now and cannot reach a generated `api` of its own.
   */
  it("nothing calls the audience mutation outside the shell", () => {
    const callers = FILES.filter(
      ({ path, source }) =>
        path !== "components/storefront/storefront-shell.tsx" &&
        source.includes("api.audience.record")
    ).map(({ path }) => path)

    expect(callers).toEqual([])
  })
})
