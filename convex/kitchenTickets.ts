import { query, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import * as defs from "@be-yours/convex-functions/kitchenTickets";
import { orderStatusPath } from "@be-yours/convex-schema";
import type { OrderStatus } from "@be-yours/convex-schema";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";
import { captureBackendError } from "./errorReporting";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const kitchenTicketsStoreId = storeIdFromDocument("Ticket not found");

// === INTERNAL QUERIES (no auth, called from actions) ===

export const internalGetById = internalQuery({
  args: { id: v.id("kitchenTickets") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const internalGetOrder = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.orderId);
  },
});

/**
 * Does this order already have a slip on the pass?
 *
 * Read from the platform webhooks before they create one. A Deliveroo or Uber
 * retry re-delivers an order we already hold, and that redelivery is the only
 * chance to repair a ticket whose first creation failed — so the duplicate path
 * has to be able to ask.
 */
export const internalHasTicketForOrder = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const tickets = await defs.getByOrder.handler(ctx, args);
    return tickets.length > 0;
  },
});

// === INTERNAL MUTATIONS (no auth, called from webhooks/internal actions) ===

export const internalCreate = internalMutation(defs.create);

export const internalMarkPickedUp = internalMutation({
  args: { id: v.id("kitchenTickets") },
  handler: async (ctx, args) => {
    return defs.markPickedUp.handler(ctx, args);
  },
});

export const internalUpdateStatus = internalMutation({
  args: {
    id: v.id("kitchenTickets"),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("ready"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
  },
  handler: async (ctx, args) => {
    return defs.updateStatus.handler(ctx, args);
  },
});

// === QUERIES ===

export const getByStore = storeQuery({
  permission: "kitchen:read",
  args: defs.getByStore.args,
  handler: (ctx, args) => defs.getByStore.handler(ctx, args),
});
export const getByStatus = storeQuery({
  permission: "kitchen:read",
  args: defs.getByStatus.args,
  handler: (ctx, args) => defs.getByStatus.handler(ctx, args),
});

export const getPrintQueue = storeQuery({
  permission: "kitchen:read",
  args: defs.getPrintQueue.args,
  handler: (ctx, args) => defs.getPrintQueue.handler(ctx, args),
});

export const getOverdueCount = storeQuery({
  permission: "kitchen:read",
  args: defs.getOverdueCount.args,
  handler: (ctx, args) => defs.getOverdueCount.handler(ctx, args),
});

export const getPrintStuckCount = storeQuery({
  permission: "kitchen:read",
  args: defs.getPrintStuckCount.args,
  handler: (ctx, args) => defs.getPrintStuckCount.handler(ctx, args),
});

export const getForDisplay = storeQuery({
  permission: "kitchen:read",
  args: defs.getForDisplay.args,
  handler: (ctx, args) => defs.getForDisplay.handler(ctx, args),
});

/**
 * The dining-room screen, read with the establishment's display token (#96).
 *
 * @public-by-design: `/display/[storeId]` is a tablet bolted to a wall in a
 * public room, and the guarded twin above needs a staff session — so the screen
 * a customer is meant to read could not be opened by the screen itself.
 *
 * The token IS the authorisation, and it is checked in the handler: a store with
 * none refuses, a wrong one refuses, and the refusal is the same `null` in every
 * case. What it protects is narrow by construction — order numbers, statuses and
 * the establishment's own name, already legible to anybody in the room — so this
 * is a rate-limiting credential, not a wall around personal data.
 */
export const getForDisplayByToken = query({
  args: defs.getForDisplayByToken.args,
  handler: (ctx, args) => defs.getForDisplayByToken.handler(ctx, args),
});

/** Whether the establishment has a display credential. Never its value. */
export const displayTokenState = storeQuery({
  permission: "kitchen:read",
  args: defs.displayTokenState.args,
  handler: (ctx, args) => defs.displayTokenState.handler(ctx, args),
});

/**
 * Issue or rotate it.
 *
 * `stores:write`, not `kitchen:write`: the token is a credential for the
 * establishment, and rotating it takes a screen off the air until somebody walks
 * over to the tablet. That is an owner's decision, not a shift decision.
 */
export const rotateDisplayToken = storeMutation({
  permission: "stores:write",
  args: defs.rotateDisplayToken.args,
  handler: (ctx, args) => defs.rotateDisplayToken.handler(ctx, args),
});

// Public: token-based access for customer order tracking
// @public-by-design: order tracking by opaque token. The payload carries
// preparation state only — no customer details.
export const getByTrackingToken = query(defs.getByTrackingToken);

// === MUTATIONS (authenticated) ===

export const updateStatus = storeMutation({
  permission: "kitchen:write",
  storeIdFrom: kitchenTicketsStoreId,
  args: defs.updateStatus.args,
  handler: (ctx, args) => defs.updateStatus.handler(ctx, args),
});

// Taking a ticket is a kitchen write, and it must be reachable by whichever
// tablet is watching the queue — the claim is the thing that stops two of them
// printing the same slip.
export const claimForPrint = storeMutation({
  permission: "kitchen:write",
  storeIdFrom: kitchenTicketsStoreId,
  args: defs.claimForPrint.args,
  handler: (ctx, args) => defs.claimForPrint.handler(ctx, args),
});

export const markPrintSent = storeMutation({
  permission: "kitchen:write",
  storeIdFrom: kitchenTicketsStoreId,
  args: defs.markPrintSent.args,
  handler: (ctx, args) => defs.markPrintSent.handler(ctx, args),
});

export const markPrintFailed = storeMutation({
  permission: "kitchen:write",
  storeIdFrom: kitchenTicketsStoreId,
  args: defs.markPrintFailed.args,
  handler: (ctx, args) => defs.markPrintFailed.handler(ctx, args),
});

export const requestReprint = storeMutation({
  permission: "kitchen:write",
  storeIdFrom: kitchenTicketsStoreId,
  args: defs.requestReprint.args,
  handler: (ctx, args) => defs.requestReprint.handler(ctx, args),
});

// === ACTIONS (authenticated, can call external APIs) ===

/**
 * Helper: get Uber Eats credentials from env vars.
 */
async function getUberEatsCredentials() {
  const { getPackageEnv, isSandbox } = await import("@be-yours/core/env");
  const pkg = getPackageEnv();
  const clientId = pkg.UBER_EATS_CLIENT_ID;
  const clientSecret = pkg.UBER_EATS_CLIENT_SECRET;
  const sandboxMode = isSandbox("uberEats");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, sandboxMode };
}

