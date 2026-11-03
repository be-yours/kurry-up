"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  recordSettlementRefusal,
  settleOrRecordRefusal,
} from "./settlementReturn";
import type { Id } from "./_generated/dataModel";
import {
  assertSettlesOrder,
  orderAlreadyCollected,
  paymentStatusAfterSettlement,
  readPayPalCapture,
} from "@be-yours/convex-functions/paymentSettlement";
import { OrderAlreadyPaidError } from "@be-yours/convex-functions/refusal";
import { assertCardChargeable } from "@be-yours/convex-functions/cardChargeFloor";

// ---------------------------------------------------------------------------
// PayPal helpers
// ---------------------------------------------------------------------------

interface PayPalEnv {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

function getPayPalEnv(): PayPalEnv {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import in Convex "use node" context
  const { getSiteEnv, isSandbox } = require("@be-yours/core/env");
  const site = getSiteEnv();
  const clientId = site.PAYPAL_CLIENT_ID;
  const clientSecret = site.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are not configured");
  }

  // Sandbox is an explicit setting, not a guess. The previous heuristic —
  // `clientId.startsWith("sb-") || clientId.startsWith("A") === false` — sent
  // every live client id that did not happen to begin with "A" to the sandbox
  // host, where payments are never actually collected.
  //
  // PAYPAL_SANDBOX_MODE is required at boot as soon as PayPal is configured
  // (see @be-yours/core/env). Left unset anyway — on a Convex deployment,
  // which runs no boot check of its own — it resolves to SANDBOX, never to the
  // live host: a capture that does not settle is recoverable, a live charge
  // against test credentials is not.
  const sandbox = isSandbox("paypal");
  const baseUrl = sandbox
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

  return { clientId, clientSecret, baseUrl };
}

async function getAccessToken(env: PayPalEnv): Promise<string> {
  const auth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString(
    "base64"
  );

  const response = await fetch(`${env.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error("Failed to get PayPal access token");
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Create a PayPal order and return the approval URL for redirect.
 */
// @public-by-design: a guest checking out has no account; the amount is read from the order server-side, never taken from the caller
export const createPayPalOrder = action({
  args: {
    orderId: v.id("orders"),
    returnUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // BEFORE the provider is called. This action is reachable with no session
    // at all — it has to be, a diner pays before they have an account — and it
    // creates a real object at a third party the restaurant is billed by or
    // quota'd by. Every public-by-design MUTATION was bounded; the actions were
    // not, because an action has no `ctx.db` and the limiter reads one, so it
    // goes through `rateLimits.consume` (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.orderId,
    });

    const order = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) throw new Error("Order not found");

    /*
     * THE DINER SAW THE WORD « Restaurant » (#621).
     *
     * `brand_name` is what PayPal prints on its own approval screen, above the
     * amount, and it was the literal string "Restaurant" — so the one moment a
     * diner checks who they are paying named nobody. The establishment's own
     * name is on the order's store.
     *
     * Read here rather than in the body below because an action has no `ctx.db`.
     * Falling back to the old literal rather than throwing: a missing store name
     * is not a reason to refuse a payment, and the checkout has already proven
     * the store exists.
     */
    const store = await ctx.runQuery(internal.stores.internalGetById, {
      id: order.storeId,
    });

    // Nothing is owed twice. `orders.create` is idempotent on the diner's key,
    // so a back-navigation and a resubmit land on the SAME order — and opening
    // a payment on one that is already settled charges the same meal again.
    // The ledger refuses the second row afterwards (#411), which keeps the
    // books right and leaves the diner debited and waiting for a refund. This
    // is what stops the charge being taken. Every provider needs it: the rule
    // is about the order, not about which page the diner happens to be on.
    //
    // Both reads, for the reason `stripe.ts` sets out: the status counts a
    // refunded order as closed, and the ledger catches the window between a
    // payment row being written and the status catching up.
    if (
      orderAlreadyCollected(order.paymentStatus) ||
      (await ctx.runQuery(internal.payments.internalCollectionOnOrder, {
        orderId: args.orderId,
      })) !== null
    ) {
      throw new OrderAlreadyPaidError();
    }

    // A total no card provider will take. Stripe's EUR floor is 0,50 € and the
    // session create is what would otherwise discover that — as a plain SDK
    // error, redacted to "Server Error" behind the checkout's retry toast, on
    // an order that can never be paid however many times the diner tries. A
    // 100 % coupon is the ordinary way to reach it.
    //
    // `"EUR"` rather than `globalSettings.currency` on purpose: EUR is what
    // this request actually sends below, so the floor has to be the one that
    // applies to it.
    assertCardChargeable({ amountMinor: order.total, currency: "EUR" });

    const env = getPayPalEnv();
    const accessToken = await getAccessToken(env);

    const response = await fetch(`${env.baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: args.orderId,
            description: `Commande #${order.orderNumber}`,
            amount: {
              currency_code: "EUR",
              value: (order.total / 100).toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
          user_action: "PAY_NOW",
          brand_name: store?.name?.trim() || "Restaurant",
          shipping_preference: "NO_SHIPPING",
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `PayPal order creation failed: ${JSON.stringify(error)}`
      );
    }

    const paypalOrder = (await response.json()) as {
      id: string;
      links: Array<{ rel: string; href: string }>;
    };

    const approvalLink = paypalOrder.links.find(
      (l) => l.rel === "approve"
    );
    if (!approvalLink) {
      throw new Error("PayPal did not return an approval URL");
    }

    /* The PayPal order id, on OUR order, before the diner leaves to approve it.
     *
     * Without it nothing could ask PayPal what became of an approval: a diner
     * who approved and closed the tab before the redirect completed left the
     * authorisation at PayPal, our order at `pending`, and the kitchen blind —
     * permanently, because no path in the product ever asked again.
     * `reconcilePendingOrders` reads it back (#431.2). */
    await ctx.runMutation(internal.payments.internalAttachCheckoutSession, {
      orderId: args.orderId,
      checkoutSessionId: paypalOrder.id,
      provider: "paypal" as const,
    });

    return {
      approvalUrl: approvalLink.href,
      paypalOrderId: paypalOrder.id,
    };
  },
});

