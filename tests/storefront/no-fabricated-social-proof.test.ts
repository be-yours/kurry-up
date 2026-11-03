/**
 * A delivered client site may not invent its own social proof.
 *
 * Until this suite existed, every storefront shipped from this template
 * published, on its own homepage and with no way for the owner to remove any
 * of it:
 *
 *   - three five-star customer testimonials signed "Emma L.", "Marc D." and
 *     "Sophie R.", each with a generated face from i.pravatar.cc;
 *   - a hard-coded 4.5 star rating stamped on every real dish pulled from the
 *     restaurant's own catalogue;
 *   - two invented dishes ("Avocado Quinoa Bowl", "Mediterranean Salad Pie")
 *     carrying 4.7 and 4.8 ratings and Unsplash photography, rendered beside
 *     the real ones in the same card styling;
 *   - "4.9/5 Average Rating" and "10K+ Happy Customers" tiles;
 *   - an About page defaulting to "10K+ clients satisfaits" and a "4.9/5 note
 *     moyenne".
 *
 * The homepage block exposed only a badge and a section title, so none of it
 * was reachable from the admin: removing invented reviews from a restaurant's
 * own site required an engine code change. The product has no reviews table
 * and no ratings table — nothing collects a rating, so any star it draws is a
 * literal somebody typed.
 *
 * The tests read the shipped source off disk rather than rendering it,
 * because the defect was the presence of the data, not the behaviour of a
 * component: a guard that only fired at runtime would pass on a page nobody
 * mounted in a test.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

/**
 * The same file, with comments removed.
 *
 * These tests look for figures a page publishes, so prose about a figure has
 * to be allowed: a comment recording that "10K+ clients satisfaits" used to
 * ship is the opposite of the defect. Only whole-line and block comments are
 * stripped, never a trailing `//`, so a `https://` inside a string cannot
 * swallow the rest of a line of real code.
 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith("//") && !t.startsWith("*")
    })
    .join("\n")
}

/** Every source file a client site actually ships. */
function storefrontSources(): string[] {
  const roots = ["app/(storefront)", "components/website", "components/storefront"]
  const out: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, entry)
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel)
      } else if ([".ts", ".tsx"].includes(extname(entry))) {
        out.push(rel)
      }
    }
  }

  for (const root of roots) walk(root)
  return out
}

