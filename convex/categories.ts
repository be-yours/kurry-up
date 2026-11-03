import { query, mutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/categories";
import { requireStorePermission } from "@be-yours/convex-functions/auth";
import { touchesTranslatableText } from "@be-yours/convex-functions/autoTranslate";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";
import { scheduleTranslation } from "./autoTranslate";

// === Queries (public for storefront) ===

// @public-by-design: the storefront renders the category menu to anonymous
// visitors. Categories carry no store-confidential data.
// @public-by-design: storefront category menu, rendered for anonymous visitors
export const list = query(defs.list);
// @public-by-design: storefront category menu, rendered for anonymous visitors
export const listActiveWithCounts = query(defs.listActiveWithCounts);

// The same catalogue with the switched-off sections in it, for the screens
// that manage them and for the platform importers that match against them.
export const listAll = storeQuery({
  permission: "products:read",
  args: defs.listAll.args,
  handler: (ctx, args) => defs.listAll.handler(ctx, args),
});

// === Mutations (with authorization) ===

const categoryStoreId = storeIdFromDocument("Category not found");

export const create = storeMutation({
  args: defs.create.args,
  permission: "products:write",
  handler: async (ctx, args) => {
    const result = await defs.create.handler(ctx, args);
    await scheduleTranslation(ctx, result, "categories", args.storeId);
    return result;
  },
});

export const update = storeMutation({
  args: defs.update.args,
  storeIdFrom: categoryStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const storeId = await categoryStoreId(ctx, args);
    const result = await defs.update.handler(ctx, args);
    if (touchesTranslatableText(args)) {
      await scheduleTranslation(ctx, args.id, "categories", storeId);
    }
    return result;
  },
});

// @guarded-inline: authorises inside the handler
export const reorder = mutation({
  args: defs.reorder.args,
  handler: async (ctx, args) => {
    // Verify all categories belong to the same store
    let storeId: string | null = null;
    for (const id of args.ids) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cat = await (ctx.db as any).get(id);
      if (!cat) throw new Error(`Category not found: ${id}`);
      if (storeId === null) {
        storeId = cat.storeId;
      } else if (cat.storeId !== storeId) {
        throw new Error("All categories must belong to the same store");
      }
    }
    // Unconditional, which it was not: the permission check sat inside
    // `if (storeId)`, and `storeId` stays null when `args.ids` is empty — so a
    // caller sending `{ ids: [] }` reached `defs.reorder.handler` having been
    // authorised by nothing. Reordering nothing is harmless in itself; a guard
    // with a caller-controlled off switch is not, and it is the same shape as
    // the `validateIntegration` bypass found beside it (#445). An empty
    // reorder is now refused rather than silently unguarded.
    if (!storeId) {
      throw new Error("No categories to reorder");
    }
    await requireStorePermission(ctx, storeId, "products:write");
    return defs.reorder.handler(ctx, args);
  },
});

export const remove = storeMutation({
  args: defs.remove.args,
  storeIdFrom: categoryStoreId,
  permission: "products:delete",
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});