/**
 * Capture a PayPal order after user approval.
 * Updates order and creates payment record.
 */
// @public-by-design: called from the return page by a guest; assertSettlesOrder binds the capture to this order, currency and amount
export const capturePayPalOrder = action({
  args: {
    paypalOrderId: v.string(),
    orderId: v.id("orders"),
  },
  handler: async (ctx, args): Promise<{
    status: string;
    orderId: Id<"orders">;
    orderNumber?: string;
    viewToken?: string;
    email?: string;
  }> => {
    // Same bound as opening the order: this asks PayPal to capture, and a loop
    // on one order is a loop against their API. Per order because that is what
    // the caller supplies (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.orderId,
    });

    interface OrderData {
      total: number;
      orderNumber: string;
      storeId: string;
      // Needed by `paymentStatusAfterSettlement`: money arriving for a
      // cancelled order is owed back, not "paid".
      status: string;
      paymentStatus: string;
      // Needed by `assertSettlesOrder`: an order already collected through
      // another method does not accept a second settlement (#378).
      paymentMethod?: string;
      viewToken?: string;
      customerInfo?: { email?: string };
    }

    // Read the order BEFORE calling PayPal.
    //
    // A capture can only happen once. The customer who reloads the confirmation
    // page — or comes back to it from their history — used to send a second
    // capture, get ORDER_ALREADY_CAPTURED back, and land on "Confirmation
    // impossible" for an order that was paid. The client-side `hasRun` ref only
    // ever protected against a re-render, never against a reload; idempotence
    // belongs here, where the truth is.
    const order: OrderData | null = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) throw new Error("Order not found");

    if (order.paymentStatus === "paid") {
      return {
        status: "paid" as const,
        orderId: args.orderId,
        orderNumber: order.orderNumber,
        viewToken: order.viewToken,
        email: order.customerInfo?.email,
      };
    }

    const env = getPayPalEnv();
    const accessToken = await getAccessToken(env);

    const response = await fetch(
      `${env.baseUrl}/v2/checkout/orders/${args.paypalOrderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`PayPal capture failed: ${JSON.stringify(error)}`);
    }

    const capture = (await response.json()) as {
      id: string;
      status: string;
      purchase_units?: Array<{
        reference_id?: string;
        payments?: {
          captures?: Array<{
            id?: string;
            amount?: { currency_code?: string; value?: string };
          }>;
        };
      }>;
    };

    const captured = readPayPalCapture(capture);

    if (capture.status === "COMPLETED") {
      // `reference_id` was set to the order id at creation but never read back,
      // so a completed capture for any order marked THIS one paid. Both the
      // reference and the captured amount must match before settling.
      assertSettlesOrder(
        {
          provider: "paypal",
          reference: captured.reference,
          amountMajor: captured.amountMajor,
          currency: captured.currency,
        },
        {
          orderId: args.orderId,
          total: order.total,
          // An order already collected through another method does not accept
          // a second settlement (#378).
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
        }
      );

      // THE LEDGER FIRST, THEN THE ORDER — the same order `stripeWebhook.ts`
      // states, and the reason is the same on a return page.
      //
      // These are two mutations and therefore two transactions. Marking the
      // order paid first COMMITS that, and the settlement can still refuse
      // afterwards. The order was then left reading « Payé » with no payment
      // row against it: the money is not on the ledger, the invoice is minted
      // against a total nothing backs, and the diner's confirmation is on its
      // way. Probed: 2 400 c taken, 1 200 c recorded, `FA-2026-000001` issued.
      //
      // Settling first is safe in the other direction: the settlement reads
      // nothing about the order's status, and one that succeeds is exactly the
      // case in which the status write is wanted.
      //
      // One mutation, one transaction: keyed on the capture id, so a second
      // capture attempt for the same PayPal order returns the row that already
      // exists instead of writing another refundable one.
      //
      // Unconditional now: the row records that the money moved, which stays
      // true whether the order ends up paid or awaiting a refund.
      await settleOrRecordRefusal(ctx, {
        orderId: args.orderId,
        storeId: order.storeId as Id<"stores">,
        amount: order.total,
        currency: "EUR",
        provider: "paypal",
        // The CAPTURE id, not the order id: PayPal refunds are issued against a
        // capture. Storing the order id here would have made every refund
        // attempt fail at the provider.
        externalId: captured.captureId ?? args.paypalOrderId,
      });
      // What this settlement should do to the ORDER — which is not always
      // "mark it paid". `refund_pending` (paid, then cancelled, money owed
      // back) is not "paid", so the old `if (order.paymentStatus !== "paid")`
      // walked into the branch and wrote the marker away; a provider retry or
      // a refreshed success tab was enough. The payment row is recorded either
      // way: the money moved, and a refund needs something to point at.
      const nextPaymentStatus = paymentStatusAfterSettlement(order);
      if (nextPaymentStatus) {
        await ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
          id: args.orderId,
          paymentStatus: nextPaymentStatus,
        });
      }

      return {
        status: "paid" as const,
        orderId: args.orderId,
        orderNumber: order.orderNumber,
        viewToken: order.viewToken,
        email: order.customerInfo?.email,
      };
    }

    return {
      status: capture.status.toLowerCase(),
      orderId: args.orderId,
      orderNumber: order.orderNumber,
      viewToken: order.viewToken,
    };
  },
});

/**
 * Issue a refund against a PayPal capture.
 *
 * Internal: the orchestration, authorisation and bookkeeping live in
 * `payments.refundPayment`. This only talks to PayPal and reports what it said.
 */
export const internalRefund = internalAction({
  args: {
    captureId: v.string(),
    /** Amount in cents. */
    amount: v.number(),
    currency: v.string(),
    /** See `payments.refundPayment`; PayPal spells it `PayPal-Request-Id`. */
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ refundId: string }> => {
    const env = getPayPalEnv();
    const accessToken = await getAccessToken(env);

    const response = await fetch(
      `${env.baseUrl}/v2/payments/captures/${args.captureId}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          // PayPal's idempotency header. A replayed request returns the
          // original refund instead of issuing a second one.
          ...(args.idempotencyKey
            ? { "PayPal-Request-Id": args.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          amount: {
            value: (args.amount / 100).toFixed(2),
            currency_code: args.currency,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      throw new Error(`PayPal refund failed: ${error || response.status}`);
    }

    const refund = (await response.json()) as { id?: string; status?: string };

    // PayPal reports COMPLETED or PENDING. Anything else is not a refund.
    if (refund.status && !["COMPLETED", "PENDING"].includes(refund.status)) {
      throw new Error(`PayPal refund returned status ${refund.status}`);
    }

    return { refundId: refund.id ?? args.captureId };
  },
});

