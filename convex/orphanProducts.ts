import * as defs from "@be-yours/convex-functions/orphanProducts";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

const orphanStoreId = storeIdFromDocument("Orphan product not found");

/**
 * The imported items that matched nothing in the catalogue (#274).
 *
 * WHY IT HAD NO WRAPPER. `orphanProducts` exists precisely because an import
 * from Uber Eats or Deliveroo leaves items with no counterpart here — a dish
 * renamed on the platform, a new one added there, a modifier the catalogue has
 * no product for. `match`, `ignore` and `listPending` are the screen for
 * resolving them, and only `match` was ever exposed. So the rows accumulated on
 * every import with no way to see them, no way to clear them, and no way to tell
 * an owner why their platform menu and their catalogue had drifted apart.
 *
 * `products:read` rather than `integrations:read`: what this lists is the
 * establishment's own catalogue seen from the outside, and the person who
 * resolves an unmatched dish is whoever maintains the menu.
 */
export const listPending = storeQuery({
  permission: "products:read",
  args: defs.listPending.args,
  handler: (ctx, args) => defs.listPending.handler(ctx, args),
});

export const match = storeMutation({
  permission: "products:write",
  args: defs.match.args,
  storeIdFrom: orphanStoreId,
  handler: (ctx, args) => defs.match.handler(ctx, args),
});

/**
 * Set an unmatched item aside without matching it.
 *
 * The honest third option, and the reason the screen needs one: a platform
 * carries items this establishment does not sell here — a combo assembled on
 * Uber Eats, a discontinued dish the platform still lists. Forcing every row to
 * be matched to something would put a wrong product in the catalogue, and
 * leaving it pending for ever makes the screen unusable after the first import.
 *
 * `ignored` rather than deleted: the row records that a human looked at it and
 * decided, so the next import does not present it again as new.
 */
export const ignore = storeMutation({
  permission: "products:write",
  args: defs.ignore.args,
  storeIdFrom: orphanStoreId,
  handler: (ctx, args) => defs.ignore.handler(ctx, args),
});
