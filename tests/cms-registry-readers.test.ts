/// <reference types="vite/client" />

/**
 * The registry's `rendered` flag is measured, not asserted (#630).
 *
 * The CMS declares 20 pages, 60 blocks and 197 fields. **Six pages are read.**
 * Whole groups are inert — Commande 0/8 blocks, Compte 0/8, Authentification
 * 0/5, Catalogue 1/10 — and the editor gave no sign of it. It showed saved,
 * plausible text (the seed fills them with « Ajouter au panier », « Passer
 * commande »), autosaved it, published it with a green badge, and offered
 * « Traduire tout », which spent OpenAI credit on strings nobody will read.
 *
 * `PageDefinition.rendered` is what the editor draws a badge from, and a
 * declaration nobody checks is the next thing to drift. So this walks the app
 * for the call sites and fails when the two disagree — in both directions.
 */

import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { getAllPageSlugs, getPageDefinition } from "@be-yours/cms"
import type { PageDefinition } from "@be-yours/cms"

/** The registry, as a list. `getAllPageSlugs` is what the package exposes. */
function getAllPageDefinitions(): PageDefinition[] {
  return getAllPageSlugs().flatMap((slug) => {
    const page = getPageDefinition(slug)
    return page ? [page] : []
  })
}
import "@/lib/cms/init"

const APP = process.cwd()

/** Where a page could be read from. */
const SCANNED = ["app", "components", "lib"]

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
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
 * Every way this app asks for a page's blocks.
 *
 * `getStorePageData` is in the list because `lib/structured-data.ts` reads
 * `storefront-layout` through it — a reader the JSON-LD depends on and a
 * `useCmsPage` sweep alone would miss.
 */
const READER =
  /(?:useCmsPage|fetchCmsPage|getStorePageData)\s*\(([^)]*)\)/g

/** A quoted slug inside a call's arguments. */
const QUOTED = /["'`]([a-z0-9-]+)["'`]/g

/** Comments removed: this fix names the unread pages in several. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

function slugsWithReaders(): Set<string> {
  /*
   * Filtered to slugs the registry declares, which is what makes this usable.
   * `fetchCmsPage(store._id as Id<"stores">, pageSlug, …)` otherwise reports a
   * reader for a page called "stores": the quoted string is a type cast, and
   * the slug is a parameter. Anything that is not a declared page is not a
   * reader of one.
   */
  const declared = new Set(getAllPageDefinitions().map((page) => page.slug))
  const found = new Set<string>()
  for (const file of sourceFiles()) {
    for (const call of code(file).matchAll(READER)) {
      const args = (call[1] ?? "").replace(/as\s+Id<[^>]*>/g, "")
      for (const quoted of args.matchAll(QUOTED)) {
        const slug = quoted[1]
        if (slug && declared.has(slug)) found.add(slug)
      }
    }
  }
  return found
}

describe("the sweep can see what it claims to see", () => {
  it("finds files, and finds the homepage's reader among them", () => {
    // Anti-vacuity: a broken walk or a regex that stopped matching would report
    // every page as unread and pass by blindness.
    expect(sourceFiles().length).toBeGreaterThan(50)
    expect(slugsWithReaders()).toContain("homepage")
  })

  it("finds the registry", () => {
    expect(getAllPageDefinitions().length).toBeGreaterThan(15)
  })
})

describe("every page's `rendered` flag matches its call sites", () => {
  it("no page claims a reader it does not have", () => {
    // The direction that matters most: a page marked rendered is one the editor
    // shows without a warning and « Traduire tout » spends money on.
    const readers = slugsWithReaders()
    const lying = getAllPageDefinitions()
      .filter((page) => page.rendered === true && !readers.has(page.slug))
      .map((page) => page.slug)
    expect(lying, "marked rendered, read by nothing").toEqual([])
  })

  it("no page is read while marked unused", () => {
    // The other direction: a page wearing an « Non utilisé » badge that a diner
    // is in fact being served is worse than no badge at all.
    const readers = slugsWithReaders()
    const understated = getAllPageDefinitions()
      .filter((page) => page.rendered !== true && readers.has(page.slug))
      .map((page) => page.slug)
    expect(understated, "read, but marked unused").toEqual([])
  })

  it("the read pages are the ones the audit measured, plus the legal pages", () => {
    // Pinned so the count moving is a deliberate line in a diff rather than a
    // number nobody re-measured. Change it in the commit that renders a page.
    expect([...slugsWithReaders()].sort()).toEqual(
      [
        "about",
        "blog",
        "contact",
        "game",
        "homepage",
        // Its `seo` block only, read by `product/[productId]`'s metadata.
        "product-detail",
        "storefront-layout",
        // The engine-owned legal pages: their identity comes from the
        // settings, their per-restaurant clauses from these entries.
        "legal-notice",
        "terms-of-sale",
        "privacy-policy",
      ].sort(),
    )
  })
})

describe("« Aperçu » never opens a page that is not there", () => {
  it("only a page with a route offers a preview", () => {
    /*
     * `PreviewClient` fell back to `/${pageSlug}` and only `homepage` declares a
     * route, so eight pages previewed into a 404 — and « Aperçu » was the one
     * place an owner could have discovered any of this unaided.
     */
    const withRoute = getAllPageDefinitions().filter((page) => page.route)
    expect(withRoute.length).toBeGreaterThan(0)
    for (const page of withRoute) {
      expect(page.route, page.slug).toMatch(/^\//)
    }
  })

  it("a page with no route is one the preview must refuse", () => {
    // Every unrendered page is such a page, which is why the two are checked
    // together: there is nothing to preview and nothing reading it.
    for (const page of getAllPageDefinitions()) {
      if (page.rendered === true) continue
      expect(page.route, `${page.slug} declares a route but nothing renders it`).toBeUndefined()
    }
  })
})
