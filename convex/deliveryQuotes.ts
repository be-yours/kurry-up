import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Delivery quote bookkeeping.
 *
 * Internal only: quotes are written by `uberDirect.getDeliveryQuote` and read
 * by `orders.create`. Nothing here is callable from a browser — the point of
 * the table is that the fee comes from the server, not from the client.
 */
export const internalRecord = internalMutation({
  args: {
    estimateId: v.string(),
    storeId: v.id("stores"),
    fee: v.number(),
    currency: v.string(),
    dropoffLatitude: v.number(),
    dropoffLongitude: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Uber can return the same estimate id twice; keep one row per quote.
    const existing = await ctx.db
      .query("deliveryQuotes")
      .withIndex("by_estimateId", (q) => q.eq("estimateId", args.estimateId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        fee: args.fee,
        currency: args.currency,
        expiresAt: args.expiresAt,
      });
      return existing._id;
    }

    return await ctx.db.insert("deliveryQuotes", {
      ...args,
      createdAt: Date.now(),
    });
  },
});
