/**
 * Uber Direct — status and courier webhook
 *
 * Receives `dapi.status_changed` and keeps the order in step with the courier.
 * Receives the courier's details on the same events and on `courier_update`
 * — who is coming, where they are, when they will arrive — and records them
 * for the diner's live tracking (`orders.getDeliveryTracking`). The newer
 * Deliveries API's `event.delivery_status` / `event.courier_update` are read
 * for those details too; only `dapi.status_changed` moves the delivery status,
 * because only its `meta.status` speaks the vocabulary the order machine maps.
 *
 * Two rules govern every early return below:
 *
 * - **An unverified body is never read.** The signature is checked before the
 *   payload is parsed, in every environment. There is no sandbox bypass here,
 *   for the same reason there is none on the Deliveroo route.
 * - **A recognised-but-unusable event answers 200.** Uber retries on anything
 *   else, and retrying will not fix an order we do not have or a status we do
 *   not know. Only a genuine server fault deserves a 5xx.
 */

import { httpAction } from "./_generated/server";
import { captureBackendError } from "./errorReporting";
import { internal } from "./_generated/api";

// @guarded-inline: the HMAC is checked before the body is parsed — see the
// note at the top of this file
export const handleWebhook = httpAction(async (ctx, request) => {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-uber-signature") ?? "";

    const { getPackageEnv } = await import("@be-yours/core/env");
    const pkg = getPackageEnv();
    // Uber Direct rides on the same app credentials as Uber Eats; a dedicated
    // webhook secret takes precedence when one is configured.
    const signingSecret =
      pkg.UBER_DIRECT_WEBHOOK_SECRET ||
      pkg.UBER_EATS_WEBHOOK_SECRET ||
      pkg.UBER_EATS_CLIENT_SECRET;

    if (!signingSecret) {
      console.error("[Uber Direct Webhook] No signing secret configured");
      await captureBackendError(ctx, {
        error: new Error(
          "UBER_DIRECT_WEBHOOK_SECRET, UBER_EATS_WEBHOOK_SECRET and UBER_EATS_CLIENT_SECRET are all unset — every courier status update is refused with 503",
        ),
        source: "uberDirectWebhook",
        level: "fatal",
        tags: { step: "no-signing-secret" },
      });
      return new Response("Uber Direct credentials not configured", {
        status: 503,
      });
    }

    const { uberDirect } = await import("@be-yours/integrations");
    const isValid = await uberDirect.verifyUberDirectSignature(
      rawBody,
      signature,
      signingSecret
    );

    if (!isValid) {
      console.error("[Uber Direct Webhook] Invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Malformed JSON", { status: 400 });
    }

    // Read once, defensively: every string capped, every URL `https:`, every
    // coordinate on the globe. The signature proves who sent the body, not
    // that its fields are sane — and they end up on a public query.
    const snapshot = uberDirect.parseDeliveryWebhookSnapshot(payload);
    const isStatusEvent = uberDirect.isDeliveryStatusEvent(snapshot.eventType);
    const isCourierEvent = uberDirect.isCourierUpdateEvent(snapshot.eventType);

    // Uber sends other event types on the same endpoint; acknowledge and drop.
    if (!isStatusEvent && !isCourierEvent) {
      return new Response("", { status: 200 });
    }

    const eventId =
      (payload as { event_id?: unknown; id?: unknown } | null)?.event_id ??
      (payload as { id?: unknown } | null)?.id ??
      "?";
    const deliveryId = snapshot.deliveryId;
    if (!deliveryId) {
      console.error(
        `[Uber Direct Webhook] Event ${String(eventId)} has no delivery id`
      );
      return new Response("", { status: 200 });
    }

    // Status first, and only from the event whose vocabulary the order machine
    // maps: a delivery that has just COMPLETED must already read as finished
    // when the snapshot below decides whether to keep a courier position.
    if (snapshot.eventType === "dapi.status_changed") {
      const status = (payload as { meta?: { status?: unknown } } | null)?.meta?.status;
      if (typeof status !== "string" || !status) {
        console.error(
          `[Uber Direct Webhook] Event ${String(eventId)} has no order_id or status`
        );
      } else {
        const result = await ctx.runMutation(
          internal.uberDirectInternal.applyDeliveryStatus,
          { deliveryId, status }
        );

        if (!result.applied) {
          console.warn(
            `[Uber Direct Webhook] Dropped ${status} for ${deliveryId}: ${result.reason}`
          );
        }
      }
    }

    if (uberDirect.snapshotHasDetails(snapshot)) {
      const recorded = await ctx.runMutation(
        internal.uberDirectInternal.applyDeliverySnapshot,
        {
          deliveryId,
          ...(snapshot.courier ? { courier: snapshot.courier } : {}),
          ...(snapshot.courierLocation
            ? { courierLocation: snapshot.courierLocation }
            : {}),
          ...(snapshot.pickupEta !== undefined ? { pickupEta: snapshot.pickupEta } : {}),
          ...(snapshot.dropoffEta !== undefined ? { dropoffEta: snapshot.dropoffEta } : {}),
          ...(snapshot.trackingUrl ? { trackingUrl: snapshot.trackingUrl } : {}),
        }
      );
      if (!recorded.applied && recorded.reason !== "NOTHING_TO_RECORD") {
        console.warn(
          `[Uber Direct Webhook] Courier details for ${deliveryId} not recorded: ${recorded.reason}`
        );
      }
    }

    return new Response("", { status: 200 });
  } catch (error) {
    // A genuine fault on our side: let Uber retry.
    console.error("[Uber Direct Webhook] Unhandled error", error);
    await captureBackendError(ctx, {
      error,
      source: "uberDirectWebhook",
      tags: { step: "unhandled" },
    });
    return new Response("Internal error", { status: 500 });
  }
});
