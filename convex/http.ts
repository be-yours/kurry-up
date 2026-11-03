/**
 * ALL provider webhooks (Stripe, Deliveroo, Uber Eats, SES) live HERE, on the
 * Convex HTTP router — point provider dashboards to CONVEX_SITE_URL/webhooks/*.
 * The Next.js /api/webhooks/* routes are kept here as 410 tombstones that
 * point integrators at the right URL — a client whose provider dashboard
 * still targets the old path gets an explanation instead of a 404.
 */
import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
import { handleWebhook as uberEatsWebhook } from "./uberEatsWebhook";
import * as uberDirectWebhook from "./uberDirectWebhook";
import { handleWebhook as deliverooWebhook } from "./deliverooWebhookHandler";
import { handleWebhook as stripePaymentWebhook } from "./stripeWebhook";
import { stripeCallback, stripeRefresh, sumupCallback } from "./oauthCallbackHandlers";
import { uberEatsConnectCallback } from "./uberEatsOAuthHttp";
import {
  handleUnsubscribe,
  handleUnsubscribePost,
  handleConfirmOptIn,
  handleSesWebhook,
  handleResendWebhook,
} from "./emailHttpHandlers";
import { handleWebhook as bidStripeWebhook } from "./bidStripeWebhook";
import { healthCheck } from "./health";

const http = httpRouter();

// Liveness. Unauthenticated on purpose — a monitor cannot hold a credential —
// and it answers 503 rather than 200-with-a-sad-body when the deployment's own
// database does not respond. See health.ts.
http.route({
  path: "/health",
  method: "GET",
  handler: healthCheck,
});

// Uber Eats webhooks
http.route({
  path: "/webhooks/uber-eats",
  method: "POST",
  handler: uberEatsWebhook,
});

// Uber Direct webhooks (courier status on our own deliveries)
http.route({
  path: "/webhooks/uber-direct",
  method: "POST",
  handler: uberDirectWebhook.handleWebhook,
});

// Deliveroo webhooks (generic + dedicated order/menu paths)
http.route({
  path: "/webhooks/deliveroo",
  method: "POST",
  handler: deliverooWebhook,
});

http.route({
  path: "/webhooks/deliveroo/order",
  method: "POST",
  handler: deliverooWebhook,
});

http.route({
  path: "/webhooks/deliveroo/menu",
  method: "POST",
  handler: deliverooWebhook,
});

// Stripe payment webhook
http.route({
  path: "/webhooks/stripe",
  method: "POST",
  handler: stripePaymentWebhook,
});

// OAuth payment provider callbacks
http.route({
  path: "/connect/stripe/callback",
  method: "GET",
  handler: stripeCallback,
});

http.route({
  path: "/connect/stripe/refresh",
  method: "GET",
  handler: stripeRefresh,
});

http.route({
  path: "/connect/sumup/callback",
  method: "GET",
  handler: sumupCallback,
});

// Uber Eats OAuth (eats.pos_provisioning) merchant consent callback
http.route({
  path: "/connect/uber-eats/callback",
  method: "GET",
  handler: uberEatsConnectCallback,
});

// Email unsubscribe (public link in every campaign email)
http.route({
  path: "/email/unsubscribe",
  method: "GET",
  handler: handleUnsubscribe,
});

// The half that actually unsubscribes. Separate from GET because link scanners
// fetch GETs in delivered mail, and because RFC 8058 one-click is a POST.
http.route({
  path: "/email/unsubscribe",
  method: "POST",
  handler: handleUnsubscribePost,
});

// Email double opt-in confirmation
http.route({
  path: "/email/confirm",
  method: "GET",
  handler: handleConfirmOptIn,
});

// AWS SES webhook (bounces, complaints, delivery, open, click via SNS)
http.route({
  path: "/webhooks/ses",
  method: "POST",
  handler: handleSesWebhook,
});

// Resend webhook (the same five events, for a deployment on EMAIL_PROVIDER=resend)
//
// A client whose AWS SES production-access request was refused runs on Resend,
// and SNS never calls the route above. Without this one nothing suppressed a
// dead address and nothing recorded a spam report on that deployment.
http.route({
  path: "/webhooks/resend",
  method: "POST",
  handler: handleResendWebhook,
});

// BeYours Stripe webhook (subscription lifecycle)
http.route({
  path: "/webhooks/stripe-bid",
  method: "POST",
  handler: bidStripeWebhook,
});

// Register Better Auth HTTP routes (sign-in, sign-up, callbacks, etc.)
authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
