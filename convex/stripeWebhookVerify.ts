"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * Internal action that verifies the Stripe webhook signature using the Stripe SDK (Node.js).
 * Called by the httpAction in stripeWebhook.ts which cannot use "use node".
 *
 * WHY IT NORMALISES FIVE EVENT TYPES AND NOT ONE: it used to extract a payload
 * for `checkout.session.completed` alone, and the handler acted on that alone.
 * `payment_intent.succeeded`, `payment_intent.payment_failed`,
 * `charge.refunded` and `charge.dispute.created` were verified, answered 200,
 * and thrown away — so a refund issued from the Stripe dashboard never reached
 * our books, and a charge whose completion event was lost had nothing else that
 * could confirm it.
 *
 * THE FIELD THAT IS USUALLY NOT THERE: a hosted checkout's `metadata.orderId`
 * lives on the SESSION, because `createCheckoutSession` sets it there, and
 * Stripe does not copy it to the session's payment intent. So an intent minted
 * by a hosted checkout, and every charge, carry none of it, and the handler
 * resolves them through `payments.externalId` — where that intent was stored
 * when the charge was first settled.
 *
 * The exception is an intent the native app's card sheet confirmed.
 * `createPaymentIntent` creates that intent itself and writes `orderId` and
 * `storeId` into ITS metadata, so `payment_intent.succeeded` reports them, and
 * the handler binds and settles the order the way it does a checkout session.
 */
export const verify = internalAction({
  args: {
    body: v.string(),
    signature: v.string(),
  },
  handler: async (_ctx, args): Promise<Record<string, unknown>> => {
    const Stripe = (await import("stripe")).default;
    const { getSiteEnv } = await import("@be-yours/core/env");
    const site = getSiteEnv();

    const secretKey = site.STRIPE_SECRET_KEY;
    const webhookSecret = site.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) {
      return { error: "not_configured" };
    }

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    try {
      const event = await stripe.webhooks.constructEventAsync(
        args.body,
        args.signature,
        webhookSecret
      );

      // The delivery's own id, on every path. Stripe retries until it gets a
      // 2xx and may repeat a delivery even after one, so the caller needs this
      // to tell a retry from a new event. It was not returned at all, which is
      // why the handler had no way to deduplicate.
      const envelope = { eventId: event.id, eventType: event.type };

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        return {
          ...envelope,
          orderId: session.metadata?.orderId ?? null,
          // A TABLE BOOKING's payment row, when the session was opened for one
          // (`reservationProviders.createDepositSession` / `createGuaranteeSession`).
          reservationPaymentId: session.metadata?.reservationPaymentId ?? null,
          sessionId: session.id,
          storeId: session.metadata?.storeId ?? null,
          paymentStatus: session.payment_status ?? null,
          amountTotal: session.amount_total ?? null,
          currency: session.currency?.toUpperCase() ?? "EUR",
          paymentIntent: String(session.payment_intent ?? session.id),
        };
      }

      if (event.type === "payment_intent.succeeded") {
        const intent = event.data.object;
        // Present only on an intent the native card sheet confirmed; see the
        // note at the top. `null`, never "", so the handler's `!result.orderId`
        // cannot be fooled by an empty string.
        const metadata = intent.metadata ?? {};
        return {
          ...envelope,
          // The intent id IS what `payments.externalId` holds for a Stripe
          // charge, so this is the whole of the lookup key.
          paymentIntent: intent.id,
          orderId: metadata.orderId || null,
          // Present on the intent of a booking's deposit and on a no-show fee charged
          // off-session: both are written with our payment row's id.
          reservationPaymentId: metadata.reservationPaymentId || null,
          storeId: metadata.storeId || null,
          // What was COLLECTED, not what was asked for: this is the figure the
          // settlement guard binds to the order total.
          amountTotal: intent.amount_received ?? null,
          currency: intent.currency?.toUpperCase() ?? "EUR",
        };
      }

      if (event.type === "payment_intent.payment_failed") {
        const intent = event.data.object;
        return {
          ...envelope,
          paymentIntent: intent.id,
          reservationPaymentId: intent.metadata?.reservationPaymentId || null,
          failureCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
          amountTotal: intent.amount ?? null,
          currency: intent.currency?.toUpperCase() ?? "EUR",
          failureMessage:
            intent.last_payment_error?.message ??
            intent.last_payment_error?.code ??
            null,
        };
      }

      if (event.type === "charge.refunded") {
        const charge = event.data.object;
        return {
          ...envelope,
          paymentIntent:
            typeof charge.payment_intent === "string"
              ? charge.payment_intent
              : (charge.payment_intent?.id ?? null),
          chargeId: charge.id,
          currency: charge.currency?.toUpperCase() ?? "EUR",
          // CUMULATIVE for the charge, not the amount of this one refund. The
          // handler stores it as a total for exactly that reason.
          amountRefunded: charge.amount_refunded ?? null,
          fullyRefunded: charge.refunded === true,
        };
      }

      if (event.type === "charge.dispute.created") {
        const dispute = event.data.object;
        const disputedIntent =
          typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : (dispute.payment_intent?.id ?? null);
        // Stripe orders no two events: a dispute can arrive before the event that settles the
        // charge, when no row of ours holds the intent id yet. The intent's own metadata names
        // a table booking's row, so the handler can still find it. A failed read only loses
        // that fallback, never the event.
        let reservationPaymentId: string | null = null;
        if (disputedIntent) {
          try {
            // Through the adapter, so that the bench's provider stand-in is honoured.
            const { REAL_PROVIDER_BASES, resolveProviderBase, stripeClient } = await import(
              "@be-yours/convex-functions/reservationProviders"
            );
            const intent = await stripeClient(
              secretKey,
              fetch,
              resolveProviderBase("stripe", process.env, REAL_PROVIDER_BASES.stripe)
            ).retrievePaymentIntent(disputedIntent);
            reservationPaymentId = intent?.metadata?.reservationPaymentId || null;
          } catch {
            reservationPaymentId = null;
          }
        }
        return {
          ...envelope,
          reservationPaymentId,
          paymentIntent: disputedIntent,
          chargeId:
            typeof dispute.charge === "string"
              ? dispute.charge
              : (dispute.charge?.id ?? null),
          currency: dispute.currency?.toUpperCase() ?? "EUR",
          // Stripe withdraws the disputed amount immediately. It is money that
          // has left, so it is recorded the same way a refund is.
          amountDisputed: dispute.amount ?? null,
          disputeReason: dispute.reason ?? null,
        };
      }

      // A refund Stripe left pending (or gave up on) changed its status. The event object is
      // the refund itself; `refund.failed` and `refund.updated` are the current names, and
      // `charge.refund.updated` the older one — all three say the same thing.
      const refundEventType: string = event.type;
      if (
        refundEventType === "charge.refund.updated" ||
        refundEventType === "refund.updated" ||
        refundEventType === "refund.failed"
      ) {
        const refund = event.data.object as unknown as {
          id?: string;
          status?: string | null;
          payment_intent?: string | { id?: string } | null;
        };
        return {
          ...envelope,
          refundId: refund.id ?? null,
          refundStatus: refund.status ?? null,
          paymentIntent:
            typeof refund.payment_intent === "string"
              ? refund.payment_intent
              : (refund.payment_intent?.id ?? null),
        };
      }

      // Same id on the path we do not handle: the caller still records the
      // delivery, so an unhandled type is not re-examined on every retry.
      return envelope;
    } catch (err) {
      console.error("[Stripe Webhook] Signature verification failed:", err);
      return { error: "invalid_signature" };
    }
  },
});
