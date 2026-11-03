import { query } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/translations";
import { storeMutation } from "./lib/storeFunctions";

// @public-by-design: translations of already-public content (product names, UI strings)
export const getUIOverrides = query(defs.getUIOverrides);

// Writes are a different matter: these used to check only that the caller was
// logged in, so any account could rewrite another restaurant's translations.
export const upsert = storeMutation({
  permission: "translations:write",
  args: defs.upsert.args,
  handler: (ctx, args) => defs.upsert.handler(ctx, args),
});
