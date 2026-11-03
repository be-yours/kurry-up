import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import {
  ENGINE_LAYOUT,
  HONOURED,
  HONOURED_FAMILIES,
  LAYOUT_FAMILIES,
  isHonoured,
  isLayoutValue,
  layoutAttributes,
  type LayoutFamily,
} from "../lib/layout-families"

/**
 * A template carries its layout, not only its palette (#507).
 *
 * WHAT WAS MISSING. `demos/assets/themes.js` has assigned all seven families —
 * nav, hero, menu, btn, tex, foot, up — to each of the fifty demo identities
 * since the demos were written, and `scripts/gen-templates.mjs` generates the
 * installed catalogue from exactly that file. It read two of them, `hero` and
 * `menu`, to compose an English sentence for `template.json`'s `description`,
 * and threw the machine-readable value away. The other five it never read.
 *
 * So a design sold "by restaurant type" reached a client as a palette, a radius
 * and a font pair, and the layout half of its identity stayed in the sales
 * demo — which is the gap #41 named and #507 scoped.
 *
 * The four rules below are the ones a reader cannot check by looking: that the
 * two copies of a template's layout agree, that the five hand-kept base
 * directories still match the demo identity they are sold as, that a family
 * claimed as honoured really paints something, and — the one that would cost
 * the most — that no rule reading these attributes can reach the dashboard.
 */

const APP_ROOT = path.resolve(__dirname, "..")
const TEMPLATES_DIR = path.join(APP_ROOT, "templates")
const GLOBALS = path.join(APP_ROOT, "app/globals.css")
const ROOT_LAYOUT = path.join(APP_ROOT, "app/layout.tsx")

const require = createRequire(import.meta.url)
const DEMOS = require(path.join(APP_ROOT, "demos/assets/themes.js"))

const FAMILY_NAMES = Object.keys(LAYOUT_FAMILIES) as LayoutFamily[]

/** Every template directory that carries a `template.json`. */
const slugs = fs
  .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((slug) => fs.existsSync(path.join(TEMPLATES_DIR, slug, "template.json")))
  .sort()

function meta(slug: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, slug, "template.json"), "utf8"))
}

/**
 * The layout a template's `layout.ts` declares.
 *
 * Read with a regex rather than imported: these are `.ts` files under
 * `templates/`, outside the app's own module graph, and fifty-one dynamic
 * imports to compare seven strings each is a slower test that proves the same
 * thing.
 */
function declaredLayout(slug: string): Record<string, string> {
  const source = fs.readFileSync(path.join(TEMPLATES_DIR, slug, "layout.ts"), "utf8")
  const body = source.slice(source.indexOf("siteLayout: SiteLayout = {"))
  const found: Record<string, string> = {}
  for (const [, family, value] of body.matchAll(/^\s*([a-z]+):\s*"([^"]*)"/gm)) {
    if (family && value !== undefined) found[family] = value
  }
  return found
}

/** The demo identity a slug is generated from, or sold as. */
const BASE_SOLD_AS: Record<string, string> = {
  pizzeria: "pizzeria-trattoria",
  "fast-food": "fast-food-smash",
  "food-truck": "food-truck-convoi",
  poulet: "poulet-braise",
  asiatique: "asiatique-izakaya",
}

function demoIdentity(slug: string) {
  const id = BASE_SOLD_AS[slug] ?? slug
  return DEMOS.LIST.find((theme: { id: string }) => theme.id === id)
}

