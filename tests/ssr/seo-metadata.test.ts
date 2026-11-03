/**
 * What the storefront tells a crawler (#168, TECH-09).
 *
 * The robots directive was read with `robots.includes("index")`, and the string
 * `"noindex"` contains `"index"`. Measured before the fix, the CMS value
 * `"noindex, nofollow"` produced `{ index: true, follow: true }`: every page an
 * owner had marked "do not index" was published to Google with a positive
 * directive. All four values the CMS offers were wrong; only `"none"`, which
 * contains neither word, happened to come out right.
 *
 * The rest of this file pins what a page has to carry beside that directive —
 * an absolute canonical, an absolute `og:image`, a `metadataBase` — because a
 * relative image is not fetched by the crawlers that matter and a missing
 * canonical is how two URLs become two pages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const cookieJar = new Map<string, string>()
const requestHeaders = new Map<string, string>()

vi.mock("server-only", () => ({}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }),
}))

const getStorePageData = vi.fn()
vi.mock("@/lib/convex-server", () => ({
  fetchCmsPageData: vi.fn(),
  getStorePageData: (...args: unknown[]) => getStorePageData(...args),
  resolveStorefrontStore: async () => null,
}))

const resolveDefaultStoreSlug = vi.fn()
vi.mock("@/lib/resolve-default-store", () => ({
  resolveDefaultStoreSlug: () => resolveDefaultStoreSlug(),
}))

vi.mock("@/lib/structured-data", () => ({
  getStorefrontSeoContext: async () => ({
    baseUrl: "https://chez-luigi.fr",
    storeId: null,
    store: null,
    logoUrl: null,
    brandName: "Chez Luigi",
  }),
}))

const { buildSeoMetadata } = await import("@/lib/seo")
const { parseRobotsDirective, PRIVATE_PAGE, INDEXABLE } = await import(
  "@/lib/crawler-policy"
)
const { generateCmsMetadata, generateStaticPageMetadata } = await import(
  "@/lib/cms/seo"
)

/** A CMS page whose SEO block answers with the given field values. */
function cmsPage(fields: Record<string, string | null>) {
  return {
    block: () => ({
      values: {},
      field: (key: string) => ({
        text: fields[key] ?? null,
        mediaUrl: key === "ogImage" ? fields.ogImage ?? null : null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: null,
      }),
    }),
    pageMeta: null,
  }
}

beforeEach(() => {
  cookieJar.clear()
  requestHeaders.clear()
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SITE_URL = "https://chez-luigi.fr"
  resolveDefaultStoreSlug.mockResolvedValue("chez-luigi")
})

describe("parseRobotsDirective", () => {
  it("reads every value the CMS offers", () => {
    expect(parseRobotsDirective("index, follow")).toEqual({ index: true, follow: true })
    expect(parseRobotsDirective("noindex, follow")).toEqual({ index: false, follow: true })
    expect(parseRobotsDirective("index, nofollow")).toEqual({ index: true, follow: false })
    expect(parseRobotsDirective("noindex, nofollow")).toEqual({
      index: false,
      follow: false,
    })
  })

  it("does not read `noindex` as `index` — the defect this file exists for", () => {
    // `"noindex, nofollow".includes("index")` is true, and that one substring
    // check advertised every hidden page to Google.
    expect(parseRobotsDirective("noindex, nofollow").index).toBe(false)
    expect(parseRobotsDirective("noindex, nofollow").follow).toBe(false)
    expect(parseRobotsDirective("noindex").index).toBe(false)
    expect(parseRobotsDirective("nofollow").follow).toBe(false)
  })

  it("understands `none` and `all`", () => {
    expect(parseRobotsDirective("none")).toEqual({ index: false, follow: false })
    expect(parseRobotsDirective("all")).toEqual({ index: true, follow: true })
  })

  it("accepts space-separated, semicolon-separated and mixed-case values", () => {
    expect(parseRobotsDirective("noindex nofollow")).toEqual({
      index: false,
      follow: false,
    })
    expect(parseRobotsDirective("NOINDEX, NOFOLLOW")).toEqual({
      index: false,
      follow: false,
    })
    expect(parseRobotsDirective("Noindex; Follow")).toEqual({
      index: false,
      follow: true,
    })
  })

  it("reads the CMS's own human label, parentheses and accents included", () => {
    expect(parseRobotsDirective("Index, Follow (par défaut)")).toEqual({
      index: true,
      follow: true,
    })
    expect(parseRobotsDirective("Noindex, Nofollow (page privée)")).toEqual({
      index: false,
      follow: false,
    })
  })

  it("takes the most restrictive reading of a contradiction", () => {
    expect(parseRobotsDirective("index, noindex")).toEqual({
      index: false,
      follow: true,
    })
  })

  it("falls back when the value is absent, empty or unrecognisable", () => {
    expect(parseRobotsDirective(null)).toEqual(INDEXABLE)
    expect(parseRobotsDirective(undefined)).toEqual(INDEXABLE)
    expect(parseRobotsDirective("")).toEqual(INDEXABLE)
    expect(parseRobotsDirective("   ")).toEqual(INDEXABLE)
    expect(parseRobotsDirective("banane")).toEqual(INDEXABLE)
    expect(parseRobotsDirective(42)).toEqual(INDEXABLE)
    expect(parseRobotsDirective("noindex", PRIVATE_PAGE)).toEqual(PRIVATE_PAGE)
  })
})

