import { mutation, internalMutation, internalQuery } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/paymentConnections";
import { v } from "convex/values";
import { authedQuery } from "./lib/storeFunctions";
import {
  getAuthUser,
  requireRolePermission,
} from "@be-yours/convex-functions/auth";

/**
 * Payment connections are deployment-level, not store-level, so the store-scoped
 * seam does not apply — authorisation is a permission check here.
 *
 * These were bare public queries. The encrypted tokens are stripped by the defs
 * layer, but the merchant id, the provider and the connection state were
 * readable by anyone.
 *
 * BOTH GATES (#649). This checked `hasPermission` and stopped, which skipped the
 * module narrowing an owner applies in the invite dialog — and this export is the
 * one that measured the cost: `payments` maps to the `integrations` module, so a
 * `manager` invited with `["settings"]` and not `["integrations"]` was shown
 * « Paramètres » by a sidebar that DOES narrow, and then handed every payment
 * connection by a guard that did not. `requireRolePermission` runs the pair.
 */
async function requirePaymentsRead(ctx: Parameters<typeof getAuthUser>[0]) {
  await requireRolePermission(ctx, "payments:read");
}

// === Queries ===

/** Internal: get full record WITH encrypted tokens — for payment actions only */
export const internalGetByProvider = internalQuery({
  args: {
    provider: v.union(v.literal("stripe"), v.literal("sumup"), v.literal("paypal")),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("paymentConnections")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider))
      .first();
  },
});

/** Get all connections (tokens stripped). */
// @guarded-inline: deployment-level, guarded by payments:read in the handler
export const getAll = authedQuery({
  args: defs.getAll.args,
  handler: async (ctx) => {
    await requirePaymentsRead(ctx);
    return defs.getAll.handler(ctx);
  },
});

// === Mutations ===

/**
 * Internal upsert called exclusively from the OAuth callback action.
 * Not callable from the client.
 */
export const upsert = internalMutation({
  args: defs.upsert.args,
  handler: async (ctx, args) => {
    return defs.upsert.handler(ctx, args);
  },
});

/**
 * Disconnect (delete) a payment connection.
 * Requires an authenticated session.
 */
// @guarded-inline: deployment-level, so the store seam does not apply — but
// auth alone let any account sever the restaurant's payment provider.
export const disconnect = mutation({
  args: defs.disconnect.args,
  handler: async (ctx, args) => {
    await requireRolePermission(ctx, "settings:write");
    return defs.disconnect.handler(ctx, args);
  },
});
