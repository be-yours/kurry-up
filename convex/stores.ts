import { query, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import * as defs from "@be-yours/convex-functions/stores";
import { storeQuery, storeMutation, authedQuery, authedMutation } from "./lib/storeFunctions";
import {
  getAuthUser,
  isStaff,
  requireRolePermission,
  requireStaff,
  seesEveryStore,
} from "@be-yours/convex-functions/auth";
import { isPublishedStore } from "@be-yours/convex-schema";

// === Queries (public for storefront) ===
// Strip sensitive data (printConfig.apiKey) from public queries

function stripSensitiveStoreData<T>(store: T): T {
  if (!store || typeof store !== "object") return store;
  const s = store as Record<string, unknown>;
  if (!s.printConfig || typeof s.printConfig !== "object") return store;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey: _apiKey, ...safePrintConfig } = s.printConfig as Record<string, unknown>;
  return { ...s, printConfig: safePrintConfig } as T;
}

// @public-by-design: public storefront info; sensitive printConfig is stripped above
export const list = query({
  args: defs.list.args,
  handler: async (ctx) => {
    const stores = await defs.list.handler(ctx);
    return stores.map(stripSensitiveStoreData);
  },
});

/**
 * The administration list: the establishments THIS account administers, drafts
 * included.
 *
 * It cannot go through `storeQuery` — the list spans several stores, so there
 * is no single store to scope to — so the gate is checked inline, the way
 * `create` does it. `requireStaff` rather than `stores:read`: the kitchen and
 * delivery roles do not hold that permission and still render behind
 * `StoreGuard`, which is built from this list.
 *
 * Staff-only was ALL it checked (#94). Membership was never applied, so a
 * kitchen account attached to one restaurant received the name, address,
 * phone, email, opening hours and delivery radius of every other restaurant
 * its owner runs. The scope now comes from the same `storeIds` every other
 * guard reads; only a super admin, whose remit is the chain, still sees all of
 * them.
 *
 * `printConfig.apiKey` is stripped here as it is on the public queries. The one
 * read that returns it is `getAdminById`, behind `stores:read`.
 */
// @guarded-inline: staff-only AND membership-scoped in the handler; the list
// spans several stores, so the store-scoped seam cannot express it
export const listAll = authedQuery({
  args: defs.listAll.args,
  handler: async (ctx) => {
    const user = await requireStaff(ctx);

    const stores = seesEveryStore(user.role)
      ? await defs.listAll.handler(ctx)
      : await defs.listByIds.handler(ctx, {
          ids: user.storeIds as Id<"stores">[],
        });

    return stores.map(stripSensitiveStoreData);
  },
});

/**
 * One establishment, by id — the query both halves of the product read.
 *
 * It is public because it has to be: the storefront's checkout, contact page and
 * open/closed banner all ask for it before anyone signs in. It returned drafts
 * to them, though — the address, the contact details, the `orderMode` and the
 * `overrides` of an establishment its owner has never published. `stores.list`
 * filters drafts out; a direct `getById` walked past that.
 *
 * A draft is not a storefront document, so an anonymous or customer caller gets
 * `null` for one. It is still an *administration* document: the store detail
 * page exists to publish drafts, the KDS reads its own establishment, and the
 * CMS pickers read the one being edited — and `kitchen` and `delivery` do not
 * hold `stores:read`, so `getAdminById` is not open to them. Staff, meaning
 * anyone whose role is not `customer`, therefore still see drafts here.
 */
// @public-by-design: published establishments are storefront info, and the
// sensitive printConfig is stripped above. Drafts are staff-only.
export const getById = query({
  args: defs.getById.args,
  handler: async (ctx, args) => {
    const store = await defs.getById.handler(ctx, args);
    if (!store) return null;
    if (!isPublishedStore(store) && !(await isStaff(ctx))) return null;
    return stripSensitiveStoreData(store);
  },
});

// Internal (no-auth) variant for webhook handlers, which run without a user identity.
export const internalGetById = internalQuery({
  args: defs.getById.args,
  handler: async (ctx, args) => defs.getById.handler(ctx, args),
});

/**
 * The same establishment, by its other name.
 *
 * `getById` was closed to drafts and this was not, so the leak moved rather
 * than went away — and a slug is the half of the pair nobody has to guess, it
 * is built from the restaurant's name. The address, the contact details, the
 * `orderMode` and the `overrides` of an unpublished establishment stayed one
 * request away.
 *
 * Visibility belongs to the establishment, not to the query that happens to
 * find it, so both doors apply the same rule. Nothing in the administration
 * reads by slug — it works in ids, from `listAll` — and the one production
 * caller is `lib/convex-server.ts`, which feeds `generateCmsMetadata` from a
 * server render carrying no identity. A draft therefore falls back to the
 * page's own title instead of publishing its own, which is the answer a
 * restaurant nobody has opened yet should give a crawler.
 */
// @public-by-design: published establishments are storefront info, and the
// sensitive printConfig is stripped above. Drafts are staff-only.
export const getBySlug = query({
  args: defs.getBySlug.args,
  handler: async (ctx, args) => {
    const store = await defs.getBySlug.handler(ctx, args);
    if (!store) return null;
    if (!isPublishedStore(store) && !(await isStaff(ctx))) return null;
    return stripSensitiveStoreData(store);
  },
});

