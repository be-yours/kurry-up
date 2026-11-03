// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A media a page still shows cannot be deleted.
 *
 * WHAT WAS BROKEN (#432.5). `deleteMedia` checked every place a media is
 * referenced BY ID — `cmsBlocks.values[].mediaId`, an article's `coverImageId`
 * and `ogImageId`. An image dropped into an article's body is not one of them:
 * the editor writes `<img src="…">`, so the reference lives as a URL inside an
 * HTML string, `usageCount` never moves, and the library showed
 * « Utilisations : 0 » beside the delete button for a photograph on a
 * **published** page.
 *
 * The measurement in the issue:
 *
 *     media is embedded in the PUBLISHED article body : true
 *     deleteMedia reference check blocks the delete   : false
 *
 * And the delete is not recoverable the way a row delete is — `cmsMediaDelete`
 * purges the S3 bytes, so the article is left with a broken image and the file
 * is gone.
 *
 * It also missed `blogCategories.imageId`, which `blog.ts` writes: the one
 * reference in the whole set that IS a plain `v.id("cmsMedia")` was the one
 * nothing looked at.
 *
 * These drive the registered mutation, because what is being measured is what
 * an owner clicking « Supprimer » gets.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorPayload } from "../../lib/convex-error"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const CDN = "https://cdn.example.test"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
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
    })
  )
}

async function seedOwner(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner-1",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner-1" })
}

/** A processed image, with the key and URLs a real one carries. */
async function seedMedia(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  filename = "pate.webp"
) {
  return t.run(async (ctx) => {
    const mediaId = await ctx.db.insert("cmsMedia", {
      storeId,
      kind: "image" as const,
      status: "ready" as const,
      filename,
      mimeType: "image/webp",
      size: 12_345,
      usageCount: 0,
      uploadedBy: "owner-1",
      uploadedAt: NOW,
    })
    await ctx.db.patch(mediaId, {
      s3Key: `cms/${mediaId}/source.webp`,
      sourceUrl: `${CDN}/cms/${mediaId}/source.webp`,
      variants: { card: { url: `${CDN}/cms/${mediaId}/card.webp`, width: 800, height: 450 } },
    })
    return mediaId
  })
}

async function seedCategory(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("blogCategories", {
      storeId,
      name: "Recettes",
      slug: "recettes",
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedArticle(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  categoryId: Id<"blogCategories">,
  over: { draftBody?: string; publishedBody?: string } = {}
) {
  const content = (body: string) => ({
    title: "La pâte à pizza",
    slug: "la-pate-a-pizza",
    excerpt: "Un extrait.",
    content: body,
    updatedAt: NOW,
  })
  return t.run((ctx) =>
    ctx.db.insert("blogArticles", {
      storeId,
      status: over.publishedBody ? ("published" as const) : ("draft" as const),
      hasUnpublishedChanges: !over.publishedBody,
      draftSlug: "la-pate-a-pizza",
      draftCategoryId: categoryId,
      draftAuthorId: "owner-1",
      draftContent: content(over.draftBody ?? "<p>Farine, eau, sel.</p>"),
      ...(over.publishedBody
        ? {
            publishedSlug: "la-pate-a-pizza",
            publishedCategoryId: categoryId,
            publishedAuthorId: "owner-1",
            publishedContent: content(over.publishedBody),
            publishedAt: NOW,
          }
        : {}),
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: "owner-1",
    })
  )
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise
    return { thrown: false as const, payload: null }
  } catch (error) {
    return { thrown: true as const, payload: convexErrorPayload(error) }
  }
}

// ===========================================================================
// The body of an article — the hole
// ===========================================================================

describe("an image in an article body", () => {
  test("cannot be deleted while a PUBLISHED article shows it", async () => {
    // The exact case #432.5 measured: embedded in the published body, and the
    // delete went through with the S3 bytes.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, storeId, categoryId, {
      publishedBody: `<p>La pâte.</p><img src="${CDN}/cms/${mediaId}/source.webp" alt="" />`,
    })

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_article_body")
    expect(refusal.payload?.message).toMatch(/La pâte à pizza/)
    // And the row is still there, which is what keeps the bytes.
    expect(await t.run((ctx) => ctx.db.get(mediaId))).not.toBeNull()
  })

  test("cannot be deleted while a DRAFT shows it either", async () => {
    // A draft body is what the owner is about to publish.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, storeId, categoryId, {
      draftBody: `<img src="${CDN}/cms/${mediaId}/card.webp" />`,
    })

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_article_body")
  })

  test("is found through the S3 key as well as the CDN URL", async () => {
    // The bucket is private and reads go through the app's own `/api/files`
    // proxy, so the markup can carry the key rather than a CDN URL.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, storeId, categoryId, {
      publishedBody: `<img src="/api/files?key=cms/${mediaId}/source.webp" />`,
    })

    expect(
      (await refusalOf(owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })))
        .payload?.code
    ).toBe("media_in_use_by_article_body")
  })

  test("and a media no article shows is still deletable", async () => {
    // The blast radius. A check that refused every delete would be worse than
    // the hole: the library's delete button would simply stop working.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    const other = await seedMedia(t, storeId, "four.webp")
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, storeId, categoryId, {
      publishedBody: `<img src="${CDN}/cms/${other}/source.webp" />`,
    })

    const result = await owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })

    expect(result.deleted).toBe(true)
    expect(await t.run((ctx) => ctx.db.get(mediaId))).toBeNull()
  })
})

// ===========================================================================
// A CMS block's rich text
// ===========================================================================

describe("an image in a CMS block's rich text", () => {
  test("cannot be deleted, though the block names no mediaId", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert("cmsBlocks", {
        storeId,
        pageSlug: "notre-histoire",
        blockKey: "recit",
        isDraft: false,
        // Rich text, not a media field: no `mediaId` anywhere in this block.
        values: { body: `<p>Depuis 1998.</p><img src="${CDN}/cms/${mediaId}/source.webp" />` },
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_block")
    expect(refusal.payload?.message).toMatch(/notre-histoire/)
  })
})

// ===========================================================================
// blogCategories.imageId — an id nothing was reading
// ===========================================================================

describe("a blog category's image", () => {
  test("cannot be deleted while the category uses it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const mediaId = await seedMedia(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    await t.run((ctx) => ctx.db.patch(categoryId, { imageId: mediaId }))

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_blog_category")
    expect(refusal.payload?.message).toMatch(/Recettes/)
  })
})

// ===========================================================================
// The case the needles must not break
// ===========================================================================

describe("a media that has not finished processing", () => {
  test("is deletable, and does not match every article", async () => {
    // A row exists between the presigned upload and `setMediaReady`, with no
    // key and no URL. An empty needle would match every document and refuse
    // every delete in the library — the opposite failure, and a worse one.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    await seedArticle(t, storeId, categoryId, {
      publishedBody: "<p>Un article avec du texte.</p>",
    })

    const mediaId = await t.run((ctx) =>
      ctx.db.insert("cmsMedia", {
        storeId,
        kind: "image" as const,
        status: "processing" as const,
        filename: "en-cours.webp",
        mimeType: "image/webp",
        size: 1,
        usageCount: 0,
        uploadedBy: "owner-1",
        uploadedAt: NOW,
      })
    )

    const result = await owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })

    expect(result.deleted).toBe(true)
  })
})
