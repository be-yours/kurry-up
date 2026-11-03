import { query, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/orders";
import { orderInvoiceSurface } from "@be-yours/convex-functions/invoices";
import {
  buildOrderConfirmationPayload,
  planOrderConfirmation,
  releaseOrderConfirmationClaim,
} from "@be-yours/convex-functions/orderConfirmation";
import {
  readyPayload,
  releaseReadyClaim,
} from "@be-yours/convex-functions/orderReady";
import { noticeFailureInputValidator } from "@be-yours/convex-schema";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";
import { v } from "convex/values";
import { captureBackendError } from "./errorReporting";

// === Queries (auth-protected) ===

export const list = storeQuery({
  permission: "orders:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

/** The dashboard's aggregates, computed on the server over a window. */
/**
 * The overview screen's figures.
 *
 * `analytics:read`, not `orders:read`. The two permissions were declared
 * together and only one of them was ever enforced: `analytics:read` and
 * `analytics:view_all` existed in `packages/core/src/auth/rbac.ts` and were
 * consumed by nothing at all, while a `kitchen` account — which holds
 * `orders:read` so it can work the pass — could read the establishment's
 * takings, average basket and best-selling dishes. Turnover is not pass
 * information.
 *
 * The SCREEN stays reachable: it is where every login lands, and its quick
 * actions and recent-orders table are `orders:read`, which all three limited
 * roles hold. `use-dashboard-stats.ts` asks this query only when the role
 * carries the permission, and says so in place of the figures when it does
 * not — a refusal thrown out of `useQuery` unwinds the render, so a screen that
 * merely let it throw would be a blank page for a third of the team.
 */
export const dashboardStats = storeQuery({
  permission: "analytics:read",
  args: defs.dashboardStats.args,
  handler: (ctx, args) => defs.dashboardStats.handler(ctx, args),
});

/** The dashboard's "Dernières commandes" table — ten rows, ten reads. */
export const recent = storeQuery({
  permission: "orders:read",
  args: defs.recent.args,
  handler: (ctx, args) => defs.recent.handler(ctx, args),
});

/** Get order by ID with access control (view token, the customer, or the store's staff) */
// @guarded-inline: the view token issued at checkout, the customer who placed
// the order, or someone who works at that order's restaurant and holds
// `orders:read` there; otherwise null
export const getById = query({
  args: {
    id: v.id("orders"),
    viewToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.id);
    if (!order) return null;

    // The invoice's number, or the reason none exists — computed on every
    // read, never persisted, so completing the seller identity is enough to
    // change the answer (#375). Everyone allowed to read the order gets it:
    // the reason a paid order carries no invoice is part of the order.
    const enriched = async () => ({
      ...order,
      ...(await orderInvoiceSurface(ctx, order)),
    });

    // Access via view token
    if (args.viewToken && order.viewToken === args.viewToken) {
      return enriched();
    }

    // Access via authenticated owner
    const identity = await ctx.auth.getUserIdentity();
    if (identity && order.customerId === identity.subject) {
      return enriched();
    }

    /**
     * Access via the staff of the restaurant the order belongs to.
     *
     * The two branches above ask "did you place this order". Nothing asked "do
     * you work here", so the admin's order-detail screen was unreachable for
     * every guest order — which is most of them: a guest carries no
     * `customerId`, checkout stores `session?.user?.id` and that is `undefined`
     * without an account. The screen rendered "Commande introuvable" to the
     * owner of the restaurant.
     *
     * Scoped to THIS order's store, through the same `requireStorePermission`
     * chain every admin function already uses — so staff of one restaurant
     * still cannot read another's. `orders:read` is the permission `list` above
     * already requires, and `list` already returns these very documents whole,
     * so this branch widens the audience of nothing: it lets the same people
     * open one of the orders they can already enumerate.
     */
    if (identity && (await defs.mayReadStoreOrders(ctx, order.storeId))) {
      return enriched();
    }

    // No access
    return null;
  },
});

// REMOVED: `getByCustomer` took an arbitrary `customerId` and returned that
// customer's entire order history — names, phones, delivery addresses, items —
// behind nothing but an "are you logged in" check. Any account could read any
// other customer's orders by passing their id.
//
// It had no caller. `getMyOrders` below is what the account page uses, and it
// derives the customer from the session instead of taking it as an argument.

// REMOVED: `getByStatus` was `list` with the status filter made mandatory,
// collected whole, and it had no caller. `list` takes an optional `status` and
// pages; a second unbounded doorway onto the same table is not worth keeping.
// @public-by-design: same rule as `getById` — the view token issued at checkout,
// or the customer who placed the order. Returns one opaque token, nothing else.
export const getTrackingToken = query(defs.getTrackingToken);

// @public-by-design: same rule as `getById` (the view token issued at checkout,
// the customer who placed the order, or that restaurant's staff), applied by
// `mayReadOrder`. Returns the live-delivery projection only — no lines, no
// amounts, no diner contact details.
export const getDeliveryTracking = query(defs.getDeliveryTracking);

// @public-by-design: the same access rule as `getDeliveryTracking`, applied by
// `mayReadOrder` (view token, the customer who placed the order, or that
// restaurant's staff). Returns the last rider status, its time and ETA — no
// name, no phone, no position.
export const getDeliverooRider = query(defs.getDeliverooRider);

// @public-by-design: the post-payment page holds an opaque order id and needs
// to know whether the payment actually landed. Returns the status and the order
// number only — no customer, no address, no amount.
export const getPaymentState = query(defs.getPaymentState);

export const MY_ORDERS_LIMIT = 50;

/**
 * The signed-in customer's most recent orders.
 *
 * Bounded rather than collected: this read that customer's entire history with
 * no window and no limit, on a live subscription, and a regular's history has
 * no ceiling of its own. Newest first, because the account page is read from
 * now backwards — an order from two years ago is not what someone opens this
 * screen for.
 */
// @guarded-inline: derives the customer from the session; never takes an id
export const getMyOrders = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    return await ctx.db
      .query("orders")
      .withIndex("by_customerId", (q) => q.eq("customerId", identity.subject))
      .order("desc")
      .take(MY_ORDERS_LIMIT);
  },
});

