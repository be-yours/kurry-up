/**
 * Blog Image Generate — Internal Functions
 *
 * internalQuery + internalMutation for the standalone image generation flow.
 * NO "use node" — these run in the default Convex runtime.
 * Called by the action in blogImageGenerate.ts ("use node").
 */

import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import {
  releaseImageQuota,
  reserveImageQuota,
} from "@be-yours/convex-functions/blogAutoGuards"
import { requireStorePermission } from "@be-yours/convex-functions/auth"

// ============================================================================
// Internal Mutations
// ============================================================================

/**
 * Authorise the establishment, then take one image out of this month's quota.
 *
 * Two faults in one: the old check took an `ownerId` and no store, so anyone
 * with a plan could generate into any restaurant in the deployment; and the
 * counter moved only after S3 had accepted the upload, so concurrent requests
 * all read the same count and all passed. Reading and writing in one mutation
 * is what makes the cap hold.
 */
export const _reserveImageQuota = internalMutation({
  args: { storeId: v.id("stores") },
  handler: async (ctx, { storeId }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    await requireStorePermission(ctx, storeId, "content:write")

    return reserveImageQuota(ctx, identity.subject)
  },
})

/** Hand the image slot back when the generation produced nothing. */
export const _releaseImageQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    await releaseImageQuota(ctx, ownerId)
  },
})
