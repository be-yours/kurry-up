/**
 * CMS Media App Wrappers
 *
 * All media queries/mutations in one file.
 * setMediaReady/setMediaFailed exposed as internalMutation only.
 * _getMediaInternal exposed as internalQuery for actions (confirmUpload, getPresignedUrlForMedia).
 *
 * NOTE: No "use node" here — actions live in separate files (cmsMediaConfirmUpload.ts, cmsMediaProcess.ts).
 */

import { internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import {
  storeQuery,
  storeMutation,
} from "./lib/storeFunctions";
import { v } from "convex/values"
import * as mediaDefs from "@be-yours/convex-functions/cmsMedia"

// ============================================================================
// Queries
// ============================================================================

// The media library is per-restaurant. These were auth-only with a client
// `storeId`, so any account could browse — and delete — another restaurant's
// assets.
export const listMedia = storeQuery({
  permission: "content:read",
  args: mediaDefs.listMedia.args,
  handler: (ctx, args) => mediaDefs.listMedia.handler(ctx, args),
})

// ============================================================================
// Mutations (auth-protected)
// ============================================================================

/** Reserve a media record before upload (status=processing) */
export const createMedia = storeMutation({
  permission: "content:write",
  args: mediaDefs.createMedia.args,
  handler: (ctx, args) => mediaDefs.createMedia.handler(ctx, args),
})

/**
 * Delete a media item (blocked if referenced), and the S3 objects with it.
 *
 * The package handler owns the reference checks and hands back the keys the row
 * held; the purge is scheduled here because only the app has `internal.*` refs.
 * Nothing is scheduled when the handler throws, so a media that is still
 * referenced keeps both its row and its files.
 */
export const deleteMedia = storeMutation({
  permission: "content:delete",
  args: mediaDefs.deleteMedia.args,
  handler: async (ctx, args) => {
    const result = await mediaDefs.deleteMedia.handler(ctx, args)

    if (result.s3Keys.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.cmsMediaDelete.purgeS3Objects,
        { s3Keys: result.s3Keys },
      )
    }

    return { deleted: result.deleted }
  },
})

// ============================================================================
// Internal Mutations (called by upload pipeline only, not from UI)
// ============================================================================

/** Mark media as ready after processing */
export const setMediaReady = internalMutation(mediaDefs.setMediaReady)

/** Mark media as failed after processing error */
export const setMediaFailed = internalMutation(mediaDefs.setMediaFailed)

// ============================================================================
// Internal Queries (called by actions: confirmUpload, getPresignedUrlForMedia)
// ============================================================================

/** Read a media record without auth (for internal pipeline use) */
export const _getMediaInternal = internalQuery({
  args: { mediaId: v.id("cmsMedia") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.mediaId)
  },
})
