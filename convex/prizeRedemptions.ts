import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/gamePlay";
import { requireStoreAccess } from "@be-yours/convex-functions/auth";
import { storeQuery, storeMutation } from "./lib/storeFunctions";

/** Staff/admin side of the prize redemption flow. */

export const listRedemptions = storeQuery({
  permission: "games:read",
  args: defs.listRedemptions.args,
  handler: (ctx, args) => defs.listRedemptions.handler(ctx, args),
});

export const listPlays = storeQuery({
  permission: "games:read",
  args: defs.listPlays.args,
  handler: (ctx, args) => defs.listPlays.handler(ctx, args),
});

export const getStats = storeQuery({
  permission: "games:read",
  args: defs.getStats.args,
  handler: (ctx, args) => defs.getStats.handler(ctx, args),
});

async function storeIdFromRedemptionCode(
  ctx: QueryCtx,
  args: { code: string }
) {
  const redemption = await ctx.db
    .query("prizeRedemptions")
    .withIndex("by_redemptionCode", (q) => q.eq("redemptionCode", args.code))
    .first();
  if (!redemption) throw new Error("REDEMPTION_NOT_FOUND");
  return redemption.storeId;
}

/**
 * True when the current viewer is staff of the store owning this redemption.
 * Drives the "Valider" button on the public ticket page — never throws.
 */
// @guarded-inline: resolves the store from the code, then checks access; returns false on refusal
export const canRedeem = query({
  args: defs.getRedemptionByCode.args,
  handler: async (ctx, args) => {
    try {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) return false;
      const storeId = await storeIdFromRedemptionCode(ctx, args);
      await requireStoreAccess(ctx, storeId);
      return true;
    } catch {
      return false;
    }
  },
});

/** Mark a redemption as used, stamped with the staff member's identity. */
export const redeemByCode = storeMutation({
  permission: "games:write",
  args: defs.redeemByCode.args,
  storeIdFrom: storeIdFromRedemptionCode,
  handler: (ctx, args, identity) =>
    defs.redeemByCode.handler(ctx, {
      code: args.code,
      redeemedBy: identity.email ?? identity.subject,
    }),
});
