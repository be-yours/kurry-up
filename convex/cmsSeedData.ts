/**
 * CMS Seed Data — Internal mutations for seeding CMS content.
 *
 * Called by cmsSeed.ts (internalAction) to create media records,
 * save draft blocks, and publish pages.
 */

// Initialize CMS registry
import { setCmsRegistry } from "@be-yours/cms"
import { appCmsConfig } from "../cms"
setCmsRegistry(appCmsConfig)

import { internalMutation, internalQuery } from "./_generated/server"
import { v } from "convex/values"
import { saveDraftBlockCore } from "@be-yours/convex-functions/cms"
import { publishPageCore } from "@be-yours/convex-functions/cmsPublish"
import { scheduleCmsTranslation } from "./cmsAutoTranslate"

// ── Query: get first store ───────────────────────────────────────────

export const getFirstStore = internalQuery({
  args: {},
  handler: async (ctx) => {
    const stores = await ctx.db.query("stores").take(1)
    return stores[0] ?? null
  },
})

// ── Mutation: create a cmsMedia record ───────────────────────────────

export const createMediaRecord = internalMutation({
  args: {
    storeId: v.id("stores"),
    filename: v.string(),
    mimeType: v.string(),
    size: v.number(),
    s3Key: v.string(),
    sourceUrl: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("cmsMedia", {
      storeId: args.storeId,
      kind: "image",
      status: "ready",
      filename: args.filename,
      mimeType: args.mimeType,
      size: args.size,
      s3Key: args.s3Key,
      sourceUrl: args.sourceUrl,
      url: args.sourceUrl,
      width: args.width,
      height: args.height,
      folder: "cms",
      usageCount: 0,
      uploadedBy: "system-seed",
      uploadedAt: Date.now(),
    })
  },
})

// ── Mutation: seed and publish one page ──────────────────────────────

export const seedAndPublishPage = internalMutation({
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
    blocks: v.any(), // Record<blockKey, Record<fieldKey, CmsFieldValue>>
  },
  handler: async (ctx, args) => {
    const blocks = args.blocks as Record<string, Record<string, unknown>>

    // Save draft for each block
    for (const [blockKey, values] of Object.entries(blocks)) {
      await saveDraftBlockCore(ctx, {
        storeId: args.storeId,
        pageSlug: args.pageSlug,
        blockKey,
        values,
        updatedBy: "system-seed",
      })
    }

    // Publish the page (creates published blocks, deletes drafts,
    // and schedules translations for blocks without them)
    const result = await publishPageCore(
      ctx,
      {
        storeId: args.storeId,
        pageSlug: args.pageSlug,
        updatedBy: "system-seed",
      },
      {
        onAfterPublish: scheduleCmsTranslation,
      },
    )

    return result
  },
})
