import { httpAction } from "./_generated/server";
import { captureBackendError } from "./errorReporting";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertSettlesOrder,
  deliberateSettlementRefusal,
  paymentStatusAfterSettlement,
} from "@be-yours/convex-functions/paymentSettlement";
import { refundSettlement } from "@be-yours/convex-functions/reservationProviders";

/**
 * Stripe webhook handler (Convex HTTP action).
 * Delegates Stripe SDK signature verification to a Node.js internalAction
 * because httpAction cannot use "use node".
 *
 * WHY IT HANDLES FIVE EVENT TYPES: it handled one,
 * `checkout.session.completed`, and answered 200 to the rest. A customer who
 * paid and closed the tab before the confirmation page left a paid Stripe
 * charge and an order stuck at `paymentStatus: "pending"` — the kitchen never
 * saw it. A refund issued from the Stripe dashboard moved real money and left
 * the admin still offering the whole amount as refundable.
 *
 * The checkout session carries our `metadata.orderId`, and so does a payment
 * intent the native app's card sheet confirmed (`createPaymentIntent` writes it
 * on the intent itself). Those two are bound and settled by one block. Every
 * other event — including the intent behind a hosted checkout, which carries
 * no metadata of ours — resolves through `payments.externalId`, the payment
 * intent stored when the charge was first settled.
 *
 * It is one function rather than a router plus handlers because the settlement
 * guard has to be visibly inside the route that settles: `settlement-binding`
 * asserts it against this export by name.
 */
