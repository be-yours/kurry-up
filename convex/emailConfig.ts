import * as defs from "@be-yours/convex-functions/emailConfig";
import { internalQuery } from "./_generated/server";
import { storeQuery, storeMutation } from "./lib/storeFunctions";

// === Queries (auth-protected — contains fromEmail/replyToEmail) ===

export const get = storeQuery({
  permission: "marketing:read",
  args: defs.get.args,
  handler: (ctx, args) => defs.get.handler(ctx, args),
});

// === Mutations (auth-protected) ===

export const upsert = storeMutation({
  permission: "marketing:write",
  args: defs.upsert.args,
  handler: (ctx, args) => defs.upsert.handler(ctx, args),
});

/**
 * The same row, for a caller with no session.
 *
 * `get` is store-scoped, and a scheduled send batch has no identity to
 * scope with — it would be refused. The authorisation happened when a person
 * started or scheduled the campaign; this is the deferred half of that work, so
 * it is `internalQuery` and unreachable from a client.
 */
export const getInternal = internalQuery({
  args: defs.get.args,
  handler: (ctx, args) => defs.get.handler(ctx, args),
});