/**
 * Helper: get Deliveroo credentials from env vars.
 */
async function getDeliverooCredentials() {
  const { getPackageEnv, isSandbox } = await import("@be-yours/core/env");
  const pkg = getPackageEnv();
  const clientId = pkg.DELIVEROO_CLIENT_ID;
  const clientSecret = pkg.DELIVEROO_CLIENT_SECRET;
  const sandboxMode = isSandbox("deliveroo");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, sandboxMode };
}

/**
 * Bring the ticket's order up to `target`, one legal move at a time, and say so
 * when it cannot.
 *
 * THE KITCHEN SCREEN DID NOT MOVE THE ORDER. « Prêt » asked for `ready` and
 * « Récupéré » for `completed`, each in one write, from an order that was still
 * `confirmed` — and the status machine only lets `confirmed` go to `preparing`.
 * Both writes were refused, the refusal was caught, logged and reported to
 * Sentry, and the action returned as if nothing had gone wrong: the toast said
 * « Commande prête », the owner and the diner kept reading « Confirmée », and the
 * « votre commande est prête » e-mail, which hangs off the `ready` transition,
 * was never sent. Found by running a restaurant from scratch, not by a test.
 *
 * So the moves are taken in turn, from wherever the order is: `confirmed` goes
 * through `preparing`, an order the owner already marked ready from the order
 * page is left alone (`[]`, or `null` for « already past it »), and each move
 * goes through `internalUpdateStatus` so the e-mails and the audit line keep
 * hanging off it.
 *
 * A refusal is REPORTED AND THROWN. The caller runs this BEFORE it moves the
 * ticket, so a refused order leaves the ticket where it was, the screen says so,
 * and pressing the button again is a retry rather than a second, contradictory
 * state. It used to be the other way round — ticket first, order after, errors
 * swallowed — which is how the two ended up disagreeing with no way back.
 */