/** The store IS the document here: `args.id` is the store id. */
const storeIdFromIdArg = async (_ctx: QueryCtx, args: { id: Id<"stores"> }) =>
  args.id;

/** Admin-only query: returns full store data including printConfig.apiKey */
export const getAdminById = storeQuery({
  permission: "stores:read",
  args: defs.getById.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.getById.handler(ctx, args),
});

// === Mutations (protected with store access) ===

/**
 * Creating a store is the one mutation the store-scoped seam cannot guard:
 * there is no store yet to check membership against. It was left as an
 * auth-only wrapper, so any signed-up customer could create restaurants.
 * `stores:write` is held by SUPER_ADMIN and CLIENT_ADMIN.
 */
// @guarded-inline: stores:write checked in the handler; no store exists yet to scope to
export const create = authedMutation({
  args: defs.create.args,
  handler: async (ctx, args) => {
    /* Role AND module (#649). `stores` is covered by `dashboard` and `settings`,
       so a member narrowed out of both should not be creating establishments. */
    await requireRolePermission(ctx, "stores:write");
    return defs.create.handler(ctx, args);
  },
});

export const update = storeMutation({
  permission: "stores:write",
  args: defs.update.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const updateHours = storeMutation({
  permission: "stores:write",
  args: defs.updateHours.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateHours.handler(ctx, args),
});

export const updateOverrides = storeMutation({
  permission: "stores:write",
  args: defs.updateOverrides.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateOverrides.handler(ctx, args),
});

export const updateAddress = storeMutation({
  permission: "stores:write",
  args: defs.updateAddress.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateAddress.handler(ctx, args),
});

export const updatePrintConfig = storeMutation({
  permission: "stores:write",
  args: defs.updatePrintConfig.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updatePrintConfig.handler(ctx, args),
});

export const updateOrderConfirmation = storeMutation({
  permission: "stores:write",
  args: defs.updateOrderConfirmation.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateOrderConfirmation.handler(ctx, args),
});

export const updateStationMapping = storeMutation({
  permission: "stores:write",
  args: defs.updateStationMapping.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateStationMapping.handler(ctx, args),
});

export const updateSoundConfig = storeMutation({
  permission: "stores:write",
  args: defs.updateSoundConfig.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateSoundConfig.handler(ctx, args),
});

export const updateDisplayConfig = storeMutation({
  permission: "stores:write",
  args: defs.updateDisplayConfig.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateDisplayConfig.handler(ctx, args),
});

/**
 * The Design screen's three save buttons — couleurs, typographie, logo — all
 * come through here, each sending only its own fields. `defs.updateBranding`
 * merges rather than replaces, so one tab's save cannot erase another's.
 *
 * `stores:write`, like every other store-settings mutation beside it: branding
 * is a setting of the establishment, and `manager` holds `stores:read` alone.
 */
export const updateBranding = storeMutation({
  permission: "stores:write",
  args: defs.updateBranding.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateBranding.handler(ctx, args),
});

export const updateOrderMode = storeMutation({
  permission: "stores:write",
  args: defs.updateOrderMode.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateOrderMode.handler(ctx, args),
});

export const updateTrendingMode = storeMutation({
  permission: "stores:write",
  args: defs.updateTrendingMode.args,
  storeIdFrom: storeIdFromIdArg,
  handler: (ctx, args) => defs.updateTrendingMode.handler(ctx, args),
});

/**
 * Deleting an establishment takes its data with it.
 *
 * One mutation is one transaction with a bounded budget, and an established
 * restaurant has more orders than that, so `defs.remove` clears one batch and
 * says whether more is left. The scheduling lives here rather than in the
 * package, which has no `internal` reference to schedule against — the same
 * split `autoTranslate` uses.
 */
export const remove = storeMutation({
  permission: "stores:delete",
  args: defs.remove.args,
  storeIdFrom: storeIdFromIdArg,
  handler: async (ctx, args) => {
    const result = await defs.remove.handler(ctx, args);
    if (result?.hasMore) {
      await ctx.scheduler.runAfter(0, internal.stores.purgeStoreData, {
        storeId: args.id,
      });
    }
    return result;
  },
});

/**
 * The rest of the sweep, one batch per run, until there is nothing left.
 *
 * Internal only: it takes an id that no longer resolves — the store row is
 * deleted in the first transaction — and it is nobody's to call but the
 * scheduler's.
 */
export const purgeStoreData = internalMutation({
  args: defs.purgeStoreData.args,
  handler: async (ctx, args) => {
    const { hasMore } = await defs.purgeStoreData.handler(ctx, args);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.stores.purgeStoreData, args);
    }
  },
});

/**
 * Every establishment on this deployment, for a migration to walk.
 *
 * Internal only, and deliberately not `listAll`'s public sibling: that one is
 * scoped to what the CALLER may see, which is the right rule for a screen and
 * the wrong one for a backfill — a migration that skipped the establishments
 * the operator running it does not administer would leave a client book half
 * built, silently (#364).
 */
export const listAllInternal = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("stores").collect(),
});
