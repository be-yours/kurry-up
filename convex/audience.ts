import { mutation, internalMutation } from "./_generated/server";
import { storeQuery } from "./lib/storeFunctions";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/audience";

/**
 * Audience measurement. Thin wrappers, as everything in this directory is —
 * the rules live in `@be-yours/convex-functions/audience` and the allow-list in
 * `audienceIngest`.
 */

// === Public ===

/**
 * Record what a storefront visitor just did.
 *
 * Public because a diner reading a menu has no session, and bounded like every
 * other public-by-design mutation here: `audienceBatchPerStore`, one unit per
 * call. The body carries no identifier of any kind — no IP address, no user
 * agent, no fingerprint, no cookie — which is what keeps this feature outside
 * the consent rules and outside the erasure path.
 */
// @public-by-design: the storefront has no session; bounded by audienceBatchPerStore
export const record = mutation({
  args: defs.record.args,
  handler: (ctx, args) => defs.record.handler(ctx, args),
});

// === Admin ===

/**
 * Everything « Fréquentation » draws.
 *
 * `analytics:read`, the same gate as `orders.dashboardStats`: `kitchen`,
 * `waiter` and `delivery` hold `orders:read` and not this one, and the whole of
 * this screen is the establishment's figures.
 */
export const summary = storeQuery({
  permission: "analytics:read",
  args: defs.summary.args,
  handler: (ctx, args) => defs.summary.handler(ctx, args),
});

// === Internal (crons) ===

/**
 * Fold the raw hits into daily counters and delete what was folded.
 *
 * Reschedules itself while there is more, a minute apart, so a backlog drains
 * without monopolising the backend during service — the same shape as
 * `kitchenTickets.purgeExpiredTickets`.
 */
export const rollupPending = internalMutation({
  args: defs.rollupPending.args,
  handler: async (ctx, args) => {
    const result = await defs.rollupPending.handler(ctx, args);

    if (result.hasMore) {
      await ctx.scheduler.runAfter(60_000, internal.audience.rollupPending, args);
    }

    return result;
  },
});

/**
 * Carry away the audience data that has outlived its window — both tables.
 *
 * The raw hits at 48 hours, which is the floor under a rollup that died
 * halfway; the counters at whatever `globalSettings.dataRetention.audienceDays`
 * says, defaulting to the CNIL's 25-month ceiling. Paused by the same switch as
 * the diner-data purge, and reports what it would have done.
 */
export const sweepExpiredAudience = internalMutation({
  args: defs.sweepExpiredAudience.args,
  handler: async (ctx, args) => {
    const result = await defs.sweepExpiredAudience.handler(ctx, args);

    if (result.hasMore) {
      await ctx.scheduler.runAfter(60_000, internal.audience.sweepExpiredAudience, args);
    }

    return result;
  },
});
