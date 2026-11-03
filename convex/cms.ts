/**
 * CMS App Wrappers (Pages & Blocks)
 *
 * Auth-protected wrappers around package-level CMS functions.
 * No media mutations here — those are in cmsMedia.ts.
 */

// Initialize CMS registry with app-specific pages (must run before any handler)
import { setCmsRegistry } from "@be-yours/cms"
import { appCmsConfig } from "../cms"
setCmsRegistry(appCmsConfig)

import { v } from "convex/values"
import { query } from "./_generated/server"
import * as cmsDefs from "@be-yours/convex-functions/cms"
import { publishPageCore } from "@be-yours/convex-functions/cmsPublish"
import { saveDraftBlockCore } from "@be-yours/convex-functions/cms"
import { scheduleCmsTranslation, schedulePageTranslation } from "./cmsAutoTranslate"
import { storeQuery, storeMutation } from "./lib/storeFunctions";

// ============================================================================
// Queries
// ============================================================================

/**
 * Every CMS page of the establishment, with its editorial status.
 *
 * GUARDED SINCE #97. It was `query(cmsDefs.listPages)` under
 * `@public-by-design: published storefront page content, no auth by design`, and
 * that annotation was wrong about the payload: it returns
 * `hasUnpublishedChanges` and `draftUpdatedAt` per page, which is a list of what
 * the staff are working on. Its only caller is the admin's content screen, so
 * nothing anonymous loses a reader.
 */
export const listPages = storeQuery({
  permission: "content:read",
  args: cmsDefs.listPages.args,
  handler: (ctx, args) => cmsDefs.listPages.handler(ctx, args),
})

/**
 * Published blocks for the storefront.
 *
 * @public-by-design: the storefront has no session, and this is the published
 * page a visitor came to read. Its `pageMeta` was narrowed in #97 to
 * `hasPublished` and `publishedAt` — it used to carry `hasUnpublishedChanges`,
 * `draftUpdatedAt` and `updatedBy`, which is editorial state and a staff user id
 * handed to anybody who asked.
 */
export const getPageBlocks = query(cmsDefs.getPageBlocks)

/** Get draft + published blocks for admin editor (auth-protected) */
export const getAdminPageBlocks = storeQuery({
  permission: "content:read",
  args: cmsDefs.getAdminPageBlocks.args,
  handler: (ctx, args) => cmsDefs.getAdminPageBlocks.handler(ctx, args),
})

/** Get preview blocks: draft > published (auth-protected) */
export const getPreviewPageBlocks = storeQuery({
  permission: "content:read",
  args: cmsDefs.getPreviewPageBlocks.args,
  handler: (ctx, args) => cmsDefs.getPreviewPageBlocks.handler(ctx, args),
})

// ============================================================================
// Mutations
// ============================================================================

/** Save draft block — built via saveDraftBlockCore helper */
export const saveDraftBlock = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
    blockKey: v.string(),
    values: v.any(),
  },
  // Derive updatedBy from auth identity (stable subject ID)
  handler: (ctx, args, identity) =>
    saveDraftBlockCore(ctx, { ...args, updatedBy: identity.subject }, {
      onAfterSave: scheduleCmsTranslation,
    }),
})

/** Reset a single field to fallback */
export const resetField = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
    blockKey: v.string(),
    fieldKey: v.string(),
  },
  handler: (ctx, args, identity) =>
    cmsDefs.resetField.handler(ctx, { ...args, updatedBy: identity.subject }),
})

/** Reset an entire block */
export const resetBlock = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
    blockKey: v.string(),
  },
  handler: (ctx, args, identity) =>
    cmsDefs.resetBlock.handler(ctx, { ...args, updatedBy: identity.subject }),
})

/** Reset all blocks for a page */
export const resetPage = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  handler: (ctx, args, identity) =>
    cmsDefs.resetPage.handler(ctx, { ...args, updatedBy: identity.subject }),
})

/** Translate all text fields of a page at once */
export const translateAllPageFields = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  handler: async (ctx, args) => {
    // Check target languages exist
    const allLanguages = await ctx.db
      .query("languages")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .withIndex("by_storeId", (q: any) => q.eq("storeId", args.storeId))
      .collect()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasTargetLangs = allLanguages.some((l: any) => l.isActive && !l.isDefault)
    if (!hasTargetLangs) {
      throw new Error("Aucune langue cible active. Ajoutez des langues dans Paramètres > Langues.")
    }

    await schedulePageTranslation(ctx, args.storeId, args.pageSlug)
  },
})

/** Publish all draft blocks for a page */
export const publishPage = storeMutation({
  permission: "content:write",
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  // Derive updatedBy from auth identity (stable subject ID)
  handler: (ctx, args, identity) =>
    publishPageCore(ctx, { ...args, updatedBy: identity.subject }, {
      onAfterPublish: scheduleCmsTranslation,
    }),
})
