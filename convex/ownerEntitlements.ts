/**
 * Owner Entitlements App Wrappers
 *
 * Auth-protected wrappers around package-level entitlements functions.
 * All queries and mutations require authentication.
 */

import { query, internalQuery, internalMutation } from "./_generated/server"
import * as ownerEntitlementsDefs from "@be-yours/convex-functions/ownerEntitlements"

// ============================================================================
// Queries
// ============================================================================

/** Get entitlements for the authenticated owner */
// @guarded-inline: derives the owner from the session; takes no id
export const getMyEntitlements = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    return ownerEntitlementsDefs.getByOwnerId.handler(ctx, {
      ownerId: identity.subject,
    })
  },
})

/** Get entitlements by ownerId (admin use) */
/**
 * Internal only.
 *
 * This was a public query taking an arbitrary `ownerId` behind an auth-only
 * guard, so any account could read anyone's plan and subscription state. Its
 * only consumer is server-side (`bidSubscriptionInternal`); the admin UI reads
 * `getMyEntitlements`.
 */
export const internalGetByOwnerId = internalQuery(
  ownerEntitlementsDefs.getByOwnerId
)

// ============================================================================
// Mutations
// ============================================================================

/** Written by the Stripe BeYours webhook, which has no user session. */
export const internalUpsert = internalMutation(ownerEntitlementsDefs.upsert)
