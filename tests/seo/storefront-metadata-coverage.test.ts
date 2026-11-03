/**
 * Every storefront route says who it is (#168, TECH-09).
 *
 * Ten of them could not. Measured at HEAD, `/menu`, `/cart`, `/store-selector`,
 * `/account`, `/account/orders`, `/account/addresses`, `/account/favorites`,
 * `/order/[orderId]`, `/track/[token]` and `/checkout` all began with
 * `"use client"` and exported no metadata of any kind — Next.js does not read
 * `generateMetadata` from a client component, so those pages inherited the
 * engine's own `<title>BeYours Engine</title>`. `/menu` is the highest-intent
 * page in the product and the CMS offers an SEO block for it that nothing read.
 *
 * The interactive halves moved into `_components/` and each route grew a server
 * shell. This test is what stops one of them quietly becoming a client
 * component again.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

const STOREFRONT_DIR = join(process.cwd(), "app/(storefront)")

interface RoutePage {
  /** Route path, e.g. `/account/orders`. */
  path: string
  /** Absolute path of the `page.tsx`. */
  file: string
}

function collectPages(dir: string, prefix = ""): RoutePage[] {
  const pages: RoutePage[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry.startsWith("_")) continue
      pages.push(
        ...collectPages(full, prefix + (entry.startsWith("(") ? "" : `/${entry}`)),
      )
    } else if (entry === "page.tsx") {
      pages.push({ path: prefix || "/", file: full })
    }
  }
  return pages
}

const PAGES = collectPages(STOREFRONT_DIR)

function declaresMetadata(source: string): boolean {
  return (
    /export\s+(async\s+)?function\s+generateMetadata\b/.test(source) ||
    /export\s+const\s+metadata\b/.test(source)
  )
}

/** The page's own metadata, or the nearest ancestor layout's. */
function metadataSource(page: RoutePage): string | null {
  let dir = dirname(page.file)
  const own = readFileSync(page.file, "utf8")
  if (declaresMetadata(own)) return own

  while (dir.startsWith(STOREFRONT_DIR)) {
    const layout = join(dir, "layout.tsx")
    try {
      const source = readFileSync(layout, "utf8")
      if (declaresMetadata(source)) return source
    } catch {
      // No layout at this level.
    }
    if (dir === STOREFRONT_DIR) break
    dir = dirname(dir)
  }
  return null
}

/** Routes that must never be indexed: they hold one customer's data. */
const PRIVATE_ROUTES = [
  "/account",
  "/account/orders",
  "/account/addresses",
  "/account/favorites",
  "/cart",
  "/checkout",
  "/checkout/pay",
  "/checkout/success",
  "/checkout/cancel",
  "/order/[orderId]",
  "/track/[token]",
  "/reservation/manage/[token]",
  "/reservation/waitlist/[token]",
  "/reservation/feedback/[token]",
  "/reservation/payment/[token]",
]

/**
 * Public routes still missing a canonical.
 *
 * Empty, and it should stay that way: a public route without a canonical lets
 * a crawler pick its own preferred URL. Add a route here only with the reason
 * it cannot have one.
 */
const CANONICAL_GAPS: string[] = []

describe("storefront metadata coverage", () => {
  it("finds the routes this card is about", () => {
    const paths = PAGES.map((page) => page.path)

    for (const path of [
      "/menu",
      "/cart",
      "/store-selector",
      "/account",
      "/order/[orderId]",
      "/track/[token]",
    ]) {
      expect(paths, `${path} is missing from the route tree`).toContain(path)
    }
  })

  it("every route carries metadata, its own or its layout's", () => {
    for (const page of PAGES) {
      expect(metadataSource(page), `${page.path} has no metadata`).not.toBeNull()
    }
  })

  it("a client page is only allowed where a layout speaks for it", () => {
    // A client component cannot export `generateMetadata` at all — that is the
    // shape of the original defect, not a style preference. The one way a
    // client page may stay one is if an ancestor layout carries the metadata
    // for it, which is how `/account` and the `/checkout` branch are covered.
    for (const page of PAGES) {
      const source = readFileSync(page.file, "utf8")
      if (!source.startsWith('"use client"')) continue

      const ownMetadata = declaresMetadata(source)
      expect(ownMetadata, `${page.path} is a client page claiming metadata`).toBe(false)
      expect(
        metadataSource(page),
        `${page.path} is a client page and no layout speaks for it`,
      ).not.toBeNull()
    }
  })

  it("every private route refuses the index", () => {
    for (const path of PRIVATE_ROUTES) {
      const page = PAGES.find((candidate) => candidate.path === path)
      expect(page, `${path} is missing`).toBeDefined()
      const source = metadataSource(page!)
      expect(source, `${path} has no metadata`).not.toBeNull()
      expect(source, `${path} does not refuse the index`).toContain("PRIVATE_PAGE")
    }
  })

  it("every public route declares its own canonical path", () => {
    const publicPages = PAGES.filter(
      (page) =>
        !PRIVATE_ROUTES.includes(page.path) && !CANONICAL_GAPS.includes(page.path),
    )

    for (const page of publicPages) {
      const source = readFileSync(page.file, "utf8")
      expect(source, `${page.path} sets no canonical`).toMatch(/pathname/)
    }
  })
})

/** Prose about `<img>` is not an `<img>`. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

describe("product images go through next/image", () => {
  // A raw `<img>` on a full-size S3 original, twelve to a menu page: no
  // resizing, no AVIF or WebP, no lazy loading.
  const IMAGE_BEARING_FILES = [
    "components/storefront/storefront-product-card.tsx",
    "components/storefront/order-summary.tsx",
    "app/(storefront)/cart/_components/CartContent.tsx",
  ]

  for (const file of IMAGE_BEARING_FILES) {
    it(`${file} renders no raw <img>`, () => {
      const source = stripComments(readFileSync(join(process.cwd(), file), "utf8"))

      expect(source).not.toMatch(/<img[\s>/]/)
      expect(source).toContain('from "next/image"')
    })
  }

  it("the product card sizes the image for the grid it sits in", () => {
    const source = readFileSync(
      join(process.cwd(), "components/storefront/storefront-product-card.tsx"),
      "utf8",
    )

    // Without `sizes`, a `fill` image asks the optimiser for a full-viewport
    // render of a quarter-viewport slot.
    expect(source).toMatch(/sizes=/)
    expect(source).toMatch(/\bfill\b/)
  })
})
