"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// OAuth token cache (module-level, persists across invocations in same worker)
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const TOKEN_BUFFER_MS = 60_000; // Expire 60 s early to avoid using a near-expired token

async function getOAuthToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const cacheKey = clientId;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  const response = await fetch("https://login.uber.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "eats.deliveries",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Uber OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  const expiresAt = Date.now() + data.expires_in * 1000 - TOKEN_BUFFER_MS;
  tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt });

  return data.access_token;
}

// ---------------------------------------------------------------------------
// Response shape returned by Uber Direct estimates endpoint
// ---------------------------------------------------------------------------

interface UberEstimateResponse {
  estimate_id: string;
  estimated_at: number;
  expires_at: number;
  estimates: Array<{
    pickup_at: number;
    delivery_fee: {
      total: number;
      currency_code: string;
      line_items: Array<{
        fee_code: string;
        value: number;
        category: string;
      }>;
    };
    etd: number;
  }>;
}

function parseEstimateResponse(data: UberEstimateResponse) {
  const estimate = data.estimates?.[0];
  if (!estimate) {
    throw new Error("UBER_API_ERROR: No estimates returned");
  }

  // Fee is already in minor currency units (cents)
  const fee = estimate.delivery_fee.total;
  const currency = estimate.delivery_fee.currency_code;

  // Convert absolute ETD timestamp to relative minutes from now
  const now = Date.now();
  const estimatedDeliveryMinutes = Math.round((estimate.etd - now) / 60_000);

  return {
    estimateId: data.estimate_id,
    fee, // cents
    currency,
    expiresAt: data.expires_at,
    estimatedDeliveryMinutes: Math.max(estimatedDeliveryMinutes, 5), // minimum 5 min
  };
}

// ---------------------------------------------------------------------------
// Shared helper: call the estimates endpoint and handle common HTTP errors
// ---------------------------------------------------------------------------