/**
 * The orders whose PayPal approval never came back.
 *
 * WHAT WAS BROKEN (#431.2). PayPal had no webhook and no reconciliation of any
 * kind — `crons.ts` reconciled Stripe alone. A diner who approved a payment and
 * closed the tab before the redirect completed left the authorisation at PayPal,
 * our order at `pending`, and the kitchen blind. Permanently: no path in the
 * product ever asked again.
 *
 * WHY THIS ONE IS DIFFERENT FROM SumUp's. A PayPal order is approved and then
 * CAPTURED, and the capture is what takes the money. So there are two states
 * worth recovering and they are not the same:
 *
 *   - `COMPLETED` — already captured. The redirect died after the capture, so
 *     the money has moved and only our record is missing. Settle it.
 *   - `APPROVED` — approved and never captured. The money has NOT moved. This
 *     sweep captures it, which is the same call `capturePayPalOrder` makes from
 *     the return page and the only thing that turns an approval into a payment.
 *     An authorisation left uncaptured expires, and the restaurant is paid
 *     nothing for a meal it has cooked.
 *
 * Anything else — `CREATED`, `VOIDED`, `PAYER_ACTION_REQUIRED` — is left alone.
 * An abandoned approval is not a failed payment, and marking it as one hides a
 * customer who is about to come back.
 *
 * The binding is the same as the return page's: `reference_id` must be this
 * order and the captured amount must equal its total, to the cent, or nothing
 * is marked paid. A sweep acts on a provider's word with no diner in front of
 * it, so it is the last place to relax that.
 */
