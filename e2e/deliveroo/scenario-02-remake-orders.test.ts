// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 2: Remake Orders Tests   │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 2: a remake — a replacement order for one
 * that went wrong, carrying `remake_details` with the parent order and whose
 * fault it was. Fault decides the money: Deliveroo's fault and the restaurant
 * is paid again, the restaurant's fault and the remake is free.
 *
 * Two blocks below post remakes at the real Convex route and read the stored
 * order back.
 *
 * THE SIX LIVE BLOCKS ARE GONE (#635). They POSTed at a deployed backend behind
 * `it.runIf(hasWebhookTarget)`, and no deployment was ever wired up, so they
 * skipped on every run this repository has ever made. A test that has never
 * executed is not coverage; it is a claim. Removed rather than left announcing
 * itself, because the announcement was the only thing it ever did.
 *
 * What the two rewritten blocks used to be: `createRemakeOrderWebhook(...)`
 * followed by `expect(remakeDetails.fault).toBe("deliveroo")` and
 * `expect(order.total_price.fractional).toBe(2500)` — the builder answering
 * for itself. Worse, both read `originalOrderId`, a module-level variable that
 * is only ever assigned inside the FIRST live block: in CI, where the live
 * blocks skip, the parent-order assertion compared `undefined` to `undefined`
 * and passed.
 *
 * @reference https://api-docs.deliveroo.com/docs/remake-orders
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readKitchenTickets,
  readOrders,
  seedStoreWithDeliveroo,
} from "./convex-harness";
import {
  assertRemakeDetails,
  assertWebhookSuccess,
  config,
  createNewOrderWebhook,
  createRemakeOrderWebhook,
  createStatusUpdateWebhook,
  generateOrderId,
  log,
  sendWebhook,
  wait,
} from "./test-config";


// ============================================================================
// Test Suite
// ============================================================================

describe("Scenario 2: Remake Orders", () => {
  let originalOrderId: string;

  // ========================================================================
  // Setup & Teardown
  // ========================================================================

  beforeAll(() => {
    configureDeliverooEnv();
    log.info("Starting Remake Orders Test Suite");
    log.info(`Convex Site URL: ${config.CONVEX_SITE_URL}`);
    log.info(`Sandbox Mode: ${config.IS_SANDBOX}`);
  });

  afterEach(cancelPendingScheduledJobs);

  // ========================================================================
  // Test 1: Original Order Creation
  // ========================================================================

  // ========================================================================
  // Test 2: Remake Order (Deliveroo Fault - Full Price)
  // ========================================================================

  // ========================================================================
  // Test 3: Remake Order (Restaurant Fault - Zero Price)
  // ========================================================================

  // ========================================================================
  // Test 4: Sync Status Timing (Wait for Accepted Webhook)
  // ========================================================================

  // ========================================================================
  // Test 5: Multiple Remake Orders for Same Parent
  // ========================================================================

  // ========================================================================
  // Test 6: A remake is charged, or not, according to fault
  // ========================================================================

  it("charges a Deliveroo-fault remake and gives a restaurant-fault one away", async () => {
    // `order_cost` and `total_price` are what the restaurant is paid for
    // making the food a second time. Both remakes are posted at the real
    // route, and what is asserted is the total that ended up in the database.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const parentId = generateOrderId("parent");

    const deliverooFault = createRemakeOrderWebhook(parentId, "deliveroo");
    const restaurantFault = createRemakeOrderWebhook(parentId, "restaurant");

    expect((await postSigned(t, JSON.stringify(deliverooFault))).status).toBe(200);
    expect((await postSigned(t, JSON.stringify(restaurantFault))).status).toBe(200);

    const orders = await readOrders(t);
    expect(orders).toHaveLength(2);

    const paid = orders.find((o) => o.externalOrderId === deliverooFault.body.order.id);
    const free = orders.find((o) => o.externalOrderId === restaurantFault.body.order.id);
    expect(paid!.total).toBe(2500);
    expect(free!.total).toBe(0);

    // Both are food somebody has to cook again, whoever pays for it.
    expect(await readKitchenTickets(t)).toHaveLength(2);
  });

  // ========================================================================
  // Test 7: The link back to the order being remade
  // ========================================================================

  it.todo(
    "links a remake to the order it replaces — `remake_details` is declared " +
      "on the payload type (convex/deliverooWebhook.ts:86) and read nowhere: " +
      "handleNewOrder never touches it, `isRemake` on the orders table " +
      "(convex-schema/src/tables/orders.ts:112, commented \"Flag for remake " +
      "orders from delivery platforms\") has no writer anywhere in the " +
      "repository, and nothing records `parent_order_id`, so a free remake is " +
      "indistinguishable in the takings from an order that was simply never " +
      "paid for",
  );

  // ========================================================================
  // Test 8: Order Flow Validation
  // ========================================================================

});
