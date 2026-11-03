"use node";

import { v } from "convex/values";
import type StripeSdk from "stripe";
import type { SiteEnv } from "@be-yours/core/env";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertSettlesOrder,
  deliberateSettlementRefusal,
  orderAlreadyCollected,
  paymentIntentVerdict,
  paymentStatusAfterSettlement,
  readStripeCheckoutSession,
  readStripePaymentIntent,
} from "@be-yours/convex-functions/paymentSettlement";
import {
  resolveStripeCharge,
  StripeChargeRouteError,
} from "@be-yours/convex-functions/stripeChargeRouting";
import {
  CardPaymentUnavailableError,
  NativeCardSheetUnavailableError,
  OrderAlreadyPaidError,
} from "@be-yours/convex-functions/refusal";
import { assertCardChargeable } from "@be-yours/convex-functions/cardChargeFloor";
import { settleOrRecordRefusal } from "./settlementReturn";

interface OrderData {
  total: number;
  orderNumber: string;
  storeId: string;
  // Needed by `paymentStatusAfterSettlement`: money arriving for a cancelled
  // order is owed back, not "paid".
  status: string;
  paymentStatus: string;
  // Needed by `assertSettlesOrder`: an order already collected through another
  // method does not accept a second settlement (#378).
  paymentMethod?: string;
  // Needed by `createCheckoutSession`: the session this order was last sent to
  // pay through, so a second checkout does not leave the first one payable
  // beside it (#411).
  stripeCheckoutSessionId?: string;
  // Needed by `createPaymentIntent` and `createCheckoutSession`: the in-app
  // PaymentIntent this order was last handed, for the same reason as the
  // session above — one order, one payable charge.
  stripePaymentIntentId?: string;
  viewToken?: string;
  customerInfo?: { email?: string };
}

/**
 * Refuse to move money on a connection state this module cannot honour.
 *
 * `resolveStripeCharge` throws for exactly one status — `connected`, the literal
 * whose meaning is "charges are routed to the connected account" — and answers
 * "platform" for every other state, `onboarding_complete` and no row included.
 * Nothing writes `connected` for Stripe today: `oauthCallbackHandlers.ts` writes
 * `onboarding_complete` or `error`, precisely because this file charges on the
 * PLATFORM key and sends no `stripeAccount`, `on_behalf_of` or `transfer_data`.
 * So this changes nothing about how a restaurant is charged today. It is a
 * tripwire: the row that would make the admin lie again is now one the money
 * paths read, and putting the lie back cannot be done quietly.
 *
 * Refusing on the mere PRESENCE of a Stripe connection would be the wrong rule
 * and a severe regression — finishing Connect onboarding would break card
 * payments outright, and the admin already tells the owner the truth in that
 * state.
 *
 * Called from the paths that START a movement of money: the checkout session and
 * the refund. Deliberately NOT from `verifyCheckoutSession`, the webhook or
 * `reconcilePendingCheckouts` — those record money that has ALREADY moved, and
 * refusing there would leave a real charge with no payment row and no order
 * marked paid, which is worse than the mis-routing being complained about.
 *
 * See `tasks/stripe-connect-runbook.md` for the half deliberately not done here.
 */
