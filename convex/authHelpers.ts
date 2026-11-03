/**
 * Internal auth helpers for actions that don't have ctx.db.
 *
 * Actions use ctx.runQuery to call these internal queries,
 * which propagate the auth context.
 */

import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  getAuthUser,
  requireRolePermission,
  requireStorePermission,
} from "@be-yours/convex-functions/auth";
import { hasPermission, type Permission } from "@be-yours/core/auth/rbac";
import {
  releaseImageToProductQuota as releaseImageToProductQuota_,
  reserveImageToProductQuota as reserveImageToProductQuota_,
} from "@be-yours/convex-functions/blogAutoGuards";

/**
 * Verify the current user has a specific permission on a store.
 * Call from actions via ctx.runQuery(internal.authHelpers.checkStorePermission, {...})
 */
export const checkStorePermission = internalQuery({
  args: {
    storeId: v.id("stores"),
    permission: v.string(),
  },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requireStorePermission(ctx, args.storeId, args.permission as any);
    return true;
  },
});

/**
 * Take one Image-to-Product analysis out of this month's quota.
 *
 * Reserved before the first paid call, not counted after the last one. The
 * analysis makes three OpenAI requests — a vision pass, an enrichment pass and
 * up to several image generations — and the counter used to move seventy-five
 * lines after the check, so concurrent requests all read the same count and all
 * passed. Reading and writing in one mutation is what makes the cap a cap.
 */
export const reserveImageToProductQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    return reserveImageToProductQuota_(ctx, ownerId);
  },
});

/** Hand the analysis slot back when nothing came of it. */
export const releaseImageToProductQuota = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    await releaseImageToProductQuota_(ctx, ownerId);
  },
});

/**
 * Verify the caller holds a permission — role AND module — with no store.
 *
 * For deployment-wide operations that have no storeId to check against:
 * connecting a payment provider, starting an Uber Eats OAuth flow, asking S3
 * for an upload URL. `checkStorePermission` cannot express those — there is no
 * store — and "is logged in" is not an answer either, because that includes
 * every customer who has ever ordered a pizza.
 *
 * BOTH GATES (#649). This ran the role check alone, and it is the widest of the
 * inline guards: nine call sites reach it, asking for `content:write`,
 * `settings:write` and `settings:read`. All three map to a module — `content` to
 * `marketing`, `settings` to `settings` — so an owner who unticked either box
 * for a member narrowed the sidebar and narrowed none of these. One fix here
 * covers all nine.
 *
 * `requireRolePermission` fails closed on an unknown role or permission string,
 * so a typo denies rather than grants, and refuses the module separately so the
 * message says which of the two gates closed.
 */
export const checkPermission = internalQuery({
  args: { permission: v.string() },
  handler: async (ctx, args) => {
    await requireRolePermission(ctx, args.permission as Permission);
    return true;
  },
});
