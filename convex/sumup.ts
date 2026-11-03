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
} from "@be-yours/convex-functions/paymentSettlement";
import {
  CardPaymentUnavailableError,
  OrderAlreadyPaidError,
} from "@be-yours/convex-functions/refusal";
import { assertCardChargeable } from "@be-yours/convex-functions/cardChargeFloor";
import { refundFailure } from "./lib/refundOutcome";
import { resolveSumUpAccessToken } from "./lib/sumupToken";

// ---------------------------------------------------------------------------
// Inline AES-256-GCM decryption (same pattern as oauthConnect.ts)
// ---------------------------------------------------------------------------

async function decrypt(encrypted: string): Promise<string> {
  const { createDecipheriv } = await import("crypto");
  const { getSiteEnv } = await import("@be-yours/core/env");
  const hex = getSiteEnv().ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string");
  }

  const key = Buffer.from(hex, "hex");
  const parts = encrypted.split(":");
  const iv = Buffer.from(parts[0] ?? "", "base64");
  const authTag = Buffer.from(parts[1] ?? "", "base64");
  const ciphertext = Buffer.from(parts[2] ?? "", "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** The inline AES-256-GCM encryption `oauthConnect.ts` uses, for the refreshed tokens. */
async function encrypt(plaintext: string): Promise<string> {
  const { randomBytes, createCipheriv } = await import("crypto");
  const { getSiteEnv } = await import("@be-yours/core/env");
  const hex = getSiteEnv().ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string");
  }

  const key = Buffer.from(hex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Get the decrypted SumUp access token from paymentConnections, refreshing it first
 * when it is within five minutes of expiry (`lib/sumupToken.ts` holds the rules and the
 * reasons). A connection without `tokenExpiresAt` is returned as it is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Convex action context
export async function getSumUpAccessToken(ctx: any): Promise<{ accessToken: string; merchantCode: string }> {
  const { getSiteEnv } = await import("@be-yours/core/env");
  const { resolveSumUpOAuthEndpoints } = await import(
    "@be-yours/convex-functions/reservationProviders"
  );
  const site = getSiteEnv();
  return await resolveSumUpAccessToken({
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch,
    tokenUrl: resolveSumUpOAuthEndpoints(process.env).tokenUrl,
    clientCredentials: () =>
      site.SUMUP_CLIENT_ID && site.SUMUP_CLIENT_SECRET
        ? { clientId: site.SUMUP_CLIENT_ID, clientSecret: site.SUMUP_CLIENT_SECRET }
        : null,
    encrypt,
    decrypt,
    readConnection: () =>
      ctx.runQuery(internal.paymentConnections.internalGetByProvider, { provider: "sumup" as const }),
    writeConnection: async (write) => {
      await ctx.runMutation(internal.paymentConnections.upsert, { provider: "sumup" as const, ...write });
    },
  });
}

/**
 * Create a SumUp checkout for card payment.
 * Returns checkoutId to be used with SumUp Card Widget.
 */
// @public-by-design: a guest checking out has no account; the amount is read from the order server-side, never taken from the caller
export const createCheckout = action({
  args: {
    orderId: v.id("orders"),
    redirectUrl: v.string(),
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

    // The diner-facing path says WHY a card cannot be taken instead of letting
    // `getSumUpAccessToken`'s plain `Error` reach the browser as a redacted
    // "Server Error" behind the generic retry toast (#374). The helper keeps
    // its own throws: verify and refund read them from a log, not a table.
    const connection = await ctx.runQuery(
      internal.paymentConnections.internalGetByProvider,
      { provider: "sumup" as const }
    );
    if (
      !connection ||
      connection.status !== "connected" ||
      !connection.encryptedAccessToken
    ) {
      throw new CardPaymentUnavailableError();
    }

    const { accessToken, merchantCode } = await getSumUpAccessToken(ctx);

    const response = await fetch(
      "https://api.payments.sumup.com/v0.1/checkouts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          checkout_reference: args.orderId,
          amount: order.total / 100,
          currency: "EUR",
          pay_to_email: merchantCode,
          redirect_url: args.redirectUrl,
          description: `Commande #${order.orderNumber}`,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`SumUp checkout creation failed: ${JSON.stringify(error)}`);
    }

    const checkout = (await response.json()) as { id: string; status: string };

    /* The checkout id, on the order, BEFORE the diner leaves for SumUp.
     *
     * Without it nothing could ask SumUp what became of a checkout: a diner who
     * paid and closed the tab before the redirect completed left the charge at
     * SumUp, the order at `pending`, and the kitchen blind — permanently,
     * because no path in the product ever asked again. `reconcilePending` reads
     * it back (#431.2).
     *
     * Written before the return rather than after, for the same reason Stripe
     * writes its own here: the window this closes is precisely the one where
     * the diner does not come back. */
    await ctx.runMutation(internal.payments.internalAttachCheckoutSession, {
      orderId: args.orderId,
      checkoutSessionId: checkout.id,
      provider: "sumup" as const,
    });

    return { checkoutId: checkout.id };
  },
});

/**
 * Verify a SumUp checkout after payment.
 * Updates order and creates payment record if paid.
 */
// @public-by-design: called from the return page by a guest; assertSettlesOrder binds the checkout to this order, currency and amount
export const verifyCheckout = action({
  args: {
    checkoutId: v.string(),
    orderId: v.id("orders"),
  },
  handler: async (ctx, args): Promise<{
    status: string;
    orderId: Id<"orders">;
    orderNumber?: string;
    viewToken?: string;
    email?: string;
  }> => {
    // Same bound as opening the session: this asks the provider about a
    // checkout, and a loop on one order is a loop against their API. Per order
    // because that is what the caller supplies (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.orderId,
    });

    const { accessToken } = await getSumUpAccessToken(ctx);

    const response = await fetch(
      `https://api.payments.sumup.com/v0.1/checkouts/${args.checkoutId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error("Failed to verify SumUp checkout");
    }

    const checkout = (await response.json()) as {
      id: string;
      status: string;
      transaction_id?: string;
      checkout_reference?: string;
      amount?: number;
      currency?: string;
    };

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
    const order: OrderData | null = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) throw new Error("Order not found");

    if (checkout.status === "PAID" || checkout.status === "AUTHORIZED") {
      // The checkout id and the order id arrive as independent arguments, so
      // nothing stops a caller pairing a cheap paid checkout with an expensive
      // pending order. SumUp echoes back the reference we set at creation and
      // the amount it actually took — both must match before anything settles.
      assertSettlesOrder(
        {
          provider: "sumup",
          reference: checkout.checkout_reference,
          amountMajor: checkout.amount,
          currency: checkout.currency,
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
      // One mutation, one transaction: keyed on the SumUp transaction id, so a
      // second verification of the same checkout returns the row that already
      // exists instead of writing another refundable one.
      //
      // Unconditional now: the row records that the money moved, which stays
      // true whether the order ends up paid or awaiting a refund.
      await settleOrRecordRefusal(ctx, {
        orderId: args.orderId,
        storeId: order.storeId as Id<"stores">,
        amount: order.total,
        currency: "EUR",
        provider: "sumup",
        externalId: checkout.transaction_id ?? checkout.id,
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
      status: checkout.status.toLowerCase(),
      orderId: args.orderId,
      orderNumber: order.orderNumber,
      viewToken: order.viewToken,
    };
  },
});

/**
 * Issue a refund against a SumUp transaction.
 *
 * Internal: authorisation and bookkeeping live in `payments.refundPayment`.
 * This only talks to SumUp and reports what it said.
 */
export const internalRefund = internalAction({
  args: {
    /** The stored SumUp transaction id. */
    externalId: v.string(),
    /** Amount in cents. */
    amount: v.number(),
  },
  handler: async (ctx, args): Promise<{ refundId: string }> => {
    // NO IDEMPOTENCY KEY, and that is SumUp's limitation rather than an
    // oversight. Stripe takes one in its request options and PayPal takes a
    // `PayPal-Request-Id` header; SumUp's `POST /v0.1/me/refund/{txid}`
    // documents neither, and inventing a header it does not read would be worse
    // than nothing — it would look like the same protection the other two have.
    //
    // So what stands between a lost response and a double refund is the
    // reservation in `payments.refundPayment`, which is released only when this
    // call proves the provider did nothing. This comment used to claim that was
    // already true — "a timeout is not a refusal, so the release does not run"
    // — and it was not: the `catch` there released on any throw whatsoever, so
    // a timed-out 48 € refund gave the balance back, the operator retried, and
    // 96 € left the account. The distinction the comment described now exists,
    // and it exists HERE, because this is the only place that knows which of
    // the two happened. See `lib/refundOutcome.ts`.
    const { accessToken } = await getSumUpAccessToken(ctx);

    let response: Response;
    try {
      response = await fetch(
        `https://api.sumup.com/v0.1/me/refund/${args.externalId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          // SumUp expects major units, like the checkout creation above.
          body: JSON.stringify({ amount: args.amount / 100 }),
        }
      );
    } catch (cause) {
      // No response at all: a dropped connection, a DNS failure, a timeout.
      // The request may have arrived and been honoured. `null` says so, and
      // the reservation stays committed.
      throw refundFailure(null, cause instanceof Error ? cause.message : "");
    }

    if (!response.ok) {
      // The status is what separates "SumUp refused" from "SumUp may have
      // refunded and failed to tell us". `refundFailure` maps it to the code
      // `payments.refundPayment` reads before deciding whether to give the
      // committed amount back.
      const detail = await response.text().catch(() => "");
      throw refundFailure(response.status, detail);
    }

    // SumUp answers 204 No Content on success and returns no refund id, so the
    // transaction id is the only reconciliation handle available.
    return { refundId: args.externalId };
  },
});

