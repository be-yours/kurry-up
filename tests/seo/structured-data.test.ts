/**
 * Structured data for the storefront (#168, TECH-09).
 *
 * `lib/json-ld.tsx` was written and never called: measured at HEAD, the only
 * file in either app that mentioned it was itself, and `git grep "ld+json"`
 * over `apps/*\/app` returned nothing. A restaurant theme therefore shipped
 * without the one piece of markup that produces opening hours, an address and a
 * price range in a rich result. It also described a store that does not exist —
 * a flat address, no hours at all, and `/s/{slug}` URLs.
 *
 * The builders are fed the real documents now
 * (`packages/convex-schema/src/tables/stores.ts`), and these tests hold the
 * shapes schema.org requires.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

vi.mock("server-only", () => ({}))

const {
  buildRestaurantSchema,
  buildMenuSchema,
  buildProductSchema,
  buildBreadcrumbSchema,
  derivePriceRange,
  pruneUndefined,
} = await import("@/lib/json-ld")

const BASE = "https://chez-luigi.fr"

/** A store as Convex stores one. */
const STORE = {
  name: "Chez Luigi",
  description: "Trattoria de quartier",
  phone: "+33 1 42 00 00 00",
  email: "bonjour@chez-luigi.fr",
  address: {
    street: "12 rue des Martyrs",
    city: "Paris",
    postalCode: "75009",
    country: "FR",
    latitude: 48.8785,
    longitude: 2.3401,
  },
  hours: [
    { day: 1, open: "11:30", close: "14:30", isClosed: false },
    { day: 2, open: "11:30", close: "14:30", isClosed: false },
    { day: 3, open: "11:30", close: "14:30", isClosed: false },
    { day: 6, open: "18:00", close: "23:00", isClosed: false },
    { day: 0, open: "00:00", close: "00:00", isClosed: true },
  ],
}

/** Round-trips a document the way the page does, and refuses `undefined`. */
function serialised(document: Record<string, unknown>): string {
  const json = JSON.stringify(document)
  expect(json).not.toContain("undefined")
  expect(json).not.toContain("null")
  return json
}

describe("Restaurant", () => {
  const document = buildRestaurantSchema(STORE, {
    baseUrl: BASE,
    image: "/api/files/branding/logo.webp",
    priceRange: "€€",
  })

  it("is a Restaurant with a stable identity", () => {
    expect(document["@context"]).toBe("https://schema.org")
    expect(document["@type"]).toBe("Restaurant")
    expect(document["@id"]).toBe(`${BASE}/#restaurant`)
    expect(document.url).toBe(BASE)
    expect(document.hasMenu).toBe(`${BASE}/menu`)
  })

  it("carries the fields a rich result reads", () => {
    expect(document.name).toBe("Chez Luigi")
    expect(document.telephone).toBe("+33 1 42 00 00 00")
    expect(document.priceRange).toBe("€€")
    expect(document.image).toBe(`${BASE}/api/files/branding/logo.webp`)
  })

  it("expands the stored address object into a PostalAddress", () => {
    expect(document.address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "12 rue des Martyrs",
      addressLocality: "Paris",
      postalCode: "75009",
      addressCountry: "FR",
    })
  })

  it("carries the coordinates when the establishment has them", () => {
    expect(document.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: 48.8785,
      longitude: 2.3401,
    })
  })

  it("groups the days that share an opening window", () => {
    expect(document.openingHoursSpecification).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: [
          "https://schema.org/Monday",
          "https://schema.org/Tuesday",
          "https://schema.org/Wednesday",
        ],
        opens: "11:30",
        closes: "14:30",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["https://schema.org/Saturday"],
        opens: "18:00",
        closes: "23:00",
      },
    ])
  })

  it("says nothing at all about a closed day", () => {
    // schema.org expresses "closed" by absence. An entry that opens and closes
    // at the same minute is a different, and false, claim.
    expect(serialised(document)).not.toContain("Sunday")
  })

  it("omits what the establishment has not filled in, rather than emitting null", () => {
    const bare = buildRestaurantSchema({ name: "Le Comptoir" }, { baseUrl: BASE })

    expect(serialised(bare)).toBe(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Restaurant",
        "@id": `${BASE}/#restaurant`,
        name: "Le Comptoir",
        url: BASE,
        hasMenu: `${BASE}/menu`,
      }),
    )
  })

  it("drops an hours row whose times are not times", () => {
    const document = buildRestaurantSchema(
      { name: "Le Comptoir", hours: [{ day: 1, open: "midi", close: "", isClosed: false }] },
      { baseUrl: BASE },
    )

    expect(document.openingHoursSpecification).toBeUndefined()
  })
})