async function assertChargeableOnPlatform(
  ctx: ActionCtx,
  /** Which money path is being refused — it goes into the audit line. */
  moment: "checkout" | "refund",
  orderId?: string
): Promise<void> {
  const connection = await ctx.runQuery(
    internal.paymentConnections.internalGetByProvider,
    { provider: "stripe" as const }
  );

  try {
    resolveStripeCharge(connection);
  } catch (error) {
    // A refusal nobody can see is a refusal nobody can fix.
    //
    // This gate throws BEFORE any call to Stripe, so the credentials verdict
    // that `createCheckoutSession` records on a refused key is never reached
    // — correctly, since nothing has asked Stripe anything. The consequence
    // was that a deployment turning every diner away for a routing reason
    // left no trace at all: `cardProviderHealth` empty (right), the ledger
    // empty (right, no money moved), and nowhere at all saying why the
    // checkout was refusing. `paymentAvailability` already greys the tile
    // from the same rule, so the diner is told; this is the half that tells
    // whoever has to put it right.
    //
    // Recorded, never rethrown from the recording: the refusal is the
    // outcome, and a failure to write it down must not replace it.
    if (error instanceof StripeChargeRouteError) {
      await ctx
        .runMutation(internal.payments.internalRecordRefusedCollection, {
          provider: "stripe" as const,
          code: error.reason,
          message: error.message,
          eventType: `stripe.${moment}`,
          ...(orderId ? { orderId } : {}),
          ...(error.merchantId ? { externalId: error.merchantId } : {}),
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Is this Stripe error about OUR credentials, rather than about the payment?
 *
 * The distinction decides whether the card tile is disarmed for everybody, so
 * it has to be narrow. `StripeAuthenticationError` is Stripe refusing the key
 * itself; `StripePermissionError` is a key that is real but not allowed to do
 * this. A declined card, a rate limit, an idempotency conflict or an outage
 * say nothing about the key, and recording those as "unusable" would take card
 * payments away from a working establishment over a transient failure.
 *
 * Matched on `type` rather than with `instanceof`: the SDK is imported
 * dynamically in each action, and its error classes are not worth pinning a
 * second import for.
 */
function isStripeCredentialsRefusal(error: unknown): boolean {
  const type = (error as { type?: unknown } | null)?.type;
  return (
    type === "StripeAuthenticationError" || type === "StripePermissionError"
  );
}

/**
 * Has money already been taken for this order?
 *
 * TWO READS, because one of them is not enough and the missing half is what
 * #411 is about.
 *
 * `paymentStatus` is the order's own account of itself, and it is the stricter
 * of the two: it counts `refunded`, so a refunded order is closed to new
 * payment attempts exactly as `orders.markCashPaid` has always closed it. A
 * refunded order is finished business, and taking money on it again should be
 * a new order rather than a second attempt at the old one.
 *
 * It is also not the whole truth. A settlement writes the payment row and the
 * order status in two transactions, so between them an order reads `pending`
 * with a `succeeded` row already against it — and a gate that trusts the
 * status alone sends the diner to pay a second time in exactly the window
 * where a payment is being recorded. `internalCollectionOnOrder` asks the
 * ledger, which is where the answer actually is.
 *
 * Shared by all three provider checkouts: the rule is about the order, not
 * about which page the diner happens to be on.
 */
async function orderAlreadyPaid(
  ctx: ActionCtx,
  orderId: Id<"orders">,
  paymentStatus: string | undefined
): Promise<boolean> {
  if (orderAlreadyCollected(paymentStatus)) return true;
  const collected = await ctx.runQuery(
    internal.payments.internalCollectionOnOrder,
    { orderId }
  );
  return collected !== null;
}

/** A Stripe client, as `openCardCharge` builds it. */
type StripeClient = StripeSdk;

/** What `openCardCharge` hands back once every refusal has been passed. */
interface OpenedCardCharge {
  stripe: StripeClient;
  order: OrderData;
  site: SiteEnv;
}

/**
 * Everything a card charge must clear before Stripe is asked to create one.
 *
 * Shared by `createCheckoutSession` (the hosted page) and `createPaymentIntent`
 * (the native app's sheet). They are two doors onto one charge, and a refusal
 * one of them makes and the other does not is a way round it. In order:
 *
 *  1. The routing gate, before the SDK is even loaded: a connection state this
 *     file cannot honour must stop the charge, not shape it. To the diner both
 *     refusals below are one fact — this deployment cannot take a card — and a
 *     plain `Error` here reached them as a redacted "Server Error" behind the
 *     checkout's generic retry toast, on the very path a fresh deployment
 *     pre-selected (#374). `CardPaymentUnavailableError` is a `ConvexError`,
 *     so the French sentence survives the wire; the routing detail stays in
 *     the log via the admin surfaces that read the connection row.
 *  2. The secret key.
 *  3. Nothing is owed twice. An order whose money has already arrived must not
 *     be sent to a payment page at all: `orders.create` is idempotent on the
 *     diner's key, so a back-navigation and a resubmit land on the SAME order,
 *     and opening a second charge on a paid one charges the same meal again.
 *     The ledger refuses the second row afterwards (#411), which keeps the
 *     books right and leaves the diner debited and waiting for a refund. This
 *     is the half that stops the charge being taken.
 *  4. A total no card provider will take. Stripe's EUR floor is 0,50 € and the
 *     create call is what would otherwise discover that — as a plain SDK
 *     error, redacted to "Server Error" behind the checkout's retry toast, on
 *     an order that can never be paid however many times the diner tries. A
 *     100 % coupon is the ordinary way to reach it. `"EUR"` rather than
 *     `globalSettings.currency` on purpose: EUR is what both callers actually
 *     send, so the floor has to be the one that applies to them.
 *
 * The rate limit is NOT in here, deliberately: each public action spends its
 * own unit first, visibly, because `public-action-limits.test.ts` holds every
 * public action in this file to metering an anonymous caller in its own body.
 */
async function openCardCharge(
  ctx: ActionCtx,
  orderId: Id<"orders">
): Promise<OpenedCardCharge> {
  try {
    await assertChargeableOnPlatform(ctx, "checkout", orderId);
  } catch (error) {
    if (error instanceof StripeChargeRouteError) {
      throw new CardPaymentUnavailableError();
    }
    throw error;
  }

  const Stripe = (await import("stripe")).default;
  const { getSiteEnv } = await import("@be-yours/core/env");
  const site = getSiteEnv();

  const secretKey = site.STRIPE_SECRET_KEY;
  if (!secretKey) throw new CardPaymentUnavailableError();

  const order: OrderData | null = await ctx.runQuery(internal.orders.internalGetById, {
    id: orderId,
  });
  if (!order) throw new Error("Order not found");

  if (await orderAlreadyPaid(ctx, orderId, order.paymentStatus)) {
    throw new OrderAlreadyPaidError();
  }

  assertCardChargeable({ amountMinor: order.total, currency: "EUR" });

  const stripe = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  return { stripe, order, site };
}

/**
 * Close the hosted Checkout Session this order was last sent to, before
 * another charge is opened beside it.
 *
 * What this DOES close is the sequential case, which is the one #411 describes
 * and by far the commonest: open, go back, open again. What it cannot close is
 * two opens genuinely in flight at once, or a Stripe read that fails while the
 * create succeeds — an action is several round trips with no transaction
 * around them, and there is no lock to take. Those fall through to the ledger,
 * which IS serializable: two completed charges on one order produce one
 * `succeeded` row, the second is refused and recorded for a refund.
 * Prevention here, guarantee there.
 *
 * Nothing used to close the previous session: `internalAttachCheckoutSession`
 * overwrote the stored id and Stripe kept the old session live for ~24 h, so a
 * diner who opened checkout twice left TWO payable sessions against one order
 * and a 1 200 € order could collect 2 400 € (#411).
 *
 * Awaited rather than scheduled: the new charge must not become payable while
 * the old one still is. `expireCheckoutSession` never throws — Stripe refuses
 * to expire a session that is already expired, which is the outcome we wanted
 * anyway — so this cannot stop a diner paying.
 *
 * Its ANSWER is read, though, and one answer stops the charge dead.
 * `already_paid` means the previous session has been completed and its
 * settlement has not reached us yet — the webhook is in flight, or the diner
 * closed the tab before the return page. The order still reads `pending`, so
 * no status gate sees it, and opening a replacement would charge the same meal
 * twice with both charges legitimate as far as every later check can tell.
 */
async function closePreviousCheckoutSession(
  ctx: ActionCtx,
  order: OrderData
): Promise<void> {
  if (!order.stripeCheckoutSessionId) return;
  const outcome = await ctx.runAction(internal.stripe.expireCheckoutSession, {
    checkoutSessionId: order.stripeCheckoutSessionId,
  });
  if (outcome === "already_paid") {
    throw new OrderAlreadyPaidError();
  }
}

/**
 * Close the in-app PaymentIntent this order was last handed, before a hosted
 * Checkout Session is opened beside it.
 *
 * The same rule as `closePreviousCheckoutSession`, from the other door: a
 * diner who opened the app's card sheet, abandoned it and then paid on the
 * hosted page would otherwise leave an intent the app can still confirm.
 *
 *  - succeeded, or processing: money has been taken or is being taken. The
 *    order still reads `pending` because the settlement has not landed, and a
 *    second charge is exactly what #411 was. Refused as already paid.
 *  - cancelled: nothing to do.
 *  - anything else: cancelled at Stripe, then released on our side.
 *
 * A failure to READ or CANCEL is swallowed, exactly as `expireCheckoutSession`
 * swallows its own: a Stripe hiccup must not block a diner from paying, and
 * the ledger still refuses a second collection if both charges complete.
 */
async function closePreviousPaymentIntent(
  ctx: ActionCtx,
  stripe: StripeClient,
  orderId: Id<"orders">,
  order: OrderData
): Promise<void> {
  const intentId = order.stripePaymentIntentId?.trim();
  if (!intentId) return;

  let status: string;
  try {
    status = (await stripe.paymentIntents.retrieve(intentId)).status;
  } catch (error) {
    console.warn(`[Stripe] Could not read payment intent ${intentId}:`, error);
    return;
  }

  if (paymentIntentVerdict(status) === "collected" || status === "processing") {
    throw new OrderAlreadyPaidError();
  }
  if (status !== "canceled") {
    try {
      await stripe.paymentIntents.cancel(intentId);
    } catch (error) {
      console.warn(`[Stripe] Could not cancel payment intent ${intentId}:`, error);
      return;
    }
  }
  await ctx.runMutation(internal.payments.internalReleasePaymentIntent, {
    orderId,
    paymentIntentId: intentId,
  });
}

/**
 * Turn a Stripe failure into what the diner should read, and remember a key
 * Stripe refused.
 *
 * A key Stripe REFUSES is the case `paymentAvailability` could not see. Its
 * check is `startsWith("sk_")` — the shape of a string — so a well-formed key
 * that is revoked, rolled or from another account armed the card tile, and the
 * exception thrown by the SDK is a plain `Stripe.errors.StripeAuthenticationError`,
 * which Convex redacts to "Server Error": exactly the screen #374 was written
 * to remove, on exactly the tile it was written to stop pre-selecting (#411).
 *
 * So the refusal is made legible AND remembered. The diner reads the same
 * French sentence as on a keyless deployment — to them it is one fact, this
 * establishment cannot take a card — and the verdict disarms the tile for
 * everyone behind them instead of each one discovering it in turn.
 *
 * This is the DETECTION half only. Recovery cannot come from here: a disarmed
 * tile is one no diner can select, so nothing reaches this line again until
 * the key works. `verifyStripeKey` on the hourly cron is what brings the tile
 * back.
 *
 * Only a credentials refusal. A declined card, a rate limit or a Stripe outage
 * says nothing about the key, and recording those as "unusable" would take the
 * card tile away from a working establishment over a transient failure. Every
 * other error is rethrown unchanged.
 */
async function rethrowStripeFailure(ctx: ActionCtx, error: unknown): Promise<never> {
  if (isStripeCredentialsRefusal(error)) {
    await ctx.runMutation(internal.globalSettings.internalRecordCardProviderHealth, {
      provider: "stripe" as const,
      usable: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error("[Stripe] la clé de ce déploiement a été refusée par Stripe:", error);
    throw new CardPaymentUnavailableError();
  }
  throw error;
}

/**
 * The key works. Written on every success rather than only on a change:
 * `checkedAt` is what tells an operator how fresh the verdict is.
 */
async function recordStripeKeyUsable(ctx: ActionCtx): Promise<void> {
  await ctx.runMutation(internal.globalSettings.internalRecordCardProviderHealth, {
    provider: "stripe" as const,
    usable: true,
  });
}

/**
 * Create a Stripe Checkout Session for card payment.
 * Redirects user to Stripe's hosted payment page.
 */
// @public-by-design: a guest checking out has no account; the amount is read from the order server-side, never taken from the caller
export const createCheckoutSession = action({
  args: {
    orderId: v.id("orders"),
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ sessionUrl: string; sessionId: string }> => {
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

    const { stripe, order } = await openCardCharge(ctx, args.orderId);

    // One order, one payable charge — whichever door it was opened through.
    await closePreviousCheckoutSession(ctx, order);
    await closePreviousPaymentIntent(ctx, stripe, args.orderId, order);

    let session: { url: string | null; id: string };
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "eur",
              unit_amount: order.total,
              product_data: {
                name: `Commande #${order.orderNumber}`,
              },
            },
            quantity: 1,
          },
        ],
        success_url: `${args.successUrl}${args.successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: args.cancelUrl,
        metadata: {
          orderId: args.orderId,
          storeId: order.storeId,
        },
        ...(order.customerInfo?.email
          ? { customer_email: order.customerInfo.email }
          : {}),
      });
    } catch (error) {
      return await rethrowStripeFailure(ctx, error);
    }

    await recordStripeKeyUsable(ctx);

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    // Keep the session id. It used to be handed to the browser and stored
    // nowhere, so a customer who paid and then closed the tab left a paid Stripe
    // charge, an order at `paymentStatus: "pending"` and no way for us to name
    // the session to Stripe and ask what happened. `reconcilePendingCheckouts`
    // reads it back.
    await ctx.runMutation(internal.payments.internalAttachCheckoutSession, {
      orderId: args.orderId,
      checkoutSessionId: session.id,
    });

    return { sessionUrl: session.url, sessionId: session.id };
  },
});

/**
 * The PaymentIntent statuses whose amount Stripe still lets us change.
 *
 * Once an intent is `processing` the confirmation has been submitted and the
 * amount is fixed; a mismatch there is left for the settlement guard to refuse.
 */
const AMOUNT_UPDATABLE_INTENT_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/**
 * Is this Stripe error "that object does not exist"?
 *
 * A stored intent id Stripe cannot find — a key rotated to another account, a
 * test id on a live key — can never collect, so it is replaced rather than
 * leaving the diner stuck on an order no retry can pay.
 */
function isStripeMissingResource(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "resource_missing";
}

/**
 * Create (or reuse) the PaymentIntent the native app's card sheet confirms.
 *
 * The in-app counterpart of `createCheckoutSession`: same order, same guards
 * (`openCardCharge`), same amount source — the order total read from the
 * database, never a number the caller supplies — and the same refusal
 * vocabulary. What differs is only what is handed back: a client secret and
 * the publishable key the sheet needs, instead of a URL to open.
 *
 * ONE ORDER, ONE PAYABLE INTENT. The intent id is stored on the order, and a
 * second call reuses it while it can still collect rather than minting a
 * second one a double tap could also confirm (#411). A succeeded intent means
 * the settlement is on its way and nothing new is opened; a cancelled one is
 * replaced. A hosted Checkout Session left open on the same order is expired
 * first, and one already paid stops this call — the same two-door rule
 * `createCheckoutSession` applies the other way round.
 *
 * The Stripe idempotency key is derived from the order, its total and the
 * intent being replaced, so two taps in flight at once reach Stripe as ONE
 * create, while a replacement after a cancellation, or after the total
 * changed, is a genuinely new request.
 *
 * `NATIVE_CARD_SHEET_UNAVAILABLE` when `STRIPE_PUBLISHABLE_KEY` is not set.
 * Card payment is NOT marked unavailable over it: the hosted page needs no
 * publishable key, and that is where the app sends the diner instead.
 */
// @public-by-design: a guest paying in the app has no account; the amount is read from the order server-side, never taken from the caller
export const createPaymentIntent = action({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    publishableKey: string;
    amount: number;
    currency: string;
  }> => {
    // Same unit, same bucket as the hosted checkout: it is the same charge
    // opened through another door, and a script alternating the two must not
    // get twice the allowance (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.orderId,
    });

    const { stripe, order, site } = await openCardCharge(ctx, args.orderId);

    // Checked BEFORE anything is closed or created, so the fallback to the
    // hosted page starts from exactly the state this call found.
    const publishableKey = site.STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey || !publishableKey.startsWith("pk_")) {
      throw new NativeCardSheetUnavailableError();
    }

    await closePreviousCheckoutSession(ctx, order);

    let intent: StripeSdk.PaymentIntent | null = null;
    let replaces: string | null = null;
    try {
      const storedId = order.stripePaymentIntentId?.trim();
      if (storedId) {
        let previous: StripeSdk.PaymentIntent | null = null;
        try {
          previous = await stripe.paymentIntents.retrieve(storedId);
        } catch (error) {
          if (!isStripeMissingResource(error)) throw error;
        }

        const verdict = previous ? paymentIntentVerdict(previous.status) : "replace";
        if (verdict === "collected") {
          // The diner has paid; the settlement has not reached the order yet.
          // `verifyPaymentIntent` or the webhook closes it — a second intent
          // would only charge the same meal again.
          throw new OrderAlreadyPaidError();
        }
        if (verdict === "reuse" && previous) {
          // Still able to collect: hand it back. If the order total moved since
          // it was created, move the intent with it while Stripe still allows —
          // otherwise the settlement would refuse the payment as a mismatch
          // after the diner had been charged.
          intent =
            previous.amount !== order.total &&
            AMOUNT_UPDATABLE_INTENT_STATUSES.has(previous.status)
              ? await stripe.paymentIntents.update(previous.id, {
                  amount: order.total,
                })
              : previous;
        } else {
          replaces = storedId;
        }
      }

      if (!intent) {
        intent = await stripe.paymentIntents.create(
          {
            amount: order.total,
            currency: "eur",
            automatic_payment_methods: { enabled: true },
            description: `Commande #${order.orderNumber}`,
            metadata: {
              orderId: args.orderId,
              storeId: order.storeId,
            },
            ...(order.customerInfo?.email
              ? { receipt_email: order.customerInfo.email }
              : {}),
          },
          {
            idempotencyKey: `native-sheet:${args.orderId}:${order.total}:${replaces ?? "first"}`,
          }
        );
      }
    } catch (error) {
      return await rethrowStripeFailure(ctx, error);
    }

    await recordStripeKeyUsable(ctx);

    if (!intent?.client_secret) {
      throw new Error("Stripe did not return a client secret for the payment intent");
    }

    // Stored before it is handed out: the order must already name the intent
    // the app is about to confirm, so the next call reuses it and the webhook
    // finds its ledger row.
    await ctx.runMutation(internal.payments.internalAttachPaymentIntent, {
      orderId: args.orderId,
      paymentIntentId: intent.id,
    });

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      publishableKey,
      amount: intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  },
});

