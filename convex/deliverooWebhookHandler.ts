import { httpAction } from "./_generated/server";
import { captureBackendError } from "./errorReporting";
import { internal } from "./_generated/api";

/**
 * Deliveroo webhook HTTP handler with signature verification.
 *
 * Receives webhooks from Deliveroo, verifies the HMAC-SHA256 signature,
 * then dispatches to internal actions for processing.
 *
 * Signature: HMAC-SHA256(secret, sequence_guid_bytes + space + raw_body_bytes)
 * Uses raw ArrayBuffer (not text) per Deliveroo docs.
 */
// @guarded-inline: verifies Deliveroo's HMAC-SHA256 over sequence guid and
// raw body before acting on either
export const handleWebhook = httpAction(async (ctx, request) => {
  try {
    // Read as ArrayBuffer first (required for correct HMAC verification)
    const buffer = await request.arrayBuffer();
    const rawBody = new TextDecoder().decode(buffer);

    const signature = request.headers.get("x-deliveroo-hmac-sha256") ?? "";
    const sequenceGuid = request.headers.get("x-deliveroo-sequence-guid") ?? "";

    console.log(`[Deliveroo Webhook] Received - sig: ${signature ? "present" : "missing"}, guid: ${sequenceGuid || "none"}, bodyLen: ${rawBody.length}`);

    // Read signing secret from environment (BeYours platform credentials)
    const { getPackageEnv } = await import("@be-yours/core/env");
    const pkg = getPackageEnv();
    const webhookSecret = pkg.DELIVEROO_WEBHOOK_SECRET;
    const clientSecret = pkg.DELIVEROO_CLIENT_SECRET;
    const signingSecret = webhookSecret || clientSecret;

    if (!signingSecret) {
      console.error("[Deliveroo Webhook] No signing secret configured");
      await captureBackendError(ctx, {
        error: new Error(
          "DELIVEROO_WEBHOOK_SECRET and DELIVEROO_CLIENT_SECRET are both unset — every Deliveroo delivery is refused with 503",
        ),
        source: "deliverooWebhook",
        level: "fatal",
        tags: { step: "no-signing-secret" },
      });
      return new Response("Deliveroo credentials not configured in environment", { status: 503 });
    }

    // Verify webhook signature using raw bytes
    let isValid = false;
    if (signature && sequenceGuid) {
      isValid = await verifySignature(buffer, signature, sequenceGuid, signingSecret);
    }

    console.log(`[Deliveroo Webhook] Signature verification: ${isValid ? "VALID" : "INVALID"}`);

    if (!isValid) {
      // Fail-closed in ALL environments, including sandbox. Deliveroo signs
      // sandbox webhooks too, so a correct DELIVEROO_WEBHOOK_SECRET must be
      // configured. Never process an unverified webhook (forgery risk).
      console.error("[Deliveroo Webhook] Invalid signature - rejecting");
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse the payload to determine event type
    const payload = JSON.parse(rawBody) as {
      event?: string;
      body?: { order?: Record<string, unknown> };
      order?: Record<string, unknown>;
    };

    // Deliveroo's own docs spell the order events two ways (`order.new` and
    // `orders.new`); the kind is what the routing below reads.
    const { deliveroo } = await import("@be-yours/integrations");
    const event = payload.event ?? "";
    const kind = deliveroo.normalizeDeliverooEvent(event);
    const order = payload.body?.order ?? payload.order;

    // What the HTTP status means to Deliveroo, and why each branch below picks
    // the one it picks.
    //
    // A 2xx is an acknowledgement: Deliveroo considers the event delivered and
    // never sends it again. Anything else is retried with exponential backoff
    // — up to 6 minutes for an ASAP `order.new`, 30 minutes for a scheduled
    // one, 10 minutes for `order.status_update`.
    //
    // This handler used to answer 200 unconditionally, including when
    // processing had failed. A Deliveroo order that could not be routed was
    // therefore lost in silence: no retry, no ticket, no trace outside a log
    // line, and a customer waiting on food nobody was cooking.
    //
    // The opposite mistake is just as real. The Order API success rate must
    // stay at or above 98% or partner access can be suspended, so a benign
    // no-op must NOT be dressed up as a failure. Hence three outcomes, not
    // two:
    //
    //   - processed, duplicate, or an event we deliberately ignore  -> 200
    //   - failed, and a redelivery could succeed                    -> 500
    //   - failed, and a redelivery would fail identically           -> 200
    //
    // The processor itself makes the last distinction: it knows whether the
    // failure was a malformed body (hopeless) or a lookup that could succeed
    // on the next attempt. See `retryable` in `deliverooWebhook.ts`.
    if (kind === "rider.status_update") {
      const result = await ctx.runAction(internal.deliverooWebhook.processRiderWebhook, {
        payload: rawBody,
      });
      if (!result.success && result.retryable !== false) {
        console.error(`[Deliveroo Webhook] Rider processing failed, asking for a retry: ${result.error ?? "unknown error"}`);
        return new Response("Rider processing failed", { status: 500 });
      }
    } else if (kind === "menu.upload_result") {
      const result = await ctx.runAction(internal.deliverooWebhook.processMenuWebhook, {
        payload: rawBody,
      });
      if (!result.success && result.retryable !== false) {
        console.error(`[Deliveroo Webhook] Menu processing failed, asking for a retry: ${result.error ?? "unknown error"}`);
        return new Response("Menu processing failed", { status: 500 });
      }
      if (!result.success) {
        console.error(`[Deliveroo Webhook] Menu processing failed permanently, not retryable: ${result.error ?? "unknown error"}`);
      }
    } else if (kind === "order.new" || kind === "order.status_update" || order) {
      const result = await ctx.runAction(internal.deliverooWebhook.processOrderWebhook, {
        payload: rawBody,
      });
      if (!result.success && result.retryable !== false) {
        console.error(`[Deliveroo Webhook] Order processing failed, asking for a retry: ${result.error ?? "unknown error"}`);
        return new Response("Order processing failed", { status: 500 });
      }
      if (!result.success) {
        console.error(`[Deliveroo Webhook] Order processing failed permanently, not retryable: ${result.error ?? "unknown error"}`);
      }
    } else {
      // An event type we do not handle. Nothing was lost and nothing will
      // change on redelivery, so acknowledge it.
      console.log(`Unknown Deliveroo webhook event: ${event || "no event field"}`);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Deliveroo webhook error:", error);
    await captureBackendError(ctx, {
      error,
      source: "deliverooWebhook",
      tags: { step: "unhandled" },
    });
    return new Response("Internal error", { status: 500 });
  }
});

/**
 * Verify Deliveroo's HMAC-SHA256 over the raw bytes.
 *
 * THIS DELEGATES NOW, AND THAT IS THE FIX (#433.2). There were two verifiers.
 * `packages/integrations/src/deliveroo/security.ts` is the hardened one — and
 * it was dead code:
 *
 *     $ grep -rn "verifyWebhookSignature" packages apps --include='*.ts' \
 *         | grep -v __tests__ | grep -v /dist/
 *     packages/integrations/src/deliveroo/security.ts:44:export async function …
 *     apps/themes/e2e/deliveroo/webhook-signing.test.ts:59
 *     apps/reference/e2e/deliveroo/webhook-signing.test.ts:59
 *
 * Only the two test files imported it. The delivered route had its own copy,
 * which DROPPED the package's hex-format check and its 64-character length
 * check, and stripped a `sha256=` prefix the package deliberately refuses.
 *
 * So `webhook-signing.test.ts`'s own docblock — *"The real verifier and the
 * real route. `verifyWebhookSignature` … is put in front of the code that will
 * judge it in production"* — was false of the tree it ran on. The suite proved
 * a function no client executed, over a route it never touched.
 *
 * The barrel is safe to import here: nothing under `packages/integrations/src`
 * touches a Node built-in, so the V8 runtime this `httpAction` runs in can
 * bundle it. Checked rather than assumed —
 * `grep -rn 'from "node:' packages/integrations/src` is empty.
 */
async function verifySignature(
  body: ArrayBuffer,
  signature: string,
  sequenceGuid: string,
  secret: string
): Promise<boolean> {
  const { deliveroo } = await import("@be-yours/integrations");
  const isValid = await deliveroo.verifyWebhookSignature(
    body,
    signature,
    sequenceGuid,
    secret
  );

  if (!isValid) {
    // No fragment of the signature, and no confirmation that a secret is
    // configured. The first is a free oracle for an attacker probing the
    // endpoint; the second told them the endpoint is live and misconfigured
    // rather than simply refusing. A refusal says it refused.
    console.warn("[Deliveroo] webhook signature rejected");
  }

  return isValid;
}
