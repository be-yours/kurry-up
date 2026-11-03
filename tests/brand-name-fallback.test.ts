/// <reference types="vite/client" />

/**
 * A delivered restaurant never shows the vendor's name (#613).
 *
 * WHAT SHIPPED. `storefront-header.tsx` read
 * `cms.block("branding").field("brandName").text ?? "BeYours"`, and
 * `grep -c branding apps/themes/convex/cmsSeed.ts` returned **0**. The
 * `branding` block is the only branding the header, the favicon, the JSON-LD
 * and the admin sidebar read, and it was the one block the seed never wrote —
 * it filled `header.brandName` instead, one accordion below in the same
 * editor, a field with no reader at all.
 *
 * So the owner opened the CMS, found « Nom de la marque (header) » already
 * filled in, concluded the job was done, and their customers were served the
 * vendor's name on the client's own domain. Worse: `cmsSeed` is an
 * `internalAction` whose only invocation anywhere is a comment, so the
 * realistic delivered state is no CMS rows at all and the fallback fired
 * unconditionally.
 *
 * TWO HALVES HERE. `resolveBrandName` is unit-tested for its chain, and the
 * sweep below reads source for the SHAPE that caused this: a `??` whose
 * right-hand side is a brand literal. A behavioural test cannot catch that —
 * the defect is what happens when the database is empty, which is the state a
 * test seeds away.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { resolveBrandName } from "../lib/cms/brand-name"

const APP = process.cwd()

/** Where copy a diner or an owner can read comes from. */
const SCANNED = ["app", "components", "lib", "convex", "cms"]

/**
 * The vendor's brands, however they are spaced.
 *
 * Both, because `README.md`'s Naming section exists precisely because the two
 * are routinely confused: BeYours is the product sold to restaurant owners,
 * BeInDigital is the agency. Neither belongs in a client's header.
 */
const VENDOR = String.raw`(?:Be\s*Yours|Be\s*In\s*Digital|BeYours|BeInDigital)`

/**
 * `?? "BeYours"`, `|| "BeYours"`, `: "BeYours"` — a brand literal standing in
 * for an absent value. Also catches `?? \`BeYours\``.
 */
const BRAND_FALLBACK = new RegExp(
  String.raw`(\?\?|\|\||:)\s*["'\`][^"'\`]*` + VENDOR + String.raw`[^"'\`]*["'\`]`,
  "g",
)

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next" || entry === "_generated") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) found.push(full)
    }
  }
  for (const dir of SCANNED) walk(join(APP, dir))
  return found
}

