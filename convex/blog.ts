/**
 * Blog App Wrappers
 *
 * Auth-protected wrappers around package-level blog functions.
 * Public queries (storefront) have no auth.
 * Admin queries and all mutations require authentication.
 */

import { v } from "convex/values"
import { query, internalMutation } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import * as blogDefs from "@be-yours/convex-functions/blog"
import {
  createArticleCore,
  saveDraftCore,
  deleteArticleCore,
} from "@be-yours/convex-functions/blog"
import {
  publishArticleCore,
  scheduleArticleCore,
  unscheduleArticleCore,
  archiveArticleCore,
  unarchiveArticleCore,
} from "@be-yours/convex-functions/blogPublish"
import { scheduleBlogTranslation } from "./blogAutoTranslate"
import { storeQuery, storeMutation, storeIdFromField } from "./lib/storeFunctions";

const blogStoreId = storeIdFromField("articleId", "Article not found");

// ============================================================================
// Public Queries (storefront, no auth)
// ============================================================================

// @public-by-design: published blog content, served to anonymous readers
export const listPublishedArticles = query(blogDefs.listPublishedArticles)
// @public-by-design: published blog content, served to anonymous readers
export const getArticleBySlug = query(blogDefs.getArticleBySlug)
// @public-by-design: published blog content, served to anonymous readers
export const listCategories = query(blogDefs.listCategories)
// @public-by-design: published blog content, served to anonymous readers
export const listTags = query(blogDefs.listTags)

// ============================================================================
// Admin Queries (auth-protected)
// ============================================================================

export const listAdminArticles = storeQuery({
  permission: "content:read",
  args: blogDefs.listAdminArticles.args,
  handler: (ctx, args) => blogDefs.listAdminArticles.handler(ctx, args),
})

export const getAdminArticle = storeQuery({
  permission: "content:read",
  storeIdFrom: blogStoreId,
  args: blogDefs.getAdminArticle.args,
  handler: (ctx, args) => blogDefs.getAdminArticle.handler(ctx, args),
})

// ============================================================================
// Store id resolvers (documents referenced through non-`id` args)
// ============================================================================

async function storeIdFromArticle(
  ctx: QueryCtx,
  args: { articleId: Id<"blogArticles"> }
): Promise<Id<"stores">> {
  const article = await ctx.db.get(args.articleId)
  if (!article) throw new Error("Article not found")
  return article.storeId
}

async function storeIdFromCategory(
  ctx: QueryCtx,
  args: { categoryId: Id<"blogCategories"> }
): Promise<Id<"stores">> {
  const category = await ctx.db.get(args.categoryId)
  if (!category) throw new Error("Category not found")
  return category.storeId
}

/**
 * The establishment a tag belongs to, read from the tag itself (#524).
 *
 * The core `deleteTag` takes a bare `tagId` and says nothing about whose it is.
 * Without this, `storeMutation` would have to take a `storeId` from the caller
 * — and a caller that supplies the establishment its own permission is checked
 * against is not a check. That is the hole #112 closed on `categoryId`.
 */
async function storeIdFromTag(
  ctx: QueryCtx,
  args: { tagId: Id<"blogTags"> }
): Promise<Id<"stores">> {
  const tag = await ctx.db.get(args.tagId)
  if (!tag) throw new Error("Tag not found")
  return tag.storeId
}

// ============================================================================
// Admin Mutations — Articles
// ============================================================================

/** Create a new blog article (draft) */
export const createArticle = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    title: v.string(),
    categoryId: v.id("blogCategories"),
  },
  handler: (ctx, args, identity) =>
    createArticleCore(ctx, {
      storeId: args.storeId,
      title: args.title,
      categoryId: args.categoryId,
      authorId: identity.subject,
    }),
})

/** Save draft content for an article */
export const saveDraft = storeMutation({
  permission: "content:write",
  args: {
    articleId: v.id("blogArticles"),
    draftContent: v.any(),
    categoryId: v.id("blogCategories"),
    tagIds: v.optional(v.array(v.id("blogTags"))),
  },
  storeIdFrom: storeIdFromArticle,
  handler: async (ctx, args, identity) => {
    await saveDraftCore(
      ctx,
      {
        articleId: args.articleId,
        draftContent: args.draftContent,
        categoryId: args.categoryId,
        authorId: identity.subject,
        updatedBy: identity.subject,
      },
      {
        onAfterSave: scheduleBlogTranslation,
      },
    )

    // Sync tags if provided
    if (args.tagIds) {
      await blogDefs.updateArticleTags.handler(ctx, {
        articleId: args.articleId,
        tagIds: args.tagIds,
      })
    }
  },
})

