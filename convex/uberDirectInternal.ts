/**
 * Uber Direct — internal mutations
 *
 * The only writers of the Uber Direct fields on an order.
 *
 * NO "use node" — Convex allows nothing but actions in a Node.js module, and
 * uberDirect.ts needs "use node" for the Uber API calls. Defining these there
 * fails the whole push with `InvalidModules`, so they live here instead. Both
 * the actions in uberDirect.ts and the webhook call into this module.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Attach a freshly booked delivery to its order. */
export const recordDelivery = internalMutation({
  args: {
    orderId: v.id("orders"),
    deliveryId: v.string(),
    trackingUrl: v.optional(v.string()),
    fee: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");

    await ctx.db.patch(args.orderId, {
      uberDirectDeliveryId: args.deliveryId,
      uberDirectStatus: "SCHEDULED" as const,
      uberDirectStatusAt: Date.now(),
      ...(args.trackingUrl ? { uberDirectTrackingUrl: args.trackingUrl } : {}),
      ...(args.fee !== undefined ? { uberDirectFee: args.fee } : {}),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Apply a courier status to the order it belongs to.
 *
 * Called by the webhook, so it must be idempotent: Uber replays events, and a
 * replay must not throw — a 500 here puts us in a retry loop.
 */
export const applyDeliveryStatus = internalMutation({
  args: {
    deliveryId: v.string(),
    status: v.string(),
    trackingUrl: v.optional(v.string()),
    /** Overrides the status-derived alert. A cancellation we asked for is a
     *  known state, not an incident, and must not raise a flag. */
    needsAttention: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean; reason?: string }> => {
    const { uberDirect } = await import("@be-yours/integrations");

    if (!uberDirect.isUberDirectStatus(args.status)) {
      // An unknown status must stall the delivery, not move the order
      // somewhere arbitrary. Recorded as a no-op, not an error.
      console.error(
        `[Uber Direct] Unknown status "${args.status}" for delivery ${args.deliveryId}`
      );
      return { applied: false, reason: "UNKNOWN_STATUS" };
    }

    const order = await ctx.db
      .query("orders")
      .withIndex("by_uberDirectDeliveryId", (q) =>
        q.eq("uberDirectDeliveryId", args.deliveryId)
      )
      .first();

    if (!order) {
      // A delivery we never booked, or one booked by another environment.
      console.error(`[Uber Direct] No order for delivery ${args.deliveryId}`);
      return { applied: false, reason: "ORDER_NOT_FOUND" };
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      uberDirectStatus: args.status,
      uberDirectStatusAt: now,
      updatedAt: now,
    };
    if (args.trackingUrl) patch.uberDirectTrackingUrl = args.trackingUrl;
    const needsAttention =
      args.needsAttention ?? uberDirect.requiresManualIntervention(args.status);
    if (needsAttention) {
      patch.uberDirectFailedAt = now;
    }
    await ctx.db.patch(order._id, patch);

    const target = uberDirect.orderStatusForDeliveryStatus(args.status);
    if (!target || order.status === target) {
      return { applied: true };
    }

    // The order machine has the final say. A courier update that would make an
    // illegal move is recorded on the delivery and dropped for the order —
    // an operator who already advanced the order by hand must not be undone.
    const { canTransitionOrderStatus } = await import(
      "@be-yours/convex-schema"
    );
    if (!canTransitionOrderStatus(order.status, target)) {
      console.warn(
        `[Uber Direct] ${args.status} would move order ${order.orderNumber} ${order.status} -> ${target}, which the status machine forbids`
      );
      return { applied: true, reason: "TRANSITION_REFUSED" };
    }

    await ctx.db.patch(order._id, { status: target, updatedAt: now });
    return { applied: true };
  },
});

/**
 * Record what a webhook said about the courier: who, where, and when.
 *
 * Separate from `applyDeliveryStatus` because it answers a different question
 * and arrives on different events — `courier_update` carries a position and no
 * status at all. The webhook runs the status first, so a delivery that has
 * just COMPLETED is already terminal when this reads it.
 *
 * The arguments are already reduced by `parseDeliveryWebhookSnapshot` — capped
 * strings, `https:` URLs, coordinates on the globe, plausible ETAs — and the
 * validators below hold the shape. What is decided here is only what the ORDER
 * accepts:
 *
 *  - A position is dropped once the delivery is COMPLETED or FAILED. The
 *    courier's whereabouts after the hand-over are theirs, not the order's.
 *  - The courier is MERGED over what is stored, so an update naming only the
 *    vehicle does not erase the name an earlier one gave.
 *
 * `updatedAt` is deliberately left alone. A courier reports its position every
 * few seconds, and bumping the order's modification time at that rate would
 * make every courier ping look like an edit to the order; `at` on the position
 * is what says how fresh it is.
 *
 * Idempotent and never throws on an unknown delivery, for the same reason as
 * `applyDeliveryStatus`: Uber replays, and a 500 is a retry loop.
 */
export const applyDeliverySnapshot = internalMutation({
  args: {
    deliveryId: v.string(),
    courier: v.optional(
      v.object({
        name: v.optional(v.string()),
        phone: v.optional(v.string()),
        imageUrl: v.optional(v.string()),
        vehicleType: v.optional(v.string()),
        rating: v.optional(v.number()),
      })
    ),
    courierLocation: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    pickupEta: v.optional(v.number()),
    dropoffEta: v.optional(v.number()),
    trackingUrl: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ applied: boolean; reason?: string; locationDropped?: boolean }> => {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_uberDirectDeliveryId", (q) =>
        q.eq("uberDirectDeliveryId", args.deliveryId)
      )
      .first();

    if (!order) {
      console.error(`[Uber Direct] No order for delivery ${args.deliveryId}`);
      return { applied: false, reason: "ORDER_NOT_FOUND" };
    }

    const { uberDirect } = await import("@be-yours/integrations");
    const finished =
      order.uberDirectStatus !== undefined &&
      uberDirect.isTerminalUberDirectStatus(order.uberDirectStatus);

    const patch: {
      uberDirectCourier?: NonNullable<typeof args.courier>;
      uberDirectCourierLocation?: { lat: number; lng: number; at: number };
      uberDirectPickupEta?: number;
      uberDirectDropoffEta?: number;
      uberDirectTrackingUrl?: string;
    } = {};

    if (args.courier) {
      patch.uberDirectCourier = { ...(order.uberDirectCourier ?? {}), ...args.courier };
    }
    const locationDropped = args.courierLocation !== undefined && finished;
    if (args.courierLocation && !finished) {
      patch.uberDirectCourierLocation = { ...args.courierLocation, at: Date.now() };
    }
    if (args.pickupEta !== undefined) patch.uberDirectPickupEta = args.pickupEta;
    if (args.dropoffEta !== undefined) patch.uberDirectDropoffEta = args.dropoffEta;
    if (args.trackingUrl) patch.uberDirectTrackingUrl = args.trackingUrl;

    if (Object.keys(patch).length === 0) {
      return { applied: false, reason: "NOTHING_TO_RECORD", locationDropped };
    }

    await ctx.db.patch(order._id, patch);
    return { applied: true, locationDropped };
  },
});
