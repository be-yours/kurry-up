/**
 * Maintenance App Wrappers
 *
 * Auth-protected wrappers around package-level maintenance functions.
 *
 * - The client (CLIENT_ADMIN) sees the state of their maintenance
 *   contract, which updates they are entitled to, and can request the
 *   migration of their whole site to the host/team of their choice.
 * - The BeYours team (SUPER_ADMIN or internal mutations) manages the
 *   contract and drives migration request fulfilment.
 */

import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import {
  getAuthUser,
  requireRolePermission,
} from "@be-yours/convex-functions/auth"
import * as maintenanceDefs from "@be-yours/convex-functions/maintenance"
import {
  hasPermission,
  Role,
  type Permission,
} from "@be-yours/core/auth/rbac"

const PERM_SYSTEM_READ = "system:read" as Permission

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function requireSystemRead(ctx: QueryCtx | MutationCtx) {
  /* Role AND module (#649): `system` maps to the `settings` module. The two
     roles that hold `system:read` are module-exempt today, so this narrows
     nobody yet — it is here so the next role added is gated by default. */
  return await requireRolePermission(ctx, PERM_SYSTEM_READ)
}

/** Contract-level actions are reserved for the account owner (or BID) */
async function requireAccountOwner(ctx: QueryCtx | MutationCtx) {
  const user = await getAuthUser(ctx)
  if (user.role !== Role.CLIENT_ADMIN && user.role !== Role.SUPER_ADMIN) {
    throw new Error(
      "Action réservée au propriétaire du compte (client_admin)",
    )
  }
  return user
}

async function requireSuperAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await getAuthUser(ctx)
  if (user.role !== Role.SUPER_ADMIN) {
    throw new Error("Action réservée à l'équipe BeYours (super_admin)")
  }
  return user
}

// ─── Queries ────────────────────────────────────────────────────────────────────

/**
 * Everything the "Maintenance" screen needs in one query:
 * contract, derived status, update entitlement, release catalog with
 * covered/locked flags, and the open migration request if any.
 */
// @guarded-inline: account owner or super admin checked in the handler
export const getOverview = query({
  args: { currentVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireSystemRead(ctx)

    const nowMs = Date.now()
    const contract = await maintenanceDefs.getContract.handler(ctx)
    const releases = await maintenanceDefs.listReleases.handler(ctx, {
      limit: 100,
    })
    const openMigrationRequest =
      await maintenanceDefs.getOpenMigrationRequest.handler(ctx)

    const settings = await ctx.db.query("globalSettings").first()
    const currentVersion =
      args.currentVersion ?? settings?.deployedAppVersion ?? "0.0.0"

    const entitlement = maintenanceDefs.resolveUpdateEntitlement({
      releases,
      contract,
      currentVersion,
      nowMs,
    })

    return {
      contract,
      status: entitlement.maintenanceStatus,
      daysRemaining: maintenanceDefs.daysRemaining(contract, nowMs),
      currentVersion,
      entitlement,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      releases: releases.map((release: any) => ({
        _id: release._id,
        version: release.version,
        releasedAt: release.releasedAt,
        notes: release.notes ?? null,
        covered: maintenanceDefs.isReleaseCovered(release.releasedAt, contract),
      })),
      openMigrationRequest,
    }
  },
})

// ─── Mutations (client side) ────────────────────────────────────────────────────

/**
 * Request the migration of the whole site to another host/team.
 * Available at any time, highlighted once maintenance has expired.
 */
// @guarded-inline: account owner or super admin checked in the handler
export const requestMigration = mutation({
  args: {
    contactEmail: v.string(),
    contactPhone: v.optional(v.string()),
    targetProvider: v.string(),
    targetTeam: v.optional(v.string()),
    targetTeamEmail: v.optional(v.string()),
    scope: v.array(maintenanceDefs.migrationScopeValidator),
    preferredDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAccountOwner(ctx)

    const requestId = await maintenanceDefs.createMigrationRequest.handler(
      ctx,
      { ...args, requestedBy: user.userId },
    )

    await ctx.db.insert("systemAuditLog", {
      action: "migration_request_created",
      performedBy: user.userId,
      performedAt: Date.now(),
      result: "success",
      details: JSON.stringify({
        targetProvider: args.targetProvider,
        scope: args.scope,
      }),
    })

    // Notify BeYours + confirm to the client (best effort, async)
    await ctx.scheduler.runAfter(
      0,
      internal.maintenanceEmail.notifyMigrationRequest,
      {
        requestId,
        requestedBy: user.userId,
        contactEmail: args.contactEmail,
        contactPhone: args.contactPhone,
        targetProvider: args.targetProvider,
        targetTeam: args.targetTeam,
        targetTeamEmail: args.targetTeamEmail,
        scope: args.scope,
        preferredDate: args.preferredDate,
        notes: args.notes,
      },
    )

    return requestId
  },
})

/** Cancel an open migration request (client side) */
// @guarded-inline: account owner or super admin checked in the handler
export const cancelMigrationRequest = mutation({
  args: {
    requestId: v.id("migrationRequests"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAccountOwner(ctx)

    await maintenanceDefs.updateMigrationRequestStatus.handler(ctx, {
      requestId: args.requestId,
      status: "cancelled",
      changedBy: user.userId,
      note: args.note,
    })

    await ctx.db.insert("systemAuditLog", {
      action: "migration_request_status_changed",
      performedBy: user.userId,
      performedAt: Date.now(),
      result: "success",
      details: JSON.stringify({ requestId: args.requestId, status: "cancelled" }),
    })

    return args.requestId
  },
})

// ─── Mutations (BeYours side) ───────────────────────────────────────────────

// ─── Internal (BID ops / actions) ───────────────────────────────────────────────

/** Contract + releases in one read — used by system.checkForUpdates */
export const _getUpdateGatingData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const contract = await maintenanceDefs.getContract.handler(ctx)
    const releases = await maintenanceDefs.listReleases.handler(ctx, {
      limit: 100,
    })
    return { contract, releases }
  },
})

