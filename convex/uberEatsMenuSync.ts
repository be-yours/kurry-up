"use node";

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  buildUberEatsMenuPayload,
  collectUnsyncableAllergens,
  type StoreIntegrationRecord,
  type ProductRecord,
  type CategoryRecord,
} from "@be-yours/convex-functions/uberEatsMenuSync";
import { getPackageEnv, isSandbox } from "@be-yours/core/env";

/**
 * Sync menu to a single Uber Eats store.
 *
 * This is a public action callable from the client (e.g. admin UI "Sync Now" button).
 *
 * Flow:
 * 1. Auth check
 * 2. Get the store integration for uberEats
 * 3. Check syncMenu=true and enabled=true
 * 4. Update menuSyncStatus to "syncing"
 * 5. Fetch all products and categories from DB
 * 6. Read global settings to resolve priceMarkup
 * 7. Format as Uber Eats menu payload (with markup / platformOverrides)
 * 8. Read credentials from process.env
 * 9. Call pushMenu() from integrations package
 * 10. Update menuSyncStatus to "success" or "error"
 */
/**
 * Push this store's menu to the platform, on a human's request.
 *
 * Guarded — and deliberately a thin shell. The scheduled sweep runs without a
 * session, so it must NOT come through here: `syncAllStores` used to call this
 * very action, and adding the permission check killed the nightly push. The
 * work now lives in `internalSyncStore`, which the scheduler calls directly.
 */
// @guarded-inline: checks products:write on the store being synced
export const syncStore = action({
  args: { storeId: v.id("stores") },
  handler: async (ctx, args): Promise<unknown> => {
    // Pushing a menu to a delivery platform is a write on the restaurant's
    // catalogue. Nothing checked the caller at all before.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: "products:write",
    });
    return ctx.runAction(internal.uberEatsMenuSync.internalSyncStore, {
      storeId: args.storeId,
    });
  },
});

/**
 * The push itself, with no authorisation of its own.
 *
 * Reachable only from the guarded action above and from the scheduled sweep —
 * an `internalAction` cannot be called from a browser.
 */