/**
 * Send the diner their confirmation, once the defs layer has decided to.
 *
 * The same split `advanceOrder` below uses, and for the same reason: the rule
 * about WHO gets an email belongs in the engine, where every payment path goes
 * through it; scheduling needs `internal.*`, which only an app has.
 *
 * `planOrderConfirmation` has already claimed the send inside the mutation's
 * transaction, so a replayed Stripe webhook hands this a null and the diner
 * gets one confirmation rather than one per settlement attempt.
 *
 * Scheduled rather than awaited: an email is not a reason for a payment that
 * has already been taken to fail.
 */
async function scheduleOrderConfirmation(
  ctx: MutationCtx,
  confirmation: { orderId: string } | null
) {
  if (!confirmation) return;
  await ctx.scheduler.runAfter(
    0,
    internal.customerEmail.sendOrderConfirmation,
    { orderId: confirmation.orderId as Id<"orders"> }
  );
}

// === Mutations ===

/**
 * Storefront checkout: the order + kitchen-ticket invariant lives in the
 * defs layer (defs.createWithTicket) — this wrapper is transport only.
 *
 * The one thing it adds is the platform push, because booking one needs
 * `internal.*` and the defs layer cannot reach it. A sale moves
 * `stock.quantity`, and that number is what Uber Eats and Deliveroo read as
 * availability: without this a dish sold out on the restaurant's own site went
 * on being ordered through the platforms until some unrelated catalogue write
 * happened to book a sync — and nothing sweeps for it, so that window has no
 * end. The Inventaire screen has booked the same push on every manual stock
 * edit since the beginning.
 */
// @public-by-design: guest order access is guarded by the view token issued at checkout
export const create = mutation({
  args: defs.createWithTicket.args,
  handler: async (ctx, args) => {
    const orderId = await defs.createWithTicket.handler(ctx, args);

    // A CASH order-ahead is confirmed here, at checkout, and nowhere else.
    //
    // Cash has no provider and no redirect, so `releaseToKitchen` sends it to
    // the pass now rather than waiting for a payment — and its own comment
    // notes that in auto mode "nobody ever" opens the admin to record the
    // money. `markCashPaid` is the only other seam, so a click-and-collect or
    // food-truck diner would otherwise see "Commande confirmée !" on screen and
    // receive nothing, possibly for ever. `planOrderConfirmation` refuses every
    // other kind of order at this point, and it claims the send, so the later
    // `markCashPaid` does not produce a second one.
    await scheduleOrderConfirmation(ctx, await planOrderConfirmation(ctx, orderId));

    // A card session the order no longer needs must not stay payable.
    //
    // #374 lets a diner who abandoned Stripe confirm « Espèces » on the same
    // attempt, and re-methods the reused order to cash. The Stripe session
    // behind the tab they left open stayed live for ~24 h — long enough to
    // collect, a second time, an order the counter had already taken in cash
    // (#378). Stripe has to be told, and only an action can tell it.
    const abandonedSession = await defs.abandonedCheckoutSession(ctx, orderId);
    if (abandonedSession) {
      await ctx.scheduler.runAfter(0, internal.stripe.expireCheckoutSession, {
        checkoutSessionId: abandonedSession,
      });
    }

    // Independent of the above, and both belong here: an order that moved
    // tracked stock has to push the new availability to the platforms.
    if (await defs.orderMovedTrackedStock(ctx, orderId)) {
      await scheduleMenuSync(ctx, [args.storeId]);
    }

    return orderId;
  },
});

