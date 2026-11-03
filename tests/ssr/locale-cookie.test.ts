/**
 * The server half of the language switch (#148).
 *
 * The app writes `beid_locale` — `setLocale` does, `app/layout.tsx` reads it
 * for `<html lang>`. Both server-side CMS readers looked for a cookie called
 * `locale`, which nothing has ever written. So `resolvedLocale` was always
 * null, every server-rendered CMS string came back in the source language, and
 * the SEO block never carried a translated title. Nothing tested either file
 * in either direction.
 *
 * `generateCmsMetadata` had a second lock on it: it gave up unless a
 * `storeSlug` cookie was present, and nothing writes that one either — a
 * leftover of the removed `/s/[storeSlug]` routing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const cookieJar = new Map<string, string>()

vi.mock("server-only", () => ({}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
}))

const fetchCmsPageData = vi.fn()
const getStorePageData = vi.fn()

vi.mock("@/lib/convex-server", () => ({
  fetchCmsPageData: (...args: unknown[]) => fetchCmsPageData(...args),
  getStorePageData: (...args: unknown[]) => getStorePageData(...args),
}))

const resolveDefaultStoreSlug = vi.fn()

vi.mock("@/lib/resolve-default-store", () => ({
  resolveDefaultStoreSlug: () => resolveDefaultStoreSlug(),
}))

const { fetchCmsPage } = await import("@/lib/cms/server")
const { generateCmsMetadata } = await import("@/lib/cms/seo")

/** One CMS block whose hero title has been translated into English. */
function heroPage() {
  return {
    blocks: [
      {
        blockKey: "hero",
        values: { title: { textValue: "Notre carte" } },
        translationsByField: {
          title: { en: { value: "Our menu" } },
        },
      },
    ],
    pageMeta: null,
  }
}

beforeEach(() => {
  cookieJar.clear()
  vi.clearAllMocks()
  fetchCmsPageData.mockResolvedValue(heroPage())
  resolveDefaultStoreSlug.mockResolvedValue(null)
})

describe("fetchCmsPage", () => {
  it("reads the locale from the cookie the app actually writes", async () => {
    cookieJar.set("beid_locale", "en")

    const page = await fetchCmsPage("store1" as never, "homepage")

    expect(page.block("hero").field("title").text).toBe("Our menu")
  })

  it("ignores a cookie named `locale` — nothing writes one", async () => {
    // Pinning the wrong name too, so a revert is a red test rather than a
    // silent return to French.
    cookieJar.set("locale", "en")

    const page = await fetchCmsPage("store1" as never, "homepage")

    expect(page.block("hero").field("title").text).toBe("Notre carte")
  })

  it("renders the source language when no locale cookie is set", async () => {
    const page = await fetchCmsPage("store1" as never, "homepage")

    expect(page.block("hero").field("title").text).toBe("Notre carte")
  })

  it("refuses a malformed cookie value rather than passing it on", async () => {
    // The value reaches a translation lookup; it is attacker-controlled.
    cookieJar.set("beid_locale", "en'><script>")

    const page = await fetchCmsPage("store1" as never, "homepage")

    expect(page.block("hero").field("title").text).toBe("Notre carte")
  })

  it("still lets an explicit locale argument win over the cookie", async () => {
    cookieJar.set("beid_locale", "fr")

    const page = await fetchCmsPage("store1" as never, "homepage", "en")

    expect(page.block("hero").field("title").text).toBe("Our menu")
  })
})

describe("generateCmsMetadata", () => {
  const seoPage = (locale: string | null) => ({
    store: { _id: "store1", slug: "chez-luigi" },
    cms: {
      block: () => ({
        values: {},
        field: (key: string) => ({
          text:
            key === "metaTitle"
              ? locale === "en"
                ? "Our menu — Chez Luigi"
                : "Notre carte — Chez Luigi"
              : null,
          mediaUrl: null,
          media: null,
          embedUrl: null,
          altText: null,
          raw: null,
        }),
      }),
      pageMeta: null,
    },
  })

  it("passes the locale cookie through to the CMS lookup", async () => {
    cookieJar.set("storeSlug", "chez-luigi")
    cookieJar.set("beid_locale", "en")
    getStorePageData.mockImplementation(
      async (_slug: string, _page: string, locale: string | null) =>
        seoPage(locale)
    )

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      fallbackTitle: "Menu",
    })

    expect(getStorePageData).toHaveBeenCalledWith("chez-luigi", "menu", "en")
    expect(metadata.title).toBe("Our menu — Chez Luigi")
    expect(metadata.openGraph?.title).toBe("Our menu — Chez Luigi")
  })

  it("resolves the establishment when no storeSlug cookie exists", async () => {
    // The normal case: nothing writes that cookie. This used to return the
    // hard-coded fallback title on every page of every storefront.
    cookieJar.set("beid_locale", "en")
    resolveDefaultStoreSlug.mockResolvedValue("chez-luigi")
    getStorePageData.mockImplementation(
      async (_slug: string, _page: string, locale: string | null) =>
        seoPage(locale)
    )

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      fallbackTitle: "Menu",
    })

    expect(resolveDefaultStoreSlug).toHaveBeenCalled()
    expect(getStorePageData).toHaveBeenCalledWith("chez-luigi", "menu", "en")
    expect(metadata.title).toBe("Our menu — Chez Luigi")
  })

  it("prefers an explicit storeSlug cookie over the default establishment", async () => {
    cookieJar.set("storeSlug", "chez-marco")
    resolveDefaultStoreSlug.mockResolvedValue("chez-luigi")
    getStorePageData.mockResolvedValue(seoPage(null))

    await generateCmsMetadata({ pageSlug: "menu", fallbackTitle: "Menu" })

    expect(getStorePageData).toHaveBeenCalledWith("chez-marco", "menu", null)
    expect(resolveDefaultStoreSlug).not.toHaveBeenCalled()
  })

  it("falls back to the given title when there is no establishment at all", async () => {
    getStorePageData.mockResolvedValue({ store: null, cms: null })

    const metadata = await generateCmsMetadata({
      pageSlug: "menu",
      fallbackTitle: "Menu",
      fallbackDescription: "Notre carte",
    })

    expect(metadata.title).toBe("Menu")
    expect(metadata.description).toBe("Notre carte")
  })
})
