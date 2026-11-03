import * as defs from "@be-yours/convex-functions/requiredActions";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// Game configuration, not storefront data: the player's own screen reads the
// required actions through `gamePlay.getSession`, never through this list.
export const list = storeQuery({
  permission: "games:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

export const create = storeMutation({
  permission: "games:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const update = storeMutation({
  permission: "games:write",
  args: defs.update.args,
  storeIdFrom: storeIdFromDocument("Action not found"),
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "games:write",
  args: defs.remove.args,
  storeIdFrom: storeIdFromDocument("Action not found"),
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});
