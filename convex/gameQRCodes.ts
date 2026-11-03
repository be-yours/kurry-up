import * as defs from "@be-yours/convex-functions/gameQRCodes";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// `list` returns every QR code of a store. Exposed publicly, it handed an
// attacker the codes for all of a competitor's tables — enough to play their
// game remotely, without ever setting foot in the restaurant.
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

// The way out of `remove`'s refusal: a played code is retired, not deleted.
export const setActive = storeMutation({
  permission: "games:write",
  args: defs.setActive.args,
  storeIdFrom: storeIdFromDocument("QR code not found"),
  handler: (ctx, args) => defs.setActive.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "games:write",
  args: defs.remove.args,
  storeIdFrom: storeIdFromDocument("QR code not found"),
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});