/**
 * The orders that opened a SumUp checkout and never came back.
 *
 * WHAT WAS BROKEN (#431.2). SumUp had no webhook and no reconciliation of any
 * kind — `crons.ts` reconciled Stripe alone:
 *
 *     $ grep -n "reconcile" convex/crons.ts
 *     only internal.stripe.reconcilePendingCheckouts
 *
 * So a diner who paid with SumUp and closed the tab before the redirect
 * completed left the charge at SumUp, the order at `pending` and the kitchen
 * blind — permanently. Not a window: no path in the product ever asked again.
 * The restaurant had the money and no order to cook.
 *
 * The same shape as `stripe.reconcilePendingCheckouts`, deliberately, down to
 * the binding: what SumUp reports must equal the order, to the cent, or nothing
 * is marked paid. A sweep is the one caller that acts on a provider's word with
 * no diner in front of it, so it is the last place to relax that.
 *
 * WHY A SWEEP RATHER THAN A WEBHOOK. A webhook needs an endpoint registered per
 * merchant account and a secret every existing client would have to add; the
 * sweep works on every deployment that already takes SumUp, today, with no
 * configuration. It is also the recovery path a webhook still needs — a webhook
 * that is never delivered leaves exactly this state.
 *
 * An unpaid or expired checkout is LEFT ALONE. An abandoned basket is not a
 * failed payment, and marking it as one hides a customer who is about to come
 * back and pay.
 */