// @guarded-inline: the Stripe SDK verifies the signature in
// internal.stripeWebhookVerify.verify before anything here reads the event
export const handleWebhook = httpAction(async (ctx, request) => {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // Verify signature in Node.js runtime (Stripe SDK requires it)
  const result = (await ctx.runAction(internal.stripeWebhookVerify.verify, {
    body,
    signature,
  })) as Record<string, unknown>;

  if (result.error === "not_configured") {
    return new Response("Stripe not configured", { status: 500 });
  }
  if (result.error === "invalid_signature") {
    return new Response("Invalid signature", { status: 400 });
  }

  // Stripe retries a delivery until it gets a 2xx, and says a delivery may
  // repeat even after one. Nothing here remembered what it had already handled,
  // so every retry ran the settlement path again from the top.
  //
  // This is a different guard from the one in `payments.settlePayment`: that one
  // stops the return page and this webhook — two DIFFERENT events — writing two
  // rows for one charge. This one stops ONE delivery being handled twice.
  // Neither subsumes the other.
  const eventId = String(result.eventId ?? "");
  if (!eventId) {
    // The verifier returns the id on every successful path. Missing it means our
    // own code moved; handling the event with no deduplication key is exactly
    // what this guard exists to prevent, so refuse instead.
    console.error("[Stripe Webhook] verified event carried no id");
    return new Response("Missing event id", { status: 500 });
  }

  const eventType = String(result.eventType ?? "unknown");

  const admission = await ctx.runMutation(internal.paymentEvents.beginEvent, {
    provider: "stripe",
    eventId,
    eventType,
  });

  if (admission === "already_processed") {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** The payment intent, which is what `payments.externalId` holds. */
  const paymentIntent = String(result.paymentIntent ?? "");

  try {
    switch (eventType) {
      // The two events that carry our order id: a hosted checkout's SESSION
      // (`createCheckoutSession` writes the metadata there), and an intent the
      // native card sheet confirmed (`createPaymentIntent` writes it on the
      // intent). One block for both, so the binding cannot drift between them.
      //
      // An intent with NO order id is the redundant confirmation of a hosted
      // checkout, and keeps its own path: it resolves through the payment row
      // the checkout settlement wrote.
      case "checkout.session.completed":
      case "payment_intent.succeeded": {
        // A TABLE BOOKING's deposit, card guarantee or no-show fee. The event is a
        // trigger, not the proof: the payment row is settled from the checkout read back
        // through the API (`reservationPaymentActions.reconcileByRef`), bound to the
        // row's own amount and currency, so the webhook arriving before the guest's
        // browser — or after — settles the same booking once.
        if (result.reservationPaymentId) {
          await ctx.runAction(internal.reservationPaymentActions.reconcileByRef, {
            paymentRef: String(result.reservationPaymentId),
            ...(eventType === "checkout.session.completed"
              ? { checkoutRef: String(result.sessionId ?? "") }
              : { externalId: paymentIntent }),
          });
          break;
        }

        if (eventType === "payment_intent.succeeded" && !result.orderId) {
          // A second, redundant confirmation that the charge went through. When
          // the return page or the checkout event already settled it this is a
          // no-op — `settlePayment` finds the row by payment intent and writes
          // nothing. When neither did, this is what closes the order.
          const outcome = await ctx.runMutation(
            internal.payments.internalSettleFromCharge,
            { provider: "stripe", externalId: paymentIntent }
          );
          if (outcome.status !== "settled") {
            // Not an error: the charge may belong to a checkout we hold no row
            // for. The reconciliation sweep owns that case, because recovering
            // it needs the checkout session and this event does not carry one.
            console.log(
              `[Stripe Webhook] payment_intent.succeeded not settled here: ${outcome.status}`
            );
          }
          break;
        }

        if (!result.orderId) break;
        // A session can complete unpaid (an asynchronous method still
        // clearing). A `payment_intent.succeeded` is paid by definition.
        if (eventType === "checkout.session.completed" && result.paymentStatus !== "paid") {
          break;
        }

        const orderId = result.orderId as Id<"orders">;

        const order = await ctx.runQuery(internal.orders.internalGetById, {
          id: orderId,
        });
        if (!order) break;

        // The guard belongs here, not in the "use node" verifier: this is the
        // only place holding BOTH the order and what Stripe claims about the
        // session. The verifier has the claim and no database.
        //
        // Same binding as the return page: the amount and currency Stripe
        // reports must equal the order, or nothing is marked paid. Checked
        // before the `paymentStatus !== "paid"` short-circuit so an
        // already-paid order cannot wave a mismatched delivery through.
        assertSettlesOrder(
          {
            provider: "stripe",
            reference: orderId,
            // `amountTotal` is Stripe's `amount_total`: MINOR units already.
            amountMinor: (result.amountTotal as number | null) ?? null,
            currency: (result.currency as string | null) ?? null,
          },
          {
            orderId,
            total: order.total,
            // An order the counter has already collected in cash does not
            // accept a card settlement from a session left live (#378).
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
          }
        );

        // The intent is required rather than defaulted to "": an empty
        // `externalId` deduplicates against nothing AND makes `routeRefund` call
        // the payment unrefundable, so a charge recorded that way could never be
        // given back.
        if (!paymentIntent) {
          console.error(`[Stripe Webhook] ${eventType} without a payment intent`);
          return new Response("Missing payment intent", { status: 400 });
        }

        // THE LEDGER FIRST, THEN THE ORDER — and the order matters.
        //
        // These are two mutations and therefore two transactions. Writing the
        // order status first committed it, and then `settlePayment` could
        // still refuse: the order was left reading « Payé » with no payment
        // row against it at all. That was survivable while every refusal
        // answered 500 — the delivery stayed open and the endpoint showed red
        // in the Stripe dashboard — and it stopped being survivable the moment
        // a refusal started answering 200 and retiring the delivery, which
        // made the state final and silent (#411).
        //
        // Settling first is safe in the other direction: `settlePayment`
        // reads nothing about the order's status, and a settlement that
        // succeeds is exactly the case in which the status write is wanted.
        //
        // One mutation, one transaction. The return page settles this same
        // charge from a DIFFERENT event; `internalSettle` keys on the payment
        // intent so whichever arrives second finds the row and writes nothing.
        await ctx.runMutation(internal.payments.internalSettle, {
          orderId,
          // The ORDER's store, never the session metadata's. They are the same
          // value when `createCheckoutSession` wrote it, and the order is the
          // one that is authoritative: metadata is a copy, it is not validated
          // by anything on the way in, and a `v.id("stores")` argument built
          // from a string that is not one throws a VALIDATOR error — which
          // happens before the handler runs, so it is a failure rather than a
          // refusal, and the route answers 500 and Stripe retries a delivery
          // that can never succeed. It would also be the only way for a
          // provider payload to name which establishment gets the money.
          storeId: order.storeId,
          // The order total, not the provider's number: after the assert they are
          // equal by construction. Matches stripe.ts, sumup.ts and paypal.ts.
          amount: order.total,
          currency: (result.currency as string) ?? "EUR",
          provider: "stripe",
          externalId: paymentIntent,
        });

        // What this settlement should do to the ORDER — which is not always
        // "mark it paid". `refund_pending` (paid, then cancelled, money owed
        // back) is not "paid", so the old `if (order.paymentStatus !== "paid")`
        // walked into the branch and wrote the marker away; a Stripe retry or a
        // refreshed success tab was enough. The payment row is recorded either
        // way: the money moved, and a refund needs something to point at.
        const nextPaymentStatus = paymentStatusAfterSettlement(order);
        if (nextPaymentStatus) {
          await ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
            id: orderId,
            paymentStatus: nextPaymentStatus,
          });
        }
        break;
      }

      // Nothing to write: the charge never happened and the order already says
      // so. Logged rather than silent, because a rising count here is the
      // difference between a card problem and a configuration one.
      case "payment_intent.payment_failed": {
        // A no-show fee the card refused: the row, the guest and the team hear of it.
        // A DEPOSIT's failed attempt is not a failure of the row — the guest may try
        // another card on the same Stripe page — and `failFee` leaves it alone.
        if (result.reservationPaymentId) {
          await ctx.runAction(internal.reservationPaymentActions.failFeeFromEvent, {
            paymentRef: String(result.reservationPaymentId),
            code: String(result.failureCode ?? "card_declined"),
            message: String(result.failureMessage ?? "Le débit a été refusé."),
          });
          break;
        }
        console.warn(
          `[Stripe Webhook] payment failed for ${paymentIntent || "unknown intent"}: ` +
            `${String(result.failureMessage ?? "no reason given")}`
        );
        break;
      }

      // A refund Stripe had left pending, or gave up on. Only a table booking's refund is
      // looked for here: an order's refunds are not tracked past the API answer. Pending is
      // not an answer, so it changes nothing; `refund.failed` is a failure whatever status
      // it carries.
      case "charge.refund.updated":
      case "refund.updated":
      case "refund.failed": {
        const settlement =
          eventType === "refund.failed"
            ? "failed"
            : refundSettlement("stripe", String(result.refundStatus ?? ""));
        if (settlement !== "pending" && result.refundId) {
          await ctx.runMutation(internal.reservationPayments.settleRefundFromProvider, {
            externalRefundId: String(result.refundId),
            status: settlement,
          });
        }
        break;
      }

      // A refund issued outside our UI — from the Stripe dashboard, which is how
      // an owner in a hurry does it. `amountRefunded` is the running total for
      // the charge, so recording it as a total makes a replay harmless.
      case "charge.refunded":
      // Stripe withdraws the disputed amount immediately, so it is money gone
      // for the same purpose as a refund: the balance must stop offering it.
      case "charge.dispute.created": {
        const reversedMinor =
          eventType === "charge.refunded"
            ? Number(result.amountRefunded ?? 0)
            : Number(result.amountDisputed ?? 0);
        const reason =
          eventType === "charge.refunded"
            ? "Remboursement effectué depuis le tableau de bord Stripe"
            : `Litige / rétrofacturation (${String(result.disputeReason ?? "motif non précisé")})`;

        if (!paymentIntent) {
          console.warn(
            `[Stripe Webhook] ${eventType} carried no payment intent; nothing to record against`
          );
          break;
        }

        if (eventType === "charge.dispute.created") {
          // A dispute on a table booking's deposit or fee is NOT a refund: no refund row, no
          // « remboursé » mail to the guest. The charge becomes « Litige ouvert » and the
          // host's alert centre raises it. Anything else is an order's.
          const disputed = await ctx.runMutation(
            internal.reservationPayments.recordProviderDispute,
            {
              externalId: paymentIntent,
              amountMinor: Number.isFinite(reversedMinor) ? reversedMinor : 0,
              reason,
              ...(result.reservationPaymentId
                ? { reservationPaymentId: String(result.reservationPaymentId) }
                : {}),
            }
          );
          if (disputed.status !== "not_found") break;
        } else {
          // A refund made at Stripe on a table booking's deposit or fee goes on the
          // booking's own ledger; anything else is an order's.
          const onBooking = await ctx.runMutation(
            internal.reservationPayments.recordProviderRefund,
            {
              externalId: paymentIntent,
              refundedTotalMinor: Number.isFinite(reversedMinor) ? reversedMinor : 0,
              reason,
              externalRefundId: (result.chargeId as string | null) ?? undefined,
            }
          );
          if (onBooking.status !== "not_found") break;
        }

        const outcome = await ctx.runMutation(
          internal.payments.internalRecordProviderRefund,
          {
            provider: "stripe",
            externalId: paymentIntent,
            refundedTotalMinor: Number.isFinite(reversedMinor) ? reversedMinor : 0,
            reason,
            externalRefundId: (result.chargeId as string | null) ?? undefined,
          }
        );

        if (outcome.status !== "recorded") {
          console.log(
            `[Stripe Webhook] ${eventType} for ${paymentIntent}: ${outcome.status}`
          );
        }
        break;
      }

      default:
        // Deliberately ignored, and answered 200 so Stripe stops retrying it.
        console.log(`[Stripe Webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    // A refusal is not a failure, and the two need opposite answers.
    //
    // A settlement this backend REFUSED — the amount does not match, the order
    // was already collected by another charge (#411), the reference names a
    // different order — is a decision, and it is permanent. Retrying delivers
    // the same answer. Answering 500 to it bought three days of Stripe retries,
    // each one re-running the guard to the same refusal, while the delivery
    // stayed `processed: false` and every attempt was re-admitted as
    // `in_flight`. Nobody was told: the only trace was a `console.error` in one
    // client's Convex dashboard.
    //
    // So: record it where an operator reads it, mark the delivery done, and
    // answer 2xx. The money HAS moved — a provider does not report a charge it
    // did not take — so the audit entry is what says a refund is owed.
    const refusal = deliberateSettlementRefusal(err);
    if (refusal) {
      console.error(
        `[Stripe Webhook] refused ${eventType} (${refusal.code}): ${refusal.message}`
      );
      await ctx.runMutation(internal.payments.internalRecordRefusedCollection, {
        provider: "stripe",
        code: refusal.code,
        message: refusal.message,
        eventType,
        ...(paymentIntent ? { externalId: paymentIntent } : {}),
        ...(result.orderId ? { orderId: result.orderId as Id<"orders"> } : {}),
        ...(result.storeId ? { storeId: result.storeId as Id<"stores"> } : {}),
      });
      // Reported as well as recorded: an audit row is read when somebody looks,
      // and a diner charged twice should not have to wait for that.
      await captureBackendError(ctx, {
        error: err,
        source: "stripeWebhook",
        tags: { eventType, refusal: refusal.code },
      });
      await ctx.runMutation(internal.paymentEvents.markProcessed, {
        provider: "stripe",
        eventId,
      });
      return new Response(
        JSON.stringify({ received: true, refused: refusal.code }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Everything else: 500, not 200. The delivery stays unprocessed, so
    // Stripe's retry is let through rather than mistaken for a duplicate and
    // dropped. Answering 200 here — which is what this route did
    // unconditionally — turns a transient failure into a permanently lost
    // event.
    console.error(`[Stripe Webhook] Error processing ${eventType}:`, err);
    await captureBackendError(ctx, {
      error: err,
      source: "stripeWebhook",
      tags: { eventType },
    });
    return new Response("Processing error", { status: 500 });
  }

  // Only once the work is done. A handler that threw on the way here leaves the
  // row unprocessed on purpose, so Stripe's next retry is let through rather
  // than being mistaken for a duplicate and dropped.
  await ctx.runMutation(internal.paymentEvents.markProcessed, {
    provider: "stripe",
    eventId,
  });

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