/**
 * What became of a Checkout Session this order has stopped needing.
 *
 *  - `expired`       — it was open, and is now closed. Nobody can pay it.
 *  - `already_paid`  — it has been COMPLETED and its settlement has not
 *                      reached us yet. The caller must not open a replacement:
 *                      the order still reads `pending`, so no status gate can
 *                      see this, and a second session would collect the same
 *                      meal twice (#411).
 *  - `nothing_to_do` — no session, no Stripe key, or a session that was
 *                      already closed. The outcome we wanted either way.
 *  - `unknown`       — Stripe could not be reached or refused the read. The
 *                      caller decides; this action does not throw, because it
 *                      also runs on the scheduler behind an order already
 *                      confirmed to a diner.
 */
type CheckoutSessionClosure =
  | "expired"
  | "already_paid"
  | "nothing_to_do"
  | "unknown";

/**
 * Expire a Checkout Session the order has no further use for.
 *
 * WHY THIS EXISTS: a session outlives the intention behind it. #374 lets a
 * diner who abandoned Stripe confirm « Espèces » on the same checkout attempt,
 * and re-methods the reused order to cash — while the Stripe session stayed
 * payable for ~24 h behind the tab they left open. Once the counter had taken
 * the notes, completing that session collected the same order a second time:
 * a cash row and a payment-intent row, both `succeeded`, both independently
 * refundable, one meal charged twice (#378). `assertSettlesOrder` refuses that
 * settlement now; this is what stops the second charge being taken at all,
 * which is the difference between the diner being made whole and the diner
 * never being charged.
 *
 * Never throws, and ANSWERS instead. It is called two ways: scheduled, behind
 * an order already confirmed to the diner, where a throw would be noise; and
 * awaited by `createCheckoutSession` and `createPaymentIntent` before either
 * opens a replacement, where a throw would block a payment. So every failure is caught and reported as a
 * `CheckoutSessionClosure` — including the whole set-up, since `getSiteEnv()`
 * parses the environment and the dynamic import can fail too.
 *
 * Why it RETRIEVES first. Stripe refuses to expire anything that is not `open`
 * and reports "already expired" and "already paid" with the same error, and
 * those two need opposite responses. The first is the outcome we wanted. The
 * second means the previous session has been completed and its settlement has
 * not reached us yet — the order still reads `pending`, so no status gate can
 * see it — and opening a replacement then collects the same meal twice (#411).
 */