export const reconcilePending = internalAction({
  args: {
    now: v.optional(v.number()),
    minAgeMinutes: v.optional(v.number()),
    maxAgeHours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ examined: number; settled: number }> => {
    const connection = await ctx.runQuery(
      internal.paymentConnections.internalGetByProvider,
      { provider: "sumup" as const }
    );
    // Not an error on a deployment that does not take SumUp, which is most of
    // them. A sweep that threw there would be red every hour for ever.
    if (!connection || connection.status !== "connected") {
      return { examined: 0, settled: 0 };
    }

    const candidates = await ctx.runQuery(
      internal.payments.internalListStrandedCheckouts,
      {
        now: args.now,
        minAgeMinutes: args.minAgeMinutes,
        maxAgeHours: args.maxAgeHours,
        limit: args.limit,
        provider: "sumup" as const,
      }
    );
    if (candidates.length === 0) return { examined: 0, settled: 0 };

    const { accessToken } = await getSumUpAccessToken(ctx);
    let settled = 0;

    for (const candidate of candidates) {
      try {
        const response = await fetch(
          `https://api.payments.sumup.com/v0.1/checkouts/${candidate.checkoutSessionId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        // A checkout SumUp no longer knows about is not a payment. Skipped
        // rather than failed: the sweep runs again, and one unreadable row must
        // not stop the rest.
        if (!response.ok) continue;

        const checkout = (await response.json()) as {
          id: string;
          status: string;
          amount: number;
          currency: string;
          checkout_reference?: string;
          transaction_id?: string;
        };
        if (checkout.status?.toUpperCase() !== "PAID") continue;

        const orderId = candidate.orderId as Id<"orders">;

        // Read NOW, not from the sweep's snapshot. `listStrandedCheckouts`
        // picked this candidate out of an index read taken at the top, so its
        // `paymentStatus` is already old — and a sweep that began before the
        // counter took the cash would otherwise settle a second collection.
        const order = await ctx.runQuery(internal.orders.internalGetById, {
          id: orderId,
        });
        if (!order) continue;

        assertSettlesOrder(
          {
            provider: "sumup",
            reference: checkout.checkout_reference,
            amountMajor: checkout.amount,
            currency: checkout.currency,
          },
          {
            orderId,
            total: order.total,
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
          }
        );

        // The ledger first, then the order — the same ordering as the return
        // page, for the same reason: marking paid first commits a claim the
        // settlement can still refuse.
        await settleOrRecordRefusal(ctx, {
          orderId,
          storeId: order.storeId as Id<"stores">,
          amount: order.total,
          currency: "EUR",
          provider: "sumup",
          externalId: checkout.transaction_id ?? checkout.id,
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
         * One order that cannot be settled must not stop the sweep — but a
         * refusal nobody can see is a refusal nobody can fix, and a
         * `console.error` in one client's Convex dashboard at 3am unattended is
         * precisely nobody being told (#520).
         *
         * A refusal here means a real charge exists at SumUp for an order this
         * deployment will not record, so the restaurant is holding the diner's
         * money and somebody owes them a refund. Stripe's sweep has recorded
         * that since #438; this one reached the log and stopped.
         */
        await recordSettlementRefusal(ctx, error, {
          provider: "sumup",
          eventType: "reconcilePendingCheckouts",
          externalId: candidate.checkoutSessionId,
          orderId: candidate.orderId as Id<"orders">,
          storeId: candidate.storeId as Id<"stores">,
        });
        console.error(
          `[SumUp reconcile] ${candidate.orderId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return { examined: candidates.length, settled };
  },
});
