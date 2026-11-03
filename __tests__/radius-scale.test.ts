import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

/**
 * The shape half of a template's identity reaches the shop (#512).
 *
 * WHAT WAS BROKEN. A template sets three things — colour, type and shape. The
 * first two were carried to the storefront by #41 and #410; the third was never
 * measured at all. Fifty of the fifty-one templates end `theme.css` with a
 * `Shape language` heading and a `--radius`, `templates/default/theme.css` lists
 * it among the tokens a client tunes, and it painted one keyboard-shortcut badge
 * in `packages/ui`. Tailwind v4 builds the `rounded-*` utilities from the
 * `--radius-*` namespace and `@theme inline` mapped none of it, so 405
 * hard-coded literals across 44 storefront files resolved to Tailwind's own
 * defaults. `pizzeria-verace` at `0.25rem` and `fast-food-verte` at `1.5rem`
 * rendered identical shapes.
 *
 * WHAT THIS HOLDS, AND WHY IT IS NOT A RESTATEMENT. The mapping is a ratio per
 * step, anchored so that at the engine's own `--radius` every step resolves to
 * the byte-identical Tailwind default — which is what makes it safe to land on
 * hundreds of delivered sites at once. That anchor is arithmetic between three
 * numbers this file does not own: the multiplier in `globals.css`, the engine's
 * `--radius` in the same file, and Tailwind's default in its own `theme.css`.
 * All three are READ here rather than written down, so the test fails on a
 * retuned multiplier, on a moved engine radius, and on a Tailwind upgrade that
 * shifts the defaults underneath us — three things no reviewer can see by
 * looking at a diff, and the third of which arrives without a diff at all.
 */

const APP_ROOT = path.resolve(__dirname, "..")
const GLOBALS = path.join(APP_ROOT, "app/globals.css")

const require = createRequire(import.meta.url)
const TAILWIND_THEME = require.resolve("tailwindcss/theme.css")

const globals = fs.readFileSync(GLOBALS, "utf8")

/** `rem` values are the only unit either file spells; anything else is a bug. */
function rem(value: string): number {
  const match = /^([0-9.]+)rem$/.exec(value.trim())
  expect(match, `not a rem value: "${value}"`).not.toBeNull()
  return Number(match![1])
}

/** The engine's own `--radius`, from the `:root` block `@layer base` declares. */
function engineRadius(): number {
  const match = /^\s*--radius:\s*([^;]+);/m.exec(globals)
  expect(match, "globals.css declares no --radius").not.toBeNull()
  return rem(match![1] as string)
}

/** Every `--radius-<step>: calc(var(--radius) * N)` the stylesheet maps. */
function mappedSteps(): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [, step, multiplier] of globals.matchAll(
    /^\s*--radius-([a-z0-9]+):\s*calc\(var\(--radius\)\s*\*\s*([0-9.]+)\);/gm
  )) {
    found[step as string] = Number(multiplier)
  }
  return found
}

/** Tailwind's own default scale, read from the version actually installed. */
function tailwindDefaults(): Record<string, number> {
  const theme = fs.readFileSync(TAILWIND_THEME, "utf8")
  const found: Record<string, number> = {}
  for (const [, step, value] of theme.matchAll(/^\s*--radius-([a-z0-9]+):\s*([^;]+);/gm)) {
    found[step as string] = rem(value as string)
  }
  return found
}

describe("the radius scale follows the template", () => {
  test("there is a scale to check", () => {
    // Anti-vacuity: every assertion below iterates one of these two, and an
    // empty match — a renamed token, a reformatted declaration, a Tailwind
    // layout change — would make all of them pass over nothing at all.
    expect(Object.keys(mappedSteps()).length).toBeGreaterThanOrEqual(8)
    expect(Object.keys(tailwindDefaults()).length).toBeGreaterThanOrEqual(8)
    expect(engineRadius()).toBeGreaterThan(0)
  })

  test("every step Tailwind declares is mapped", () => {
    // A scale with two steps pinned to Tailwind while the other six follow the
    // establishment is not a shape language. This is also what notices a step
    // ADDED by a Tailwind upgrade: `--radius-5xl` would arrive unmapped and
    // silently stop following the template.
    const unmapped = Object.keys(tailwindDefaults()).filter((step) => !(step in mappedSteps()))

    expect(unmapped, "declared by Tailwind and not mapped in globals.css").toEqual([])
  })

  test("nothing is mapped that Tailwind does not declare", () => {
    // The other direction: a mapping for a step no utility reads is dead
    // weight that looks like coverage.
    const defaults = tailwindDefaults()
    const extra = Object.keys(mappedSteps()).filter((step) => !(step in defaults))

    expect(extra, "mapped in globals.css and unknown to Tailwind").toEqual([])
  })

  test("at the engine's own --radius, every step is Tailwind's default exactly", () => {
    // THE ANCHOR, AND THE REASON THIS CHANGE COULD SHIP TO EVERY DELIVERED SITE
    // AT ONCE. The mapping is global — `@theme` reaches the dashboard as well as
    // the shop — so it has to be a no-op until a template is applied. Each
    // multiplier is its step's Tailwind default divided by the engine's radius,
    // and this multiplies it back out. A retuned multiplier, a moved engine
    // radius, or a Tailwind release that shifts a default all land here.
    const radius = engineRadius()
    const defaults = tailwindDefaults()
    const drifted: string[] = []

    for (const [step, multiplier] of Object.entries(mappedSteps())) {
      const resolved = radius * multiplier
      const expected = defaults[step]
      if (expected === undefined) continue
      // Exact to floating-point noise, not "close": the promise is that today's
      // rendering does not move, and a 0.5px drift on 405 literals is a redesign
      // nobody asked for.
      if (Math.abs(resolved - expected) > 1e-9) {
        drifted.push(`${step}: ${radius} * ${multiplier} = ${resolved}rem, Tailwind says ${expected}rem`)
      }
    }

    expect(drifted).toEqual([])
  })

  test("the mapping is a ratio, never an offset", () => {
    // shadcn's own convention is additive — `calc(var(--radius) - 2px)` — and it
    // fails at the sharp end, which is where this catalogue lives: 30 of the 50
    // templates sit at or below 0.5rem and three ask for 0rem outright. An
    // offset leaves `rounded-2xl`, the storefront's most-used radius, at 6px on
    // a template that asked for square corners, and can reach a negative radius,
    // which is an INVALID declaration — dropped by the browser, so the utility
    // silently falls back instead of failing. A ratio can do neither.
    const offsets = [
      ...globals.matchAll(/^\s*(--radius-[a-z0-9]+):\s*(calc\([^;]*\));/gm),
    ]
      // `var(--radius)` carries two hyphens of its own, so the custom-property
      // references go first and what is left is the arithmetic.
      .filter(([, , expression]) => /[+\-]/.test((expression as string).replace(/var\(--[\w-]+\)/g, "")))
      .map(([, token]) => token as string)

    expect(offsets, "maps a radius step by offset rather than by ratio").toEqual([])
  })

  test("--radius itself is not mapped as a step", () => {
    // `--radius-DEFAULT` would make the bare `rounded` utility follow too. It is
    // deliberately absent: Tailwind 4.2.2 declares no such default, so adding
    // one would not restore a value — it would invent a utility that resolves to
    // nothing today, and `rounded` is spelled nowhere in the storefront.
    expect(mappedSteps()).not.toHaveProperty("DEFAULT")
    expect(tailwindDefaults()).not.toHaveProperty("DEFAULT")
  })
})
