/**
 * BeYours Subscription Internal Functions (App Layer)
 *
 * NO "use node" — contains internalQuery and internalMutation only.
 * Called by the "use node" actions in bidSubscription.ts.
 */

import { internalQuery, internalMutation } from "./_generated/server";
import * as bidSubscriptionDefs from "@be-yours/convex-functions/bidSubscription";
import * as ownerEntitlementsDefs from "@be-yours/convex-functions/ownerEntitlements";

// ============================================================================
// Internal Queries
// ============================================================================

/** Read entitlements by ownerId — no auth, used by createCheckoutSession/createPortalSession */
export const getByOwnerId = internalQuery({
  args: ownerEntitlementsDefs.getByOwnerId.args,
  handler: async (ctx, args) => {
    return ownerEntitlementsDefs.getByOwnerId.handler(ctx, args);
  },
});

// ============================================================================
// Internal Mutations
// ============================================================================

/** Attach stripeCustomerId immediately after Stripe customer creation */
export const attachStripeCustomerId = internalMutation({
  args: bidSubscriptionDefs.attachStripeCustomerId.args,
  handler: async (ctx, args) => {
    return bidSubscriptionDefs.attachStripeCustomerId.handler(ctx, args);
  },
});

/** Full upsert from a Stripe event (checkout, subscription.updated, deleted) */
export const upsertFromStripe = internalMutation({
  args: bidSubscriptionDefs.upsertFromStripe.args,
  handler: async (ctx, args) => {
    return bidSubscriptionDefs.upsertFromStripe.handler(ctx, args);
  },
});
