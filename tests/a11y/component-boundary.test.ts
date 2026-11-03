/**
 * No control on this app is filled with the colour behind it.
 *
 * WCAG 2.1 SC 1.4.11 Non-text Contrast, Level AA asks 3:1 for the visual
 * boundary of a user-interface component against the adjacent colour. The
 * scanner and the arithmetic are in `@be-yours/ui` — the package that owns the
 * colours; the regions are here, because only the app knows which of its trees
 * render under which token scope, and a client site cloned from this template
 * runs this same file over its own source.
 *
 * WHAT IT CAUGHT. The homepage hero CTA — the first button on the shop, the
 * one the page is built to point at — was `bg-primary` on a `bg-primary` hero:
 * 1.00:1, no boundary, separated from its ground by `shadow-primary/20`, which
 * is a primary-coloured shadow on a primary ground. Three more closing-panel
 * CTAs had it exactly (about, blog, menu). Measured across the default palette
 * and all 51 templates in both modes, the fill was 1.00:1 in all 102, so no
 * choice of theme could have rescued it.
 *
 * This is the markup complement of the token check in `contrast.test.ts`,
 * which measures `--primary` against `--background` and passes: the token pair
 * was never the problem. What the section actually put behind the button was.
 */

import { describe, expect, it } from "vitest"
import type { Rgb } from "@be-yours/ui/contrast"
import { loadTokens } from "@be-yours/ui/contrast-scan"
import {
  formatBoundaryFailures,
  NON_TEXT_MIN,
  scanComponentBoundary,
} from "@be-yours/ui/component-boundary"

/**
 * The token scope each tree renders under — the same split the contrast sweep
 * uses, and for the same reason: a property declared on an element beats the
 * one it would have inherited, so everything inside `.storefront-theme` reads
 * the shop's palette and everything outside reads the engine's.
 */
const REGIONS = [
  { dir: "app/(storefront)", scope: ".storefront-theme" },
  { dir: "components/storefront", scope: ".storefront-theme" },
  { dir: "app/(auth)", scope: ".storefront-theme" },
  { dir: "app", scope: "" },
  { dir: "components", scope: "" },
] as const

const MODES = ["light", "dark"] as const

const SHEET = loadTokens(process.cwd(), [
  ":root",
  ".dark",
  ".storefront-theme",
  ".dark .storefront-theme",
])

/** One flat token map for a mode and a scope, nearest declaration winning. */
function palette(mode: (typeof MODES)[number], scope: string): Map<string, Rgb> {
  const chain = scope
    ? mode === "dark"
      ? [`.dark ${scope}`, scope, ".dark", ":root"]
      : [scope, ":root"]
    : mode === "dark"
      ? [".dark", ":root"]
      : [":root"]

  const out = new Map<string, Rgb>()
  for (const selector of [...chain].reverse()) {
    for (const [name, rgb] of SHEET.get(selector) ?? []) out.set(name, rgb)
  }
  return out
}

function sweep(minimumRatio?: number) {
  const seen = new Set<string>()
  const findings = []
  for (const { dir, scope } of REGIONS) {
    for (const mode of MODES) {
      for (const f of scanComponentBoundary({
        appDir: process.cwd(),
        dirs: [dir],
        tokens: palette(mode, scope),
        label: `${scope || ":root"}, ${mode}`,
        minimumRatio,
      })) {
        // A file is measured once, under the scope of whichever region claims
        // it first — `app/(storefront)` before the general `app`.
        const key = `${mode}:${f.file}:${f.line}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push(f)
      }
    }
  }
  return findings
}

describe("a control and the colour behind it", () => {
  it(`keeps every control ${NON_TEXT_MIN}:1 from its ground`, () => {
    const failures = sweep()
    expect(formatBoundaryFailures(failures)).toBe(
      `No control filled with its own ground below ${NON_TEXT_MIN}:1.`
    )
  })

  /**
   * The green above is only worth something if the sweep resolves anything at
   * all. A scanner that has stopped finding grounds — a renamed token, a
   * `className` shape it no longer reads — reports nothing, which looks
   * exactly like a product with nothing wrong. This is the same liveness
   * escape hatch `target-size` and `contrast-scan` carry.
   */
  it("is measuring real pairs, not passing on silence", () => {
    const everything = sweep(1000)
    expect(everything.length).toBeGreaterThan(20)

    // And the hero CTA is one of them — the exact control this guard was
    // written for. If it stops being resolved, the guard has gone quiet on
    // the line it exists to hold.
    const hero = everything.find(
      (f) =>
        f.file.includes("HomepageContent.tsx") && f.ground === "primary" && f.element === "Button"
    )
    expect(hero, "the hero CTA is no longer resolved against its hero").toBeDefined()
    expect(hero!.ratio).toBeGreaterThanOrEqual(NON_TEXT_MIN)
  })
})