describe("generateCmsMetadata", () => {
  it("carries the CMS robots directive into the page's metadata", async () => {
    getStorePageData.mockResolvedValue({
      store: { _id: "s1", name: "Chez Luigi" },
      cms: cmsPage({ metaTitle: "Notre carte", robots: "noindex, nofollow" }),
    })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      pathname: "/menu",
      fallbackTitle: "Menu",
    })

    expect(metadata.robots).toMatchObject({ index: false, follow: false })
    expect(metadata.robots).toMatchObject({
      googleBot: { index: false, follow: false },
    })
  })

  it("writes an absolute canonical and an absolute og:url", async () => {
    getStorePageData.mockResolvedValue({
      store: { _id: "s1", name: "Chez Luigi" },
      cms: cmsPage({ metaTitle: "Notre carte" }),
    })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      pathname: "/menu",
      fallbackTitle: "Menu",
    })

    expect(metadata.alternates?.canonical).toBe("https://chez-luigi.fr/menu")
    expect(metadata.openGraph?.url).toBe("https://chez-luigi.fr/menu")
    expect(metadata.metadataBase?.toString()).toBe("https://chez-luigi.fr/")
  })

  it("expands a CMS og:image served by the app's own media proxy", async () => {
    // `/api/files/...` is what `buildMediaUrl` returns on a private bucket. A
    // relative og:image is simply not fetched by a crawler.
    getStorePageData.mockResolvedValue({
      store: { _id: "s1", name: "Chez Luigi" },
      cms: cmsPage({ metaTitle: "Notre carte", ogImage: "/api/files/cms/a/hero.webp" }),
    })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      pathname: "/menu",
      fallbackTitle: "Menu",
    })

    expect(metadata.openGraph?.images).toEqual([
      { url: "https://chez-luigi.fr/api/files/cms/a/hero.webp" },
    ])
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" })
  })

  it("names the establishment as the site, not the engine", async () => {
    getStorePageData.mockResolvedValue({
      store: { _id: "s1", name: "Chez Luigi" },
      cms: cmsPage({ metaTitle: "Notre carte" }),
    })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      pathname: "/menu",
      fallbackTitle: "Menu",
    })

    expect(metadata.openGraph?.siteName).toBe("Chez Luigi")
  })

  it("lets a caller override the CMS directive outright", async () => {
    // A customer's order must not become indexable because somebody picked
    // "Index, Follow" in a dropdown.
    getStorePageData.mockResolvedValue({
      store: { _id: "s1", name: "Chez Luigi" },
      cms: cmsPage({ robots: "index, follow" }),
    })

    const metadata = await generateCmsMetadata({
      pageSlug: "order-tracking",
      pathname: "/track/abc",
      fallbackTitle: "Suivi",
      robots: PRIVATE_PAGE,
    })

    expect(metadata.robots).toMatchObject({ index: false, follow: false })
  })

  it("still produces a canonical when there is no establishment at all", async () => {
    getStorePageData.mockResolvedValue({ store: null, cms: null })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      pathname: "/menu",
      fallbackTitle: "Menu",
      fallbackDescription: "Notre carte",
    })

    expect(metadata.title).toBe("Menu")
    expect(metadata.description).toBe("Notre carte")
    expect(metadata.alternates?.canonical).toBe("https://chez-luigi.fr/menu")
  })
})

describe("generateStaticPageMetadata", () => {
  it("gives a private page a title and refuses it to a crawler", async () => {
    const metadata = await generateStaticPageMetadata({
      title: "Votre panier",
      pathname: "/cart",
      robots: PRIVATE_PAGE,
    })

    expect(metadata.title).toBe("Votre panier")
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe("https://chez-luigi.fr/cart")
    expect(metadata.openGraph?.siteName).toBe("Chez Luigi")
  })
})

describe("base URL", () => {
  it("prefers the configured site URL over the request host", async () => {
    // The sitemap and robots.txt are rendered without a request and can read
    // only the environment. A canonical built from the host would disagree
    // with them on any deployment reachable at more than one name.
    requestHeaders.set("host", "preview-7f2.vercel.app")

    const metadata = await buildSeoMetadata({
      fallbackTitle: "Menu",
      pathname: "/menu",
    })

    expect(metadata.alternates?.canonical).toBe("https://chez-luigi.fr/menu")
  })

  it("falls back to the request host when nothing is configured", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    requestHeaders.set("host", "chez-marco.fr")

    const metadata = await buildSeoMetadata({
      fallbackTitle: "Menu",
      pathname: "/menu",
    })

    expect(metadata.alternates?.canonical).toBe("https://chez-marco.fr/menu")
  })
})