export const reconcilePendingOrders = internalAction({
  args: {
    now: v.optional(v.number()),
    minAgeMinutes: v.optional(v.number()),
    maxAgeHours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ examined: number; settled: number; captured: number }> => {
    const { getSiteEnv } = await import("@be-yours/core/env");
    const site = getSiteEnv();
    // Not an error on a deployment that does not take PayPal, which is most of
    // them. A sweep that threw there would be red every hour for ever.
    if (!site.PAYPAL_CLIENT_ID || !site.PAYPAL_CLIENT_SECRET) {
      return { examined: 0, settled: 0, captured: 0 };
    }

    const candidates = await ctx.runQuery(
      internal.payments.internalListStrandedCheckouts,
      {
        now: args.now,
        minAgeMinutes: args.minAgeMinutes,
        maxAgeHours: args.maxAgeHours,
        limit: args.limit,
        provider: "paypal" as const,
      }
    );
    if (candidates.length === 0) return { examined: 0, settled: 0, captured: 0 };

    const env = getPayPalEnv();
    const accessToken = await getAccessToken(env);

    let settled = 0;
    let captured = 0;

    for (const candidate of candidates) {
      try {
        const orderId = candidate.orderId as Id<"orders">;

        const lookup = await fetch(
          `${env.baseUrl}/v2/checkout/orders/${candidate.checkoutSessionId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        // An order PayPal no longer knows about is not a payment. Skipped
        // rather than failed: the sweep runs again, and one unreadable row must
        // not stop the rest.
        if (!lookup.ok) continue;

        const remote = (await lookup.json()) as { id: string; status?: string };
        const status = remote.status?.toUpperCase();
        if (status !== "COMPLETED" && status !== "APPROVED") continue;

        // Read NOW, not from the sweep's snapshot: a sweep that began before
        // the counter took the cash would otherwise settle a second collection.
        const order = await ctx.runQuery(internal.orders.internalGetById, {
          id: orderId,
        });
        if (!order) continue;
        if (order.paymentStatus === "paid") continue;

        /* APPROVED means the money has not moved yet, so this sweep is what
           moves it. The same endpoint the return page calls — and its
           `PayPal-Request-Id` is the order id, so a capture this sweep and the
           returning diner both attempt happens once. */
        let payload = remote as Record<string, unknown>;
        if (status === "APPROVED") {
          const capture = await fetch(
            `${env.baseUrl}/v2/checkout/orders/${candidate.checkoutSessionId}/capture`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "PayPal-Request-Id": `reconcile-${orderId}`,
              },
            }
          );
          if (!capture.ok) continue;
          payload = (await capture.json()) as Record<string, unknown>;
          captured += 1;
        } else {
          // COMPLETED already: the capture detail is on the order document.
          payload = remote as Record<string, unknown>;
        }

        const read = readPayPalCapture(payload as never);
        if ((payload as { status?: string }).status?.toUpperCase() !== "COMPLETED") continue;

        assertSettlesOrder(
          {
            provider: "paypal",
            reference: read.reference,
            amountMajor: read.amountMajor,
            currency: read.currency,
          },
          {
            orderId,
            total: order.total,
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
          }
        );

        // The ledger first, then the order — the same ordering as the return
        // page, for the same reason.
        await settleOrRecordRefusal(ctx, {
          orderId,
          storeId: order.storeId as Id<"stores">,
          amount: order.total,
          currency: "EUR",
          provider: "paypal",
          // The CAPTURE id: PayPal refunds are issued against a capture, so
          // storing the order id would make every later refund fail.
          externalId: read.captureId ?? candidate.checkoutSessionId,
        });

        const nextPaymentStatus = paymentStatusAfterSettlement(order);
        if (nextPaymentStatus) {
          await ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
            id: orderId,
            paymentStatus: nextPaymentStatus,
          });
        }
        settled += 1;
      } catch (error) {
        /*
         * The same as SumUp's, and for the same reason (#520): a deliberate
         * refusal means PayPal holds a real charge for an order this deployment
         * will not record, and somebody owes the diner a refund. The sweep still
         * continues — one unsettleable order must not stop the rest.
         */
        await recordSettlementRefusal(ctx, error, {
          provider: "paypal",
          eventType: "reconcilePendingCheckouts",
          externalId: candidate.checkoutSessionId,
          orderId: candidate.orderId as Id<"orders">,
          storeId: candidate.storeId as Id<"stores">,
        });
        console.error(
          `[PayPal reconcile] ${candidate.orderId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return { examined: candidates.length, settled, captured };
  },
});
