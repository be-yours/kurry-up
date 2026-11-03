import * as defs from "@be-yours/convex-functions/stockLedger";
import { storeQuery } from "./lib/storeFunctions";

/**
 * Why the stock number changed (#99).
 *
 * `products:read`, the same permission the Inventaire screen this sits on
 * already asks for: a movement is a fact about a dish, and anybody who may see
 * the quantity may see how it got there. Writing is not exposed at all — every
 * row is written by the path that moved the stock, inside the same transaction,
 * so a ledger entry cannot exist without the movement it records.
 */
export const list = storeQuery({
  permission: "products:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});
