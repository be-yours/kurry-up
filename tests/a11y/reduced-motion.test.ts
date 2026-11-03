/**
 * A person who has asked their device to stop moving things.
 *
 * WHAT WAS MEASURED, at `b9e20ea`. `globals.css` carried a
 * `prefers-reduced-motion` block and it reached one element: the rule named
 * `.animate-in`, which occurs once in the whole app
 * (`app/(storefront)/account/page.tsx`). Everything else that moves was
 * untouched — `animate-pulse` on every loading state, the kitchen display's
 * `live-dot`, every CSS transition — and framer-motion was untouchable by
 * construction, because it writes inline `style` on each frame and no
 * stylesheet rule outranks that. Ten `motion.*` elements render on the buying
 * path and the preference reached zero of them.
 *
 * TWO HALVES, because there are two animation systems and one rule cannot
 * cover both:
 *
 *   CSS      — a universal reduced-motion block in `app/globals.css`. Not
 *              scoped to a class: the statement is "this person asked for no
 *              motion", not "this particular animation is unwanted", so
 *              anything the product grows later is covered without anyone
 *              remembering.
 *   framer   — `<MotionConfig reducedMotion="user">` in `app/providers.tsx`,
 *              which is a context and therefore reaches every `motion`
 *              component under it: the storefront, the auth pages, the admin,
 *              the game.
 *
 * AND THE SEPARATE OBLIGATION. WCAG 2.2.2 (Pause, Stop, Hide — Level A) is not
 * about a preference at all: moving content that starts by itself, runs for
 * more than five seconds and sits beside other content needs a way to stop it,
 * for everybody. The homepage hero ran two `repeat: Infinity` floats with no
 * control anywhere. They settle after one four-second cycle now, which is
 * inside what the criterion allows — a pause button on a restaurant hero is
 * chrome nobody wants, and honouring `prefers-reduced-motion` is a sufficient
 * technique for 2.3.3, not for this one.
 *
 * SOURCE-LEVEL, and comments are stripped before matching. The first detector
 * of this shape in this repository passed against a lying comment, because the
 * comment contained the word it was looking for.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import { describe, expect, it } from "vitest"

const APP = join(__dirname, "../..")

/** Source with comments removed, so a claim about a rule cannot pass for it. */
function code(...parts: string[]): string {
  return readFileSync(join(APP, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\/[^\n]*/g, "")
}

describe("the CSS half", () => {
  const css = code("app", "globals.css")

  /** The `@media (prefers-reduced-motion: reduce)` block, braces balanced. */
  const block = (() => {
    const head = css.indexOf("@media (prefers-reduced-motion: reduce)")
    if (head === -1) return ""
    let depth = 0
    let i = css.indexOf("{", head)
    const start = i
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1)
    }
    return ""
  })()

  it("exists at all", () => {
    expect(block).not.toBe("")
  })

  it("reaches every element, not one class", () => {
    // `.animate-in` was the whole of it, and it appears once in the app.
    expect(block).toMatch(/(^|[{;}\s])\*\s*,/)
    expect(block).toContain("*::before")
    expect(block).toContain("*::after")
  })

  it("stops a loop rather than merely shortening one pass of it", () => {
    // `animation-duration: 0.01ms` alone leaves an `infinite` animation
    // running forever, 100 000 times a second. The display's `live-dot` is one.
    expect(block).toContain("animation-iteration-count: 1")
  })

  it("covers transitions and scrolling too", () => {
    expect(block).toContain("transition-duration")
    expect(block).toContain("scroll-behavior")
  })

  it("shortens rather than removes, so `animationend` still fires", () => {
    // A handler that never runs is a component stuck half-rendered.
    expect(block).not.toMatch(/animation:\s*none/)
    expect(block).toContain("0.01ms")
  })
})

describe("the framer-motion half", () => {
  const providers = code("app", "providers.tsx")

  it("is declared once, at the root, where every motion component is under it", () => {
    expect(providers).toContain('from "framer-motion"')
    expect(providers).toMatch(/<MotionConfig\s+reducedMotion="user">/)
  })

  it("wraps the children rather than sitting beside them", () => {
    // A provider that renders no children provides nothing. This is the
    // failure mode a source check exists to catch: it type-checks, it renders,
    // and it reaches nothing.
    const open = providers.indexOf("<MotionConfig")
    const close = providers.indexOf("</MotionConfig>")

    expect(open).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)
    expect(providers.slice(open, close)).toContain("{children}")
  })
})

/** Every `.tsx` under a directory, recursively. */
function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== ".next") walk(full)
      } else if (extname(full) === ".tsx") out.push(full)
    }
  }
  walk(dir)
  return out
}

describe("WCAG 2.2.2 — nothing on the buying path moves forever", () => {
  /* The storefront and the shared components a diner meets. The admin is a
     different population with a different argument: an operator chose to be
     there, and the game screens are an activity of their own. Reduced motion
     covers both through the context above; this criterion is about the pages
     somebody is sent to in order to buy a meal. */
  const ROOTS = ["app/(storefront)", "components/storefront", "components/website"]

  it("has no unbounded framer-motion loop", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sources(join(APP, root))) {
        const source = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "")
        source.split("\n").forEach((line, index) => {
          if (/repeat:\s*Infinity/.test(line)) {
            offenders.push(`${file.slice(APP.length + 1)}:${index + 1}`)
          }
        })
      }
    }

    // `HomepageContent.tsx` held two, four and five seconds long, with no
    // pause control anywhere on the page.
    expect(offenders).toEqual([])
  })

  it("has no unbounded CSS animation either", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sources(join(APP, root))) {
        const source = readFileSync(file, "utf8")
        source.split("\n").forEach((line, index) => {
          // Tailwind's own `animate-pulse`/`animate-spin` are `infinite`, and
          // they are how a LOADING state says it is still working — bounded by
          // the load, not by the clock, and gone the moment data arrives. They
          // are not the criterion's subject; a decorative marquee is.
          if (/\banimation:[^;"'`]*\binfinite\b/.test(line)) {
            offenders.push(`${file.slice(APP.length + 1)}:${index + 1}`)
          }
        })
      }
    }

    expect(offenders).toEqual([])
  })
})
