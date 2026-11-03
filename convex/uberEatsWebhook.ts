import { httpAction, internalAction } from "./_generated/server"
import { captureBackendError } from "./errorReporting";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { toKitchenTicketItemsFromPlatform } from "@be-yours/convex-functions/orders";
import {
  classifyUberEvent,
  resolveStoreIntegration,
  toWebhookOrderItems,
} from "@be-yours/convex-functions/platformWebhook";

type StoreIntegrationRecord = {
  _id: Id<"storeIntegrations">
  storeId: Id<"stores">
  platform: "uberEats" | "deliveroo"
  platformStoreId: string
  enabled: boolean
  autoAccept: boolean
  orderMode?: "auto_accept" | "auto_reject" | "manual"
}

/**
 * Uber Eats webhook handler.
 *
 * Uber sends a thin event; the order itself is fetched over the API, mapped,
 * and saved. Credentials are platform-level, from the environment.
 *
 * Three rules govern everything below, and each of them replaced a defect:
 *
 * 1. **Never guess which establishment an order belongs to.** An order we
 *    cannot place is kept in `platformWebhookFailures` for a human. The
 *    previous fallback — the first enabled integration — put one owner's
 *    orders in another owner's kitchen.
 * 2. **The local status follows the platform, never leads it.** `confirmed`
 *    is written only after Uber has returned 2xx to `acceptOrder`.
 * 3. **Acknowledge with 200 unless a retry would genuinely help.** Uber retries
 *    seven times and gives up; a 500 for an event we will never process is a
 *    wasted retry, and a 200 for an order we dropped is a lost order.
 */

/**
 * Render a value from a platform payload as a storable string.
 *
 * The webhook validators require strings, and a payload is not a contract:
 * `store: { id: 12345 }` is well-formed JSON that Uber could send tomorrow.
 * Passing it straight into a validator threw inside the dead-letter write —
 * so the one code path whose whole job is "record what we could not handle"
 * was itself unable to handle it, and answered 500 instead.
 */
function asPayloadString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  return undefined
}

/** How many times we re-attempt an accept Uber refused before giving up. */
const MAX_ACCEPT_ATTEMPTS = 4

/** Backoff between accept attempts, in ms. Bounded by Uber's 11.5-minute
 *  auto-cancel: the whole ladder has to finish inside it. */
const ACCEPT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000]

