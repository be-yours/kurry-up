/**
 * An end-to-end case that finds no data must say so, not pass (#533).
 *
 * WHAT THIS IS ABOUT. `order-detail.spec.ts` read
 * `const hasOrder = await navigateToFirstOrder(page); if (hasOrder) { … }` in
 * every one of its cases, and the admin project's database had no order when CI
 * ran it. Thirteen green cases, zero assertions executed — and it stayed green
 * while the row it clicks stopped navigating altogether.
 *
 * `test.skip(condition, reason)` is the honest form of the same fact: it appears
 * in the report as a skip, with the reason, so somebody can see that the suite
 * did not cover what it claims to cover. A silent early return cannot be
 * distinguished from a pass by any reader or any tool.
 *
 * AN ASSERTION IS THE OTHER HONEST FORM, AND THE STRONGER ONE. A skip is the
 * right answer while the fixture has nothing to offer; once it does, an empty
 * list is a defect rather than a gap, and the case should go red. This file
 * used to pin the word `test.skip(` into `order-detail.spec.ts`, which was the
 * mechanism and not the point — `convex/seedFixture.ts` writes two orders now,
 * that spec asserts instead, and the guard below accepts either. What no case
 * below accepts, in any spec, is the early return.
 *
 * WHY A PINNED LIST RATHER THAN A CLEAN SWEEP. Three other specs carry the same
 * shape, twenty-three times between them, and each needs its own judgement about
 * what to seed or what to skip. Rewriting them blind — mechanically swapping
 * `if` for `test.skip` — would turn silent passes into loud skips without
 * anybody deciding whether the case should be running. They are named here
 * instead, with their counts, so the ledger is visible and a NEW one fails.
 *
 * Remove a name when its spec is fixed. The second case below fails if you
 * forget.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const APP = process.cwd()
const E2E = join(APP, "e2e")

/**
 * The specs still opting out of themselves in silence, with how many times.
 *
 * Each is a case that may assert nothing and report a pass. Fixing one means
 * deciding, per case, whether to seed the data or to skip with a reason — which
 * is why they are a ledger and not a sweep.
 */
const PINNED: Record<string, number> = {
  "admin/blog-editor.spec.ts": 4,
  "admin/promotions.spec.ts": 2,
  "admin/store-detail.spec.ts": 17,
}

/**
 * A body guarded on a "did we find any data" boolean.
 *
 * Deliberately narrow: `if (hasOrder)`, `if (hasRows)`, `if (hasStore)`. It is
 * the shape the defect actually took, and a broader pattern would fire on every
 * ordinary conditional in a spec — which is how a guard gets an allowlist so
 * long it stops meaning anything.
 */
const VACUOUS_GUARD = /\bif\s*\(\s*has[A-Z]\w*\s*\)/g

/**
 * The two honest answers to "the list this case reads is empty".
 *
 * A skip with a reason appears in the report; so does a failed assertion. A
 * silent early return appears as a pass, which is the entire defect. Either
 * branch here is acceptable and the choice belongs to the spec: skip while
 * nothing guarantees the data, assert once something does.
 *
 * The second branch is written against `rows.first()` rather than against
 * `expect(` at large, because every spec in the suite contains `expect(` and a
 * pattern that broad would accept the early return too.
 */
const SAYS_SO_WHEN_EMPTY = /test\.skip\(|expect\(\s*rows\.first\(\)\s*,/

/**
 * The body of `openFirstOrder`, which is what the pattern above is matched on.
 *
 * WHY NOT THE WHOLE FILE. `test.skip(` anywhere in the spec used to satisfy
 * the guard — a skip about a station filter, a viewport, anything at all —
 * while `openFirstOrder` itself quietly went back to letting an empty list
 * through. The predecessor `expect(source).toContain("test.skip(")` had the
 * same hole, so this is not new, but it is the hole worth closing: every case
 * in that file reaches its data through this one helper, so it is the only
 * place the answer has to appear.
 *
 * BRACE-COUNTED, NOT INDENTATION-MATCHED. The first version of this looked for
 * the closing brace at the helper's own indentation (`\n  }`, two spaces inside
 * `test.describe`). That coupled the guard to the file's layout, and the two
 * ways it broke were not equally harmless: a slice cut short only makes the
 * guard fail, which somebody sees, but `indexOf` finding nothing returns −1 and
 * the fallback handed back THE REST OF THE FILE — silently restoring the exact
 * hole this helper exists to close. Moving the helper to the top level was
 * enough to do it.
 *
 * Counting braces from the body's opening one is layout-independent, and every
 * way it can go wrong fails loudly: an unbalanced count returns `""`, which the
 * caller asserts against, and a stray brace inside a string or comment can only
 * end the slice EARLY — never late. It is not a parser and does not need to be;
 * it needs to never hand back more than the helper.
 */
function openFirstOrderBody(source: string): string {
  const start = source.indexOf("async function openFirstOrder")
  if (start === -1) return ""

  const open = source.indexOf("{", start)
  if (open === -1) return ""

  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }

  // Never balanced. Returning the remainder is what the old version did, and it
  // is the one answer that must not be given.
  return ""
}

/** Every spec under `e2e/`, as a path relative to it. */
function specs(dir: string = E2E, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".auth") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) specs(full, out)
    else if (entry.endsWith(".spec.ts")) out.push(full.slice(E2E.length + 1))
  }
  return out
}

/** How many guarded bodies a spec has, comments excluded. */
function offences(relative: string): number {
  const source = readFileSync(join(E2E, relative), "utf8")
    // The rewritten spec explains the pattern in its own header, and a scanner
    // that reads comments cannot tell the explanation from the thing explained.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
  return (source.match(VACUOUS_GUARD) ?? []).length
}