/**
 * Comments removed. This fix is explained in several that name the literal
 * they removed, and a scanner that reads comments accuses the fix of being the
 * bug — the trap `indexing-and-brand.test.ts` documents on the commercial site.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

describe("no user-facing string falls back to the vendor's name", () => {
  it("finds files to read", () => {
    // Anti-vacuity: a broken walk would pass every assertion below.
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files.map((f) => relative(APP, f))).toContain(
      join("components", "storefront", "storefront-header.tsx"),
    )
  })

  it("catches the shape it is looking for", () => {
    // Anti-vacuity for the regex, against the exact line that shipped.
    const shipped = `const brandName = cms.block("branding").field("brandName").text ?? "BeYours"`
    expect(shipped.match(BRAND_FALLBACK)).not.toBeNull()
    expect(`const brandName = store?.name ?? "BeYours"`.match(BRAND_FALLBACK)).not.toBeNull()
    // And does not fire on the footer's deliberate attribution.
    expect(`poweredBy: t("Propulsé par BeYours")`.match(BRAND_FALLBACK)).toBeNull()
  })

  /**
   * The one match that is not a defect, named rather than regex-ed away.
   *
   * `platformStoreStatus.ts` sends `{ reason: "Updated from the BeYours admin" }`
   * to Uber Eats' store-status endpoint. The audience is Uber's API and the
   * operator reading Uber's own portal, and the sentence names the system that
   * made the change — which is what a `reason` field is for. It is not a name
   * shown to a diner and not a fallback for an absent establishment name.
   *
   * Listed here so it is a deliberate line in a diff. Anything else added to
   * this list wants the same paragraph.
   */
  const ALLOWED = new Set([
    'convex/platformStoreStatus.ts: : "Updated from the BeYours admin"',
    /*
     * `apps/reference` only, and correct there: the bench's own document title.
     * It is the engine's test bench and is sold to nobody, so naming the engine
     * is what its title is FOR. `apps/themes` — the app cloned per client — has
     * no such line, which is why this entry matches in one app and not the
     * other and why the staleness check below asks for one match rather than
     * all of them.
     */
    'app/layout.tsx: : "BeYours Engine"',
  ])

  it("has none", () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      for (const match of code(file).matchAll(BRAND_FALLBACK)) {
        const found = `${relative(APP, file)}: ${match[0]}`
        if (!ALLOWED.has(found)) offenders.push(found)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the allow-list still matches something, so it is not silencing nothing", () => {
    /*
     * Anti-vacuity, at the granularity the two apps allow. An allow-list that
     * matches nothing at all is a list the next person reads as covering a case
     * it does not — but this file is byte-identical in both apps and one entry
     * is `reference`-only, so "every entry matches" cannot be the rule.
     *
     * `platformStoreStatus.ts` exists in both, so it is asserted by name.
     */
    const found = new Set<string>()
    for (const file of sourceFiles()) {
      for (const match of code(file).matchAll(BRAND_FALLBACK)) {
        found.add(`${relative(APP, file)}: ${match[0]}`)
      }
    }
    expect(found.has('convex/platformStoreStatus.ts: : "Updated from the BeYours admin"')).toBe(
      true,
    )
    for (const entry of found) expect(ALLOWED.has(entry), entry).toBe(true)
  })
})

describe("resolveBrandName", () => {
  it("prefers the field the admin edits", () => {
    expect(
      resolveBrandName({ branding: "Chez Luigi", legacyHeader: "Ancien", storeName: "Store" }),
    ).toBe("Chez Luigi")
  })

  it("falls back to the field the seed actually writes", () => {
    // Every site delivered before this fix has its name here and nowhere else.
    expect(resolveBrandName({ legacyHeader: "Chez Luigi", storeName: "Store" })).toBe(
      "Chez Luigi",
    )
  })

  it("ends at the establishment's own name", () => {
    expect(resolveBrandName({ storeName: "Chez Luigi" })).toBe("Chez Luigi")
  })

  it("ends at nothing rather than at a name the establishment did not choose", () => {
    // The whole point. An empty header is a visible gap somebody fixes; a
    // vendor's name is a defect nobody notices until a diner does.
    expect(resolveBrandName({})).toBe("")
    expect(resolveBrandName({ branding: null, legacyHeader: undefined, storeName: null })).toBe("")
  })

  it("treats whitespace as absent", () => {
    // A cleared CMS field can arrive as "  ", and " " in a header is the same
    // defect as an empty one with none of the visibility.
    expect(resolveBrandName({ branding: "   ", storeName: "Chez Luigi" })).toBe("Chez Luigi")
  })

  it("trims what it returns", () => {
    expect(resolveBrandName({ branding: " Chez Luigi " })).toBe("Chez Luigi")
  })
})

describe("the seed writes the block the header reads", () => {
  it("fills branding.brandName, not only header.brandName", () => {
    const seed = readFileSync(join(APP, "convex/cmsSeed.ts"), "utf8")
    const layout = seed.slice(seed.indexOf('pageSlug: "storefront-layout"'))
    const block = layout.slice(0, layout.indexOf('pageSlug: "store-selector"'))
    expect(block).toMatch(/branding:\s*\{/)
    expect(block).toMatch(/brandName:/)
  })
})