async function advanceOrderTo(
  ctx: ActionCtx,
  args: {
    orderId: Id<"orders">;
    ticketId: Id<"kitchenTickets">;
    target: OrderStatus;
    source: string;
  }
): Promise<void> {
  const order = await ctx.runQuery(internal.kitchenTickets.internalGetOrder, {
    orderId: args.orderId,
  });
  if (!order) throw new Error("Order not found");

  const path = orderStatusPath(order.status, args.target);
  if (path === null) {
    // Past the target is fine — the owner got there from the order page first.
    // Cancelled is not: the kitchen is being told a dinner is going ahead that
    // the diner has called off.
    if (order.status === "cancelled") {
      throw new Error("Cette commande a été annulée : le ticket ne peut plus avancer.");
    }
    return;
  }

  for (const status of path) {
    try {
      await ctx.runMutation(internal.orders.internalUpdateStatus, {
        id: args.orderId,
        status,
      });
    } catch (error) {
      console.error(`Failed to move order to ${status}:`, error);
      await captureBackendError(ctx, {
        error,
        source: args.source,
        tags: { step: `order-${status}` },
        extra: { ticketId: args.ticketId },
      });
      throw error;
    }
  }
}

/**
 * Accept a kitchen ticket: start the order, update status, notify the platform
 * (Uber Eats / Deliveroo).
 *
 * Every source, not only the two platforms: it is also what « Démarrer » does on
 * a ticket from the website or the till, where there is nobody to notify and the
 * only job is to put the order in `preparing` alongside the ticket.
 */
// @guarded-inline: checks kitchen:write on the ticket's own store
export const acceptTicket = action({
  args: { id: v.id("kitchenTickets") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ticket = await ctx.runQuery(internal.kitchenTickets.internalGetById, { id: args.id });
    if (!ticket) throw new Error("Kitchen ticket not found");

    // The ticket carries the restaurant; check the caller may work its kitchen.
    // Being logged in was the only requirement before, so any customer account
    // could accept, ready, complete or cancel tickets in any restaurant.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: ticket.storeId,
      permission: "kitchen:write",
    });

    // 1. The order first: confirmed if it is not yet, then preparing. A marketplace
    //    order arrives `pending`; a website one is already `confirmed`.
    await advanceOrderTo(ctx, {
      orderId: ticket.orderId,
      ticketId: args.id,
      target: "preparing",
      source: "kitchenTickets.acceptTicket",
    });

    // 2. Update ticket status to in_progress
    await ctx.runMutation(internal.kitchenTickets.internalUpdateStatus, {
      id: args.id,
      status: "in_progress",
    });

    // 3. Notify platform
    const order = await ctx.runQuery(internal.kitchenTickets.internalGetOrder, { orderId: ticket.orderId });
    const externalId = order?.externalOrderId;
    if (!externalId) return;

    if (ticket.source === "uber_eats") {
      try {
        const creds = await getUberEatsCredentials();
        if (creds) {
          const { uberEats } = await import("@be-yours/integrations");
          await uberEats.acceptOrder(creds, externalId);
          console.log(`Accepted Uber Eats order ${externalId}`);
        }
      } catch (error) {
        console.error("Failed to accept order on Uber Eats:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.acceptTicket",
          tags: { step: "accept-uber-eats" },
          extra: { ticketId: args.id },
        });
      }
    }

    if (ticket.source === "deliveroo") {
      try {
        const creds = await getDeliverooCredentials();
        if (creds) {
          const { deliveroo } = await import("@be-yours/integrations");
          try {
            await deliveroo.acceptOrder(creds, externalId);
            console.log(`Accepted Deliveroo order ${externalId}`);
          } catch (acceptError) {
            // `409 invalid_status_transition — already in status accepted`.
            // Deliveroo accepts a tabletless order itself in its sandbox, and a
            // restaurant may have accepted it elsewhere: the order is accepted,
            // which is what this call was for. Treating it as a failure skipped
            // the `in_kitchen` stage below, and Deliveroo's scenario 13 waits
            // for all four stages.
            const status = (acceptError as { statusCode?: number } | null)?.statusCode;
            if (status !== 409) throw acceptError;
            console.log(`Deliveroo order ${externalId} was already accepted`);
          }
          // Cooking starts when the kitchen takes the ticket. Deliveroo uses
          // the stage to time the rider's arrival, so it is worth sending, but
          // never worth failing the accept for.
          try {
            await deliveroo.updatePrepStage(creds, externalId, "in_kitchen");
          } catch (stageError) {
            console.warn("Failed to send Deliveroo in_kitchen stage:", stageError);
          }
        }
      } catch (error) {
        console.error("Failed to accept order on Deliveroo:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.acceptTicket",
          tags: { step: "accept-deliveroo" },
          extra: { ticketId: args.id },
        });
      }
    }
  },
});

