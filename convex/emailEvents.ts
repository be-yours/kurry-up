import { internalMutation, internalQuery } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/emailEvents";
import { storeQuery, storeIdFromField } from "./lib/storeFunctions";

// === Queries (auth-protected) ===

// Opens, clicks and bounces of a campaign — auth-only meant any account could
// read another restaurant's engagement history.
// @kept-callerless: read by `apps/reference/scripts/verify-campaign-send.mjs`,
// which checks that a resumed campaign does not re-send to an address already
// recorded here. No screen calls it; it stays public because the twins' convex
// trees are identical and the bench's script needs it (#413).
export const listByCampaign = storeQuery({
  permission: "marketing:read",
  args: defs.listByCampaign.args,
  storeIdFrom: storeIdFromField("campaignId", "Campaign not found"),
  handler: (ctx, args) => defs.listByCampaign.handler(ctx, args),
});

export const listBySubscriber = storeQuery({
  permission: "marketing:read",
  args: defs.listBySubscriber.args,
  storeIdFrom: storeIdFromField("subscriberId", "Subscriber not found"),
  handler: (ctx, args) => defs.listBySubscriber.handler(ctx, args),
});

// === Internal mutations (called by SES webhook HTTP action only) ===

export const alreadySentTo = internalQuery(defs.alreadySentTo);
export const sentCountsSince = internalQuery(defs.sentCountsSince);
export const create = internalMutation(defs.create);
export const createBatch = internalMutation(defs.createBatch);