export const expireCheckoutSession = internalAction({
  args: { checkoutSessionId: v.string() },
  handler: async (_ctx, args): Promise<CheckoutSessionClosure> => {
    const sessionId = args.checkoutSessionId.trim();
    if (!sessionId) return "nothing_to_do";

    // INSIDE the try, all of it. This action is `await`ed on the diner's
    // checkout path now, not only scheduled behind a confirmed order, so
    // "never throws" has to be enforced rather than asserted: `getSiteEnv()`
    // parses the environment and can throw, and so can the dynamic import.
    try {
      const Stripe = (await import("stripe")).default;
      const { getSiteEnv } = await import("@be-yours/core/env");

      // Nothing to expire on a deployment that takes no card payments.
      const secretKey = getSiteEnv().STRIPE_SECRET_KEY;
      if (!secretKey) return "nothing_to_do";

      const stripe = new Stripe(secretKey, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      // Read before writing. `sessions.expire` refuses anything that is not
      // `open`, and reports "already paid" and "already expired" with the same
      // error — two outcomes that need opposite responses from the caller. One
      // is what we wanted; the other is a charge that has already been taken.
      // The extra call runs only on the rare path where one order is sent to
      // checkout twice.
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === "paid") return "already_paid";
      if (session.status !== "open") return "nothing_to_do";

      await stripe.checkout.sessions.expire(sessionId);
      return "expired";
    } catch (error) {
      console.warn(
        `[Stripe] Could not expire checkout session ${sessionId}:`,
        error
      );
      return "unknown";
    }
  },
});