/**
 * Mark a kitchen ticket as ready: update ticket + order status + notify platform.
 * - Deliveroo: POST /order/v1/orders/{id}/prep_stage { stage: "ready_for_collection" }
 * - Uber Eats: POST /v1/eats/orders/{id}/mark_order_as_ready_for_pickup
 */
// @guarded-inline: checks kitchen:write on the ticket's own store
export const readyTicket = action({
  args: { id: v.id("kitchenTickets") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ticket = await ctx.runQuery(internal.kitchenTickets.internalGetById, { id: args.id });
    if (!ticket) throw new Error("Kitchen ticket not found");

    // The ticket carries the restaurant; check the caller may work its kitchen.
    // Being logged in was the only requirement before, so any customer account
    // could accept, ready, complete or cancel tickets in any restaurant.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: ticket.storeId,
      permission: "kitchen:write",
    });

    // 1. Update order status to ready, through `preparing` when it is still
    //    `confirmed`. First, and loudly: see `advanceOrderTo`.
    await advanceOrderTo(ctx, {
      orderId: ticket.orderId,
      ticketId: args.id,
      target: "ready",
      source: "kitchenTickets.readyTicket",
    });

    // 2. Update ticket status to ready
    await ctx.runMutation(internal.kitchenTickets.internalUpdateStatus, {
      id: args.id,
      status: "ready",
    });

    // 3. Notify platform
    const order = await ctx.runQuery(internal.kitchenTickets.internalGetOrder, { orderId: ticket.orderId });
    const externalId = order?.externalOrderId;

    if (ticket.source === "deliveroo" && externalId) {
      try {
        const creds = await getDeliverooCredentials();
        if (creds) {
          const { deliveroo } = await import("@be-yours/integrations");
          // Deliveroo's scenario 13 wants every stage, in order. Pressing
          // « Prêt » is the one moment the product knows, so the food is by
          // definition within 60 seconds of ready when « soon » goes out.
          await deliveroo.updatePrepStage(creds, externalId, "ready_for_collection_soon");
          await deliveroo.updatePrepStage(creds, externalId, "ready_for_collection");
          console.log(`Deliveroo order ${externalId} marked as ready`);
        }
      } catch (error) {
        console.error("Failed to update Deliveroo prep stage:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.readyTicket",
          tags: { step: "deliveroo-prep-stage" },
          extra: { ticketId: args.id },
        });
      }
    } else if (ticket.source === "uber_eats" && externalId) {
      try {
        const { getPackageEnv, isSandbox } = await import("@be-yours/core/env");
        const pkg = getPackageEnv();
        if (pkg.UBER_EATS_CLIENT_ID && pkg.UBER_EATS_CLIENT_SECRET) {
          const { uberEats } = await import("@be-yours/integrations");
          await uberEats.markOrderAsReady(
            {
              clientId: pkg.UBER_EATS_CLIENT_ID,
              clientSecret: pkg.UBER_EATS_CLIENT_SECRET,
              sandboxMode: isSandbox("uberEats"),
            },
            externalId
          );
          console.log(`Uber Eats order ${externalId} marked as ready`);
        }
      } catch (error) {
        console.error("Failed to mark Uber Eats order as ready:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.readyTicket",
          tags: { step: "uber-eats-ready" },
          extra: { ticketId: args.id },
        });
      }
    }

    console.log(`Ticket ${ticket.orderNumber} marked as ready (source: ${ticket.source})`);
  },
});

/**
 * Mark a kitchen ticket as completed (picked up by driver/customer).
 * Updates ticket + order status. Pickup is tracked by the driver's app on platforms.
 */
