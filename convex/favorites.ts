import { query, mutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/favorites";

// === Queries (authenticated) ===

/**
 * List all favorites for the authenticated user
 */
// @guarded-inline: derives the user from the session; never takes a userId
export const myFavorites = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    return defs.listByUser.handler(ctx, { userId: identity.subject });
  },
});

// === Mutations (authenticated) ===

/**
 * Toggle a product favorite for the authenticated user
 */
// @guarded-inline: derives the user from the session; never takes a userId
export const toggleFavorite = mutation({
  args: {
    productId: defs.toggle.args.productId,
    storeId: defs.toggle.args.storeId,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return defs.toggle.handler(ctx, {
      userId: identity.subject,
      ...args,
    });
  },
});