/**
 * Verify a Stripe Checkout Session after redirect.
 * Updates order and creates payment record if paid.
 */
// @public-by-design: called from the return page by a guest; the session id is the only
// argument and the order comes from that same session's metadata, so nothing a caller
// supplies chooses which order is settled. assertSettlesOrder then binds the amount and
// currency Stripe reports to the order total before anything is marked paid.
export const verifyCheckoutSession = action({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, args): Promise<{
    status: string;
    orderId?: Id<"orders">;
    orderNumber?: string;
    viewToken?: string;
    email?: string;
    error?: string;
  }> => {
    // Bounded on the session id, which is what this action is given.
    //
    // Stated plainly rather than overclaimed: this stops a LOOP on one session
    // id. It does not stop a caller inventing ids, and nothing here can —
    // there is no order and no store to key on until Stripe answers. What
    // makes that acceptable is that an invented id is refused by Stripe on the
    // spot and creates nothing; what was worth bounding is the real id, which
    // a return page can otherwise be made to replay without limit (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.sessionId,
    });

    const Stripe = (await import("stripe")).default;
    const { getSiteEnv } = await import("@be-yours/core/env");
    const site = getSiteEnv();

    const secretKey = site.STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const rawSession = await stripe.checkout.sessions.retrieve(args.sessionId);
    const orderId = rawSession.metadata?.orderId as Id<"orders"> | undefined;
    const storeId = rawSession.metadata?.storeId as Id<"stores"> | undefined;

    if (!orderId) {
      return { status: "error", error: "Missing orderId in session metadata" };
    }

    // Fetch order for response data
    const order: OrderData | null = await ctx.runQuery(internal.orders.internalGetById, {
      id: orderId,
    });

    if (rawSession.payment_status === "paid" && order) {
      // Before the idempotency check, not after: an order already marked paid
      // must not let a mismatched session through unexamined.
      //
      // The reference check is tautological on this path — `orderId` came from
      // this very session's metadata, so it cannot name a different order. It
      // stays because it costs nothing and keeps the guard identical across the
      // three providers. What this genuinely closes is the AMOUNT and CURRENCY
      // binding: `amount_total` was recorded as the settlement with nothing
      // compared to it, so a session worth less than the order — an order
      // edited after the session was created, a Stripe-side coupon, a stale
      // session for an earlier cart — flipped the order to `paid` and booked
      // the smaller sum as payment in full.
      const settlement = readStripeCheckoutSession(rawSession);
      assertSettlesOrder(
        {
          provider: "stripe",
          reference: settlement.reference,
          // Stripe reports MINOR units. This must never go through the
          // major-unit field: it would be multiplied by 100 and reject every
          // legitimate payment.
          amountMinor: settlement.amountMinor,
          currency: settlement.currency,
        },
        {
          orderId,
          total: order.total,
          // The order's method as it stands NOW. A session left live behind an
          // abandoned checkout must not collect an order the counter has since
          // taken in cash (#378).
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
        }
      );

      // THE LEDGER FIRST, THEN THE ORDER — the same order `stripeWebhook.ts`
      // states, and the reason is the same on a return page.
      //
      // These are two mutations and therefore two transactions. Marking the
      // order paid first COMMITS that, and `internalSettle` can still refuse
      // afterwards. The order was then left reading « Payé » with no payment
      // row against it: the money is not on the ledger, the invoice is minted
      // against a total nothing backs, and the diner's confirmation is on its
      // way. Probed: 2 400 c taken, 1 200 c recorded, `FA-2026-000001` issued.
      //
      // Settling first is safe in the other direction: `internalSettle` reads
      // nothing about the order's status, and a settlement that succeeds is
      // exactly the case in which the status write is wanted.
      //
      // One mutation, one transaction. The webhook settles this same charge
      // from a DIFFERENT event, and the two used to race: each read
      // `paymentStatus !== "paid"` and then wrote, so the loser still inserted
      // a second `succeeded` row for one charge — and each row was
      // independently refundable. `internalSettle` keys on the payment intent
      // and makes the second caller a no-op.
      //
      // Unconditional: the row records that the money moved, which stays true
      // whether the order ends up paid or awaiting a refund.
      await settleOrRecordRefusal(ctx, {
        orderId,
        storeId: storeId ?? (order.storeId as Id<"stores">),
        // The order total, not the provider's number. After the assert the two
        // are equal by construction, and this closes the last path by which a
        // provider-reported amount reached the ledger unchecked.
        // Matches sumup.ts and paypal.ts.
        amount: order.total,
        currency: settlement.currency ?? "EUR",
        provider: "stripe",
        externalId: String(settlement.paymentIntentId ?? rawSession.id),
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

      return {
        status: "paid" as const,
        orderId,
        orderNumber: order.orderNumber,
        viewToken: order.viewToken,
        email: order.customerInfo?.email,
      };
    }

    return {
      status: (rawSession.payment_status ?? "unpaid") as string,
      orderId,
      orderNumber: order?.orderNumber,
      viewToken: order?.viewToken,
    };
  },
});

