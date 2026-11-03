import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import * as defs from "@be-yours/convex-functions/products";
import { requireStorePermission } from "@be-yours/convex-functions/auth";
import { touchesTranslatableText } from "@be-yours/convex-functions/autoTranslate";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";
import { scheduleMenuSync } from "./lib/menuSync";
import { scheduleTranslation } from "./autoTranslate";

// === Queries (public for storefront) ===

// @public-by-design: the catalogue IS the storefront. Prices and availability
// are meant to be readable without an account — but only for what is ON SALE.
// Both of these filter on `isActive`; `listAll` and `getAnyById` below are the
// unfiltered pair, and they are guarded.
export const list = query(defs.list);
// @public-by-design: the storefront's product page; serves only what is on sale
export const getById = query(defs.getById);
// @public-by-design: the catalogue IS the storefront; prices and availability are public
export const getManualTrending = query(defs.getManualTrending);
// @public-by-design: the catalogue IS the storefront; prices and availability are public
export const getTrending = query(defs.getTrending);
// @public-by-design: the catalogue IS the storefront; prices and availability are public
export const getManyByIds = query(defs.getManyByIds);

// === Queries (the owner's own catalogue, drafts included) ===
//
// `list` and `getById` above are the storefront's and return only what is on
// sale. These two are their counterparts for the back office, and they are
// guarded rather than public for the obvious reason: an unpublished dish, its
// price and its stock are the establishment's business until the owner says
// otherwise.
export const listAll = storeQuery({
  permission: "products:read",
  args: defs.listAll.args,
  handler: (ctx, args) => defs.listAll.handler(ctx, args),
});

// === Helpers ===

/**
 * The establishment a product belongs to.
 *
 * Called a second time inside the mutations below, deliberately: the seam
 * resolves it for the permission check but does not hand it to the handler, and
 * `remove` deletes the very document the resolver reads — so the store has to be
 * read BEFORE the handler runs, not after.
 */
const productStoreId = storeIdFromDocument("Product not found");

/**
 * One product, whatever its state — the edit screen's read.
 *
 * Below `productStoreId` rather than beside `listAll`, because `storeIdFrom`
 * is evaluated when this module loads: referencing the const from above it is
 * a temporal dead zone, and the whole `convex/products.ts` module fails to
 * import rather than one query failing to run.
 */
export const getAnyById = storeQuery({
  permission: "products:read",
  storeIdFrom: productStoreId,
  args: defs.getAnyById.args,
  handler: (ctx, args) => defs.getAnyById.handler(ctx, args),
});

/** Resolve storeId from a `productId` arg for authorization */
async function storeIdFromProductId(
  ctx: QueryCtx,
  args: { productId: Id<"products"> }
): Promise<Id<"stores">> {
  const product = await ctx.db.get(args.productId);
  if (!product) throw new Error("Product not found");
  return product.storeId;
}

// === Mutations (with authorization + menu sync) ===

export const create = storeMutation({
  args: defs.create.args,
  permission: "products:write",
  handler: async (ctx, args) => {
    const result = await defs.create.handler(ctx, args);
    await scheduleMenuSync(ctx, [args.storeId]);
    // A new dish always carries a name, so there is always something to
    // translate for whatever second language the store has switched on.
    await scheduleTranslation(ctx, result, "products", args.storeId);
    return result;
  },
});

export const update = storeMutation({
  args: defs.update.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const storeId = await productStoreId(ctx, args);
    const result = await defs.update.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    if (touchesTranslatableText(args)) {
      await scheduleTranslation(ctx, args.id, "products", storeId);
    }
    return result;
  },
});

export const updateStock = storeMutation({
  args: defs.updateStock.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const storeId = await productStoreId(ctx, args);
    const result = await defs.updateStock.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

export const toggleStatus = storeMutation({
  args: defs.toggleStatus.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const storeId = await productStoreId(ctx, args);
    const result = await defs.toggleStatus.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

// Turning tracking on for a product already sitting at zero makes it sold out;
// turning it off makes it sellable again. Both change what the delivery
// platforms should be showing, so this has to push like `updateStock` does —
// it was the one stock control that changed availability and told nobody.
export const toggleStockTracking = storeMutation({
  args: defs.toggleStockTracking.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const storeId = await productStoreId(ctx, args);
    const result = await defs.toggleStockTracking.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

export const updateAutoDisable = storeMutation({
  args: defs.updateAutoDisable.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: (ctx, args) => defs.updateAutoDisable.handler(ctx, args),
});

export const updateLowStockThreshold = storeMutation({
  args: defs.updateLowStockThreshold.args,
  storeIdFrom: productStoreId,
  permission: "products:write",
  handler: (ctx, args) => defs.updateLowStockThreshold.handler(ctx, args),
});

export const remove = storeMutation({
  args: defs.remove.args,
  storeIdFrom: productStoreId,
  permission: "products:delete",
  handler: async (ctx, args) => {
    const storeId = await productStoreId(ctx, args);
    const result = await defs.remove.handler(ctx, args);
    await scheduleMenuSync(ctx, [storeId]);
    return result;
  },
});

export const updateWithPropagation = storeMutation({
  args: defs.updateWithPropagation.args,
  storeIdFrom: storeIdFromProductId,
  permission: "products:write",
  handler: async (ctx, args) => {
    const result = await defs.updateWithPropagation.handler(ctx, args);
    // The one write that can change several establishments at once; the handler
    // reports which, so every twin's menu is pushed and no other store's is.
    await scheduleMenuSync(ctx, result.storeIds as Array<Id<"stores">>);
    return result;
  },
});

/**
 * Copy one restaurant's catalogue into another.
 *
 * Two stores, and the seam can only scope to one — so it scopes to the side
 * that gets WRITTEN. It used to scope to the source, which is the wrong half:
 * the caller proved rights over the restaurant being read while the products
 * and categories landed in a restaurant they might not administer at all. A
 * manager of one store could stuff their catalogue into someone else's.
 *
 * The source is checked in the handler, at `products:read` — copying a
 * competitor's catalogue into your own is the symmetric abuse.
 */
export const duplicateCatalog = storeMutation({
  args: defs.duplicateCatalog.args,
  storeIdFrom: async (_ctx, args) => args.targetStoreId,
  permission: "products:write",
  handler: async (ctx, args) => {
    await requireStorePermission(ctx, args.sourceStoreId, "products:read");
    return defs.duplicateCatalog.handler(ctx, args);
  },
});

/**
 * Reorder the catalogue of one establishment.
 *
 * Scoped on `args.storeId` like every other write here; the handler refuses any
 * product id that is not in that store, so the list of ids a client sends
 * cannot reach across establishments.
 */
export const reorder = storeMutation({
  args: defs.reorder.args,
  permission: "products:write",
  handler: (ctx, args) => defs.reorder.handler(ctx, args),
});

export const setTrendingProducts = storeMutation({
  args: defs.setTrendingProducts.args,
  permission: "products:write",
  handler: (ctx, args) => defs.setTrendingProducts.handler(ctx, args),
});
