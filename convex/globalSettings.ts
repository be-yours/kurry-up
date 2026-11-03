import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import * as defs from "@be-yours/convex-functions/globalSettings";
import {
  getAuthUser,
  requireRolePermission,
} from "@be-yours/convex-functions/auth";
import { publicGlobalSettings } from "@be-yours/convex-functions/publicGlobalSettings";

/**
 * Global settings are owner-level, not store-level, so the store-scoped
 * `storeMutation` seam does not apply. Authorisation is a plain permission
 * check instead.
 *
 * This used to be a hardcoded `["owner", "admin", "super_admin"]` list. Two of
 * those three roles do not exist in the schema (`super_admin`, `client_admin`,
 * `manager`, `kitchen`, `waiter`, `delivery`, `customer`), so the restaurant
 * owner — a `client_admin` — was refused on every save. `settings:write` is
 * held by exactly SUPER_ADMIN and CLIENT_ADMIN, which is the intent.
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

// === Queries ===

/**
 * Public query: an allow-list, not a strip (#620).
 *
 * `stripSensitiveGlobalSettings` used to take the whole document, delete the
 * four Uber Direct credentials and return the rest — so every field nobody
 * thought about shipped public. An anonymous visitor received
 * `payments.paypalEmail`, both platform `priceMarkup` percentages,
 * `systemLock.lockedBy`, `appliedMigrations`, `deployedAppVersion` and
 * `lastBackupAt`.
 *
 * `publicGlobalSettings` builds the answer from named keys instead, in the
 * engine so both apps get it, and `global-settings-public-shape.test.ts` pins
 * the exact set. A field added to the table is private until somebody adds it
 * there and says why.
 */

// @public-by-design: the storefront needs tax rate, delivery config and
// opening rules before any sign-in. The answer is built from an allow-list —
// see `publicGlobalSettings` — so nothing else travels.
export const get = query({
  args: defs.get.args,
  handler: async (ctx) => {
    const settings = await defs.get.handler(ctx);
    return publicGlobalSettings(settings as Record<string, unknown> | null);
  },
});

/** Admin-only query: returns full global settings including integration secrets */
// @guarded-inline: settings:read / settings:write checked in the handler
export const getAdmin = query({
  args: defs.get.args,
  handler: async (ctx) => {
    await requireSettingsPermission(ctx, "settings:read");
    return defs.get.handler(ctx);
  },
});

/** Internal query: returns full settings for server-side functions (no auth needed) */
export const getInternal = internalQuery({
  args: defs.get.args,
  handler: async (ctx) => {
    return defs.get.handler(ctx);
  },
});

// === Mutations ===

// @guarded-inline: settings:read / settings:write checked in the handler
export const upsert = mutation({
  args: defs.upsert.args,
  handler: async (ctx, args) => {
    await requireSettingsPermission(ctx, "settings:write");
    return defs.upsert.handler(ctx, args);
  },
});
/**
 * Record what the card provider said about our credentials.
 *
 * Internal: written by the nightly probe and by the checkout action, both of
 * which run with no user identity. Read back by `paymentAvailability.get`,
 * which is what decides whether the checkout arms its card tile (#411).
 */
export const internalRecordCardProviderHealth = internalMutation(
  defs.recordCardProviderHealth
);
