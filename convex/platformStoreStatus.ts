"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { StoreIntegrationRecord } from "@be-yours/convex-functions/uberEatsMenuSync";
import { getPackageEnv, isSandbox } from "@be-yours/core/env";

/**
 * Push a store's platform status (ONLINE / PAUSED / OFFLINE) to Uber Eats or
 * Deliveroo.
 *
 * The admin integration card has always had a "Statut sur la plateforme"
 * select, but it only ever wrote `storeIntegrations.storeStatus` in Convex —
 * nothing carried the value to the platform, so pausing a store in the admin
 * left Uber Eats and Deliveroo happily taking orders. This action is what
 * `storeIntegrations.upsert` schedules to close that gap.
 *
 * Internal on purpose: it takes no caller-supplied platform ids and cannot be
 * reached from a browser. The permission check lives on the mutation that
 * schedules it (`settings:write`).
 */
export const pushStoreStatus = internalAction({
  args: {
    storeId: v.id("stores"),
    platform: v.union(v.literal("uberEats"), v.literal("deliveroo")),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const integration = (await ctx.runQuery(
      internal.storeIntegrations.internalGetByStorePlatform,
      { storeId: args.storeId, platform: args.platform }
    )) as StoreIntegrationRecord | null;

    if (!integration) {
      return { success: false, error: "No integration configured" };
    }
    if (!integration.storeStatus) {
      // Nothing chosen in the admin — leave whatever the platform has.
      return { success: false, error: "No store status set" };
    }
    // A disabled integration may still push OFFLINE, and must. Switching the
    // integration off and selecting "Hors ligne" in the same save is exactly
    // how an owner stops serving a platform; refusing the call on `!enabled`
    // left the restaurant live on Uber Eats with the integration switched off.
    // Anything that would put the store BACK on sale is refused, though —
    // a disabled integration is not something to re-open through.
    if (!integration.enabled && integration.storeStatus !== "OFFLINE") {
      return { success: false, error: "Integration is disabled" };
    }

    const pkg = getPackageEnv();

    try {
      if (args.platform === "uberEats") {
        const clientId = pkg.UBER_EATS_CLIENT_ID;
        const clientSecret = pkg.UBER_EATS_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error("Uber Eats API credentials not configured in environment");
        }
        const { uberEats } = await import("@be-yours/integrations");
        await uberEats.updateStoreStatus(
          {
            clientId,
            clientSecret,
            sandboxMode: isSandbox("uberEats"),
          },
          integration.platformStoreId,
          integration.storeStatus,
          { reason: "Updated from the BeYours admin" }
        );
        // NOTE: Uber requires an auto-resume time on PAUSED and the admin card
        // offers no duration, so the client's 30-minute default applies. Uber
        // brings the store back on its own after that while Convex still reads
        // PAUSED — the card will be lying until someone saves it again. Giving
        // the owner a duration is UI work this change does not invent.
      } else {
        const clientId = pkg.DELIVEROO_CLIENT_ID;
        const clientSecret = pkg.DELIVEROO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error("Deliveroo API credentials not configured in environment");
        }
        if (!integration.brandId) {
          throw new Error("Deliveroo integration has no brandId");
        }
        const { deliveroo } = await import("@be-yours/integrations");
        await deliveroo.updateStoreStatus(
          {
            clientId,
            clientSecret,
            sandboxMode: isSandbox("deliveroo"),
          },
          integration.brandId,
          integration.platformStoreId,
          integration.storeStatus
        );
      }

      console.log(
        `Pushed ${args.platform} status ${integration.storeStatus} for store ${args.storeId}`
      );
      return { success: true };
    } catch (error: unknown) {
      // Rethrow rather than swallow. The mutation has already committed, so
      // nothing rolls back and the admin keeps its saved value — but the action
      // is scheduled, and a scheduled action that returns `{success:false}`
      // fails invisibly while the admin shows a success toast. Deliveroo
      // refuses OPEN outside opening hours; that has to be findable.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to push ${args.platform} status for store ${args.storeId}:`,
        message
      );
      throw new Error(
        `Failed to push ${args.platform} store status for ${args.storeId}: ${message}`
      );
    }
  },
});