// @guarded-inline: checks kitchen:write on the ticket's own store
export const completeTicket = action({
  args: { id: v.id("kitchenTickets") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ticket = await ctx.runQuery(internal.kitchenTickets.internalGetById, { id: args.id });
    if (!ticket) throw new Error("Kitchen ticket not found");

    // The ticket carries the restaurant; check the caller may work its kitchen.
    // Being logged in was the only requirement before, so any customer account
    // could accept, ready, complete or cancel tickets in any restaurant.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: ticket.storeId,
      permission: "kitchen:write",
    });

    // 1. Update order status: handed over to the courier, or collected. First,
    //    through whatever it still has to pass: see `advanceOrderTo`.
    await advanceOrderTo(ctx, {
      orderId: ticket.orderId,
      ticketId: args.id,
      target: ticket.orderType === "delivery" ? "out_for_delivery" : "completed",
      source: "kitchenTickets.completeTicket",
    });

    // 2. Mark picked up
    try {
      await ctx.runMutation(internal.kitchenTickets.internalMarkPickedUp, { id: args.id });
    } catch (error) {
      console.error("Failed to mark picked up:", error);
      await captureBackendError(ctx, {
        error,
        source: "kitchenTickets.completeTicket",
        tags: { step: "mark-picked-up" },
        extra: { ticketId: args.id },
      });
    }

    // 3. Update ticket status to completed
    await ctx.runMutation(internal.kitchenTickets.internalUpdateStatus, {
      id: args.id,
      status: "completed",
    });

    // 4. Tell Deliveroo the order left the kitchen with its rider or customer.
    //    Best effort: the order is already handed over, and a failed stage must
    //    not turn a finished service into an error on the pass.
    if (ticket.source === "deliveroo") {
      try {
        const handedOver = await ctx.runQuery(internal.kitchenTickets.internalGetOrder, {
          orderId: ticket.orderId,
        });
        const creds = await getDeliverooCredentials();
        if (creds && handedOver?.externalOrderId) {
          const { deliveroo } = await import("@be-yours/integrations");
          await deliveroo.updatePrepStage(creds, handedOver.externalOrderId, "collected");
        }
      } catch (error) {
        console.error("Failed to send Deliveroo collected stage:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.completeTicket",
          tags: { step: "deliveroo-collected-stage" },
          extra: { ticketId: args.id },
        });
      }
    }

    console.log(`Ticket ${ticket.orderNumber} completed (source: ${ticket.source})`);
  },
});

/**
 * Cancel a kitchen ticket + its order, and notify the platform.
 *
 * Platform behavior:
 * - Uber Eats: deny (pre-accept) or cancel (post-accept). Refund is automatic.
 * - Deliveroo: reject (pre-accept only). Post-accept cancel not available via API.
 * - Website: NOTHING is refunded here. `orders.internalUpdateStatus` flags the
 *   order `paymentStatus: "refund_pending"` and leaves the `payments` rows
 *   alone. It used to patch them to "refunded" without calling any provider, so
 *   the books claimed a refund the customer never received — and since
 *   `planRefund` accepts only "succeeded"/"partially_refunded", that fake
 *   refund then made the real one impossible. An operator sends the money back
 *   through `payments.refundPayment`, which calls the provider first.
 */
