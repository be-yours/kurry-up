import * as defs from "@be-yours/convex-functions/emailSegments";
import { internalQuery } from "./_generated/server";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

const emailSegmentsStoreId = storeIdFromDocument("Segment not found");

// === Queries (auth-protected) ===

export const list = storeQuery({
  permission: "marketing:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

export const countMatchingSubscribers = storeQuery({
  permission: "marketing:read",
  args: defs.countMatchingSubscribers.args,
  handler: (ctx, args) => defs.countMatchingSubscribers.handler(ctx, args),
});

// === Mutations (auth-protected) ===

export const create = storeMutation({
  permission: "marketing:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const update = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailSegmentsStoreId,
  args: defs.update.args,
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const remove = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailSegmentsStoreId,
  args: defs.remove.args,
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});

export const duplicate = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailSegmentsStoreId,
  args: defs.duplicate.args,
  handler: (ctx, args) => defs.duplicate.handler(ctx, args),
});

/**
 * The same row, for a caller with no session.
 *
 * `getById` is store-scoped, and a scheduled send batch has no identity to
 * scope with — it would be refused. The authorisation happened when a person
 * started or scheduled the campaign; this is the deferred half of that work, so
 * it is `internalQuery` and unreachable from a client.
 */
export const getByIdInternal = internalQuery({
  args: defs.getById.args,
  handler: (ctx, args) => defs.getById.handler(ctx, args),
});