import { scheduleMenuSync } from "./lib/menuSync";

const orderStoreId = storeIdFromDocument("Order not found");

/**
 * Cash taken at the counter, recorded as a payment.
 *
 * Under `orders:update_status`, not `payments:write`. The people who take cash
 * are the ones who move the order along — the manager at the till and the rider
 * at the door — and `payments:write` belongs to the owner, who is not there
 * when the notes change hands. Recording that a cash order was paid is a step
 * in its lifecycle; refunding it, which does hold `payments:refund`, is not.
 */
export const markCashPaid = storeMutation({
  permission: "orders:update_status",
  args: defs.markCashPaid.args,
  storeIdFrom: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    return order.storeId;
  },
  handler: async (ctx, args) => {
    const { paymentId, confirmation } = await defs.markCashPaid.handler(ctx, args);
    await scheduleOrderConfirmation(ctx, confirmation);
    // The payment id, as before — the admin ignores it, but changing what a
    // mutation answers is not this fix's to do.
    return paymentId;
  },
});

// Protected: Admin only — verify store access via order's storeId
/**
 * Advance an order, and start the post-order automation if one is waiting.
 *
 * The shared handler decides WHO should be reached — it holds the rule — and
 * returns it; scheduling needs `internal.*`, which only an app has. The same
 * split `emailSubscribers.confirmDoubleOptIn` uses.
 *
 * Scheduled rather than awaited: a thank-you email is not a reason for an order
 * confirmation to fail.
 */
async function advanceOrder(
  ctx: MutationCtx,
  args: Parameters<typeof defs.updateStatus.handler>[1]
) {
  // A cancellation gives the order's tracked stock back, and a dish that is
  // available again has to reach the platforms for the same reason a sold-out
  // one does. Resolved before the handler runs, while the order still says what
  // it took and has not yet been marked cancelled — a replayed cancellation
  // restocks nothing, so it must not book a push either.
  const order =
    args.status === "cancelled"
      ? await ctx.db.get(args.id as Id<"orders">)
      : null;
  const restocks =
    order !== null &&
    order.status !== "cancelled" &&
    (await defs.orderMovedTrackedStock(ctx, args.id));

  const dispatch = await defs.updateStatus.handler(ctx, args);

  if (restocks && order) await scheduleMenuSync(ctx, [order.storeId]);

  if (dispatch) {
    // The post-order automation, when the diner is a subscriber. `ready` is
    // carried on the same object because a status change can owe two different
    // sends; `startPostOrder` would refuse a payload without a subscriber id
    // anyway, so the shape is checked rather than assumed.
    if ("subscriberId" in dispatch) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailAutomationActions.startPostOrder,
        dispatch as never
      );
    }

    // « Votre commande est prête » (#96). Scheduled rather than awaited: a
    // notification is not a reason for a kitchen status change to fail.
    const ready = (dispatch as { ready?: { orderId: string } }).ready;
    if (ready) {
      await ctx.scheduler.runAfter(0, internal.customerEmail.sendOrderReady, {
        orderId: ready.orderId as Id<"orders">,
      });
    }
  }
}

export const updateStatus = storeMutation({
  // The permission exists precisely for this: advancing an order through its
  // lifecycle. Under `orders:write` the two roles whose entire job is to move
  // an order forward — kitchen and delivery — were refused, while the kitchen
  // display screen offered them the button.
  permission: "orders:update_status",
  args: defs.updateStatus.args,
  storeIdFrom: orderStoreId,
  handler: (ctx, args) => advanceOrder(ctx, args),
});

export const remove = storeMutation({
  permission: "orders:delete",
  args: defs.remove.args,
  storeIdFrom: orderStoreId,
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});

// === Internal Queries (for payment actions) ===

