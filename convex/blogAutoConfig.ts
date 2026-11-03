/**
 * Blog Auto Config App Wrappers
 *
 * Auth-protected wrappers with entitlement checks.
 * The upsert mutation validates plan limits before saving.
 */

import { v } from "convex/values"
import { query, mutation } from "./_generated/server"
import { storeQuery } from "./lib/storeFunctions"
import { requireStorePermission } from "@be-yours/convex-functions/auth"
import * as blogAutoConfigDefs from "@be-yours/convex-functions/blogAutoConfig"
import {
  checkAutoBlogAccess,
  checkImageGenerationAccess,
  validateConfigAgainstPlan,
} from "@be-yours/convex-functions/blogAutoGuards"

// ============================================================================
// Queries
// ============================================================================

/** Get auto blog config for a store */
export const getByStoreId = storeQuery({
  permission: "content:read",
  args: blogAutoConfigDefs.getByStoreId.args,
  handler: (ctx, args) => blogAutoConfigDefs.getByStoreId.handler(ctx, args),
})

// @guarded-inline: derives the owner from the session; takes no id
/** Get auto-blog access status for the authenticated owner */
export const getAccessStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    return checkAutoBlogAccess(ctx, identity.subject)
  },
})

// @guarded-inline: derives the owner from the session; takes no id
/** Get image generation access status for the authenticated owner */
export const getImageAccessStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    return checkImageGenerationAccess(ctx, identity.subject)
  },
})

// ============================================================================
// Mutations
// ============================================================================

// @guarded-inline: store permission checked below, then plan entitlements
/** Upsert auto blog config with entitlement checks */
export const upsert = mutation({
  args: {
    storeId: v.id("stores"),
    isEnabled: v.boolean(),
    themes: v.array(v.string()),
    frequency: v.union(v.literal("weekly"), v.literal("monthly")),
    preferredWeekdays: v.optional(v.array(v.number())),
    preferredMonthDays: v.optional(v.array(v.number())),
    preferredHour: v.number(),
    timezone: v.string(),
    tone: v.union(
      v.literal("formel"),
      v.literal("decontracte"),
      v.literal("storytelling")
    ),
    primaryLocale: v.string(),
    autoTranslate: v.boolean(),
    approvalMode: v.union(
      v.literal("draft_review"),
      v.literal("auto_publish")
    ),
    categoryId: v.optional(v.id("blogCategories")),
    targetStoreIds: v.optional(v.array(v.id("stores"))),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // The entitlement check below asks "does THIS owner have an autoBlog plan",
    // which says nothing about the store being configured. Without this, an
    // owner with a plan could switch on auto-publishing for someone else's
    // restaurant — and `targetStoreIds` could aim it at several.
    await requireStorePermission(ctx, args.storeId, "content:write")
    for (const targetStoreId of args.targetStoreIds ?? []) {
      await requireStorePermission(ctx, targetStoreId, "content:write")
    }

    // Check entitlements
    const access = await checkAutoBlogAccess(ctx, identity.subject)
    if (!access.allowed) {
      throw new Error(access.reason ?? "Accès refusé")
    }

    // Validate plan-specific limits
    validateConfigAgainstPlan(access.entitlements, {
      themes: args.themes,
      approvalMode: args.approvalMode,
      autoTranslate: args.autoTranslate,
      frequency: args.frequency,
      preferredWeekdays: args.preferredWeekdays,
      preferredMonthDays: args.preferredMonthDays,
      preferredHour: args.preferredHour,
      timezone: args.timezone,
    })

    return blogAutoConfigDefs.upsert.handler(ctx, {
      ...args,
      ownerId: identity.subject,
    })
  },
})