/**
 * Verify an in-app PaymentIntent once the native sheet reports it finished.
 *
 * The native counterpart of `verifyCheckoutSession`, with the same answer
 * shape so the app's confirmation screen reads both alike. It settles through
 * exactly the same steps, in the same order: bind what Stripe reports to the
 * order (`assertSettlesOrder`), record the money or record the refusal
 * (`settleOrRecordRefusal`), then ask `paymentStatusAfterSettlement` what the
 * order becomes. Idempotent: `internalSettle` keys on the intent id, so a
 * repeated call, or one racing the webhook, writes no second row.
 */
// @public-by-design: called by the app after the payment sheet closes, by a guest; the intent id is
// the only argument and the order comes from that same intent's metadata, so nothing a caller
// supplies chooses which order is settled. assertSettlesOrder then binds the amount and currency
// Stripe reports to the order total before anything is marked paid.
export const verifyPaymentIntent = action({
  args: {
    paymentIntentId: v.string(),
  },
  handler: async (ctx, args): Promise<{
    status: string;
    orderId?: Id<"orders">;
    orderNumber?: string;
    viewToken?: string;
    email?: string;
    error?: string;
  }> => {
    // Bounded on the intent id, which is what this action is given — the same
    // reasoning, and the same limit, as `verifyCheckoutSession` (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "paymentSessionPerOrder",
      subject: args.paymentIntentId,
    });

    const Stripe = (await import("stripe")).default;
    const { getSiteEnv } = await import("@be-yours/core/env");
    const site = getSiteEnv();

    const secretKey = site.STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const rawIntent = await stripe.paymentIntents.retrieve(args.paymentIntentId);
    const settlement = readStripePaymentIntent(rawIntent);
    const orderId = settlement.reference as Id<"orders"> | undefined;

    if (!orderId) {
      // A hosted-checkout intent carries no metadata of ours; that path is
      // verified through its session, not here.
      return { status: "error", error: "Missing orderId in payment intent metadata" };
    }

    const order: OrderData | null = await ctx.runQuery(internal.orders.internalGetById, {
      id: orderId,
    });

    if (rawIntent.status === "succeeded" && order) {
      // Before any idempotency shortcut: an order already marked paid must not
      // let a mismatched intent through unexamined. The reference check is
      // tautological here, as it is for a checkout session — the order id came
      // from this intent's own metadata. What it closes is the AMOUNT and
      // CURRENCY binding: `amount_received` must equal the order total to the
      // cent, or nothing is marked paid.
      assertSettlesOrder(
        {
          provider: "stripe",
          reference: settlement.reference,
          // MINOR units already. Never the major-unit field.
          amountMinor: settlement.amountMinor,
          currency: settlement.currency,
        },
        {
          orderId,
          total: order.total,
          // The order's method as it stands NOW (#378).
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
        }
      );

      // THE LEDGER FIRST, THEN THE ORDER — see `verifyCheckoutSession` for the
      // measured cost of the other order. Unconditional: the row records that
      // the money moved, which stays true whether the order ends up paid or
      // awaiting a refund.
      await settleOrRecordRefusal(ctx, {
        orderId,
        // The ORDER's store, never the metadata's copy of it.
        storeId: order.storeId as Id<"stores">,
        // The order total, not the provider's number: equal by construction
        // after the assert.
        amount: order.total,
        currency: settlement.currency ?? "EUR",
        provider: "stripe",
        externalId: rawIntent.id,
      });

      const nextPaymentStatus = paymentStatusAfterSettlement(order);
      if (nextPaymentStatus) {
        await ctx.runMutation(internal.orders.internalUpdatePaymentStatus, {
          id: orderId,
          paymentStatus: nextPaymentStatus,
        });
      }

      return {
        status: "paid" as const,
        orderId,
        orderNumber: order.orderNumber,
        viewToken: order.viewToken,
        email: order.customerInfo?.email,
      };
    }

    // Not settled (yet): Stripe's own status, verbatim — `processing` for a
    // payment method that confirms later, `requires_payment_method` for a
    // declined card the diner can retry in the same sheet.
    return {
      status: rawIntent.status,
      orderId,
      orderNumber: order?.orderNumber,
      viewToken: order?.viewToken,
    };
  },
});