// @guarded-inline: verifies the Uber signature over the raw body before
// the payload is read or trusted
export const handleWebhook = httpAction(async (ctx, request) => {
  let rawBody = ""
  try {
    rawBody = await request.text()
    const signature = request.headers.get("x-uber-signature") ?? ""

    // Read credentials from environment variables (BeYours platform credentials)
    const { getPackageEnv, isSandbox } = await import("@be-yours/core/env")
    const pkg = getPackageEnv()
    const clientId = pkg.UBER_EATS_CLIENT_ID
    const clientSecret = pkg.UBER_EATS_CLIENT_SECRET
    const webhookSecret = pkg.UBER_EATS_WEBHOOK_SECRET
    const sandboxMode = isSandbox("uberEats")

    if (!clientId || !clientSecret) {
      return new Response("Uber Eats credentials not configured in environment", { status: 503 })
    }

    // Verify webhook signature using dedicated webhook secret (falls back to client secret)
    const { uberEats } = await import("@be-yours/integrations")
    const signingSecret = webhookSecret || clientSecret
    const isValid = await uberEats.verifyUberEatsSignature(rawBody, signature, signingSecret)

    if (!isValid) {
      console.error("Invalid Uber Eats webhook signature")
      return new Response("Invalid signature", { status: 401 })
    }

    // Parse webhook event. Payload shape varies by API version (v0.1 vs v1) and
    // event type — `meta` is not always present. Derive ids defensively and
    // never throw on shape: a webhook must be acknowledged with 200.
    let event: {
      event_type?: string
      event_id?: string
      meta?: { resource_id?: string; resource_href?: string; status?: string; user_id?: string }
      resource_href?: string
      resource_id?: string
      order_id?: string
      id?: string
      [key: string]: unknown
    }
    try {
      event = JSON.parse(rawBody)
    } catch {
      console.error("Uber Eats webhook: unparseable body, acking 200:", rawBody.slice(0, 300))
      return new Response("OK", { status: 200 })
    }

    // Normalized accessors (meta may be absent in some payload shapes).
    const resourceId =
      event.meta?.resource_id ?? event.resource_id ?? event.order_id ?? event.id ?? ""

    // Log the raw body when we cannot find an id, to capture the real shape.
    if (!resourceId) {
      console.warn(`Uber Eats webhook: no resource id in ${event.event_type ?? "?"}; body=${rawBody.slice(0, 500)}`)
    }

    // What Uber actually sent. The old handler matched `orders.cancel`,
    // `orders.scheduled` and `eats.order.status_update` — Uber sends none of
    // those, so cancellations fell through to "unknown event, ack 200" while
    // the kitchen kept cooking. The real names carry a `.notification` suffix.
    const kind = classifyUberEvent(event.event_type)
    console.log(`Uber Eats webhook: ${event.event_type} (${kind}) - ${resourceId}`)

    const uberCredentials = { clientId, clientSecret, sandboxMode }

    // ---------------------------------------------------------------------
    // New and scheduled orders
    // ---------------------------------------------------------------------
    if (kind === "new_order" || kind === "scheduled_order") {
      const scheduled = kind === "scheduled_order"

      let fullOrder: Awaited<ReturnType<typeof uberEats.fetchOrder>> | null = null
      let unifiedOrder: ReturnType<typeof uberEats.mapUberEatsOrderToUnified> | null = null
      let fetchError: string | undefined
      try {
        fullOrder = await uberEats.fetchOrder(uberCredentials, resourceId)
        unifiedOrder = uberEats.mapUberEatsOrderToUnified(fullOrder)
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error)
        console.warn(`Could not fetch Uber order ${resourceId}: ${fetchError}`)
      }

      // Without the order we know neither what it contains nor where it goes.
      // It is kept, not guessed at, and retried — a 429 or a timeout recovers
      // on its own, and anything else stays visible in the dead-letter queue.
      if (!unifiedOrder) {
        await ctx.runMutation(internal.platformWebhookFailures.record, {
          platform: "uberEats" as const,
          eventType: event.event_type,
          externalOrderId: resourceId || undefined,
          platformStoreId: asPayloadString(event.meta?.user_id),
          reason: "fetch_failed" as const,
          detail: fetchError ?? "fetchOrder returned no order",
          rawBody,
        })
        console.error(`Uber order ${resourceId} could not be read — recorded for review, not routed`)
        // 500 so Uber retries: the usual cause is a 429 or a 5xx on our
        // follow-up fetch, and those recover.
        return new Response("Could not fetch order", { status: 500 })
      }

      const allIntegrations = await ctx.runQuery(
        internal.storeIntegrations.internalListByPlatformEnabled,
        { platform: "uberEats" }
      ) as StoreIntegrationRecord[]

      const resolution = resolveStoreIntegration(allIntegrations, unifiedOrder.storeExternalId)
      if (!resolution.ok) {
        await ctx.runMutation(internal.platformWebhookFailures.record, {
          platform: "uberEats" as const,
          eventType: event.event_type,
          externalOrderId: asPayloadString(unifiedOrder.externalOrderId) ?? resourceId,
          platformStoreId: asPayloadString(unifiedOrder.storeExternalId),
          reason: resolution.reason,
          detail: `No enabled Uber Eats integration matches store ${unifiedOrder.storeExternalId}`,
          rawBody,
        })
        console.error(
          `Uber order ${resourceId} names store ${unifiedOrder.storeExternalId}, which has no enabled integration (${resolution.reason}) — recorded, not routed`
        )
        // Nothing to retry: the integration is missing, not flaky.
        return new Response("OK", { status: 200 })
      }

      const integration = resolution.integration
      const externalOrderId = unifiedOrder.externalOrderId ?? resourceId
      const orderNumber = unifiedOrder.displayId ?? `UE-${resourceId.slice(-6).toUpperCase()}`
      const scheduledTime = fullOrder?.scheduled_time ?? undefined
      const notes = scheduled
        ? `[SCHEDULED for ${scheduledTime ?? "unknown"}]${unifiedOrder.notes ? " " + unifiedOrder.notes : ""}`
        : unifiedOrder.notes

      const { orderId: internalOrderId, created }: { orderId: Id<"orders">; created: boolean } =
        await ctx.runMutation(internal.orders.createFromWebhook, {
          storeId: integration.storeId,
          externalOrderId,
          platform: "uberEats",
          status: "pending",
          type: unifiedOrder.type ?? "delivery",
          customerName: unifiedOrder.customer.name ?? "Client Uber Eats",
          customerPhone: unifiedOrder.customer.phone,
          customerEmail: unifiedOrder.customer.email,
          deliveryAddress: unifiedOrder.delivery?.address ? {
            street: unifiedOrder.delivery.address.street,
            city: unifiedOrder.delivery.address.city ?? "",
            postalCode: unifiedOrder.delivery.address.postalCode ?? "",
            country: unifiedOrder.delivery.address.country ?? "",
          } : undefined,
          // `unitPrice`, not `totalPrice`. `createFromWebhook` multiplies by
          // quantity itself, so passing the line total charged twice — every
          // Uber Eats line was stored at roughly double its real price.
          items: toWebhookOrderItems(unifiedOrder.items),
          subtotal: unifiedOrder.subtotal ?? 0,
          total: unifiedOrder.total ?? 0,
          notes,
          createdAt: new Date(unifiedOrder.placedAt).getTime(),
        })

      // On a duplicate webhook (Uber retries), the order already exists — do
      // NOT create a second kitchen ticket or re-run auto-accept/reject.
      if (!created) {
        console.log(`Duplicate Uber Eats webhook for ${externalOrderId} — already processed`)
        return new Response("OK", { status: 200 })
      }

      console.log(`Created internal order ${internalOrderId} from Uber Eats order ${externalOrderId}`)

      // Create kitchen ticket for KDS
      try {
        const trackingToken = `ue-${externalOrderId.slice(-8)}-${Date.now().toString(36)}`
        await ctx.runMutation(internal.kitchenTickets.internalCreate, {
          storeId: integration.storeId,
          orderId: internalOrderId as Id<"orders">,
          orderNumber,
          orderType: unifiedOrder.type ?? "delivery",
          // One mapping, in the package, tested across the seam: this is
          // where `notes: undefined` was hard-coded, one call after the
          // mapper had extracted the customer's instruction and allergy.
          items: toKitchenTicketItemsFromPlatform(unifiedOrder.items),
          priority: "normal" as const,
          source: "uber_eats" as const,
          trackingToken,
          customerName: unifiedOrder.customer.name ?? "Client Uber Eats",
          customerPhone: unifiedOrder.customer.phone,
          deliveryNotes: unifiedOrder.notes,
        })
        console.log(`Created kitchen ticket for Uber Eats order ${orderNumber}`)
      } catch (error) {
        console.error(`Failed to create kitchen ticket:`, error)
        await captureBackendError(ctx, {
          error,
          source: "uberEatsWebhook",
          tags: { step: "kitchen-ticket" },
          extra: { externalOrderId },
        })
      }

      // A scheduled order is persisted so staff can see it, but deliberately
      // not accepted here: Uber sends `orders.notification` again about an hour
      // before fulfilment, and that is when accepting is meaningful.
      if (scheduled) {
        console.log(`Persisted scheduled Uber Eats order ${externalOrderId} for ${scheduledTime ?? "unknown"}`)
        return new Response("OK", { status: 200 })
      }

      // Resolve order mode: platform override > store global > legacy autoAccept > manual
      const store = await ctx.runQuery(internal.stores.internalGetById, { id: integration.storeId })
      const orderMode = integration.orderMode
        ?? store?.orderMode
        ?? (integration.autoAccept ? "auto_accept" : "manual")

      if (orderMode === "auto_accept") {
        await settleWithUber(ctx, {
          action: "accept",
          orderId: internalOrderId as Id<"orders">,
          externalOrderId,
          attempt: 1,
          rawBody,
        })
      } else if (orderMode === "auto_reject") {
        await settleWithUber(ctx, {
          action: "reject",
          orderId: internalOrderId as Id<"orders">,
          externalOrderId,
          attempt: 1,
          rawBody,
        })
      } else {
        // Manual: the order waits on the KDS. Nothing has been promised to
        // Uber, so `platformSyncStatus` stays pending until staff act.
        await ctx.runMutation(internal.platformWebhookFailures.setPlatformSyncStatus, {
          id: internalOrderId as Id<"orders">,
          platformSyncStatus: "pending" as const,
        })
        console.log(`[Manual] Uber Eats order ${externalOrderId} - awaiting staff action`)
      }

      return new Response("OK", { status: 200 })
    }

    // ---------------------------------------------------------------------
    // Cancellation
    // ---------------------------------------------------------------------
    if (kind === "cancel") {
      console.log(`Order cancelled (${event.event_type}): ${resourceId}`)
      try {
        await ctx.runMutation(internal.orders.updateFromWebhook, {
          externalOrderId: resourceId,
          platform: "uberEats" as const,
          status: "cancelled" as const,
          updatedAt: Date.now(),
        })
        console.log(`Cancelled order ${resourceId}`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.toLowerCase().includes("not found")) {
          // Cancel for an order we never stored — ack and move on.
          console.warn(`Cancel for unknown order ${resourceId}, ack`)
        } else {
          throw error
        }
      }
      return new Response("OK", { status: 200 })
    }

    // ---------------------------------------------------------------------
    // Release: Uber has handed the order to another channel. It is no longer
    // ours to cook.
    // ---------------------------------------------------------------------
    if (kind === "release") {
      console.log(`Order released to another channel: ${resourceId}`)
      try {
        await ctx.runMutation(internal.orders.updateFromWebhook, {
          externalOrderId: resourceId,
          platform: "uberEats" as const,
          status: "cancelled" as const,
          cancellationReason: "released_by_uber",
          updatedAt: Date.now(),
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (!msg.toLowerCase().includes("not found")) throw error
        console.warn(`Release for unknown order ${resourceId}, ack`)
      }
      return new Response("OK", { status: 200 })
    }

    // Store lifecycle and report events: acknowledged, nothing to do here yet.
    if (
      kind === "store_provisioned" ||
      kind === "store_deprovisioned" ||
      kind === "report" ||
      kind === "fulfillment_issues_resolved"
    ) {
      console.log(`Uber Eats ${kind} acknowledged: ${resourceId}`)
      return new Response("OK", { status: 200 })
    }

    // Unknown event type — acknowledge, and keep it so an unrecognised name is
    // visible rather than silently dropped. This is how `orders.cancel.notification`
    // went unnoticed for the life of the integration.
    console.warn(`Unknown Uber Eats event type: ${event.event_type ?? "(absent)"}`)
    await ctx.runMutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      eventType: event.event_type,
      externalOrderId: resourceId || undefined,
      reason: "processing_failed" as const,
      detail: `Unrecognised event type: ${event.event_type ?? "(absent)"}`,
      rawBody,
    })
    return new Response("OK", { status: 200 })
  } catch (error) {
    console.error("Uber Eats webhook error:", error)
    await captureBackendError(ctx, {
      error,
      source: "uberEatsWebhook",
      tags: { step: "unhandled" },
    })
    return new Response("Internal error", { status: 500 })
  }
})

