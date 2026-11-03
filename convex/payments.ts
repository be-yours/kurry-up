import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import * as defs from "@be-yours/convex-functions/payments";
import { collectionOnOrder } from "@be-yours/convex-functions/paymentLedger";
import {
  storeQuery,
  storeMutation,
  storeIdFromDocument,
  storeIdFromField,
} from "./lib/storeFunctions";
import { requireStorePermission } from "@be-yours/convex-functions/auth";
import {
  planRefund,
  routeRefund,
  type PaymentForRefund,
} from "@be-yours/convex-functions/refundPolicy";
import { mayReleaseRefundReservation } from "./lib/refundOutcome";

const paymentsStoreId = storeIdFromDocument("Payment not found");
const payments_getByOrderStoreId = storeIdFromField("orderId", "Order not found");

export const getByOrder = storeQuery({
  permission: "payments:read",
  storeIdFrom: payments_getByOrderStoreId,
  args: defs.getByOrder.args,
  handler: (ctx, args) => defs.getByOrder.handler(ctx, args),
});

export const getByStore = storeQuery({
  permission: "payments:read",
  args: defs.getByStore.args,
  handler: (ctx, args) => defs.getByStore.handler(ctx, args),
});

export const create = storeMutation({
  // Recording a payment is not refunding one. The wrong verb also tied taking
  // money to the right to give it back.
  permission: "payments:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const updateStatus = storeMutation({
  // Same wrong verb as `create`: this moves a payment through its states, it
  // does not refund anything — and it can no longer pretend to. `refunded` and
  // `partially_refunded` are gone from the argument union, so this doorway
  // cannot write a refund nobody performed. See the package definition.
  permission: "payments:write",
  storeIdFrom: paymentsStoreId,
  args: defs.updateStatus.args,
  handler: (ctx, args) => defs.updateStatus.handler(ctx, args),
});

// === Refunds ===
//
// `payments.refund` used to be a mutation that patched `refundedAmount` and
// flipped the status to "refunded" without calling any provider — the money
// never moved. It was also an `authedMutation`, so any authenticated account
// could "refund" any payment of any store.
//
// The public entry point is now an action: it authorises, asks the provider to
// move the money, and only records the refund once the provider confirms.

/**
 * Load a payment for refunding, enforcing store access and `payments:refund`.
 * Internal, but the caller's identity propagates from the action.
 */
export const internalLoadForRefund = internalQuery({
  args: { id: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.id);
    if (!payment) throw new Error("Paiement introuvable.");
    await requireStorePermission(ctx, payment.storeId, "payments:refund");
    return payment;
  },
});

export const internalReserveRefund = internalMutation(defs.reserveRefund);
export const internalConfirmRefund = internalMutation(defs.confirmRefund);
export const internalReleaseRefund = internalMutation(defs.releaseRefund);

/**
 * Refund a payment: authorise, call the provider, then record the outcome.
 *
 * Nothing is written unless the money actually moved — except for cash, which
 * is handed back at the counter and recorded as a manual refund.
 */
// @guarded-inline: internalLoadForRefund requires payments:refund on the payment's store
export const refundPayment = action({
  args: {
    id: v.id("payments"),
    /** Amount in cents. */
    amount: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ refundedAmount: number; isFullRefund: boolean }> => {
    const payment = await ctx.runQuery(internal.payments.internalLoadForRefund, {
      id: args.id,
    });

    const forRefund: PaymentForRefund = {
      provider: payment.provider,
      status: payment.status,
      amount: payment.amount,
      refundedAmount: payment.refundedAmount,
      externalId: payment.externalId,
    };

    // Validate before touching the provider: a refund we would refuse to record
    // must never be sent out either.
    const plan = planRefund({ payment: forRefund, amount: args.amount });
    const route = routeRefund(forRefund);

    if (route.kind === "unsupported") {
      throw new Error(route.reason);
    }

    // Commit the amount FIRST, inside a transaction. The provider call used to
    // come first, so two refunds arriving together both saw an untouched
    // balance and both sent money back. Reserving here is the serialisation
    // point: the second caller reads the first's committed amount and is
    // refused before anything leaves the account.
    const reservation: { plan: { refundedAmount: number; isFullRefund: boolean }; index: number } =
      await ctx.runMutation(internal.payments.internalReserveRefund, {
        id: args.id,
        amount: plan.amount,
        reason: args.reason,
        refundMethod: route.kind === "api" ? "api" : "manual",
      });

    let externalRefundId: string | undefined;

    if (route.kind === "api") {
      try {
        // ONE KEY PER RESERVED REFUND, so a retry cannot send the money twice.
        //
        // `internalReserveRefund` serialises against a CONCURRENT second
        // refund — the second caller reads the first's committed amount and is
        // refused. It does nothing about the SAME refund being sent twice,
        // which is the ordinary shape of a failure here: the provider takes the
        // request, the response is lost to a timeout or a dropped connection,
        // and the operator presses the button again. `internalReleaseRefund`
        // then gives the amount back precisely so they can, and the second
        // attempt is a second real refund at the provider.
        //
        // `reservation.index` is the refund's ordinal on this payment, so the
        // key is stable across retries of one refund and different for the next
        // partial refund of the same payment — which is exactly the property
        // required. There was ONE idempotency key in the whole engine before
        // this (`uberDirect.ts:317`), while `apps/site` used the pattern
        // correctly for its own Stripe calls.
        const idempotencyKey = `refund-${args.id}-${reservation.index}`;

        const result: { refundId: string } =
          route.provider === "stripe"
            ? await ctx.runAction(internal.stripe.internalRefund, {
                externalId: route.externalId,
                amount: plan.amount,
                reason: args.reason,
                idempotencyKey,
              })
            : route.provider === "sumup"
              ? await ctx.runAction(internal.sumup.internalRefund, {
                  externalId: route.externalId,
                  amount: plan.amount,
                })
              : await ctx.runAction(internal.paypal.internalRefund, {
                  captureId: route.externalId,
                  amount: plan.amount,
                  currency: payment.currency ?? "EUR",
                  idempotencyKey,
                });

        externalRefundId = result.refundId;
      } catch (error) {
        // Give the amount back ONLY when a retry cannot pay twice.
        //
        // The release exists so the restaurant is not left with a balance
        // claiming money was returned when it was not. It was unconditional,
        // and for SumUp that is the double-refund itself: no idempotency key
        // exists there, so releasing after a LOST RESPONSE hands the operator a
        // retry that sends a second real refund. Measured shape: a 48 € refund
        // times out, the balance is returned, the operator presses the button
        // again, 96 € leaves the account.
        //
        // Stripe and PayPal carry `idempotencyKey` above, so their retry
        // reaches the same key and returns the original refund rather than
        // making another — releasing on any failure is correct for them and
        // stays that way. `mayReleaseRefundReservation` is that distinction,
        // and it defaults to NOT releasing for anything else.
        if (mayReleaseRefundReservation(route.provider, error)) {
          await ctx.runMutation(internal.payments.internalReleaseRefund, {
            id: args.id,
            index: reservation.index,
          });
        }
        throw error;
      }
    }

    // Record the provider's reference against THIS refund. A scalar field was
    // overwritten by each partial refund, leaving the earlier one with no proof.
    await ctx.runMutation(internal.payments.internalConfirmRefund, {
      id: args.id,
      index: reservation.index,
      externalRefundId,
    });

    return {
      refundedAmount: reservation.plan.refundedAmount,
      isFullRefund: reservation.plan.isFullRefund,
    };
  },
});