describe("the end-to-end suite", () => {
  const found = specs()

  it("has specs to read", () => {
    // Anti-vacuity, in a file about vacuity: a wrong E2E path would make every
    // assertion below pass by finding nothing.
    expect(found.length).toBeGreaterThan(20)
  })

  it("opts out of a case loudly or not at all", () => {
    const offenders = Object.fromEntries(
      found.map((spec) => [spec, offences(spec)]).filter(([, n]) => (n as number) > 0)
    )
    const unpinned = Object.fromEntries(
      Object.entries(offenders).filter(([spec]) => !(spec in PINNED))
    )

    expect(
      unpinned,
      "a spec skips its own assertions silently — use test.skip(condition, reason)"
    ).toEqual({})
  })

  it("keeps the pinned list honest — a spec that is fixed must leave it", () => {
    const stale = Object.entries(PINNED).filter(([spec, count]) => {
      if (!found.includes(spec)) return true
      return offences(spec) !== count
    })

    expect(
      stale,
      "a pinned spec changed: drop it from PINNED if it is fixed, or update its count"
    ).toEqual([])
  })

  it("holds order-detail.spec.ts to the fixed shape", () => {
    // The one this issue was about, asserted directly rather than by its absence
    // from PINNED — so deleting the list would not silently release it.
    const source = readFileSync(join(E2E, "admin/order-detail.spec.ts"), "utf8")

    expect(offences("admin/order-detail.spec.ts")).toBe(0)

    const opener = openFirstOrderBody(source)
    expect(
      opener,
      "openFirstOrder is gone or renamed — the guard below would pass on an empty string"
    ).not.toBe("")
    expect(
      opener,
      "openFirstOrder must skip with a reason or assert when the list is empty — never pass"
    ).toMatch(SAYS_SO_WHEN_EMPTY)

    // And the assertion that makes the click mean anything.
    expect(source).toContain("toHaveURL(")
  })

  it("catches the shape when there is one", () => {
    // Anti-vacuity for the regex itself, both directions.
    expect("if (hasOrder) {".match(VACUOUS_GUARD)).toHaveLength(1)
    expect("if ( hasRows )".match(VACUOUS_GUARD)).toHaveLength(1)
    expect("if (hasOrder === false)".match(VACUOUS_GUARD)).toBeNull()
    expect("if (hasty)".match(VACUOUS_GUARD)).toBeNull()
    expect("test.skip(!hasOrder, 'why')".match(VACUOUS_GUARD)).toBeNull()
  })

  it("accepts both honest answers to an empty list, and nothing else", () => {
    // The same, for the second regex. The multi-line form is the one the spec
    // actually writes, so it is the one worth pinning.
    expect('test.skip(rowCount === 0, "nothing to open")').toMatch(SAYS_SO_WHEN_EMPTY)
    expect('await expect(\n      rows.first(),\n      "nothing to open"\n    )').toMatch(
      SAYS_SO_WHEN_EMPTY
    )
    expect("const rowCount = await rows.count()").not.toMatch(SAYS_SO_WHEN_EMPTY)
    expect("if (hasOrder) { await expect(page).toHaveURL(/x/) }").not.toMatch(
      SAYS_SO_WHEN_EMPTY
    )
  })

  it("reads the answer out of openFirstOrder, not out of the file at large", () => {
    // The hole this closes: a skip belonging to some OTHER case satisfying the
    // guard while the helper every case goes through stopped handling an empty
    // list. Both halves are asserted — the slice ends at the helper, and what
    // follows it is not consulted.
    const spec = [
      "test.describe('x', () => {",
      "  async function openFirstOrder(page: Page): Promise<void> {",
      "    const rows = page.locator('tbody tr')",
      "    await rows.first().click()",
      "  }",
      "",
      "  test('unrelated', () => {",
      "    test.skip(noStation, 'the station filter offers no option')",
      "  })",
      "})",
    ].join("\n")

    expect(spec).toMatch(SAYS_SO_WHEN_EMPTY)
    expect(openFirstOrderBody(spec)).not.toMatch(SAYS_SO_WHEN_EMPTY)

    // And the honest version of the same helper passes.
    const fixed = spec.replace(
      "    await rows.first().click()",
      "    await expect(\n      rows.first(),\n      'nothing to open'\n    ).toBeVisible()"
    )
    expect(openFirstOrderBody(fixed)).toMatch(SAYS_SO_WHEN_EMPTY)

    // A renamed helper yields an empty slice, which the case above rejects
    // rather than passing on.
    expect(openFirstOrderBody("async function openSomethingElse() {}")).toBe("")
  })

  it("ends the slice at the helper whatever its indentation", () => {
    // The regression the indentation-matched version had. At the top level the
    // helper closes at column 0, `indexOf("\n  }")` found nothing, and the
    // fallback returned the rest of the file — so the unrelated skip below
    // satisfied the guard again.
    const topLevel = [
      "async function openFirstOrder(page) {",
      "  const rows = page.locator('tbody tr')",
      "  await rows.first().click()",
      "}",
      "",
      "test('unrelated', () => { test.skip(noStation, 'no option') })",
    ].join("\n")

    const body = openFirstOrderBody(topLevel)
    expect(body).toContain("rows.first().click()")
    expect(body).not.toContain("test.skip(")
    expect(body).not.toMatch(SAYS_SO_WHEN_EMPTY)

    // Unbalanced braces yield "", never the remainder.
    expect(openFirstOrderBody("async function openFirstOrder() { if (x) {")).toBe("")
  })
})