/** Publish an article */
export const publishArticle = storeMutation({
  permission: "content:write",
  args: { articleId: v.id("blogArticles") },
  storeIdFrom: storeIdFromArticle,
  handler: (ctx, args, identity) =>
    publishArticleCore(ctx, args.articleId, identity.subject),
})

/** Schedule an article for future publication */
export const scheduleArticle = storeMutation({
  permission: "content:write",
  args: {
    articleId: v.id("blogArticles"),
    publishAt: v.number(),
  },
  storeIdFrom: storeIdFromArticle,
  handler: async (ctx, args): Promise<void> => {
    // Schedule the internal publish action
    const jobId = await ctx.scheduler.runAt(
      args.publishAt,
      internal.blog._publishArticleInternal,
      { articleId: args.articleId },
    )

    return scheduleArticleCore(ctx, args.articleId, args.publishAt, jobId)
  },
})

/** Unschedule an article (revert to draft) */
export const unscheduleArticle = storeMutation({
  permission: "content:write",
  args: { articleId: v.id("blogArticles") },
  storeIdFrom: storeIdFromArticle,
  handler: (ctx, args) => unscheduleArticleCore(ctx, args.articleId),
})

/** Archive an article */
export const archiveArticle = storeMutation({
  permission: "content:write",
  args: { articleId: v.id("blogArticles") },
  storeIdFrom: storeIdFromArticle,
  handler: (ctx, args) => archiveArticleCore(ctx, args.articleId),
})

/** Unarchive an article */
export const unarchiveArticle = storeMutation({
  permission: "content:write",
  args: { articleId: v.id("blogArticles") },
  storeIdFrom: storeIdFromArticle,
  handler: (ctx, args) => unarchiveArticleCore(ctx, args.articleId),
})

/** Delete an article */
export const deleteArticle = storeMutation({
  permission: "content:delete",
  args: { articleId: v.id("blogArticles") },
  storeIdFrom: storeIdFromArticle,
  handler: (ctx, args) => deleteArticleCore(ctx, args),
})

// ============================================================================
// Admin Mutations — Categories
// ============================================================================

export const createCategory = storeMutation({
  permission: "content:write",
  args: blogDefs.createCategory.args,
  handler: (ctx, args) => blogDefs.createCategory.handler(ctx, args),
})

export const updateCategory = storeMutation({
  permission: "content:write",
  args: blogDefs.updateCategory.args,
  storeIdFrom: storeIdFromCategory,
  handler: (ctx, args) => blogDefs.updateCategory.handler(ctx, args),
})

export const deleteCategory = storeMutation({
  permission: "content:delete",
  args: blogDefs.deleteCategory.args,
  storeIdFrom: storeIdFromCategory,
  handler: (ctx, args) => blogDefs.deleteCategory.handler(ctx, args),
})

// ============================================================================
// Admin Mutations — Tags
// ============================================================================

export const createTag = storeMutation({
  permission: "content:write",
  args: blogDefs.createTag.args,
  handler: (ctx, args) => blogDefs.createTag.handler(ctx, args),
})

/**
 * Remove a tag, and the joins that pointed at it (#524).
 *
 * The editor has created tags since it was written and nothing deleted one, so
 * every typo and every abandoned idea stayed in the picker for the life of the
 * establishment. `blogDefs.deleteTag` existed, join cleanup and all, and no app
 * wrapped it.
 *
 * `content:delete`, matching `deleteCategory`: removing a rubric and removing a
 * tag are the same act on the same screen.
 */
export const deleteTag = storeMutation({
  permission: "content:delete",
  args: blogDefs.deleteTag.args,
  storeIdFrom: storeIdFromTag,
  handler: (ctx, args) => blogDefs.deleteTag.handler(ctx, args),
})

// ============================================================================
// Internal Mutations (for scheduled publish)
// ============================================================================

/** Called by scheduler to publish a scheduled article */
export const _publishArticleInternal = internalMutation({
  args: { articleId: v.id("blogArticles") },
  handler: async (ctx, args) => {
    return publishArticleCore(ctx, args.articleId, "system")
  },
})
