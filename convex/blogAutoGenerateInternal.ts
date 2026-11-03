/**
 * Blog Auto Generate — Internal Functions
 *
 * internalQuery + internalMutation for the AI article generation flow.
 * NO "use node" — these run in the default Convex runtime.
 * Called by the action in blogAutoGenerate.ts ("use node").
 */

import { v } from "convex/values"
import { internalQuery, internalMutation } from "./_generated/server"
import {
  checkAutoBlogAccess,
  releaseArticleQuota,
  releaseImageQuota,
  reserveArticleQuota,
  reserveImageQuota,
} from "@be-yours/convex-functions/blogAutoGuards"
import { requireStorePermission } from "@be-yours/convex-functions/auth"
import { completeJobCore } from "@be-yours/convex-functions/blogAutoPlanner"
import {
  getGenerationContextCore,
  saveGeneratedArticleCore,
} from "@be-yours/convex-functions/blogAutoGenerate"
import { scheduleBlogTranslation } from "./blogAutoTranslate"

// ============================================================================
// Internal Queries
// ============================================================================

/**
 * Entitlements, quota, AND the right to write content on this establishment.
 *
 * The store used to be missing from this check entirely: it took an `ownerId`
 * and nothing else, so any account with an Auto Blog plan could generate an
 * article into any restaurant in the deployment. The `@guarded-inline` marker
 * on the calling action asserted this check covered the store, which is what
 * kept the linter quiet about it.
 *
 * The owner is read from the session rather than taken as an argument, so a
 * caller cannot spend somebody else's quota either.
 */
export const _checkAccess = internalQuery({
  args: { storeId: v.id("stores") },
  handler: async (ctx, { storeId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    await requireStorePermission(ctx, storeId, "content:write")

    return checkAutoBlogAccess(ctx, identity.subject)
  },
})

/** Get store and category context for the AI prompt */
export const _getGenerationContext = internalQuery({
  args: {
    storeId: v.id("stores"),
    categoryId: v.id("blogCategories"),
  },
  handler: async (ctx, args) => {
    return getGenerationContextCore(ctx, {
      storeId: args.storeId,
      categoryId: args.categoryId,
    })
  },
})

// ============================================================================
// Internal Mutations
// ============================================================================

/**
 * Take one article out of this month's quota before a penny is spent.
 *
 * The store is re-authorised here and not merely at the start of the action:
 * this mutation writes, and a write reached through `ctx.runMutation` carries
 * no guard of its own.
 */
export const _reserveQuota = internalMutation({
  args: { storeId: v.id("stores") },
  handler: async (ctx, { storeId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    await requireStorePermission(ctx, storeId, "content:write")

    return reserveArticleQuota(ctx, identity.subject)
  },
})

/**
 * The same reservation, for a caller that has no session.
 *
 * `executeAutoBlogQueue` runs on a cron: there is no identity to derive an
 * owner from, and the establishment was authorised when the configuration was
 * saved. Internal functions are not publicly callable, which is what makes
 * taking the owner as an argument acceptable here and not in `_reserveQuota`.
 */
export const _reserveQuotaForOwner = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    return reserveArticleQuota(ctx, ownerId)
  },
})

/** Hand the article slot back when the generation produced nothing. */
export const _releaseQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    await releaseArticleQuota(ctx, ownerId)
  },
})

/**
 * Take one image out of this month's image quota.
 *
 * An article generates up to four `gpt-image-1` images and none of them was
 * ever counted: the image quota existed and this pipeline never asked it.
 */
export const _reserveImageQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    return reserveImageQuota(ctx, ownerId)
  },
})

/** Hand an image slot back when OpenAI or S3 refused. */
export const _releaseImageQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    await releaseImageQuota(ctx, ownerId)
  },
})

/** Create a cmsMedia record for a blog-auto image (called from generateArticle action) */
export const _createBlogImage = internalMutation({
  args: {
    storeId: v.id("stores"),
    filename: v.string(),
    mimeType: v.string(),
    size: v.number(),
    uploadedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const mediaId = await ctx.db.insert("cmsMedia", {
      storeId: args.storeId,
      kind: "image" as const,
      filename: args.filename,
      mimeType: args.mimeType,
      size: args.size,
      folder: "blog-auto",
      uploadedBy: args.uploadedBy,
      status: "processing" as const,
      usageCount: 0,
      uploadedAt: now,
    })
    return mediaId
  },
})

/** Save the generated article, publish it where the plan allows, optionally translate it */
export const _saveGeneratedArticle = internalMutation({
  args: {
    storeId: v.id("stores"),
    ownerId: v.string(),
    title: v.string(),
    excerpt: v.string(),
    content: v.string(),
    categoryId: v.id("blogCategories"),
    authorId: v.string(),
    coverImageId: v.optional(v.id("cmsMedia")),
    coverImageAlt: v.optional(v.string()),
    metaTitle: v.optional(v.string()),
    metaDescription: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    autoTranslate: v.optional(v.boolean()),
    approvalMode: v.optional(
      v.union(v.literal("draft_review"), v.literal("auto_publish")),
    ),
    /**
     * The scheduled job this article belongs to, when there is one.
     *
     * Passed so the article and the queue row that asked for it commit
     * together. Completing the job in a later mutation left a window in which
     * the article existed and the job still read `generating`: a crash there,
     * or an action hitting the Convex time limit, meant the recovery sweep
     * re-queued a slot that had already produced its article, and the owner
     * paid once for two.
     */
    jobId: v.optional(v.id("blogAutoQueue")),
  },
  handler: async (ctx, args) => {
    const { articleId, status } = await saveGeneratedArticleCore(ctx, {
      storeId: args.storeId,
      ownerId: args.ownerId,
      title: args.title,
      excerpt: args.excerpt,
      content: args.content,
      categoryId: args.categoryId,
      authorId: args.authorId,
      coverImageId: args.coverImageId,
      coverImageAlt: args.coverImageAlt,
      metaTitle: args.metaTitle,
      metaDescription: args.metaDescription,
      tags: args.tags,
      approvalMode: args.approvalMode,
    })

    if (args.jobId) {
      await completeJobCore(ctx, {
        jobId: args.jobId,
        articleId,
        status,
        at: Date.now(),
      })
    }

    // Schedule auto-translation if enabled
    if (args.autoTranslate) {
      await scheduleBlogTranslation(ctx, articleId, args.storeId)
    }

    return { articleId, status }
  },
})