describe("the storefront invents no reviews", () => {
  it("ships no fabricated testimonial", () => {
    const offenders = storefrontSources().filter((path) => {
      const src = readCode(path)
      return (
        src.includes("pravatar") ||
        /const TESTIMONIALS\b/.test(src) ||
        /authorName:\s*["']/.test(src)
      )
    })

    expect(offenders).toEqual([])
  })

  it("ships no invented dish alongside the restaurant's own catalogue", () => {
    const offenders = storefrontSources().filter((path) =>
      /const VEGETARIAN_MEALS\b/.test(readCode(path)),
    )

    expect(offenders).toEqual([])
  })
})

describe("the storefront invents no ratings", () => {
  it("never hard-codes a rating on a card", () => {
    // `rating={someExpression}` is fine — a literal is not, because no data
    // source in the product can produce one.
    const offenders = storefrontSources().flatMap((path) => {
      const matches = readCode(path).match(/rating=\{\s*[\d.]+\s*\}/g)
      return matches ? matches.map((m) => `${path}: ${m}`) : []
    })

    expect(offenders).toEqual([])
  })

  it("renders a star only when a rating was supplied", () => {
    const card = read("components/website/meal-card.tsx")

    expect(card).toMatch(/rating\?:\s*number/)
    expect(card).toContain("rating !== undefined")
  })

  it("publishes no average rating or customer count the owner never measured", () => {
    const offenders = storefrontSources().flatMap((path) => {
      const src = readCode(path)
      const found: string[] = []
      // The two figures this template used to ship, in either punctuation.
      if (/\b4[.,]9\s*\/\s*5/.test(src)) found.push("4.9/5")
      if (/\b10K\+/.test(src)) found.push("10K+")
      if (/Happy Customers/.test(src)) found.push("Happy Customers")
      return found.map((f) => `${path}: ${f}`)
    })

    expect(offenders).toEqual([])
  })
})

describe("figures about the establishment come from the establishment", () => {
  it("the About page stats carry no invented code fallback", () => {
    const about = read("app/(storefront)/about/_components/AboutContent.tsx")

    // Every other block on this page legitimately falls back to sample copy a
    // restaurateur is expected to overwrite. A headline figure is different:
    // an unedited site would otherwise state a customer count and an average
    // rating that nobody measured.
    expect(about).not.toMatch(/stat\dValue"\)\.text \?\?/)
    expect(about).toContain("statItems.length > 0")
  })
})

describe("the homepage offers no section it cannot fill", () => {
  it("registers no CMS block for the deleted sections", () => {
    const page = read("cms/pages/homepage.ts")

    // A block in the registry is a section in the editor. Leaving these would
    // hand the owner two sections that render nowhere.
    expect(page).not.toContain('key: "testimonials"')
    expect(page).not.toContain('key: "vegetarianMeals"')
  })
})

describe("the storefront states no figure or promise the establishment never made", () => {
  // Found on a fresh site: the hero fell back to « Restaurant Premium » and a
  // « Top Rated · Gourmet Choice » stamp beside a star, « Livraison rapide ·
  // 15-30 Mins » and, further down, « Limited Time Offer », « Livraison Gratuite »
  // and a « Watch our story · 2:45 Mins » card over a play button that played
  // nothing — and the checkout ended on « Délai estimé : 25-35 mins » for every
  // basket at every restaurant. None of it was reachable from the admin as a
  // claim somebody had made; all of it was published under the restaurant's
  // name. The rule the tests above already hold for ratings and customer counts
  // is the same one: sample COPY may fall back, a claim or a figure may not.

  it("the homepage has no code fallback for its badges and stamps", () => {
    const home = readCode("app/(storefront)/_components/HomepageContent.tsx")

    expect(home).not.toMatch(/hero\.field\("badge"\)\.text\s*\?\?/)
    expect(home).not.toMatch(/cta\.field\("badge"\)\.text\s*\?\?/)
    for (const field of [
      "floatingBadge1Title",
      "floatingBadge1Subtitle",
      "floatingBadge2Title",
      "floatingBadge2Subtitle",
    ]) {
      expect(home, field).not.toMatch(new RegExp(`field\\("${field}"\\)\\.text\\s*\\?\\?`))
    }
  })

  it("no storefront file hard-codes a time, a rating stamp, an offer or a video", () => {
    const offenders = storefrontSources().flatMap((path) => {
      const src = readCode(path)
      const found: string[] = []
      if (/\b\d+\s*[-–]\s*\d+\s*(mins?|minutes)\b/i.test(src)) found.push("a time range")
      if (/Top Rated|Gourmet Choice/.test(src)) found.push("a rating stamp")
      if (/Livraison [Gg]ratuite/.test(src)) found.push("free delivery")
      if (/Limited Time Offer/.test(src)) found.push("an invented offer")
      if (/Watch our story|\d:\d\d\s*Mins/.test(src)) found.push("a video that does not exist")
      return found.map((f) => `${path}: ${f}`)
    })

    expect(offenders).toEqual([])
  })

  it("the order summary prints a preparation time only when one was computed", () => {
    const summary = readCode("components/storefront/order-summary.tsx")

    expect(summary).not.toMatch(/Délai estimé/)
    expect(summary).toMatch(/estimatedMinutes !== undefined/)
  })

  it("the CMS seed carries none of these figures either", () => {
    // It is not a storefront file, so the scans above never saw it, and it ships
    // in every clone: whoever ran it on a client's deployment published them.
    const seed = readCode("convex/cmsSeed.ts")

    expect(seed).not.toMatch(
      /10K\+|4[.,]9\s*\/\s*5|Top Rated|Gourmet Choice|\d+\s*[-–]\s*\d+\s*Mins|Temps moyen de livraison|Offre limitée|Restaurant Premium/
    )
  })
})
