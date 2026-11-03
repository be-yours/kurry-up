import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { claimMenuSyncWindow } from "@be-yours/convex-functions/rateLimit";

/**
 * Book the platform menu push for the establishments a write touched.
 *
 * Two things were wrong before the window claim existed, and they multiplied.
 * Every mutation queued `syncAllStores` — for both platforms, unconditionally —
 * and Convex does not dedupe scheduled jobs, so a fifty-product import queued a
 * hundred sweeps. Each of those then pushed the menu of **every** establishment
 * on the deployment, including the ones nobody had touched. Fifty edits in one
 * restaurant meant a hundred full uploads per restaurant on the account, at an
 * endpoint Uber rate-limits to about one call a minute per store.
 *
 * Now: one claim per (platform, establishment) per window, and the push is
 * scoped to the store that actually changed. Everything behind the first edit
 * of a window rides on the upload it already booked — a menu upload is a full
 * overwrite, so the single push at the end of the window carries the burst's
 * final state.
 *
 * Failures stay non-fatal: a catalogue write, a checkout or a cancellation must
 * not be refused because its platform push could not be booked.
 *
 * WHY IT LIVES HERE: `products.ts` and `menus.ts` each carried their own copy,
 * with the same body and different signatures, and the order path needed a
 * third — an order now moves `stock.quantity`, which is exactly what the
 * platforms read as availability. Three copies of a rate-limiting rule is three
 * chances for one of them to drift.
 */
export async function scheduleMenuSync(
  ctx: MutationCtx,
  storeIds: Array<Id<"stores">>
) {
  for (const storeId of Array.from(new Set(storeIds))) {
    try {
      const uberEats = await claimMenuSyncWindow(ctx, "uberEats", storeId);
      if (uberEats.claimed) {
        await ctx.scheduler.runAt(
          uberEats.runAt,
          internal.uberEatsMenuSync.internalSyncStore,
          { storeId }
        );
      }

      const deliveroo = await claimMenuSyncWindow(ctx, "deliveroo", storeId);
      if (deliveroo.claimed) {
        await ctx.scheduler.runAt(
          deliveroo.runAt,
          internal.deliverooMenuSync.internalSyncStore,
          { storeId }
        );
      }
    } catch (error) {
      console.error("Failed to schedule menu sync:", error);
    }
  }
}
