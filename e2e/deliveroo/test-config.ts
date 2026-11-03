/**
 * Deliveroo Integration - Test Configuration
 * Shared configuration and utilities for all Deliveroo scenario tests
 */

import crypto from "node:crypto";

// ============================================================================
// Environment Configuration
// ============================================================================

export const config = {
  // No fallback on purpose. This used to default to a real dev deployment
  // (reliable-parrot-452), so an unconfigured run posted signed Deliveroo
  // webhooks at a backend nobody had asked for. Unset now means unset, and
  // sendWebhook() refuses rather than picking a target for you.
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL || "",
  WEBHOOK_SECRET: process.env.DELIVEROO_WEBHOOK_SECRET || process.env.DELIVEROO_CLIENT_SECRET || "",
  CLIENT_ID: process.env.DELIVEROO_CLIENT_ID || "",
  CLIENT_SECRET: process.env.DELIVEROO_CLIENT_SECRET || "",
  BRAND_ID: process.env.DELIVEROO_BRAND_ID || "",
  SITE_ID: process.env.DELIVEROO_SITE_ID || "SFM-MRS-PRA-01",
  IS_SANDBOX: true,
  // Convex HTTP route for Deliveroo webhooks
  ORDER_WEBHOOK_PATH: "/webhooks/deliveroo/order",
  MENU_WEBHOOK_PATH: "/webhooks/deliveroo/menu",
};

// ============================================================================
// Live-run Gates — removed (#635)
// ============================================================================

/*
 * `hasWebhookTarget`, `hasDeliverooSandbox` and `announceSkippedLiveRun` gated 26
 * tests — thirteen in each twin — on credentials nobody ever set, so they skipped
 * on every run this repository has made. Five needed real Deliveroo sandbox OAuth;
 * the other eight needed a deployed Convex endpoint the vitest task cannot provide.
 * `announceSkippedLiveRun` printed a banner saying so, which was the honest thing
 * to do and was also the only thing any of them ever did.
 *
 * `turbo.json` declared `DELIVEROO_E2E_REQUIRE_LIVE` for exactly this machinery —
 * the switch that turned the silent skip into a failure — and that declaration went
 * with it. The other `DELIVEROO_*` variables stay: `convex-harness.ts` sets its own
 * values for the suites that do run, and the product code reads them.
 *
 * What remains in this directory needs no credential and no deployment: 63 tests
 * against `convexTest` and against the real client with `fetch` replaced.
 */

// ============================================================================
// Utilities
// ============================================================================

/**
 * The byte that joins the sequence GUID to the body in the signed message.
 *
 * A single space for every modern webhook — order events, rider events, menu,
 * picking, catalogue, Express and Signature. The legacy POS webhook
 * (`new_order` / `cancel_order`) uses `" \n "` instead, and nothing in these
 * suites sends one. Getting this wrong is invisible until a live run: the
 * request is well-formed and the verifier simply answers 401.
 */
export const SIGNATURE_SEPARATOR = " ";

/**
 * Create the HMAC-SHA256 signature Deliveroo puts in `X-Deliveroo-Hmac-Sha256`.
 *
 * The signed message is `sequence_guid + " " + raw body bytes`, hex-encoded,
 * keyed on the webhook secret — NOT the body alone. Signing the body alone is
 * exactly what this function used to do, and because these suites skip
 * whenever no live target is configured, eleven green runs never once proved
 * the verifier accepted anything. `apps/reference/convex/deliverooWebhookHandler.ts`
 * builds the same message from raw bytes and rejects everything else with 401.
 *
 * The body is taken as bytes, not as a string, so the bytes that get signed
 * are provably the bytes that get sent — re-serializing JSON between the two
 * changes the signature.
 */
export function createSignature(
  sequenceGuid: string,
  payload: Uint8Array,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(sequenceGuid)
    .update(SIGNATURE_SEPARATOR)
    .update(payload)
    .digest("hex");
}

/**
 * Send webhook to Convex HTTP endpoint
 */
export async function sendWebhook(payload: unknown, path?: string): Promise<Response> {
  if (!config.CONVEX_SITE_URL) {
    throw new Error(
      "CONVEX_SITE_URL is not set: refusing to send a signed Deliveroo webhook " +
        "with no explicit target. Set it to the deployment you mean to hit.",
    );
  }

  // Serialize once. `payloadBytes` is both what gets signed and what gets
  // sent, so the two cannot drift.
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signingSecret = config.WEBHOOK_SECRET || config.CLIENT_SECRET;
  const sequenceGuid = crypto.randomUUID();
  const signature = createSignature(sequenceGuid, payloadBytes, signingSecret);

  const url = `${config.CONVEX_SITE_URL}${path || config.ORDER_WEBHOOK_PATH}`;

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-deliveroo-hmac-sha256": signature,
      "x-deliveroo-sequence-guid": sequenceGuid,
      "x-deliveroo-request-id": sequenceGuid,
    },
    body: payloadBytes,
  });
}

/**
 * Wait for a specific duration
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate test order ID
 */
