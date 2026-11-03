import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/languages";
import { storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// @public-by-design: the language switcher runs before any sign-in. A list of
// enabled locales is not confidential.
// @public-by-design: the language switcher runs before any sign-in
export const list = query(defs.list);
// @public-by-design: the language switcher runs before any sign-in
export const listActive = query(defs.listActive);
// @public-by-design: the language switcher runs before any sign-in
export const listAll = query(defs.listAll);

const languageStoreId = storeIdFromDocument("Language not found");

export const create = storeMutation({
  permission: "translations:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const toggleActive = storeMutation({
  permission: "translations:write",
  args: defs.toggleActive.args,
  storeIdFrom: languageStoreId,
  handler: (ctx, args) => defs.toggleActive.handler(ctx, args),
});

export const setDefault = storeMutation({
  permission: "translations:write",
  args: defs.setDefault.args,
  handler: (ctx, args) => defs.setDefault.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "translations:write",
  args: defs.remove.args,
  storeIdFrom: languageStoreId,
  handler: async (ctx, args) => {
    // The translations for a language the establishment no longer offers are of
    // no use to anything, and leaving them means re-adding the same code
    // resurrects last month's text on the storefront (#432.6). A first batch
    // goes with the language row; the rest is drained here, the way
    // `menus.remove` drains its own.
    const result = await defs.remove.handler(ctx, args);
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.languages.purgeTranslations, {
        storeId: result.storeId,
        languageCode: result.languageCode,
      });
    }
    return result;
  },
});

export const purgeTranslations = internalMutation({
  args: defs.purgeTranslations.args,
  handler: async (ctx, args) => {
    const { hasMore } = await defs.purgeTranslations.handler(ctx, args);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.languages.purgeTranslations, args);
    }
  },
});
