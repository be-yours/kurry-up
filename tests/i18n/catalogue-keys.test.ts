/**
 * The static string catalogues, and the keys the storefront asks for (#148).
 *
 * `lib/i18n/index.ts` calls `REFERENCE_KEYS` "for CI validation" and nothing
 * validated anything: `en.json` and `es.json` could drift from `fr.json` and
 * the only symptom would be a customer seeing a raw key like `cart.orderNow`
 * on a button. `t()` returns the key when a lookup misses, which is a good
 * failure mode at runtime and an invisible one without a test.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import fr from "@/lib/i18n/locales/fr.json"
import en from "@/lib/i18n/locales/en.json"
import es from "@/lib/i18n/locales/es.json"
import {
  REFERENCE_KEYS,
  REFERENCE_LOCALE,
  REFERENCE_STRINGS,
} from "@/lib/i18n/index"
import { STATUS_LABEL_KEYS } from "@be-yours/core/status-labels"

const CATALOGUES: Record<string, Record<string, string>> = { en, es }

describe("locale catalogues", () => {
  it("ships more than a token number of keys", () => {
    // Guards the guard: an empty reference would make every check below pass.
    expect(REFERENCE_KEYS.length).toBeGreaterThan(150)
  })

  for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
    it(`${locale}.json carries exactly the keys fr.json does`, () => {
      const reference = new Set(Object.keys(fr))
      const actual = new Set(Object.keys(catalogue))

      const missing = [...reference].filter((k) => !actual.has(k)).sort()
      const extra = [...actual].filter((k) => !reference.has(k)).sort()

      expect({ missing, extra }).toEqual({ missing: [], extra: [] })
    })

    it(`${locale}.json has no empty values`, () => {
      const blank = Object.entries(catalogue)
        .filter(([, value]) => typeof value !== "string" || value.trim() === "")
        .map(([key]) => key)

      expect(blank).toEqual([])
    })

    it(`${locale}.json keeps every placeholder fr.json declares`, () => {
      // `{count}`, `{amount}`, `{max}`, `{time}` are substituted at render
      // time. A translation that drops one silently loses the number.
      const placeholders = (value: string) =>
        (value.match(/\{\{?\w+\}?\}/g) ?? []).sort()

      const broken: Array<{ key: string; expected: string[]; got: string[] }> = []
      for (const [key, source] of Object.entries(fr as Record<string, string>)) {
        const expected = placeholders(source)
        if (expected.length === 0) continue
        const got = placeholders(catalogue[key] ?? "")
        if (JSON.stringify(expected) !== JSON.stringify(got)) {
          broken.push({ key, expected, got })
        }
      }

      expect(broken).toEqual([])
    })
  }
})

describe("the synchronously available reference catalogue", () => {
  it("is the fr catalogue, and says so", () => {
    // The storefront seeds the language store with this before the first
    // render. `loadAllStaticStrings` is a dynamic import and resolves a tick
    // later; without the seed the header paints `nav.home nav.menu nav.about`.
    expect(REFERENCE_LOCALE).toBe("fr")
    expect(REFERENCE_STRINGS).toEqual(fr)
  })

  it("covers every key the storefront asks for", () => {
    // It is also the floor under a language that ships no JSON of its own —
    // German, say. A store offering one must show readable French chrome, not
    // a page of raw keys.
    const missing = Object.keys(fr).filter((k) => !(k in REFERENCE_STRINGS))
    expect(missing).toEqual([])
  })
})

describe("the keys an engine package asks for", () => {
  /**
   * The sweep below this one reads `t("…")` literals out of the app's own
   * components. Some keys are asked for from inside an engine package, where
   * that sweep cannot see them: `useOrderStatusLabels` and
   * `useStoreStatusLabels` in `@be-yours/restaurant` resolve the status
   * vocabulary through `t()` for the two storefront badges. A key with no
   * entry falls back to the source-language word rather than rendering raw —
   * but it also means a French label on a Spanish page, silently.
   */
  it("answers every status label key the badges translate through", () => {
    const reference = new Set(Object.keys(fr))
    const unknown = STATUS_LABEL_KEYS.filter((key) => !reference.has(key))

    expect(unknown).toEqual([])
  })

  it("asks for more than a token number of them", () => {
    // Guards the guard: an empty vocabulary would make the check above pass.
    expect(STATUS_LABEL_KEYS.length).toBeGreaterThanOrEqual(11)
  })
})

describe("the keys the storefront asks for", () => {
  /** Every `t("…")` literal under the storefront components and routes. */
  function translationKeysInSource(): Array<{ file: string; key: string }> {
    const roots = [
      join(process.cwd(), "components", "storefront"),
      // The home page's cards: « Prix », « Lire la suite » and the category
      // counts were English literals until they moved into the catalogue, and a
      // key asked for here and missing there would render as the key itself.
      join(process.cwd(), "components", "website"),
      join(process.cwd(), "app", "(storefront)"),
    ]

    const found: Array<{ file: string; key: string }> = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue

        const source = readFileSync(path, "utf-8")
        // `t("some.key")` and `labelKey: "some.key"` — the two shapes the
        // storefront uses. Anything computed is out of reach of a static
        // check and is deliberately not matched. Either quote: the files
        // added since #673 are prettier-formatted, which writes single ones,
        // and a sweep that read only double quotes skipped every key in them.
        for (const match of source.matchAll(/\bt\(\s*["']([\w.]+)["']/g)) {
          found.push({ file: path, key: match[1]! })
        }
        for (const match of source.matchAll(/labelKey:\s*["']([\w.]+)["']/g)) {
          found.push({ file: path, key: match[1]! })
        }
      }
    }

    for (const root of roots) walk(root)
    return found
  }

  it("asks for at least a dozen of them — t() is actually used", () => {
    // Before the fix `t()` had no call sites at all: `setOverrides` and
    // `setStaticStrings` were never called and nothing resolved a key.
    const used = translationKeysInSource()
    expect(used.length).toBeGreaterThanOrEqual(12)
  })

  it("asks only for keys the catalogues can answer", () => {
    const reference = new Set(Object.keys(fr))
    const unknown = translationKeysInSource()
      .filter(({ key }) => !reference.has(key))
      .map(({ file, key }) => `${file.replace(process.cwd() + "/", "")}: ${key}`)
      .sort()

    // A key with no entry renders as the key itself — `cart.orderNow` on a
    // button, in every language including French.
    expect(unknown).toEqual([])
  })

  it("spreads across more than one component", () => {
    const files = new Set(translationKeysInSource().map((m) => m.file))
    expect(files.size).toBeGreaterThanOrEqual(4)
  })
})