export function generateOrderId(prefix: string = "test"): string {
  return `fr:${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Generate order number
 */
export function generateOrderNumber(): string {
  return `ORD-${Date.now().toString().slice(-8)}`;
}

// ============================================================================
// Common Webhook Builders
// ============================================================================

interface DeliverooPrice {
  fractional: number;
  currency_code: string;
}

interface DeliverooWebhookOrder {
  id: string;
  order_number: string;
  location_id: string;
  display_id: string;
  status: string;
  status_log: Array<{ at: string; status: string }>;
  fulfillment_type: string;
  asap: boolean;
  total_price: DeliverooPrice;
  partner_order_total: DeliverooPrice;
  items: Array<Record<string, unknown>>;
  start_preparing_at: string;
  confirm_at?: string;
  offer_discount?: DeliverooPrice;
  meal_card_payment?: DeliverooPrice;
  cash_due?: DeliverooPrice;
  customer?: Record<string, unknown>;
  delivery_address?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeliverooWebhookPayload {
  event: string;
  body: {
    order: DeliverooWebhookOrder;
  };
}

/**
 * Create order.new webhook (Deliveroo order.created format)
 */
export function createNewOrderWebhook(overrides: Partial<Record<string, unknown>> = {}): DeliverooWebhookPayload {
  const orderId = (overrides.id as string) || generateOrderId("new");
  const orderNumber = (overrides.order_number as string) || generateOrderNumber();

  return {
    event: "order.new",
    body: {
      order: {
        id: orderId,
        order_number: orderNumber,
        location_id: config.SITE_ID,
        display_id: orderNumber.slice(-4),
        status: "placed",
        status_log: [
          { at: new Date().toISOString(), status: "pending" },
          { at: new Date().toISOString(), status: "placed" },
        ],
        fulfillment_type: "deliveroo",
        asap: true,
        total_price: { fractional: 2500, currency_code: "EUR" },
        partner_order_total: { fractional: 2500, currency_code: "EUR" },
        items: [
          {
            pos_item_id: "ITEM-TEST-001",
            quantity: 1,
            name: "Test Item",
            unit_price: { fractional: 2500, currency_code: "EUR" },
            total_price: { fractional: 2500, currency_code: "EUR" },
          },
        ],
        start_preparing_at: new Date(Date.now() + 5 * 60000).toISOString(),
        ...overrides,
      },
    },
  };
}

/**
 * Create order.status_update webhook
 *
 * `location_id` is part of the payload, as it is in Deliveroo's: the order
 * object an `order.status_update` carries is the same object `order.new`
 * carries, and the handler routes EVERY order event by that field before it
 * looks at anything else (`processOrderWebhook`, `resolveStoreIntegration`).
 * Without it the request is refused with 500 as an order for a site we cannot
 * place, so a fixture that omitted it could never have driven a status update
 * through the handler at all.
 *
 * @param overrides extra order fields — a cancellation reason, a status log
 */
export function createStatusUpdateWebhook(
  orderId: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    event: "order.status_update",
    body: {
      order: {
        id: orderId,
        location_id: config.SITE_ID,
        status: status,
        status_log: [{ at: new Date().toISOString(), status: status }],
        ...overrides,
      },
    },
  };
}

/**
 * Create remake order webhook
 */
export function createRemakeOrderWebhook(
  parentOrderId: string,
  fault: "deliveroo" | "restaurant",
) {
  const orderId = generateOrderId("remake");
  const orderNumber = generateOrderNumber();
  const orderCost = fault === "deliveroo" ? 2500 : 0;
  const totalPrice = fault === "deliveroo" ? 2500 : 0;

  const baseWebhook = createNewOrderWebhook({
    id: orderId,
    order_number: orderNumber,
    total_price: { fractional: totalPrice, currency_code: "EUR" },
  });

  return {
    ...baseWebhook,
    body: {
      ...baseWebhook.body,
      order: {
        ...baseWebhook.body.order,
        remake_details: {
          fault: fault as string,
          parent_order_id: parentOrderId,
          order_cost: orderCost,
        },
      },
    },
  };
}

// ============================================================================
// Test Assertions
// ============================================================================

/**
 * Assert webhook response is successful (200 OK)
 */
export async function assertWebhookSuccess(response: Response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Webhook failed: ${response.status} ${response.statusText} - ${text}`,
    );
  }
  const text = await response.text();
  return text;
}

/**
 * Assert remake details are valid
 */
export function assertRemakeDetails(
  remakeDetails: { parent_order_id: string; fault: string },
  expectedParentId: string,
  expectedFault: string,
) {
  if (!remakeDetails) {
    throw new Error("remake_details is missing");
  }
  if (remakeDetails.parent_order_id !== expectedParentId) {
    throw new Error(
      `Expected parent_order_id to be ${expectedParentId}, got ${remakeDetails.parent_order_id}`,
    );
  }
  if (remakeDetails.fault !== expectedFault) {
    throw new Error(
      `Expected fault to be ${expectedFault}, got ${remakeDetails.fault}`,
    );
  }
}

// ============================================================================
// Logging Helpers
// ============================================================================

export const log = {
  info: (message: string) => console.log(`  ${message}`),
  success: (message: string) => console.log(`  ${message}`),
  error: (message: string) => console.error(`  ${message}`),
  test: (message: string) => console.log(`  ${message}`),
  wait: (message: string) => console.log(`  ${message}`),
};
