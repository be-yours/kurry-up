import * as defs from "@be-yours/convex-functions/games";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// A game document carries its `winRatio`. Exposed publicly, the odds the owner
// configured were readable by anyone holding a storeId.
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

export const updateWinRatio = storeMutation({
  permission: "games:write",
  args: defs.updateWinRatio.args,
  storeIdFrom: storeIdFromDocument("Game not found"),
  handler: (ctx, args) => defs.updateWinRatio.handler(ctx, args),
});

export const update = storeMutation({
  permission: "games:write",
  args: defs.update.args,
  storeIdFrom: storeIdFromDocument("Game not found"),
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "games:write",
  args: defs.remove.args,
  storeIdFrom: storeIdFromDocument("Game not found"),
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});