/**
 * Tell Uber, then tell the database — in that order.
 *
 * The old code had the call to Uber inside `if (unifiedOrder)` and the local
 * transition to `confirmed` outside it, with a `catch` that only logged. So the
 * order was confirmed to the customer whether or not Uber had ever been told,
 * and when Uber had not been told it auto-cancelled at 11.5 minutes with the
 * food already made. `platformSyncStatus` existed in the schema throughout and
 * was written by nothing.
 */
async function settleWithUber(
  ctx: ActionCtx,
  params: {
    action: "accept" | "reject"
    orderId: Id<"orders">
    externalOrderId: string
    attempt: number
    rawBody?: string
  }
): Promise<void> {
  const { action, orderId, externalOrderId, attempt } = params
  const { getPackageEnv, isSandbox } = await import("@be-yours/core/env")
  const pkg = getPackageEnv()
  const credentials = {
    clientId: pkg.UBER_EATS_CLIENT_ID as string,
    clientSecret: pkg.UBER_EATS_CLIENT_SECRET as string,
    sandboxMode: isSandbox("uberEats"),
  }
  const { uberEats } = await import("@be-yours/integrations")

  try {
    if (action === "accept") {
      await uberEats.acceptOrder(credentials, externalOrderId)
    } else {
      await uberEats.cancelOrder(credentials, externalOrderId, {
        code: "STORE_CLOSED",
        explanation: "Store is not accepting orders",
      })
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Uber ${action} failed for ${externalOrderId} (attempt ${attempt}): ${detail}`)

    // The order stays where it is. It is NOT confirmed to anybody.
    await ctx.runMutation(internal.platformWebhookFailures.setPlatformSyncStatus, {
      id: orderId,
      platformSyncStatus: "failed" as const,
    })

    const nextDelay = ACCEPT_RETRY_DELAYS_MS[attempt - 1]
    if (attempt < MAX_ACCEPT_ATTEMPTS && nextDelay !== undefined) {
      await ctx.scheduler.runAfter(nextDelay, internal.uberEatsWebhook.retrySettleWithUber, {
        action,
        orderId,
        externalOrderId,
        attempt: attempt + 1,
        // Carried through every attempt. Attempt 1 can never be the last, so
        // without this the ONE failure class that actually loses an accepted
        // order was the one whose record had no body to replay.
        rawBody: params.rawBody,
      })
      return
    }

    // Out of attempts. Uber will auto-cancel; the staff need to know now.
    await ctx.runMutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      externalOrderId,
      reason: "accept_failed" as const,
      detail: `Uber ${action} failed after ${attempt} attempts: ${detail}`,
      rawBody: params.rawBody,
    })
    return
  }

  // Uber said yes. Only now does the order move.
  await ctx.runMutation(internal.orders.internalUpdateStatus, {
    id: orderId,
    status: action === "accept" ? ("confirmed" as const) : ("cancelled" as const),
  })
  await ctx.runMutation(internal.platformWebhookFailures.setPlatformSyncStatus, {
    id: orderId,
    platformSyncStatus: "synced" as const,
  })
  console.log(`[${action === "accept" ? "Auto-Accept" : "Auto-Reject"}] Uber Eats order ${externalOrderId} (attempt ${attempt})`)
}

/** Bounded retry of an accept/reject Uber refused. */
export const retrySettleWithUber = internalAction({
  args: {
    action: v.union(v.literal("accept"), v.literal("reject")),
    orderId: v.id("orders"),
    externalOrderId: v.string(),
    attempt: v.number(),
    rawBody: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Minutes pass between attempts, and staff can act in them. If the order
    // has already moved on — accepted by hand on the KDS, or cancelled — then
    // this retry is stale: accepting on Uber now would contradict what the
    // restaurant has already decided, and pushing `confirmed` onto a cancelled
    // order is a transition the state machine rightly refuses, which would
    // throw inside a scheduled action for no good reason.
    const order = await ctx.runQuery(internal.orders.internalGetById, { id: args.orderId })
    if (!order || order.status !== "pending") {
      console.log(
        `Abandoning Uber ${args.action} retry for ${args.externalOrderId}: order is ${order?.status ?? "gone"}`
      )
      return
    }

    await settleWithUber(ctx, {
      action: args.action,
      orderId: args.orderId,
      externalOrderId: args.externalOrderId,
      attempt: args.attempt,
      rawBody: args.rawBody,
    })
  },
})