describe("the catalogue carries a layout", () => {
  test("there is a catalogue to check", () => {
    // Anti-vacuity: every assertion below iterates this list, and an empty one
    // would make all of them pass on a repository with no templates at all.
    expect(slugs.length).toBeGreaterThanOrEqual(50)
    expect(slugs).toContain("default")
  })

  test("every template declares all seven families, in both files", () => {
    // `layout.ts` is what the site imports; `template.json.layout` is what a
    // catalogue screen reads without parsing TypeScript. Two copies of one fact
    // drift unless something compares them.
    const wrong: string[] = []
    for (const slug of slugs) {
      const declared = declaredLayout(slug)
      const json = (meta(slug).layout ?? {}) as Record<string, string>
      for (const family of FAMILY_NAMES) {
        if (declared[family] === undefined) wrong.push(`${slug}: layout.ts has no ${family}`)
        else if (json[family] !== declared[family]) {
          wrong.push(`${slug}: ${family} is "${declared[family]}" in layout.ts, "${json[family]}" in template.json`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  test("every value is one its family admits", () => {
    // A value outside its family reaches the DOM as an attribute no rule
    // matches — invisible, and an invisible wrong value is how a site silently
    // renders as something else.
    const wrong: string[] = []
    for (const slug of slugs) {
      const declared = declaredLayout(slug)
      for (const family of FAMILY_NAMES) {
        const value = declared[family]
        if (!isLayoutValue(family, value)) wrong.push(`${slug}: ${family}="${value}"`)
      }
    }
    expect(wrong).toEqual([])
  })

  test("the five hand-kept base directories still match the demo they are sold as", () => {
    // `gen-templates.mjs` deliberately leaves these five alone, so nothing
    // regenerates them when the demo identity changes. This is what notices.
    const wrong: string[] = []
    for (const slug of Object.keys(BASE_SOLD_AS)) {
      const identity = demoIdentity(slug)
      expect(identity, `no demo identity for ${slug}`).toBeDefined()
      const declared = declaredLayout(slug)
      for (const family of FAMILY_NAMES) {
        const fromDemo = String(identity[family] ?? "")
        if (declared[family] !== fromDemo) {
          wrong.push(`${slug}: ${family} is "${declared[family]}" here, "${fromDemo}" in themes.js`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  test("a generated template matches its demo identity too", () => {
    // The generator reads `themes.js` directly, so this cannot drift — but it
    // can stop being written at all, and then every value above would be the
    // stale one already on disk.
    const declared = declaredLayout("asiatique-bambou")
    const identity = demoIdentity("asiatique-bambou")

    expect(declared.hero).toBe(String(identity.hero))
    expect(declared.btn).toBe(String(identity.btn))
    expect(declared.up).toBe(String(identity.up ?? 0))
  })
})

/** Every `selector { … }` rule in `globals.css`, comments stripped. */
function globalsRules(): string[] {
  const css = fs.readFileSync(GLOBALS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  return [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((selector) => selector.length > 0)
}

/** The values `globals.css` actually has rules for, per family. */
function valuesInCss(): Record<string, Set<string>> {
  const found: Record<string, Set<string>> = {}
  for (const selector of globalsRules()) {
    for (const [, family, value] of selector.matchAll(/\[data-([a-z]+)="([^"]*)"\]/g)) {
      if (!family || !FAMILY_NAMES.includes(family as LayoutFamily)) continue
      ;(found[family] ??= new Set()).add(value ?? "")
    }
  }
  return found
}

/**
 * A selector list split into the selectors it really is.
 *
 * Not `split(",")`: `:is(h1, h2, h3)` carries commas of its own, and splitting
 * on them turns one scoped selector into three fragments, two of which mention
 * no element at all. The functional groups go first, so what is left is the
 * comma list.
 */
function alternatives(selector: string): string[] {
  return selector
    .replace(/:(?:is|where|not|has)\([^()]*\)/g, "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

describe("what the stylesheet honours", () => {
  test("the scan finds rules — it is not reading an empty stylesheet", () => {
    expect(globalsRules().length).toBeGreaterThan(20)
    expect(Object.keys(valuesInCss()).length).toBeGreaterThan(0)
  })

  test("every value claimed as honoured paints something", () => {
    // A value carried in `template.json` that paints nothing is a promise the
    // product does not keep — the failure this whole issue is about, one level
    // up. Per value and not per family: `hero` honours three of ten, and
    // claiming the family whole would be the same lie at a coarser grain.
    //
    // A family's FIRST value is the engine's own and needs no rule: `split`,
    // `left`, `columns`, `none`, `0` are what the component already renders.
    const painted = valuesInCss()
    const unpainted: string[] = []
    for (const family of FAMILY_NAMES) {
      for (const value of HONOURED[family]) {
        if (value === ENGINE_LAYOUT[family]) continue
        if (!painted[family]?.has(value as string)) unpainted.push(`${family}="${value}"`)
      }
    }

    expect(unpainted, "claimed in HONOURED with no rule in globals.css").toEqual([])
  })

  test("every value that paints something is claimed", () => {
    // The other direction: a rule written without adding its value to HONOURED
    // leaves the catalogue's own documentation saying it does nothing.
    const unclaimed: string[] = []
    for (const [family, values] of Object.entries(valuesInCss())) {
      for (const value of values) {
        if (!isHonoured(family as LayoutFamily, value)) unclaimed.push(`${family}="${value}"`)
      }
    }

    expect(unclaimed, "has rules in globals.css but is not in HONOURED").toEqual([])
  })

  test("an unbuilt value has no rules at all", () => {
    // This used to be stated per FAMILY — "a family with no honoured value has
    // no rules" — and `btn` was its last subject. Painting three of `btn`'s five
    // left every family at least partly built, so the guard had nothing to hold
    // and its own anti-vacuity assertion was what failed. The rule it was
    // reaching for is per value, which is the grain everything else here uses:
    // a value the README calls unbuilt must paint nothing, or the catalogue
    // tells whoever picks a template the opposite of what the shop does.
    const painted = valuesInCss()
    const unbuilt = FAMILY_NAMES.flatMap((family) =>
      LAYOUT_FAMILIES[family]
        .filter((value) => !isHonoured(family, value))
        .map((value) => ({ family, value }))
    )

    expect(unbuilt.length, "every value is built — this test has nothing to guard").toBeGreaterThan(0)
    expect(
      unbuilt
        .filter(({ family, value }) => painted[family]?.has(value))
        .map(({ family, value }) => `${family}="${value}"`),
      "has rules in globals.css but is not in HONOURED"
    ).toEqual([])
  })

  test("no rule reading a family can reach the dashboard", () => {
    // THE ONE THAT WOULD COST THE MOST. The attribute sits on `<html>`, which
    // is the administration's ancestor too. A selector that reads it without
    // naming `.storefront-theme` repaints the owner's screens — which is
    // exactly what #410 and #41 each cost, one layer down.
    const escaping = globalsRules().filter(
      (selector) =>
        /\[data-(nav|hero|menu|btn|tex|foot|up)\s*=/.test(selector) &&
        !alternatives(selector).every((part) => part.includes(".storefront-theme"))
    )

    expect(escaping, "reads a layout family outside .storefront-theme").toEqual([])
  })
})

/**
 * The header those fifty-one files carry, which nothing was reading.
 *
 * `HONOURED`, `globals.css` and `templates/README.md` are all held against each
 * other above. The generated comment at the top of every `layout.ts` was not,
 * and it drifted exactly as an unguarded restatement does: it named `tex` and
 * `up` as the only two families a diner sees and called the other five
 * unpainted. Measured when this was written, five of the seven are complete —
 * `nav` 4/4, `tex` 5/5, `foot` 3/3, `up` 2/2, `btn` 5/5 — with `hero` at 3 of 10
 * and `menu` at 5 of 8. The sentence was the reverse of the product, in fifty
 * template files plus the client zone's own copy, which is the first thing a
 * client reads when they open the file they are invited to edit.
 *
 * The fix was not a fresher sentence. A generated comment that restates a
 * measurement goes stale by construction, and the next person to paint a value
 * would have had fifty-one copies to remember. The header points at the
 * measurement now, and this holds it there.
 */
describe("the header on every layout.ts", () => {
  const headers = (): Array<[string, string]> => {
    const files = fs
      .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(TEMPLATES_DIR, entry.name, "layout.ts"))
      .filter((file) => fs.existsSync(file))
    files.push(path.join(APP_ROOT, "site", "layout.ts"))
    return files.map((file) => [
      path.relative(APP_ROOT, file),
      fs.readFileSync(file, "utf8").split("import type")[0] ?? "",
    ])
  }

  test("there are headers to check", () => {
    // Anti-vacuity: a glob that matched nothing would pass everything below.
    expect(headers().length).toBeGreaterThan(50)
  })

  test("no header counts the families that paint", () => {
    /* The claim that went stale, and the shape of it rather than its exact
       words: any header asserting that N families do or do not paint is one
       somebody has to remember to update, in fifty-one places. */
    const stale = headers()
      .filter(([, header]) =>
        /(two|three|four|five|six|seven)\s+of\s+(them|the\s+seven)|paint nothing yet|other\s+(two|three|four|five|six)\s+are/i.test(
          header,
        ),
      )
      .map(([file]) => file)

    expect(stale).toEqual([])
  })

  test("every header points at both sources instead", () => {
    for (const [file, header] of headers()) {
      expect(header, `${file} does not name lib/layout-families.ts`).toContain(
        "lib/layout-families.ts",
      )
      expect(header, `${file} does not name templates/README.md`).toContain(
        "templates/README.md",
      )
    }
  })

  test("the stylesheet's own family block counts nothing either", () => {
    /* `globals.css` carried the identical claim in its own words — two families
       honoured, the other five painting nothing — in BOTH apps, since it is a
       twin file. Same failure, same reason, and it would have been left behind
       by a sweep that only looked at `layout.ts`. */
    const css = fs.readFileSync(GLOBALS, "utf8")
    expect(css).not.toMatch(/paint nothing yet/i)
    expect(css).not.toMatch(/(two|three|four|five|six)\s+families\s+are\s+honoured/i)
  })

  test("the generator emits a header that would pass the two above", () => {
    /* Fixing fifty-one files and leaving the generator writing the old sentence
       would restore it on the next `pnpm gen:templates`. */
    const generator = fs.readFileSync(
      path.join(APP_ROOT, "scripts", "gen-templates.mjs"),
      "utf8",
    )
    expect(generator).not.toMatch(/paint nothing yet/i)
    expect(generator).toContain("templates/README.md")
  })
})

describe("what the catalogue tells whoever picks a template", () => {
  const README = path.join(TEMPLATES_DIR, "README.md")

  /** The family rows of README's table, as `{ family: builtClaim }`. */
  function readmeRows(): Record<string, string> {
    const rows: Record<string, string> = {}
    for (const line of fs.readFileSync(README, "utf8").split("\n")) {
      const match = /^\|\s*`([a-z]+)`\s*\|[^|]*\|([^|]*)\|/.exec(line)
      if (match && FAMILY_NAMES.includes(match[1] as LayoutFamily)) {
        rows[match[1] as string] = (match[2] ?? "").trim()
      }
    }
    return rows
  }

  test("every family has a row", () => {
    // Anti-vacuity, and the reason this test exists: the table is what somebody
    // choosing a template reads, and a family missing from it is a value they
    // can set with no way to learn it does nothing.
    expect(Object.keys(readmeRows()).sort()).toEqual([...FAMILY_NAMES].sort())
  })

  test("the prose marks built exactly the families that have a built value", () => {
    // `HONOURED` is the same thing in code and the stylesheet is held against
    // that. Without this, the two could agree while the table a person reads
    // promised one more.
    //
    // `**partly**` is its own mark, for a family where some values are built and
    // some are not — `hero` is three of ten, and calling that `**yes**` would be
    // the coarse-grained version of the lie this issue is about.
    const rows = readmeRows()
    const fully = FAMILY_NAMES.filter(
      (family) => HONOURED[family].length === LAYOUT_FAMILIES[family].length
    ).sort()
    const partly = FAMILY_NAMES.filter(
      (family) =>
        HONOURED[family].length > 0 && HONOURED[family].length < LAYOUT_FAMILIES[family].length
    ).sort()

    const marked = (mark: string) =>
      Object.entries(rows)
        .filter(([, built]) => built.startsWith(mark))
        .map(([family]) => family)
        .sort()

    expect(marked("**yes**")).toEqual(fully)
    expect(marked("**partly**")).toEqual(partly)
    expect(HONOURED_FAMILIES.length).toBe(fully.length + partly.length)
  })
})

describe("what reaches the DOM", () => {
  test("the root layout spreads the families onto <html>", () => {
    const source = fs.readFileSync(ROOT_LAYOUT, "utf8")

    expect(source).toContain('from "@/site/layout"')
    expect(source).toContain("layoutAttributes(siteLayout)")
  })

  test("every family becomes one data attribute", () => {
    const attributes = layoutAttributes({
      nav: "center",
      hero: "poster",
      menu: "bento",
      btn: "brutal",
      tex: "grain",
      foot: "heavy",
      up: "1",
    })

    // Every family, plus the `-requested` note for the two whose value is
    // valid and unpainted. `btn: "brutal"` is neither: it is painted, so it is
    // emitted as itself. See the case below.
    for (const family of FAMILY_NAMES) {
      expect(attributes, family).toHaveProperty(`data-${family}`)
    }
    expect(attributes["data-nav"]).toBe("center")
    expect(attributes["data-up"]).toBe("1")
  })

  test("a value outside its family becomes the engine's, not itself", () => {
    // Falling back rather than passing it through: an attribute no rule matches
    // is invisible, so the site would render the engine layout while claiming
    // another. Same outcome, but the DOM would lie about it.
    const attributes = layoutAttributes({ hero: "trapezoid" } as never)

    expect(attributes["data-hero"]).toBe(ENGINE_LAYOUT.hero)
  })

  test("a valid but UNPAINTED value becomes the engine's too (#529)", () => {
    /*
     * THE SAME LIE, ONE STEP FURTHER IN. The case above already refuses to emit
     * a value no rule matches, and gives the reason: "an attribute no rule
     * matches is invisible, so the site would render the engine layout while
     * claiming another." That is exactly as true of `hero: "poster"` — a value
     * its family admits and `globals.css` has no rule for.
     *
     * The line was drawn at family membership rather than at what is painted,
     * and measured at `a92a0e51` that left 31 templates emitting a hero the
     * shop does not paint, 26 a menu, and 51 a button style — `data-btn` being
     * the whole family, `HONOURED.btn` is empty.
     *
     * The value is not lost. It moves to `data-<family>-requested`, so the DOM
     * says both what it renders and what the template asked for, and a person
     * debugging "why is my poster hero not showing" has the answer in the
     * markup rather than in a stylesheet they have to search.
     */
    /*
     * `btn` USED TO BE THE THIRD CASE HERE, as `btn: "brutal"`, and it is gone
     * because the family has no unpainted value left to demonstrate the rule
     * with — all five reach the shop. That is the good direction, and it is why
     * this case is anchored on two families rather than rewritten to keep a
     * third: an example that has to be an unpainted value cannot outlive the
     * value being painted.
     *
     * The anti-vacuity guard is the ledger at the foot of this file, which
     * fails if `hero` or `menu` runs out of unpainted values too without this
     * case being revisited.
     */
    const attributes = layoutAttributes({
      hero: "poster",
      menu: "bento",
    })

    expect(attributes["data-hero"]).toBe(ENGINE_LAYOUT.hero)
    expect(attributes["data-menu"]).toBe(ENGINE_LAYOUT.menu)

    expect(attributes["data-hero-requested"]).toBe("poster")
    expect(attributes["data-menu-requested"]).toBe("bento")

    // And the painted one is emitted as itself, in the same call — the two
    // behaviours have to be distinguishable on one layout or this proves only
    // that everything falls back.
    expect(layoutAttributes({ btn: "brutal" })["data-btn"]).toBe("brutal")
    expect(layoutAttributes({ btn: "brutal" })).not.toHaveProperty("data-btn-requested")
  })

  test("an honoured value is emitted as itself, with no note", () => {
    // Anti-vacuity: a `layoutAttributes` that always answered the engine's
    // value would satisfy the case above and break every template that works.
    const attributes = layoutAttributes({ hero: "zen", menu: "ledger", nav: "bar" })

    expect(attributes["data-hero"]).toBe("zen")
    expect(attributes["data-menu"]).toBe("ledger")
    expect(attributes["data-nav"]).toBe("bar")
    expect(attributes).not.toHaveProperty("data-hero-requested")
    expect(attributes).not.toHaveProperty("data-menu-requested")
    expect(attributes).not.toHaveProperty("data-nav-requested")
  })

  test("the engine's own value is never noted as requested-and-refused", () => {
    // The engine's own value must fall through silently rather than telling a
    // reader their default was overruled. This mattered most while `btn: "soft"`
    // was both the engine's value AND unpainted; `soft` is painted now, and the
    // rule it proved is the one that outlives it.
    const attributes = layoutAttributes(ENGINE_LAYOUT)

    for (const family of FAMILY_NAMES) {
      expect(attributes[`data-${family}`], family).toBe(ENGINE_LAYOUT[family])
      expect(attributes, family).not.toHaveProperty(`data-${family}-requested`)
    }
  })

  test("a missing layout is the engine's layout, whole", () => {
    expect(layoutAttributes(undefined)).toEqual(
      Object.fromEntries(FAMILY_NAMES.map((family) => [`data-${family}`, ENGINE_LAYOUT[family]]))
    )
  })

  test("the engine's own layout is a legal one", () => {
    // It is the fallback for every invalid value, so a typo here would make
    // every fallback illegal and nothing else would notice.
    for (const family of FAMILY_NAMES) {
      expect(isLayoutValue(family, ENGINE_LAYOUT[family]), `${family}`).toBe(true)
    }
  })
})

/**
 * How much of the catalogue names a layout the shop does not paint (#529).
 *
 * MEASURED, NOT ASSUMED. At `a92a0e51`, over the 51 installed templates:
 * 31 name a hero outside `HONOURED`, 26 a menu, and 51 a button style — the
 * whole family, since `HONOURED.btn` is empty. `btn` has since left this ledger
 * entirely: `brutal` (5 templates) and `underline` (8) are painted, so all five
 * of its values reach the shop and the family has no row left to keep. That is
 * the direction the second test below exists to force, and the first time a
 * family has made it all the way out. Nothing failed on any of it:
 * `layout-families.test.ts` pinned only the out-of-FAMILY fallback, so a value
 * its family admits and no rule paints went straight through.
 *
 * WHY A LEDGER RATHER THAN A CLEAN SWEEP, and this is the "say which" the issue
 * asks for. Neither of the two offered actions is available as written:
 *
 *   - PAINT THEM. Each unpainted value already carries a measured reason it is
 *     not built, written where the rule would go — and that reason is worth
 *     re-reading rather than trusting, because two of them have now expired.
 *     `btn`'s said the fill values needed every filled control in the shop
 *     named by hand; the name turned out to be `data-variant`, which
 *     `Button.tsx` had been writing all along. `menu`'s said `tickets` and
 *     `dotted` could not be done over this card; #566 did them.
 *     What is left is harder. Two of the three menus want white type over a
 *     dish photograph the owner may not have uploaded — unreadable on exactly
 *     the dishes with no photo, and invisible to the contrast sweep, which
 *     reads source files. The third wants a category bar that lives in another
 *     component and has no counterpart on the homepage. The seven heroes want
 *     a photograph this hero does not carry, a second image, a locations
 *     board, a marquee that would animate forever — or, `editorial`, a rating
 *     stamp this product refuses to invent at all.
 *   - REGENERATE THE 51 `layout.ts` WITH ONLY HONOURED VALUES. That erases the
 *     design intent the catalogue is sold on. `pizzeria-trattoria` names
 *     `hero: "poster"` because that is the design; flattening it to `"split"`
 *     would make the file agree with the stylesheet by deleting the thing the
 *     stylesheet is meant to catch up with.
 *
 * So the DOM was made honest instead — `layoutAttributes` now emits the engine's
 * value and records the ask in `data-<family>-requested` — and the gap is a
 * ledger with its numbers pinned. A new unpainted value fails. Painting one
 * fails too, until its count comes down, which is the direction that matters.
 */
describe("templates naming a layout the shop does not paint", () => {
  /** Per family: how many of the 51 templates name an unpainted value. */
  const PINNED: Record<string, number> = {
    hero: 31,
    menu: 17,
  }

  /** Every unpainted value the catalogue names today, per family. */
  const PINNED_VALUES: Record<string, string[]> = {
    hero: ["board", "collage", "duo", "editorial", "fullbleed", "magazine", "poster"],
    menu: ["bento", "mosaic", "tabs"],
  }

  /** `{ family: { count, values } }` over the installed catalogue. */
  function measure() {
    const counts: Record<string, number> = {}
    const values: Record<string, Set<string>> = {}
    for (const slug of slugs) {
      const layout = declaredLayout(slug)
      for (const family of Object.keys(LAYOUT_FAMILIES) as LayoutFamily[]) {
        const value = layout[family]
        if (value === undefined || isHonoured(family, value)) continue
        counts[family] = (counts[family] ?? 0) + 1
        ;(values[family] ??= new Set()).add(value)
      }
    }
    return { counts, values }
  }

  test("there are templates to measure", () => {
    // Anti-vacuity: an empty catalogue satisfies every count below trivially.
    expect(slugs.length).toBeGreaterThan(40)
  })

  test("no family is worse than the ledger says", () => {
    const { counts } = measure()

    for (const [family, count] of Object.entries(counts)) {
      expect(count, `${family} names an unpainted value in more templates than pinned`)
        .toBeLessThanOrEqual(PINNED[family] ?? 0)
    }
  })

  test("the ledger is not better than the truth either", () => {
    /*
     * The half that makes this worth keeping. Painting `poster` drops `hero` to
     * 24, and this fails until the number comes down — so the ledger cannot sit
     * at a figure the catalogue left behind, quietly permitting a regression
     * back up to it.
     */
    const { counts } = measure()

    for (const [family, pinned] of Object.entries(PINNED)) {
      expect(counts[family] ?? 0, `${family}: PINNED says ${pinned}`).toBe(pinned)
    }
  })

  test("no family outside the ledger names an unpainted value", () => {
    // `nav`, `tex`, `foot` and `up` are fully honoured. One of them acquiring an
    // unpainted value is a new defect, not a known one.
    const { counts } = measure()

    expect(Object.keys(counts).sort()).toEqual(Object.keys(PINNED).sort())
  })

  test("the unpainted values are the ones the ledger names", () => {
    // A template swapping `poster` for some other unpainted hero keeps the count
    // and changes the fact, and the fix for each value is different.
    const { values } = measure()

    for (const [family, pinned] of Object.entries(PINNED_VALUES)) {
      expect([...(values[family] ?? [])].sort(), family).toEqual([...pinned].sort())
    }
  })

  test("every pinned value is one its family actually admits", () => {
    // A typo here would pin a value no template could ever name, and the counts
    // above would then be measuring something else.
    for (const [family, pinned] of Object.entries(PINNED_VALUES)) {
      for (const value of pinned) {
        expect(isLayoutValue(family as LayoutFamily, value), `${family}/${value}`).toBe(true)
        expect(isHonoured(family as LayoutFamily, value), `${family}/${value}`).toBe(false)
      }
    }
  })
})
