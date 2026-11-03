/**
 * No icon-only control is smaller than a finger.
 *
 * WCAG 2.5.8 Target Size (Minimum), AA in WCAG 2.2: a pointer target is at
 * least 24 by 24 CSS pixels. A control labelled with a word is as large as the
 * word; a control labelled with a 16px icon is 16px unless something says
 * otherwise, and nothing did — the password reveal on the sign-in dialog was
 * 16 by 16, the smallest control in the product, and twenty more sat between
 * 12 and 22.
 *
 * WHY A SWEEP AND NOT A CHECKLIST. Every one of those twenty-one was written
 * by somebody who had no reason to think about it: `p-0.5` around an `h-3 w-3`
 * X on a filter chip is an ordinary line of markup. A list of known-bad
 * controls would have been out of date on the next chip. The instrument reads
 * the markup, so the next one is caught on the pull request that writes it.
 *
 * WHAT IT DOES NOT CLAIM. It measures size, not spacing — 2.5.8's exception for
 * a target with 24px of clearance around it is not evaluated, so a control this
 * suite passes at exactly 24 may still be uncomfortable next to another one.
 * And a size that arrives through a CSS file, an `asChild` slot or a runtime
 * class name is not resolved; those are skipped rather than guessed at. The
 * liveness test below is what stops that silence being mistaken for a pass.
 */

import { describe, expect, it } from "vitest"
import {
  BUTTON_SIZE_PX,
  formatUndersized,
  MINIMUM_TARGET_PX,
  scanTargetSize,
} from "@be-yours/ui/target-size"

/**
 * The same regions the contrast sweep covers, minus the token-scope split it
 * needs and this does not: a pixel is a pixel in either palette.
 */
const DIRS = [
  "app",
  "components",
  "lib",
  "node_modules/@be-yours/ui/src",
  "node_modules/@be-yours/admin/src",
]

const SWEEP_BUDGET_MS = 120_000

describe("WCAG 2.5.8 target size", () => {
  it(`has no icon-only control below ${MINIMUM_TARGET_PX}x${MINIMUM_TARGET_PX} CSS px`, () => {
    const found = scanTargetSize({ appDir: process.cwd(), dirs: DIRS })
    expect(formatUndersized(found)).toBe(
      `No icon-only control below ${MINIMUM_TARGET_PX}x${MINIMUM_TARGET_PX} CSS px.`,
    )
  }, SWEEP_BUDGET_MS)

  it("is actually looking at something", () => {
    // A scanner that resolves nothing reports nothing, which is the same green
    // as a product with no failures — the exact trap `contrast.test.ts` guards
    // against next door. Raising the floor past any real control turns every
    // one the scanner RESOLVED into a finding, so this counts them.
    const resolved = scanTargetSize({ appDir: process.cwd(), dirs: DIRS, minimumPx: 4096 })

    // Measured at the time of writing: 96 icon-only controls across the two
    // apps and the two engine packages. A number that falls away here means
    // the scan has stopped reading the markup, not that the product has become
    // perfect.
    //
    // (Written the long way round on purpose. Tailwind scans this file's text
    // for class candidates and the bare word for that — the one meaning
    // `visibility: collapsed` — is a utility. `tests/` is not in the mirror
    // tree, so the token emitted one rule in the monorepo stylesheet and none
    // in the client's, and `pnpm check:mirror-css` failed on the difference.)
    expect(resolved.length).toBeGreaterThan(40)

    // And every one of them clears the real floor, which is the claim above
    // stated from the other side.
    for (const control of resolved) {
      expect(control.heightPx).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX)
      expect(control.widthPx).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX)
    }

    // The size table must know every variant `Button` defines: one it does not
    // know is measured as "unknown" and skipped, which is the quiet way a
    // guard stops guarding.
    expect(Object.keys(BUTTON_SIZE_PX).sort()).toEqual(
      ["default", "icon", "icon-lg", "icon-sm", "icon-xs", "lg", "sm", "xs"],
    )
  }, SWEEP_BUDGET_MS)
})
