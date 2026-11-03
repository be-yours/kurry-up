import { v } from "convex/values";

import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Accepting or refusing a Deliveroo order by hand (#103, #104).
 *
 * WHAT WAS MISSING. `storeIntegrations.orderMode` offers three settings —
 * `auto_accept`, `auto_reject` and `manual` — and the webhook honours the first
 * two. Under `manual` it logged the mode and did nothing else, so the order sat
 * in the product with no control anywhere that could accept or refuse it: the
 * audit's "trapped failed deliveries" and "missing manual Deliveroo controls".
 * A restaurant that chose manual had no way to run a service.
 *
 * The API calls existed — `deliveroo.acceptOrder` and `deliveroo.rejectOrder` in
 * `@be-yours/integrations` — and only the webhook's automatic paths called
 * them.
 *
 * BOTH SIDES MOVE, AND THE PLATFORM MOVES FIRST. Deliveroo is the party that owes
 * the diner an answer, so the call goes out before the internal status changes: if
 * the platform refuses the decision, nothing here claims it happened. The reverse
 * order would leave a restaurant reading « confirmée » on an order Deliveroo still
 * considers pending.
 */

/** How Deliveroo names the reasons a restaurant may refuse an order. */
const REJECT_REASONS = v.union(
  v.literal("busy"),
  v.literal("closing_early"),
  v.literal("ingredient_unavailable"),
  v.literal("customer_called_to_cancel"),
  v.literal("other")
);

/**
 * Accept it.
 *
 * `orders:update_status` — the permission that exists for advancing an order
 * through its lifecycle, and the one the kitchen and the counter hold. Accepting
 * a delivery order is a service decision, not an owner's.
 */
// @guarded-inline: checks orders:update_status on the order's own store
export const accept = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ accepted: boolean; reason?: string }> => {
    const order = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) return { accepted: false, reason: "order_not_found" };

    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: order.storeId,
      permission: "orders:update_status",
    });

    if (order.source !== "deliveroo" || !order.externalOrderId) {
      return { accepted: false, reason: "not_a_deliveroo_order" };
    }

    const credentials = await deliverooCredentials();
    if (!credentials) return { accepted: false, reason: "deliveroo_not_configured" };

    const { deliveroo } = await import("@be-yours/integrations");
    // The platform first: if this throws, the internal status is untouched and
    // the order is still awaiting a decision, which is true.
    await deliveroo.acceptOrder(credentials, order.externalOrderId);

    await ctx.runMutation(internal.orders.internalUpdateStatus, {
      id: args.orderId as Id<"orders">,
      status: "confirmed",
    });

    return { accepted: true };
  },
});

/** Refuse it, with the reason Deliveroo will show the diner. */
// @guarded-inline: checks orders:update_status on the order's own store
export const reject = action({
  args: { orderId: v.id("orders"), reason: v.optional(REJECT_REASONS) },
  handler: async (ctx, args): Promise<{ rejected: boolean; reason?: string }> => {
    const order = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) return { rejected: false, reason: "order_not_found" };

    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: order.storeId,
      permission: "orders:update_status",
    });

    if (order.source !== "deliveroo" || !order.externalOrderId) {
      return { rejected: false, reason: "not_a_deliveroo_order" };
    }

    const credentials = await deliverooCredentials();
    if (!credentials) return { rejected: false, reason: "deliveroo_not_configured" };

    const { deliveroo } = await import("@be-yours/integrations");
    await deliveroo.rejectOrder(credentials, order.externalOrderId, args.reason ?? "busy");

    // `cancelled`, and `updateStatus` carries the rest: it cancels the kitchen
    // tickets, gives the tracked stock back and writes the audit line. A
    // Deliveroo order is NOT flagged `refund_pending` — Deliveroo took the money
    // and Deliveroo gives it back, which `cancellationPaymentStatus` already
    // knows.
    await ctx.runMutation(internal.orders.internalUpdateStatus, {
      id: args.orderId as Id<"orders">,
      status: "cancelled",
      cancellationReason: `Refusée : ${args.reason ?? "busy"}`,
    });

    return { rejected: true };
  },
});

/**
 * The deployment's Deliveroo credentials, or null.
 *
 * Same resolution as `deliverooWebhook.ts`'s own helper. Duplicated rather than
 * shared because that one is a module-private function in a file this must not
 * import — `deliverooWebhook` registers HTTP handlers, and importing it here
 * would pull those into every action bundle.
 */
async function deliverooCredentials() {
  try {
    const { getPackageEnv, isSandbox } = await import("@be-yours/core/env");
    const pkg = getPackageEnv();
    const clientId = pkg.DELIVEROO_CLIENT_ID;
    const clientSecret = pkg.DELIVEROO_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret, sandboxMode: isSandbox("deliveroo") };
  } catch {
    /*
     * `getPackageEnv` validates the WHOLE package environment and throws when
     * anything it declares is missing — so on a deployment that has not finished
     * onboarding, reading the Deliveroo pair at all threw a ZodError. Caught here
     * because the honest answer to "can we reach Deliveroo?" is no, and the
     * screen can say that: an uncaught throw reaches the browser as a 500 that
     * tells a restaurant mid-service nothing it can act on.
     */
    return null;
  }
}