/**
 * Issue a refund against a Stripe payment intent.
 *
 * Internal: authorisation and bookkeeping live in `payments.refundPayment`.
 * This only talks to Stripe and reports what it said.
 */
export const internalRefund = internalAction({
  args: {
    /** The stored payment intent id (`pi_…`). */
    externalId: v.string(),
    /** Amount in cents. */
    amount: v.number(),
    reason: v.optional(v.string()),
    /**
     * Stable across retries of ONE reserved refund, different for the next.
     * Built by `payments.refundPayment` from the payment id and the refund's
     * ordinal — see the comment there for why a reservation is not enough.
     */
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ refundId: string }> => {
    // The same gate as `createCheckoutSession`, on purpose. A refund that
    // ignored the rule while checkout honoured it is the same split this
    // repository keeps hitting: the two halves of one charge would disagree
    // about which account they belong to.
    await assertChargeableOnPlatform(ctx, "refund");

    const Stripe = (await import("stripe")).default;
    const { getSiteEnv } = await import("@be-yours/core/env");

    const secretKey = getSiteEnv().STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Stripe's own `reason` field is a closed enum, so the operator's free-text
    // motive goes to metadata where it survives without being rejected.
    // The key goes in the REQUEST OPTIONS, not the body: Stripe replays the
    // original response for 24 hours rather than creating a second refund. Same
    // call shape `apps/site` already uses for its own Stripe requests.
    const refund = await stripe.refunds.create(
      {
        payment_intent: args.externalId,
        amount: args.amount,
        metadata: args.reason ? { motif: args.reason.slice(0, 500) } : undefined,
      },
      args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined
    );

    // `pending` is legitimate for some payment methods; `failed` and `canceled`
    // are not refunds and must not be recorded as such.
    if (refund.status && !["succeeded", "pending"].includes(refund.status)) {
      throw new Error(`Stripe a refusé le remboursement (statut ${refund.status}).`);
    }

    return { refundId: refund.id };
  },
});

/**
 * Ask Stripe what really happened to the checkouts that never came back paid.
 *
 * WHY THIS EXISTS: every path that marked an order paid was a message we had to
 * RECEIVE — the customer landing on the confirmation page, or a webhook
 * delivery. Neither is guaranteed. A guest who pays and closes the tab sends
 * neither, and if the `checkout.session.completed` delivery is also lost the
 * charge sits in Stripe with an order at `paymentStatus: "pending"` behind it.
 * The kitchen never sees the order and the customer has paid. Nothing detected
 * that, ever, because detecting it means asking rather than waiting.
 *
 * This is the asking. It runs on the scheduler and takes the same route as
 * every other settlement: `assertSettlesOrder` binds the amount and currency to
 * the order, `paymentStatusAfterSettlement` decides what the order becomes, and
 * `internalSettle` writes the payment row — so a session that also arrived by
 * webhook produces no second row, and a session for a cancelled order is
 * recorded as money owed back rather than as a paid order.
 *
 * The window has both ends. Below `minAgeMinutes` the customer may still be on
 * Stripe's payment page; above `maxAgeHours` the session has expired on Stripe's
 * side and there is nothing left to retrieve.
 *
 * One order's failure does not stop the sweep: a mismatched amount throws from
 * the guard, and that order is exactly the one a human needs to look at, not a
 * reason to abandon the others.
 */
