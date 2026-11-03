/**
 * Temporary seed mutations for development/testing.
 * DELETE THIS FILE before production deployment.
 */

import { v } from "convex/values"
import { internalMutation } from "./_generated/server"

const PRESETS: Record<
  string,
  {
    monthlyQuota: number
    maxTopics?: number
    monthlyImageQuota: number
    allowMultiLanguage: boolean
    allowAutoPublish: boolean
  }
> = {
  starter: {
    monthlyQuota: 2,
    maxTopics: 3,
    monthlyImageQuota: 5,
    allowMultiLanguage: false,
    allowAutoPublish: false,
  },
  pro: {
    monthlyQuota: 8,
    monthlyImageQuota: 20,
    allowMultiLanguage: false,
    allowAutoPublish: true,
  },
  enterprise: {
    monthlyQuota: 30,
    monthlyImageQuota: 100,
    allowMultiLanguage: true,
    allowAutoPublish: true,
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertEntitlements(ctx: any, ownerId: string, plan: string) {
  const preset = PRESETS[plan]!
  const now = Date.now()

  const autoBlog = {
    enabled: true,
    plan: plan as "starter" | "pro" | "enterprise",
    monthlyQuota: preset.monthlyQuota,
    maxTopics: preset.maxTopics,
    monthlyImageQuota: preset.monthlyImageQuota,
    allowMultiLanguage: preset.allowMultiLanguage,
    allowAutoPublish: preset.allowAutoPublish,
  }

  const existing = await ctx.db
    .query("ownerEntitlements")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex("by_ownerId", (q: any) => q.eq("ownerId", ownerId))
    .first()

  if (existing) {
    await ctx.db.patch(existing._id, {
      autoBlog,
      subscriptionStatus: "active",
      updatedAt: now,
    })
    return existing._id
  }

  return await ctx.db.insert("ownerEntitlements", {
    ownerId,
    autoBlog,
    subscriptionStatus: "active",
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * Seed entitlements for the currently authenticated user.
 * Call from the app (e.g. a temp button or browser console).
 */
export const seedMyEntitlements = internalMutation({
  args: {
    plan: v.union(
      v.literal("starter"),
      v.literal("pro"),
      v.literal("enterprise")
    ),
  },
  handler: async (ctx, { plan }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    return upsertEntitlements(ctx, identity.subject, plan)
  },
})

/**
 * Seed entitlements with explicit ownerId (for CLI usage).
 */
export const seedEntitlements = internalMutation({
  args: {
    ownerId: v.string(),
    plan: v.union(
      v.literal("starter"),
      v.literal("pro"),
      v.literal("enterprise")
    ),
  },
  handler: async (ctx, { ownerId, plan }) => {
    return upsertEntitlements(ctx, ownerId, plan)
  },
})

/** Backfill monthlyImageQuota for all existing entitlements that are missing it */
export const backfillImageQuota = internalMutation({
  args: {},
  handler: async (ctx) => {
    const IMAGE_QUOTAS: Record<string, number> = {
      starter: 5,
      pro: 20,
      enterprise: 100,
    }

    const all = await ctx.db.query("ownerEntitlements").collect()
    let updated = 0

    for (const ent of all) {
      if (ent.autoBlog?.plan && ent.autoBlog.monthlyImageQuota === undefined) {
        const quota = IMAGE_QUOTAS[ent.autoBlog.plan] ?? 0
        await ctx.db.patch(ent._id, {
          autoBlog: {
            ...ent.autoBlog,
            monthlyImageQuota: quota,
          },
          updatedAt: Date.now(),
        })
        updated++
      }
    }

    return { updated, total: all.length }
  },
})