/**
 * Does this order already hold a collection?
 *
 * Internal, and read from the checkout ACTIONS before they open a payment
 * page. `order.paymentStatus` is not the whole truth: a settlement writes the
 * payment row and the order status in two transactions, so between them an
 * order reads `pending` with a `succeeded` row already against it — and a gate
 * that trusts the status alone sends the diner to pay a second time (#411).
 */
export const internalCollectionOnOrder = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const collected = await collectionOnOrder(ctx, args.orderId);
    return collected ? { provider: collected.provider } : null;
  },
});

// === Internal Mutations (for payment actions and webhooks) ===

/** Create payment record without auth — used by payment verification actions */
export const internalCreate = internalMutation(defs.create);

/**
 * Record a settled provider payment, exactly once — used by every payment
 * verification action and by the Stripe webhook.
 *
 * Replaces the `internalCreate` + `internalUpdateStatus` pair those four call
 * sites used to run in two separate transactions, which let the return page and
 * the webhook each write a row for the same charge.
 */
export const internalSettle = internalMutation(defs.settlePayment);

/**
 * Move a payment through its non-refund states without auth.
 *
 * `refunded` and `partially_refunded` are absent from the argument union on
 * purpose — see `updateStatus` in the package. A refund goes through
 * `refundPayment`, or through `internalRecordProviderRefund` when the provider
 * performed it on its own side.
 */
export const internalUpdateStatus = internalMutation(defs.updateStatus);

// === Provider-side events (Stripe webhook and reconciliation) ===

/**
 * Settle whatever a `payment_intent.succeeded` already refers to.
 *
 * Resolves the order through `payments.externalId`, the only route such an
 * event leaves open, and then runs the same `settlePayment` as every other
 * settlement path — so the redundant confirmation cannot produce a second row.
 */
/**
 * Settle an order from a `payment_intent.succeeded` event.
 *
 * The defs layer now routes this through `recordPaymentStatus`, so the kitchen
 * release and the diner's confirmation happen here as they do on every other
 * payment path. Scheduling the send is this wrapper's part, exactly as in
 * `orders.ts`.
 */
export const internalSettleFromCharge = internalMutation({
  args: defs.settleFromChargeEvent.args,
  handler: async (ctx, args) => {
    const result = await defs.settleFromChargeEvent.handler(ctx, args);
    if (result.confirmation) {
      await ctx.scheduler.runAfter(
        0,
        internal.customerEmail.sendOrderConfirmation,
        { orderId: result.confirmation.orderId as Id<"orders"> }
      );
    }
    return result;
  },
});

/**
 * Record a refund or chargeback the provider performed on its own side, so the
 * refundable balance the admin shows matches the money that is actually left.
 */
export const internalRecordProviderRefund = internalMutation(defs.recordProviderRefund);

/**
 * Record a collection this deployment refused, where an operator will read it.
 *
 * The refusal keeps the ledger honest; the charge still exists at the provider
 * and the diner is owed it back. This is the only place that fact is written
 * down — see the package definition (#411).
 */
export const internalRecordRefusedCollection = internalMutation(
  defs.recordRefusedCollection
);


/** Remember the Stripe Checkout Session an order was sent to pay through. */
export const internalAttachCheckoutSession = internalMutation(defs.attachCheckoutSession);

/**
 * Remember the PaymentIntent the native card sheet was handed, with a pending
 * ledger row the `payment_intent.succeeded` webhook can resolve it through.
 */
export const internalAttachPaymentIntent = internalMutation(defs.attachPaymentIntent);

/** Forget an in-app PaymentIntent a hosted checkout has just cancelled. */
export const internalReleasePaymentIntent = internalMutation(defs.releasePaymentIntent);

/** The orders that took a Stripe checkout and never came back paid. */
export const internalListStrandedCheckouts = internalQuery(defs.listStrandedCheckouts);
