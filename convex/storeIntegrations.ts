import { internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import * as defs from "@be-yours/convex-functions/storeIntegrations";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// Internal (no-auth) variant for webhook handlers, which run without a user identity.
export const internalListByPlatformEnabled = internalQuery({
  args: defs.listByPlatformEnabled.args,
  handler: async (ctx, args) => defs.listByPlatformEnabled.handler(ctx, args),
});

// Same, for the scheduled menu sync. `getByStorePlatform` below is store-scoped
// and needs a session; the scheduler has none, so the nightly push died on it.
export const internalGetByStorePlatform = internalQuery({
  args: defs.getByStorePlatform.args,
  handler: async (ctx, args) => defs.getByStorePlatform.handler(ctx, args),
});

// === Queries (auth-protected where applicable) ===

// @public-by-design: a diner needs to know whether this restaurant is also on
// Uber Eats or Deliveroo, and the answer is two strings the owner typed. The
// platform ids, the sync status and everything else on the row stay behind
// `settings:read` in `listByStore` below.
export const publicLinks = query({
  args: defs.publicLinks.args,
  handler: (ctx, args) => defs.publicLinks.handler(ctx, args),
});

export const listByStore = storeQuery({
  permission: "settings:read",
  args: defs.listByStore.args,
  handler: (ctx, args) => defs.listByStore.handler(ctx, args),
});
export const getByStorePlatform = storeQuery({
  permission: "settings:read",
  args: defs.getByStorePlatform.args,
  handler: (ctx, args) => defs.getByStorePlatform.handler(ctx, args),
});

// `listByPlatformEnabled`, `getBySiteId` and `getByBrandId` search ACROSS every
// store — that is their whole purpose: an incoming Uber Eats or Deliveroo event
// carries a platform id, and these resolve which restaurant it belongs to. They
// cannot be store-scoped, and the webhooks that need them run as
// `internalAction`s with no user identity. So they are internal only; the public
// exports they used to have let anyone enumerate every connected restaurant.
export const internalGetBySiteId = internalQuery(defs.getBySiteId);
export const internalGetByBrandId = internalQuery(defs.getByBrandId);

// === Mutations (store-scoped) ===

// Saving the integration card is also how an owner pauses or re-opens the
// store on the platform: the card's "Statut sur la plateforme" select writes
// `storeStatus` through here. That value used to stop in Convex — the platform
// never heard about it — so a paused store kept receiving Uber Eats and
// Deliveroo orders. Scheduling the push makes the control do what it says.
//
// Not on every save, and not only on a change either — both are wrong, for
// opposite reasons.
//
// The admin form initialises the select to "OFFLINE" and falls back to
// "OFFLINE" for a row that never stored one
// (`packages/admin/src/pages/stores/use-store-detail.ts:129,137,253,264`).
// Pushing that would pull a restaurant off the platform the moment someone
// connected an integration or edited its prep time — an OFFLINE the owner
// never chose. So an OFFLINE with no established status behind it is ignored.
//
// But gating on "the value changed" is worse: it reads Convex's stored value
// as proof of the platform's. There is no action retrier in this repo, so a
// push that throws is terminal — Convex says PAUSED, the platform is still
// live, and saving again does nothing because nothing differs. Re-saving has
// to be the retry, so any save carrying a real status pushes. The calls are
// idempotent, and a human clicking Save cannot approach Uber's one-change-
// per-second-per-store limit.
export const upsert = storeMutation({
  permission: "settings:write",
  args: defs.upsert.args,
  handler: async (ctx, args) => {
    const before = (await defs.getByStorePlatform.handler(ctx, {
      storeId: args.storeId,
      platform: args.platform,
    })) as { storeStatus?: "ONLINE" | "PAUSED" | "OFFLINE" } | null;

    const result = await defs.upsert.handler(ctx, args);

    // An OFFLINE is only believed once the integration has had a status of its
    // own; before that it is indistinguishable from the form's default.
    const isDefaultedOffline =
      args.storeStatus === "OFFLINE" && (before === null || before.storeStatus === undefined);

    if (args.storeStatus !== undefined && !isDefaultedOffline) {
      await ctx.scheduler.runAfter(0, internal.platformStoreStatus.pushStoreStatus, {
        storeId: args.storeId,
        platform: args.platform,
      });
    }
    return result;
  },
});

export const remove = storeMutation({
  permission: "settings:write",
  args: defs.remove.args,
  storeIdFrom: storeIdFromDocument("Integration not found"),
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});

// === Internal Mutations (for webhooks and schedulers) ===

export const internalUpdateMenuSyncStatus = internalMutation(defs.updateMenuSyncStatus);
export const internalUpsert = internalMutation(defs.upsert);

export const setOrderMode = internalMutation({
  args: {
    platformStoreId: v.string(),
    platform: v.union(v.literal("uberEats"), v.literal("deliveroo")),
    orderMode: v.union(v.literal("auto_accept"), v.literal("auto_reject"), v.literal("manual")),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("storeIntegrations")
      .withIndex("by_platform_enabled", (q) => q.eq("platform", args.platform).eq("enabled", true))
      .filter((q) => q.eq(q.field("platformStoreId"), args.platformStoreId))
      .first();
    if (!integration) throw new Error(`No integration found for ${args.platformStoreId}`);
    await ctx.db.patch(integration._id, { orderMode: args.orderMode });
    return { success: true, id: integration._id, orderMode: args.orderMode };
  },
});
