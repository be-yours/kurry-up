import { query, mutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/customerAddresses";
import { v } from "convex/values";

/**
 * Customer delivery addresses — authenticated surface
 *
 * Every function resolves the caller from the session rather than taking a
 * userId: an address is personal data, and accepting a caller-supplied id
 * would let anyone read or edit anyone else's.
 */

const addressFields = {
  label: v.optional(v.string()),
  street: v.string(),
  city: v.string(),
  postalCode: v.string(),
  country: v.string(),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  instructions: v.optional(v.string()),
};

/** The signed-in customer's addresses, default first. Empty for guests. */
// @guarded-inline: returns only the caller's own addresses
export const myAddresses = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return defs.listByUser.handler(ctx, { userId: identity.subject });
  },
});

// @guarded-inline: writes an address owned by the caller
export const addAddress = mutation({
  args: addressFields,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return defs.add.handler(ctx, { userId: identity.subject, ...args });
  },
});

// @guarded-inline: the package definition rejects an address the caller does not own (FORBIDDEN)
export const updateAddress = mutation({
  args: { addressId: v.id("customerAddresses"), ...addressFields },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return defs.update.handler(ctx, { userId: identity.subject, ...args });
  },
});

// @guarded-inline: the package definition rejects an address the caller does not own (FORBIDDEN)
export const removeAddress = mutation({
  args: { addressId: v.id("customerAddresses") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return defs.remove.handler(ctx, { userId: identity.subject, ...args });
  },
});

// @guarded-inline: the package definition rejects an address the caller does not own (FORBIDDEN)
export const setDefaultAddress = mutation({
  args: { addressId: v.id("customerAddresses") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return defs.setDefault.handler(ctx, { userId: identity.subject, ...args });
  },
});

/** One-shot import of what the customer had saved in their browser. */
// @guarded-inline: imports into the caller's own account only
export const importLocalAddresses = mutation({
  args: {
    addresses: v.array(
      v.object({
        localId: v.string(),
        isDefault: v.optional(v.boolean()),
        ...addressFields,
      })
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return defs.importFromLocal.handler(ctx, {
      userId: identity.subject,
      ...args,
    });
  },
});