async function callEstimatesEndpoint(
  token: string,
  body: object
): Promise<Response> {
  return fetch("https://api.uber.com/v1/eats/deliveries/estimates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Action: getDeliveryQuote
// ---------------------------------------------------------------------------

/**
 * Get a delivery quote from Uber Direct.
 * Returns the estimated fee and delivery time for a given dropoff location.
 */
// @public-by-design: the checkout page asks for a delivery quote before the
// guest has paid or signed in. NOTE: the quote is not yet bound to the address
// it was priced for, nor single-use — tracked separately on the review list.
export const getDeliveryQuote = action({
  args: {
    storeId: v.id("stores"),
    dropoffLatitude: v.number(),
    dropoffLongitude: v.number(),
    dropoffAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // BEFORE anything is asked of Uber. This action is anonymous by design —
    // a diner has to see the delivery fee before they have an account — and
    // Uber both charges for a quote and caps how many an account may ask for.
    // Unbounded, a script burns the restaurant's quota until real deliveries
    // stop being quotable, at no cost to whoever runs it (#430.5).
    await ctx.runMutation(internal.rateLimits.consume, {
      name: "deliveryQuotePerStore",
      subject: args.storeId,
    });

    // 1. Fetch store to verify pickup coordinates exist
    // Note: defs.getById uses the arg key "id", so we map storeId → id here
    const store = await ctx.runQuery(api.stores.getById, { id: args.storeId });
    if (!store) {
      throw new Error("STORE_NOT_FOUND");
    }
    if (!store.address?.latitude || !store.address?.longitude) {
      throw new Error(
        "STORE_ADDRESS_INCOMPLETE: Store has no coordinates configured"
      );
    }

    // 2. Fetch global settings for Uber Direct credentials
    const settings = await ctx.runQuery(internal.globalSettings.getInternal, {});
    if (!settings) {
      throw new Error("SETTINGS_NOT_FOUND");
    }

    const uberConfig = settings.integrations?.uberDirect;
    if (!uberConfig?.enabled) {
      throw new Error("UBER_DIRECT_DISABLED");
    }
    if (!uberConfig.clientId || !uberConfig.clientSecret) {
      throw new Error(
        "UBER_DIRECT_NOT_CONFIGURED: Missing clientId or clientSecret"
      );
    }
    if (!uberConfig.customerId) {
      throw new Error(
        "UBER_DIRECT_NOT_CONFIGURED: Missing customerId (Uber store ID)"
      );
    }

    // 3. Obtain OAuth token (served from module-level cache when still valid)
    let token: string;
    try {
      token = await getOAuthToken(uberConfig.clientId, uberConfig.clientSecret);
    } catch (err) {
      throw new Error(
        `UBER_AUTH_FAILED: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }

    // 4. Build estimates request body
    // customerId IS the Uber store ID used as the pickup reference
    const estimateBody = {
      pickup: {
        store_id: uberConfig.customerId,
      },
      dropoff: {
        location: {
          latitude: args.dropoffLatitude,
          longitude: args.dropoffLongitude,
        },
      },
      pickup_times: [0], // 0 = ASAP
    };

    // 5. Call Uber Direct estimates endpoint
    let estimateResponse = await callEstimatesEndpoint(token, estimateBody);

    // On 401, the cached token may have been revoked — evict and retry once
    if (estimateResponse.status === 401) {
      tokenCache.delete(uberConfig.clientId);
      const freshToken = await getOAuthToken(
        uberConfig.clientId,
        uberConfig.clientSecret
      );
      estimateResponse = await callEstimatesEndpoint(freshToken, estimateBody);
    }

    // Handle well-known Uber Direct error codes with clear messages
    if (estimateResponse.status === 422) {
      throw new Error(
        "UNDELIVERABLE_ZONE: Uber Direct cannot deliver to this location"
      );
    }

    if (estimateResponse.status === 429) {
      throw new Error(
        "RATE_LIMITED: Uber Direct API rate limit exceeded. Please try again later."
      );
    }

    if (!estimateResponse.ok) {
      const text = await estimateResponse.text();
      throw new Error(`UBER_API_ERROR (${estimateResponse.status}): ${text}`);
    }

    const quote = parseEstimateResponse(
      (await estimateResponse.json()) as UberEstimateResponse
    );

    // Persist the quote. `orders.create` reads the fee from here rather than
    // from a client argument, so a browser cannot dictate its own delivery
    // charge in percentage fee mode.
    await ctx.runMutation(internal.deliveryQuotes.internalRecord, {
      estimateId: quote.estimateId,
      storeId: args.storeId,
      fee: quote.fee,
      currency: quote.currency,
      dropoffLatitude: args.dropoffLatitude,
      dropoffLongitude: args.dropoffLongitude,
      expiresAt: quote.expiresAt,
    });

    return quote;
  },
});

// ---------------------------------------------------------------------------
// Delivery lifecycle
//
// Everything above books nothing: it prices a course. The actions below are
// what actually put a courier on the road, and what keeps the order in step
// with them.
// ---------------------------------------------------------------------------

const CREATE_ORDER_URL = "https://api.uber.com/v1/eats/deliveries/orders";

/** Resolve credentials once; every lifecycle action needs the same three. */
async function requireUberConfig(ctx: ActionCtx): Promise<{
  clientId: string;
  clientSecret: string;
  customerId: string;
}> {
  const settings = await ctx.runQuery(internal.globalSettings.getInternal, {});
  if (!settings) {
    throw new Error("SETTINGS_NOT_FOUND");
  }

  const uberConfig = settings.integrations?.uberDirect;
  if (!uberConfig?.enabled) {
    throw new Error("UBER_DIRECT_DISABLED");
  }
  if (!uberConfig.clientId || !uberConfig.clientSecret) {
    throw new Error(
      "UBER_DIRECT_NOT_CONFIGURED: Missing clientId or clientSecret"
    );
  }
  if (!uberConfig.customerId) {
    throw new Error(
      "UBER_DIRECT_NOT_CONFIGURED: Missing customerId (Uber store ID)"
    );
  }

  return {
    clientId: uberConfig.clientId,
    clientSecret: uberConfig.clientSecret,
    customerId: uberConfig.customerId,
  };
}

/**
 * Call Uber with a token, retrying once on 401.
 *
 * The token lives in a module-level cache shared with the quote path, so it can
 * be revoked between two calls. One eviction and one retry is the difference
 * between a transient 401 and a failed delivery.
 */
async function callUber(
  clientId: string,
  clientSecret: string,
  url: string,
  init: { method: string; body?: string; idempotencyKey?: string }
): Promise<Response> {
  const send = async (token: string) =>
    fetch(url, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // Uber replays on network timeouts. Without this header a retried
        // create would dispatch a second courier to the same address, and we
        // would pay for both.
        ...(init.idempotencyKey
          ? { "X-Idempotency-Key": init.idempotencyKey }
          : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });

  let token = await getOAuthToken(clientId, clientSecret);
  let response = await send(token);

  if (response.status === 401) {
    tokenCache.delete(clientId);
    token = await getOAuthToken(clientId, clientSecret);
    response = await send(token);
  }

  return response;
}

/**
 * Book a courier for an order that already has a quote.
 *
 * Idempotent on the order: an order that already carries a delivery id returns
 * it untouched rather than booking a second courier.
 */
// @guarded-inline: checks orders:update_status on the order's store below
export const createDelivery = action({
  args: {
    orderId: v.id("orders"),
    /** Unix ms when the food will be ready. Omit for ASAP. */
    pickupAt: v.optional(v.number()),
    pickupInstructions: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    deliveryId: string;
    trackingUrl?: string;
    fee?: number;
    alreadyBooked: boolean;
  }> => {
    const order = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    // Booking a courier spends the restaurant's money, and cancelling one stops
    // a delivery that is under way. Both need the same authority as advancing
    // the order itself — without this, any caller could do either on any order.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: order.storeId,
      permission: "orders:update_status",
    });

    // Booking twice costs two couriers and two fees.
    if (order.uberDirectDeliveryId) {
      return {
        deliveryId: order.uberDirectDeliveryId,
        trackingUrl: order.uberDirectTrackingUrl,
        fee: order.uberDirectFee,
        alreadyBooked: true,
      };
    }

    if (!order.uberDirectEstimateId) {
      throw new Error(
        "NO_QUOTE: Call getDeliveryQuote before booking a courier"
      );
    }

    const config = await requireUberConfig(ctx);
    const { uberDirect } = await import("@be-yours/integrations");

    let body: string;
    try {
      body = JSON.stringify(
        uberDirect.buildCreateDeliveryRequest(order, {
          uberStoreId: config.customerId,
          quote: { estimateId: order.uberDirectEstimateId },
          pickupAt: args.pickupAt,
          pickupInstructions: args.pickupInstructions,
        })
      );
    } catch (err) {
      // A payload error is ours, not Uber's — surface the code as-is so the
      // caller can tell "no phone number" from "Uber is down".
      throw new Error(
        err instanceof Error ? err.message : "UBER_DIRECT_PAYLOAD_INVALID"
      );
    }

    const response = await callUber(
      config.clientId,
      config.clientSecret,
      CREATE_ORDER_URL,
      { method: "POST", body, idempotencyKey: order.orderNumber }
    );

    if (response.status === 409) {
      throw new Error(
        "DELIVERY_ALREADY_EXISTS: Uber already has a delivery for this order"
      );
    }
    if (response.status === 422) {
      throw new Error(
        "QUOTE_EXPIRED_OR_UNDELIVERABLE: Re-quote before booking again"
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`UBER_API_ERROR (${response.status}): ${text}`);
    }

    const created = (await response.json()) as {
      order_id: string;
      order_tracking_url?: string;
      full_fee?: { total: number };
    };

    await ctx.runMutation(internal.uberDirectInternal.recordDelivery, {
      orderId: args.orderId,
      deliveryId: created.order_id,
      trackingUrl: created.order_tracking_url,
      fee: created.full_fee?.total,
    });

    return {
      deliveryId: created.order_id,
      trackingUrl: created.order_tracking_url,
      fee: created.full_fee?.total,
      alreadyBooked: false,
    };
  },
});

/**
 * Cancel a booked delivery.
 *
 * Cancels the courier only. The order is left alone on purpose: cancelling it
 * is a separate decision, subject to the order status machine, and the two do
 * not always go together — a restaurant may cancel a courier to deliver the
 * order itself.
 */
// @guarded-inline: checks orders:update_status on the order's store below
export const cancelDelivery = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ cancelled: boolean }> => {
    const order = await ctx.runQuery(internal.orders.internalGetById, {
      id: args.orderId,
    });
    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    // Booking a courier spends the restaurant's money, and cancelling one stops
    // a delivery that is under way. Both need the same authority as advancing
    // the order itself — without this, any caller could do either on any order.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: order.storeId,
      permission: "orders:update_status",
    });

    if (!order.uberDirectDeliveryId) {
      throw new Error("NO_DELIVERY: This order has no Uber Direct delivery");
    }

    const config = await requireUberConfig(ctx);
    const response = await callUber(
      config.clientId,
      config.clientSecret,
      `${CREATE_ORDER_URL}/${encodeURIComponent(order.uberDirectDeliveryId)}/cancel`,
      { method: "POST" }
    );

    // Already terminal on Uber's side: nothing to cancel, and reporting an
    // error here would push the operator to retry a no-op.
    if (response.status === 409 || response.status === 404) {
      return { cancelled: false };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`UBER_API_ERROR (${response.status}): ${text}`);
    }

    // Uber will also send a FAILED webhook; writing it here keeps the admin
    // screen honest in the meantime. Not an incident: we asked for it.
    await ctx.runMutation(internal.uberDirectInternal.applyDeliveryStatus, {
      deliveryId: order.uberDirectDeliveryId,
      status: "FAILED",
      needsAttention: false,
    });

    return { cancelled: true };
  },
});