// @guarded-inline: checks kitchen:write on the ticket's own store
export const cancelTicket = action({
  args: {
    id: v.id("kitchenTickets"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ticket = await ctx.runQuery(internal.kitchenTickets.internalGetById, { id: args.id });
    if (!ticket) throw new Error("Kitchen ticket not found");

    // The ticket carries the restaurant; check the caller may work its kitchen.
    // Being logged in was the only requirement before, so any customer account
    // could accept, ready, complete or cancel tickets in any restaurant.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: ticket.storeId,
      permission: "kitchen:write",
    });

    const wasAccepted = ticket.status !== "pending";
    const cancelReason = args.reason ?? "Commande annulée par le restaurant";

    /* DELIVEROO CANNOT BE CANCELLED FROM HERE ONCE ACCEPTED (#627).
     *
     * Deliveroo's Order API offers `PATCH /v1/orders/{id}` with
     * `status: "rejected"`, and that is a PRE-ACCEPT rejection — there is no
     * endpoint this integration can call to withdraw an order the restaurant
     * has already accepted. What used to happen is the whole defect: the
     * transmission was gated on `!wasAccepted`, the `else` wrote a
     * `console.log`, and everything above this line ran anyway. So the ticket
     * was cancelled, the order was cancelled, the refusal reason was dropped,
     * Deliveroo was never told, **the diner's app still showed the order
     * coming**, and the toast read « Commande annulée ».
     *
     * Refusing here, BEFORE anything local changes, is the honest answer: our
     * state and Deliveroo's stay in agreement, and the operator is told what
     * they actually have to do. The KDS hides the control for this case with
     * the same reason, so this is a backstop rather than the first thing an
     * operator meets.
     *
     * If Deliveroo ever exposes a post-accept cancellation, this is where it
     * goes, and the block at the bottom of this handler is where the call
     * belongs. */
    if (ticket.source === "deliveroo" && wasAccepted) {
      throw new Error(
        "Cette commande Deliveroo a déjà été acceptée : elle ne peut pas être annulée depuis la cuisine. " +
          "Deliveroo n'accepte l'annulation d'une commande acceptée que depuis son propre support. " +
          "Appelez Deliveroo, puis annulez la commande ici une fois qu'ils l'ont fait de leur côté.",
      );
    }

    // 1. Cancel the kitchen ticket
    await ctx.runMutation(internal.kitchenTickets.internalUpdateStatus, {
      id: args.id,
      status: "cancelled",
    });

    // 2. Cancel the order. This flags it `refund_pending` when it was paid; it
    //    does NOT move money and does not touch the payments rows.
    try {
      await ctx.runMutation(internal.orders.internalUpdateStatus, {
        id: ticket.orderId,
        status: "cancelled",
      });
    } catch (error) {
      console.error("Failed to cancel order:", error);
      await captureBackendError(ctx, {
        error,
        source: "kitchenTickets.cancelTicket",
        tags: { step: "cancel-order" },
        extra: { ticketId: args.id },
      });
    }

    // 3. Notify platform
    const order = await ctx.runQuery(internal.kitchenTickets.internalGetOrder, { orderId: ticket.orderId });
    const externalId = order?.externalOrderId;
    if (!externalId) return;

    if (ticket.source === "uber_eats") {
      try {
        const creds = await getUberEatsCredentials();
        if (creds) {
          const { uberEats } = await import("@be-yours/integrations");
          if (wasAccepted) {
            // Post-accept: use cancelOrder (refund handled by Uber)
            await uberEats.cancelOrder(creds, externalId, {
              explanation: cancelReason,
              code: "OTHER",
            });
            console.log(`Cancelled Uber Eats order ${externalId} (post-accept)`);
          } else {
            // Pre-accept: use denyOrder
            await uberEats.denyOrder(creds, externalId, {
              explanation: cancelReason,
              code: "OTHER",
            });
            console.log(`Denied Uber Eats order ${externalId} (pre-accept)`);
          }
        }
      } catch (error) {
        console.error("Failed to cancel/deny order on Uber Eats:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.cancelTicket",
          tags: { step: "cancel-uber-eats" },
          extra: { ticketId: args.id },
        });
      }
    }

    if (ticket.source === "deliveroo") {
      try {
        const creds = await getDeliverooCredentials();
        if (creds) {
          const { deliveroo } = await import("@be-yours/integrations");
          if (!wasAccepted) {
            // Pre-accept: reject via API with reason from KDS
            const rejectReason = args.reason ?? "busy";
            await deliveroo.rejectOrder(creds, externalId, rejectReason);
            console.log(`Rejected Deliveroo order ${externalId} (pre-accept, reason: ${rejectReason})`);
          }
          /* No `else`. A post-accept Deliveroo cancellation is refused at the
             top of this handler (#627) and never reaches here, so a branch
             logging "cancelled internally" would describe a state that can no
             longer exist. */
        }
      } catch (error) {
        console.error("Failed to reject order on Deliveroo:", error);
        await captureBackendError(ctx, {
          error,
          source: "kitchenTickets.cancelTicket",
          tags: { step: "reject-deliveroo" },
          extra: { ticketId: args.id },
        });
      }
    }
  },
});

// === RETENTION (cron) ===

/**
 * Delete finished tickets past the retention window.
 *
 * Scheduled nightly from `crons.ts`; internal because a sweep runs with no user
 * identity. One batch per call, and it queues the next one itself while there
 * is more to delete — a single nightly batch would take months to drain a
 * deployment that turns retention on with a year of history behind it, and
 * would never catch up with the day's own orders.
 *
 * A minute apart, so a large backlog drains without monopolising the backend
 * during service.
 */
export const purgeExpiredTickets = internalMutation({
  args: defs.purgeExpiredTickets.args,
  handler: async (ctx, args) => {
    const result = await defs.purgeExpiredTickets.handler(ctx, args);

    if (result.hasMore) {
      await ctx.scheduler.runAfter(
        60_000,
        internal.kitchenTickets.purgeExpiredTickets,
        args,
      );
    }

    return result;
  },
});