describe("Menu", () => {
  const sections = [
    { id: "cat_1", slug: "entrees", name: "Entrées" },
    { id: "cat_2", slug: "plats", name: "Plats" },
    { id: "cat_3", slug: "vides", name: "Catégorie vide" },
  ]
  const items = [
    { id: "p1", name: "Burrata", price: 1250, sectionId: "cat_1" },
    { id: "p2", name: "Osso buco", price: 2400, sectionId: "cat_2", available: false },
    { id: "p3", name: "Café gourmand", price: 600, sectionId: null },
  ]

  const document = buildMenuSchema(STORE, sections, items, { baseUrl: BASE })

  it("is a Menu at the menu's own URL", () => {
    expect(document["@type"]).toBe("Menu")
    expect(document.url).toBe(`${BASE}/menu`)
  })

  it("prices a dish in euros, not in cents", () => {
    const json = serialised(document)

    expect(json).toContain('"price":"12.50"')
    expect(json).toContain('"priceCurrency":"EUR"')
    expect(json).not.toContain('"price":1250')
  })

  it("marks an unavailable dish out of stock", () => {
    expect(serialised(document)).toContain("https://schema.org/OutOfStock")
  })

  it("drops a section with no dish in it", () => {
    expect(serialised(document)).not.toContain("Catégorie vide")
  })

  it("keeps a dish whose category was deleted", () => {
    expect(serialised(document)).toContain("Café gourmand")
  })

  it("points a section at the filter the menu page actually reads", () => {
    // The menu filters on `?category=<slug>`, never on the category id.
    expect(serialised(document)).toContain(`${BASE}/menu?category=entrees`)
  })
})

describe("MenuItem", () => {
  it("prices the dish and names its seller", () => {
    const document = buildProductSchema(
      { id: "p1", name: "Burrata", price: 1250, imageUrl: "/api/files/products/a.webp" },
      { baseUrl: BASE, store: STORE },
    )

    expect(document["@type"]).toBe("MenuItem")
    expect(document.url).toBe(`${BASE}/product/p1`)
    expect(document.image).toBe(`${BASE}/api/files/products/a.webp`)
    expect(document.offers).toMatchObject({
      "@type": "Offer",
      price: "12.50",
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock",
      seller: { "@type": "Restaurant", "@id": `${BASE}/#restaurant` },
    })
  })
})

describe("BreadcrumbList", () => {
  it("numbers the trail from one and resolves every item", () => {
    const document = buildBreadcrumbSchema(
      [
        { name: "Accueil", path: "/" },
        { name: "Menu", path: "/menu" },
        { name: "Burrata", path: "/product/p1" },
      ],
      BASE,
    )

    expect(document?.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Accueil", item: `${BASE}/` },
      { "@type": "ListItem", position: 2, name: "Menu", item: `${BASE}/menu` },
      { "@type": "ListItem", position: 3, name: "Burrata", item: `${BASE}/product/p1` },
    ])
  })

  it("is nothing at all when there is no hierarchy", () => {
    expect(buildBreadcrumbSchema([], BASE)).toBeUndefined()
  })
})

describe("derivePriceRange", () => {
  it("bands the catalogue by its median dish", () => {
    expect(derivePriceRange([600, 800, 900])).toBe("€")
    expect(derivePriceRange([1200, 1500, 1800])).toBe("€€")
    expect(derivePriceRange([2500, 3200, 3800])).toBe("€€€")
    expect(derivePriceRange([4500, 6000])).toBe("€€€€")
  })

  it("says nothing rather than invent a band", () => {
    expect(derivePriceRange([])).toBeUndefined()
    expect(derivePriceRange([0, -1, Number.NaN])).toBeUndefined()
  })
})

describe("pruneUndefined", () => {
  it("never leaves a null hole inside an array", () => {
    // JSON.stringify turns an undefined array entry into null, and a null in
    // `hasMenuItem` is a malformed document rather than an empty one.
    expect(pruneUndefined({ list: [1, undefined, 2] })).toEqual({ list: [1, 2] })
  })
})

describe("the markup actually reaches the page", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

  it("the storefront layout renders the establishment", () => {
    const layout = read("app/(storefront)/layout.tsx")

    expect(layout).toContain("JsonLd")
    expect(layout).toContain("getRestaurantJsonLd")
  })

  it("the menu renders the carte and its breadcrumbs", () => {
    const page = read("app/(storefront)/menu/page.tsx")

    expect(page).toContain("getMenuJsonLd")
    expect(page).toContain("buildBreadcrumbSchema")
  })

  it("a dish renders its own offer", () => {
    const page = read("app/(storefront)/product/[productId]/page.tsx")

    expect(page).toContain("buildProductSchema")
  })

  it("the renderer emits an application/ld+json script", () => {
    expect(read("lib/json-ld.tsx")).toContain('type="application/ld+json"')
  })
})