/** Sync the release catalog (idempotent by version) */
export const _upsertReleases = internalMutation({
  args: maintenanceDefs.upsertReleases.args,
  handler: async (ctx, args) => {
    return maintenanceDefs.upsertReleases.handler(ctx, args)
  },
})

/**
 * Apply a Stripe subscription event to the maintenance contract.
 * Called by bidSubscription.processWebhookEvent when the subscription is
 * the maintenance product. Coverage only ever extends; a cancellation
 * (periodEndMs undefined, autoRenew false) keeps the paid coverage.
 */
export const _applyStripeRenewal = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    periodEndMs: v.optional(v.number()),
    autoRenew: v.boolean(),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now()
    const existing = await maintenanceDefs.getContract.handler(ctx)

    // Nothing to cancel and nothing to create coverage from
    if (!existing && args.periodEndMs === undefined) return null

    const patch = maintenanceDefs.buildRenewalPatch({
      existingCoveredUntil: existing?.coveredUntil ?? null,
      periodEndMs: args.periodEndMs ?? null,
      autoRenew: args.autoRenew,
      nowMs: timestamp,
    })

    let contractId
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...patch,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        updatedBy: "stripe",
        updatedAt: timestamp,
      })
      contractId = existing._id
    } else {
      // First maintenance purchase through Stripe — coverage starts now
      contractId = await ctx.db.insert("maintenanceContracts", {
        startedAt: timestamp,
        coveredUntil: patch.coveredUntil ?? timestamp,
        autoRenew: patch.autoRenew,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        updatedBy: "stripe",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }

    await ctx.db.insert("systemAuditLog", {
      action: "maintenance_contract_set",
      performedBy: "stripe",
      performedAt: timestamp,
      result: "success",
      details: JSON.stringify({
        stripeSubscriptionId: args.stripeSubscriptionId,
        coveredUntil: patch.coveredUntil ?? existing?.coveredUntil ?? null,
        autoRenew: patch.autoRenew,
      }),
    })

    return contractId
  },
})

/**
 * Provision the contract without auth — run by the BeYours team from
 * the Convex dashboard/CLI (e.g. at go-live: startedAt = now,
 * coveredUntil = now + 1 year).
 */
export const _setContract = internalMutation({
  args: maintenanceDefs.upsertContract.args,
  handler: async (ctx, args) => {
    const contractId = await maintenanceDefs.upsertContract.handler(ctx, {
      ...args,
      updatedBy: args.updatedBy ?? "beindigital",
    })

    await ctx.db.insert("systemAuditLog", {
      action: "maintenance_contract_set",
      performedBy: args.updatedBy ?? "beindigital",
      performedAt: Date.now(),
      result: "success",
      details: JSON.stringify({
        startedAt: args.startedAt,
        coveredUntil: args.coveredUntil,
        autoRenew: args.autoRenew,
      }),
    })

    return contractId
  },
})

// @kept-callerless: no screen calls this. It is the read half of the migration
// flow `apps/docs/guides/maintenance-and-migration.md` documents: `requestMigration`
// is live and files a request, and without this nothing can see what was filed.
// Removing it left a request that could be made and never read (#413).
// @guarded-inline: account owner or super admin checked in the handler
export const listMigrationRequests = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSystemRead(ctx)
    return maintenanceDefs.listMigrationRequests.handler(ctx, args)
  },
})

// @kept-callerless: no screen calls this. `apps/docs/guides/maintenance-and-migration.md:88`
// names it as the way a super_admin moves a migration request through
// acknowledged → in_progress → completed (#413).
// @guarded-inline: account owner or super admin checked in the handler
export const updateMigrationRequestStatus = mutation({
  args: {
    requestId: v.id("migrationRequests"),
    status: maintenanceDefs.migrationRequestStatusValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireSuperAdmin(ctx)

    await maintenanceDefs.updateMigrationRequestStatus.handler(ctx, {
      requestId: args.requestId,
      status: args.status,
      changedBy: user.userId,
      note: args.note,
    })

    await ctx.db.insert("systemAuditLog", {
      action: "migration_request_status_changed",
      performedBy: user.userId,
      performedAt: Date.now(),
      result: "success",
      details: JSON.stringify({ requestId: args.requestId, status: args.status }),
    })

    return args.requestId
  },
})

// @kept-callerless: no screen calls this. `apps/docs/guides/maintenance-and-migration.md:84`
// names it as the super_admin path for setting and renewing a maintenance
// contract, alongside the Stripe one (#413).
// @guarded-inline: account owner or super admin checked in the handler
export const setContract = mutation({
  args: {
    startedAt: v.number(),
    coveredUntil: v.number(),
    autoRenew: v.boolean(),
    lastRenewedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireSuperAdmin(ctx)

    const contractId = await maintenanceDefs.upsertContract.handler(ctx, {
      ...args,
      updatedBy: user.userId,
    })

    await ctx.db.insert("systemAuditLog", {
      action: "maintenance_contract_set",
      performedBy: user.userId,
      performedAt: Date.now(),
      result: "success",
      details: JSON.stringify({
        startedAt: args.startedAt,
        coveredUntil: args.coveredUntil,
        autoRenew: args.autoRenew,
      }),
    })

    return contractId
  },
})