/** Get order by ID without auth — used by Stripe/PayPal/SumUp actions */
export const internalGetById = internalQuery({
  args: { id: v.id("orders") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

// === Internal Mutations (for webhooks and schedulers) ===

export const createFromWebhook = internalMutation(defs.createFromWebhook);
export const updateFromWebhook = internalMutation(defs.updateFromWebhook);
export const applyDeliverooRider = internalMutation(defs.applyDeliverooRider);

// Internal version of updateStatus for webhooks/schedulers
export const internalUpdateStatus = internalMutation({
  args: defs.updateStatus.args,
  handler: (ctx, args) => advanceOrder(ctx, args),
});

/**
 * Update only paymentStatus — used by payment actions and webhooks.
 *
 * Transport over `defs.recordPaymentStatus`, which is where "a paid order
 * feeds the kitchen" lives. Patching `paymentStatus` here directly is what
 * left the Stripe, PayPal and SumUp paths each responsible for remembering to
 * tell the kitchen, and none of them did.
 *
 * The union comes from the defs layer too, `refund_pending` included: the four
 * provider paths pass whatever `paymentStatusAfterSettlement` returns, and for
 * money arriving against a cancelled order that is `refund_pending`. Restating
 * the union here is how the two would drift.
 */
export const internalUpdatePaymentStatus = internalMutation({
  args: defs.recordPaymentStatus.args,
  handler: async (ctx, args) => {
    const confirmation = await defs.recordPaymentStatus.handler(ctx, args);
    await scheduleOrderConfirmation(ctx, confirmation);
  },
});

/**
 * Everything the confirmation email needs, read as the order was recorded.
 *
 * Internal because it answers with the diner's email address and the token that
 * opens their order page; the only caller is the scheduled action, which has no
 * identity to scope a public query with.
 */
export const confirmationPayload = internalQuery({
  args: { orderId: v.id("orders") },
  handler: (ctx, args) => buildOrderConfirmationPayload(ctx, args.orderId),
});

/**
 * Give back a confirmation claim the sender could not use, and say why.
 *
 * WHAT THIS COMMENT USED TO SAY, and why it was wrong. It read: "A send that
 * reached SES and failed keeps its claim: retrying a provider that already
 * refused is how a diner ends up with three receipts." #530 changed that, and
 * this docblock did not follow — the catch block now releases, because
 * releasing is not retrying. Nothing reschedules the action; the claim only
 * makes a LATER legitimate settlement able to send. The fear was real and it
 * was about a different act.
 *
 * `failure` is optional and the three callers differ on purpose. An order
 * cancelled or deleted between the claim and the send passes none — nothing
 * failed. No sender address, and a transport failure, each pass their own.
 */
export const releaseConfirmationClaim = internalMutation({
  args: {
    orderId: v.id("orders"),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) =>
    releaseOrderConfirmationClaim(ctx, args.orderId, args.failure),
});

/** What the « votre commande est prête » notice needs (#96). */
export const readyNoticePayload = internalQuery({
  args: { orderId: v.id("orders") },
  handler: (ctx, args) => readyPayload(ctx, args.orderId),
});

/**
 * Give back a ready-notice claim the sender could not use, and say why.
 *
 * Same shape as the confirmation's above, including what `failure` is for:
 * `AWS_SES_FROM_EMAIL` unset is the day-one state of a new backend, and keeping
 * the claim would silence that establishment's notices for ever — but until
 * #530 nobody was told it had happened, so the notice was lost in silence
 * rather than in error.
 */
export const releaseReadyNoticeClaim = internalMutation({
  args: {
    orderId: v.id("orders"),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) => releaseReadyClaim(ctx, args.orderId, args.failure),
});

/**
 * Give a slip to a platform order that reached the kitchen nowhere.
 *
 * Scheduled from `crons.ts`; internal because a sweep runs with no identity.
 * The webhooks repair this on a platform redelivery, which is the fast path;
 * this is the backstop for a retry that never comes. Definition and reasoning
 * live in `@be-yours/convex-functions/orders`.
 *
 * Wrapped rather than passed straight through, for the second half of #632. The
 * definition writes a `ticketless_sweep_failed` audit entry, which is what an
 * operator of THIS establishment can read. Sentry is the other half: with one
 * Convex deployment per client, a failure nobody reports is a failure the
 * maintenance contract cannot answer, because finding it means logging into
 * each client's console one at a time.
 *
 * Reporting from a mutation is safe here and would not be from every mutation:
 * `captureBackendError` schedules the report inside the transaction, so it
 * survives only if the mutation commits. This one never rethrows — that is the
 * whole point of the sweep's `catch` — so it always commits. See the trap
 * documented in `errorReporting.ts`.
 */
export const sweepTicketlessPlatformOrders = internalMutation({
  args: defs.sweepTicketlessPlatformOrders.args,
  handler: async (ctx) => {
    const result = await defs.sweepTicketlessPlatformOrders.handler(ctx);

    if (result.failures.length > 0) {
      console.error(
        "[Ticketless sweep] could not give a slip to",
        result.failures.length,
        "platform order(s):",
        result.failures
      );
      await captureBackendError(ctx, {
        error: new Error(
          `Ticketless sweep failed on ${result.failures.length} platform order(s)`
        ),
        source: "orders.sweepTicketlessPlatformOrders",
        tags: { step: "give-slip" },
        extra: {
          examined: result.examined,
          repaired: result.repaired,
          failed: result.failures.length,
          /*
           * The orders themselves, so the Sentry issue names them rather than
           * carrying a count nobody can act on. `extra` takes scalars only, so
           * they travel as one JSON string.
           */
          failures: JSON.stringify(result.failures),
        },
      });
    }

    return result;
  },
});
