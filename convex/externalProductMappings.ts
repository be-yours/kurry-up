import { internalQuery, internalMutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/externalProductMappings";
import { storeMutation } from "./lib/storeFunctions";

// Mapping between our products and their ids on Uber Eats / Deliveroo. This is
// integration plumbing: no storefront reads it, and it was entirely public.
//
// Two surfaces, deliberately:
//  - the store-scoped ones below, for the admin;
//  - the internal ones, for the webhook and import paths. Those run as
//    `internalAction`s with no user identity, so a store-scoped guard there
//    would reject Uber Eats and Deliveroo themselves.

export const upsert = storeMutation({
  permission: "products:write",
  args: defs.upsert.args,
  handler: (ctx, args) => defs.upsert.handler(ctx, args),
});

// `getByInternal` and `remove` resolve a mapping by product or mapping id and
// carry no storeId, so they cannot be store-scoped. `getByExternal` now takes
// one — not as a permission guard, since it runs from an `internalAction` with
// no identity, but because a PLU is only unique inside one establishment and
// resolving it across the deployment matched another restaurant's dish. All
// three have no UI caller — internal is the whole surface they need.
export const internalGetByInternal = internalQuery(defs.getByInternal);
export const internalGetByExternal = internalQuery(defs.getByExternal);
export const internalListByStorePlatform = internalQuery(defs.listByStorePlatform);
export const internalUpsert = internalMutation(defs.upsert);
export const internalRemove = internalMutation(defs.remove);
