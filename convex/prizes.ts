import * as defs from "@be-yours/convex-functions/prizes";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// Prizes are admin data: the catalogue and its remaining stock. `list` used to
// be a bare `query`, so any visitor holding a storeId — visible in the
// `/display/[storeId]` URL — could read a competitor's prize stock.
export const list = storeQuery({
  permission: "games:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

const prizeStoreId = storeIdFromDocument("Prize not found");

export const create = storeMutation({
  permission: "games:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const update = storeMutation({
  permission: "games:write",
  args: defs.update.args,
  storeIdFrom: prizeStoreId,
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "games:write",
  args: defs.remove.args,
  storeIdFrom: prizeStoreId,
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});
