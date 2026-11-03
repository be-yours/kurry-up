import {
  internalQuery,
  internalMutation,
  query,
  mutation,
} from "./_generated/server";
import * as defs from "@be-yours/convex-functions/uberEatsConnections";
import {
  getAuthUser,
  requireRolePermission,
} from "@be-yours/convex-functions/auth";

/**
 * The connection is one row for the whole deployment, so there is no store to
 * scope a guard against. Same reasoning, and the same permissions, as
 * `globalSettings` and `storeIntegrations`.
 */
async function requireSettingsPermission(
  ctx: Parameters<typeof getAuthUser>[0],
  permission: "settings:read" | "settings:write"
) {
  /* Role AND module (#649): `settings` maps to the `settings` module, so an
     owner who unticked that box for a member narrowed nothing while this
     checked the role alone. */
  return await requireRolePermission(ctx, permission);
}

// === Internal (called from "use node" OAuth actions) ===

/** Full row including encrypted tokens — node actions only. */
export const getConnection = internalQuery(defs.getConnection);

/** Upsert the connection after token exchange/refresh. */
export const upsert = internalMutation(defs.upsert);

// === Client-facing ===

/**
 * Whether this deployment's Uber Eats merchant connection is alive (#274).
 *
 * WHY IT HAD NO WRAPPER. `getStatus` and `disconnect` were written to be the
 * admin's view of the connection — the docblock above `getStatus` says "safe
 * metadata for the admin UI" — and neither was ever exposed. So an owner could
 * complete the OAuth consent and have no way to tell whether it had taken, and
 * no way to end it: the only evidence a connection existed at all was a menu
 * sync succeeding or failing.
 *
 * `settings:read` / `settings:write`, matching `storeIntegrations`: this is one
 * connection for the whole deployment, with no store to scope against, so the
 * guard is a role check rather than the store-scoped seam.
 *
 * The handler returns metadata only — never the encrypted tokens.
 */
// @guarded-inline: checks settings:read by role — the connection is one row
// for the whole deployment, so there is no store to scope against
export const getStatus = query({
  args: defs.getStatus.args,
  handler: async (ctx) => {
    await requireSettingsPermission(ctx, "settings:read");
    return await defs.getStatus.handler(ctx);
  },
});

/**
 * End the connection.
 *
 * Deleting the row is the whole of it: the tokens live nowhere else, and the
 * next sync fails with "No Uber Eats merchant connection" rather than with a
 * stale credential Uber has already revoked.
 */
// @guarded-inline: checks settings:write by role — no store to scope against
export const disconnect = mutation({
  args: defs.disconnect.args,
  handler: async (ctx) => {
    await requireSettingsPermission(ctx, "settings:write");
    return await defs.disconnect.handler(ctx);
  },
});
