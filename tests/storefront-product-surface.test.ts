/// <reference types="vite/client" />

/**
 * Two product fields a diner could never see (#626).
 *
 * « Prix barré TTC » had **zero** storefront readers — the repository's only
 * strikethrough renderer, `packages/ui/.../PriceDisplay.tsx`, has zero call
 * sites in either app — so an owner ran a markdown that showed nowhere.
 *
 * `product-images-field.tsx` offers six reorderable slots and every storefront
 * reader took `images[0]`, so an owner uploaded six photographs and a diner saw
 * one. That is what moved **PM9 Image Gallery from absent to PARTIAL** in the
 * feature ledger: the uploader landed without a reader.
 *
 * Source-level because both are render-time conditions on a client component
 * whose parents need a Convex provider, a store selection and a cart store. The
 * thing that regressed is whether the field is referenced at all, which is what
 * this reads.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const STOREFRONT = join(process.cwd(), "components", "storefront")

const read = (file: string): string => readFileSync(join(STOREFRONT, file), "utf8")

/** Comments removed: both fixes are explained in one that names what was missing. */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")

describe("the strikethrough price", () => {
  for (const file of ["storefront-product-card.tsx", "product-detail-client.tsx"]) {
    it(`${file} renders it`, () => {
      const source = code(file)
      expect(source).toMatch(/compareAtPrice/)
      expect(source).toMatch(/line-through/)
    })

    it(`${file} draws it only when it is above the price`, () => {
      // A `compareAtPrice` below the price is not a markdown, and a
      // strikethrough on a HIGHER number is a lie about the discount. The
      // condition is the honesty, not decoration.
      expect(code(file)).toMatch(/compareAtPrice > product\.price/)
    })
  }

  it("the detail page does not compare against a price an option changed", () => {
    // A markdown on the base dish says nothing about a dish with three
    // supplements, and striking the original through beside a modified total
    // would invent a discount.
    expect(code("product-detail-client.tsx")).toMatch(/totalPrice === product\.price/)
  })
})

describe("the other five photographs", () => {
  const source = code("product-detail-client.tsx")

  it("are reachable", () => {
    expect(source).toMatch(/images\[activeImage\]/)
    expect(source).toMatch(/setActiveImage/)
  })

  it("are not drawn as a strip when there is only one", () => {
    // Nothing new appears on the common case.
    expect(source).toMatch(/images\.length > 1/)
  })

  it("skip an empty slot rather than rendering a gap", () => {
    // The six slots are reorderable, so a cleared middle one is an ordinary
    // state and a blank thumbnail would be a defect of its own.
    expect(source).toMatch(/typeof url === "string" && url\.length > 0/)
  })

  it("name themselves for a screen reader", () => {
    // A row of unlabelled image buttons is unusable without sight, and this is
    // the control that chooses what the main picture shows.
    expect(source).toMatch(/aria-label=\{`Voir la photo/)
    expect(source).toMatch(/aria-current=/)
  })

  it("the card still shows one, which is all a card should", () => {
    // Anti-vacuity in the other direction: the gallery belongs on the detail
    // page, and a menu of twelve cards must not become twelve galleries.
    expect(code("storefront-product-card.tsx")).not.toMatch(/setActiveImage/)
  })
})
