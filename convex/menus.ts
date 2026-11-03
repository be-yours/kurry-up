import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/menus";
import { touchesTranslatableText } from "@be-yours/convex-functions/autoTranslate";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";
import { scheduleMenuSync } from "./lib/menuSync";
import { scheduleTranslation } from "./autoTranslate";

// === Queries (public for storefront) ===

// Was `query(defs.list)`, marked "@public-by-design: menus are the published
// storefront offering". Nothing on the storefront has ever rendered a menu —
// the admin's menus tab was its only caller in the whole repository — so what
// that registration actually published was an anonymous read of every menu a
// store has, drafts included. It is guarded now, not filtered: a filtered
// public query with no public caller is surface bought for nothing.
export const list = storeQuery({
  permission: "products:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

/**
 * The formules a diner may order, with their sections resolved.
 *
 * @public-by-design: this IS the published storefront offering, and the
 * storefront reads it with no session. It is the filtered twin `list`'s comment
 * asked for — `isActive` only, deactivated formules never leave the server, and
 * a formule whose mandatory dish has been switched off is left out rather than
 * offered and then refused at the checkout.
 */
export const listActive = query({
  args: defs.listActive.args,
  handler: (ctx, args) => defs.listActive.handler(ctx, args),
});
// === Mutations (with menu sync trigger) ===

/**
 * The establishment a menu belongs to.
 *
 * Read a second time inside the mutations: the seam resolves it for the
 * permission check but does not pass it to the handler, and `remove` deletes
 * the document the resolver reads — so it has to be read before the handler.
 */
const menuStoreId = storeIdFromDocument("Menu not found");

export const create = storeMutation({
  permission: "menus:write",
  args: defs.create.args,
  handler: async (ctx, args) => {
    const result = await defs.create.handler(ctx, args);
    await scheduleMenuSync(ctx, [args.storeId]);
    await scheduleTranslation(ctx, result, "menus", args.storeId);
    return result;
  },
});

export const update = storeMutation({
  permission: "menus:write",
  args: defs.update.args,
  storeIdFrom: menuStoreId,
  handler: async (ctx, args) => {
    const storeId = await menuStoreId(ctx, args);
    const result = await defs.update.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    if (touchesTranslatableText(args)) {
      await scheduleTranslation(ctx, args.id, "menus", storeId);
    }
    return result;
  },
});

export const toggleStatus = storeMutation({
  permission: "menus:write",
  args: defs.toggleStatus.args,
  storeIdFrom: menuStoreId,
  handler: async (ctx, args) => {
    const storeId = await menuStoreId(ctx, args);
    const result = await defs.toggleStatus.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

export const remove = storeMutation({
  permission: "menus:write",
  args: defs.remove.args,
  storeIdFrom: menuStoreId,
  handler: async (ctx, args) => {
    const storeId = await menuStoreId(ctx, args);
    const result = await defs.remove.handler(ctx, args);
    // The menu's own name and description, in every language the owner added,
    // are of no use to anything once the menu is gone. A first batch goes with
    // it; the rest is drained here.
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.menus.purgeTranslations, {
        menuId: args.id,
        storeId,
      });
    }
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

export const purgeTranslations = internalMutation({
  args: defs.purgeTranslations.args,
  handler: async (ctx, args) => {
    const { hasMore } = await defs.purgeTranslations.handler(ctx, args);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.menus.purgeTranslations, args);
    }
  },
});