export const internalSyncStore = internalAction({
  args: { storeId: v.id("stores") },
  handler: async (ctx, args) => {

    // 1. Get the store integration for uberEats
    // `getByStorePlatform` is store-scoped and needs a session; the scheduler
    // has none, so the sweep died here before reaching the platform at all.
    const integration = await ctx.runQuery(
      internal.storeIntegrations.internalGetByStorePlatform,
      { storeId: args.storeId, platform: "uberEats" }
    ) as StoreIntegrationRecord | null;

    if (!integration) {
      console.error(`No Uber Eats integration found for store ${args.storeId}`);
      return { success: false, error: "No Uber Eats integration configured" };
    }

    // 3. Check syncMenu and enabled flags
    if (!integration.enabled) {
      console.log(`Uber Eats integration disabled for store ${args.storeId}`);
      return { success: false, error: "Integration is disabled" };
    }

    if (!integration.syncMenu) {
      console.log(`Menu sync disabled for store ${args.storeId}`);
      return { success: false, error: "Menu sync is disabled" };
    }

    // 4. Update status to "syncing"
    await ctx.runMutation(internal.storeIntegrations.internalUpdateMenuSyncStatus, {
      storeId: args.storeId,
      platform: "uberEats",
      menuSyncStatus: "syncing",
    });

    try {
      // 5. Fetch all products and categories
      const products = await ctx.runQuery(api.products.list, {
        storeId: args.storeId,
      }) as ProductRecord[];

      const categories = await ctx.runQuery(api.categories.list, {
        storeId: args.storeId,
      }) as CategoryRecord[];

      // 6. Read global settings to extract the Uber Eats price markup
      const settings = await ctx.runQuery(internal.globalSettings.getInternal, {}) as {
        integrations?: { uberEats?: { priceMarkup?: number } }
      } | null;
      const priceMarkup = settings?.integrations?.uberEats?.priceMarkup ?? 0;

      // 7. Build menu payload, applying markup or individual product overrides
      const menuPayload = buildUberEatsMenuPayload(products, categories, priceMarkup);

      // Allergen names the shared vocabulary could not map have no enum member
      // to travel in, so they are not on the wire. That is a gap in a legal
      // disclosure, and it used to be invisible because *every* allergen was
      // dropped. Name the products here so the gap is diagnosable.
      //
      // This is a log, not a dashboard: `menuSyncError` is already stored and
      // already rendered nowhere, and adding a second field nothing displays
      // would repeat the mistake. The product form now offers the canonical
      // list, so an unmapped value is a deliberate free-text entry rather than
      // the default outcome.
      const unsyncable = collectUnsyncableAllergens(products);
      if (unsyncable.length > 0) {
        console.warn(
          `Uber Eats menu sync for store ${args.storeId}: ` +
            `${unsyncable.length} product(s) declare an allergen that is not in the ` +
            `canonical vocabulary, so it was not sent. ` +
            unsyncable
              .map((r) => `${r.productName} (${r.productId}): ${r.values.join(", ")}`)
              .join(" | ")
        );
      }

      // 8. Read credentials from environment
      const pkg = getPackageEnv();
      const clientId = pkg.UBER_EATS_CLIENT_ID;
      const clientSecret = pkg.UBER_EATS_CLIENT_SECRET;
      const sandboxMode = isSandbox("uberEats");

      if (!clientId || !clientSecret) {
        throw new Error("Uber Eats API credentials not configured in environment");
      }

      const credentials = { clientId, clientSecret, sandboxMode };

      // 9. Push menu to Uber Eats
      const { uberEats } = await import("@be-yours/integrations");
      await uberEats.pushMenu(credentials, integration.platformStoreId, menuPayload);

      // 10. Update status to "success"
      await ctx.runMutation(internal.storeIntegrations.internalUpdateMenuSyncStatus, {
        storeId: args.storeId,
        platform: "uberEats",
        menuSyncStatus: "success",
      });

      console.log(`Menu synced successfully for store ${args.storeId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Menu sync failed for store ${args.storeId}:`, errorMessage);

      // Update status to "error"
      await ctx.runMutation(internal.storeIntegrations.internalUpdateMenuSyncStatus, {
        storeId: args.storeId,
        platform: "uberEats",
        menuSyncStatus: "error",
        menuSyncError: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  },
});

/**
 * Spacing between the pushes one sweep books.
 *
 * `runAfter(0)` for every store fired the whole fleet at once. One account,
 * one set of credentials: a deployment with thirty establishments opened thirty
 * simultaneous menu uploads, and Uber's own guidance puts the menu endpoint at
 * roughly one call a minute per store with the token endpoint capped at a
 * hundred an hour. Two seconds apart turns a stampede into a queue.
 */
const SWEEP_STAGGER_MS = 2_000;

/**
 * Sync menu to ALL stores that have Uber Eats sync enabled.
 *
 * A deliberate full sweep — an operator asking for everything to be re-pushed,
 * or a future cron. It is NOT what a catalogue edit triggers any more: product
 * and menu mutations book `internalSyncStore` for the one establishment they
 * changed, through the per-store window in `claimMenuSyncWindow`. Calling this
 * on every edit is what turned a fifty-product import into a hundred sweeps,
 * each of them uploading every restaurant's menu.
 *
 * The pushes are spaced by `SWEEP_STAGGER_MS` so a fleet does not arrive at the
 * platform in one burst.
 */
export const syncAllStores = internalAction({
  args: {},
  handler: async (ctx) => {
    // Query all enabled Uber Eats integrations
    const allIntegrations = await ctx.runQuery(
      internal.storeIntegrations.internalListByPlatformEnabled,
      { platform: "uberEats" }
    ) as StoreIntegrationRecord[];

    // Filter to only those with menu sync enabled
    const syncableIntegrations = allIntegrations.filter(
      (i) => i.syncMenu && i.enabled
    );

    if (syncableIntegrations.length === 0) {
      console.log("No stores with Uber Eats menu sync enabled");
      return { synced: 0 };
    }

    // One push per store, spaced out rather than all at once.
    for (const [index, integration] of syncableIntegrations.entries()) {
      await ctx.scheduler.runAfter(
        index * SWEEP_STAGGER_MS,
        internal.uberEatsMenuSync.internalSyncStore,
        { storeId: integration.storeId as Id<"stores"> }
      );
    }

    console.log(`Scheduled menu sync for ${syncableIntegrations.length} store(s)`);
    return { synced: syncableIntegrations.length };
  },
});