export const reconcilePendingCheckouts = internalAction({
  args: {
    now: v.optional(v.number()),
    minAgeMinutes: v.optional(v.number()),
    maxAgeHours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ examined: number; settled: number; failed: number }> => {
    const Stripe = (await import("stripe")).default;
    const { getSiteEnv } = await import("@be-yours/core/env");

    const secretKey = getSiteEnv().STRIPE_SECRET_KEY;
    if (!secretKey) {
      // Not an error on a deployment that takes no card payments.
      return { examined: 0, settled: 0, failed: 0 };
    }

    const candidates = await ctx.runQuery(
      internal.payments.internalListStrandedCheckouts,
      {
        now: args.now,
        minAgeMinutes: args.minAgeMinutes,
        maxAgeHours: args.maxAgeHours,
        limit: args.limit,
      }
    );

    if (candidates.length === 0) {
      return { examined: 0, settled: 0, failed: 0 };
    }

    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    let settled = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const rawSession = await stripe.checkout.sessions.retrieve(
          candidate.checkoutSessionId
        );

        // Unpaid or expired: the customer never completed it. Leave the order
        // alone — an abandoned checkout is not a failed payment, and marking it
        // as one would hide a customer who is about to come back and pay.
        if (rawSession.payment_status !== "paid") continue;

        const orderId = candidate.orderId as Id<"orders">;
        const settlement = readStripeCheckoutSession(rawSession);

        // Read BEFORE the guard, not after. `listStrandedCheckouts` picked this
        // candidate out of an index read taken at the top of the sweep, so its
        // `paymentStatus` is a snapshot; the method check needs the order as it
        // is NOW. A sweep that began before the counter took the cash would
        // otherwise settle the very session #378 is about.
        const order: OrderData | null = await ctx.runQuery(
          internal.orders.internalGetById,
          { id: orderId }
        );
        if (!order) continue;

        // Same binding as the return page and the webhook: what Stripe reports
        // must equal the order, to the cent, or nothing is marked paid.
        assertSettlesOrder(
          {
            provider: "stripe",
            reference: settlement.reference,
            amountMinor: settlement.amountMinor,
            currency: settlement.currency,
          },
          {
            orderId,
            total: candidate.total,
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
          }
        );

        // THE LEDGER FIRST, THEN THE ORDER, as everywhere else that settles.
        // Two mutations are two transactions: marking the order paid first
        // commits it, and `internalSettle` can still refuse — leaving an order
        // reading « Payé » with nothing on the ledger behind it, on a sweep
        // that runs unattended at 3am. The refusal is caught below and recorded
        // where an operator reads it.
        await ctx.runMutation(internal.payments.internalSettle, {
          orderId,
          storeId: candidate.storeId as Id<"stores">,
          amount: candidate.total,
          currency: settlement.currency ?? "EUR",
          provider: "stripe",
          externalId: String(settlement.paymentIntentId ?? rawSession.id),
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
        failed += 1;
        console.error(
          `[Stripe Reconcile] order ${candidate.orderId} (session ${candidate.checkoutSessionId}):`,
          error
        );

        // A refusal here means what it means on the webhook: a real charge
        // exists at Stripe for an order this deployment will not record again,
        // and somebody owes the diner a refund. The sweep runs unattended at
        // 3am, so a `console.error` in one client's Convex dashboard is
        // precisely nobody being told (#411).
        const refusal = deliberateSettlementRefusal(error);
        if (refusal) {
          await ctx.runMutation(
            internal.payments.internalRecordRefusedCollection,
            {
              provider: "stripe" as const,
              code: refusal.code,
              message: refusal.message,
              eventType: "reconcilePendingCheckouts",
              externalId: candidate.checkoutSessionId,
              orderId: candidate.orderId as Id<"orders">,
              storeId: candidate.storeId as Id<"stores">,
            }
          );
        }
      }
    }

    if (settled > 0 || failed > 0) {
      console.log(
        `[Stripe Reconcile] examined ${candidates.length}, settled ${settled}, failed ${failed}`
      );
    }

    return { examined: candidates.length, settled, failed };
  },
});

/**
 * Ask Stripe whether this deployment's key still works, and write it down.
 *
 * WHY A SCHEDULED CHECK AND NOT ONLY THE CHECKOUT PATH. Two reasons, and the
 * second is the one that decides the interval. A key is revoked or rolled
 * between orders, so left to the checkout alone the first diner of the day is
 * the one who finds out. And once a verdict has disarmed the tile, the
 * checkout is unreachable — no diner can select a tile the storefront renders
 * disabled — so the checkout can never be what discovers the key has been put
 * right. This is the only writer that can bring card payments back, which is
 * why it runs hourly rather than nightly.
 *
 * `balance.retrieve` is the cheapest authenticated call Stripe offers and it
 * reads nothing about anybody: it answers the one question asked here, which
 * is whether these credentials are accepted at all.
 *
 * Never throws — it is a cron, and the deployment must not go red over a
 * check. A failure that is NOT about the credentials leaves the last verdict
 * standing rather than replacing it with a guess.
 */
export const verifyStripeKey = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: boolean; usable: boolean }> => {
    const { getSiteEnv } = await import("@be-yours/core/env");

    let secretKey: string | undefined;
    try {
      secretKey = getSiteEnv().STRIPE_SECRET_KEY;
    } catch {
      // A malformed env refuses to parse. `paymentAvailability` already reads
      // that as unavailable through its own key check.
      return { checked: false, usable: false };
    }

    // Nothing to verify on a deployment that takes no card payments. Recording
    // "unusable" here would be redundant — the key check already answers it —
    // and would overwrite a verdict about a key that may come back.
    if (!secretKey) return { checked: false, usable: false };

    const Stripe = (await import("stripe")).default;
    // Inert unless the bench's stand-in is switched on (`stripeSdkEndpoint`): a key check
    // that reached the real Stripe with a stand-in key would mark the card provider
    // unusable for every guest of a bench with no provider account.
    const { stripeSdkEndpoint } = await import(
      "@be-yours/convex-functions/reservationProviders"
    );
    const standIn = stripeSdkEndpoint(process.env);
    const stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(),
      ...(standIn ?? {}),
    });

    try {
      await stripe.balance.retrieve();
    } catch (error) {
      if (!isStripeCredentialsRefusal(error)) {
        console.warn("[Stripe] key check could not complete:", error);
        return { checked: false, usable: false };
      }
      await ctx.runMutation(
        internal.globalSettings.internalRecordCardProviderHealth,
        {
          provider: "stripe" as const,
          usable: false,
          detail: error instanceof Error ? error.message : String(error),
        }
      );
      return { checked: true, usable: false };
    }

    await ctx.runMutation(
      internal.globalSettings.internalRecordCardProviderHealth,
      { provider: "stripe" as const, usable: true }
    );
    return { checked: true, usable: true };
  },
});
