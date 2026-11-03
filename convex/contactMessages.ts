import { mutation } from "./_generated/server"
import * as defs from "@be-yours/convex-functions/contactMessages"
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

// === Queries (admin, auth-protected) ===

export const list = storeQuery({
  permission: "customers:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
})

/**
 * Unread count for the sidebar badge.
 */
export const unreadCount = storeQuery({
  permission: "customers:read",
  args: defs.unreadCount.args,
  handler: (ctx, args) => defs.unreadCount.handler(ctx, args),
})

// === Mutations ===

/**
 * Public mutation — allows unauthenticated storefront visitors to submit a contact message.
 */
// @public-by-design: the contact form is filled in by visitors (rate limiting tracked as S3-7)
export const create = mutation({
  args: defs.create.args,
  handler: async (ctx, args) => {
    return defs.create.handler(ctx, args)
  },
})

/**
 * Admin mutation — update message status (read, archived).
 */
export const updateStatus = storeMutation({
  permission: "customers:write",
  args: defs.updateStatus.args,
  storeIdFrom: storeIdFromDocument("Message not found"),
  handler: (ctx, args) => defs.updateStatus.handler(ctx, args),
})
