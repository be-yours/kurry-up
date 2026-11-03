// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 5: Customer Collect Order   │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 5: click & collect
 * (`fulfillment_type: "customer"`). Nobody delivers this order — the customer
 * walks in for it — so the two things that matter are that the kitchen gets it
 * and that everything downstream knows it is a collection.
 *
 * Each block posts a signed payload at the real Convex route and reads back
 * the `orders` and `kitchenTickets` rows the handler wrote.
 *
 * What is NOT here any more: ten blocks that built a fixture and asserted on
 * the fixture, including four that only re-read `fulfillment_type` and
 * `status` out of the builder that had just set them. Four of them are gone
 * rather than rewritten — "supports scheduled customer collect" belongs to
 * scenario 3, which now drives the scheduler for real, and repeating it here
 * would have been coverage in name only.
 *
 * @reference https://api-docs.deliveroo.com/docs/order-integration
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mapDeliverooStatus } from "../../convex/deliverooWebhook";
import {
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readKitchenTickets,
  readOrders,
  readScheduledJobs,
  seedStoreWithDeliveroo,
} from "./convex-harness";
import {
  createNewOrderWebhook,
  createStatusUpdateWebhook,
  generateOrderId,
} from "./test-config";

// No client credentials: a collection order has to reach the counter whether
// or not we can talk back to Deliveroo.
beforeAll(() => configureDeliverooEnv());
afterEach(cancelPendingScheduledJobs);

function collectOrder(id: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      fulfillment_type: "customer",
      asap: true,
      customer: { name: "Camille Roy", phone_number: "+33612345678" },
      ...overrides,
    }),
  );
}

describe("Scenario 5: a customer-collect order arrives", () => {
  it("creates the order and puts a ticket on the pass", async () => {
    const t = newHarness();
    const storeId = await seedStoreWithDeliveroo(t);

    const response = await postSigned(
      t,
      collectOrder(generateOrderId("collect"), { order_number: "DLV-4821" }),
    );
    expect(response.status).toBe(200);

    const orders = await readOrders(t);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.storeId).toEqual(storeId);
    expect(orders[0]!.source).toBe("deliveroo");

    const tickets = await readKitchenTickets(t);
    expect(tickets).toHaveLength(1);
    // Deliveroo's own reference on the slip, so the counter can match it to
    // the tablet when the customer arrives asking for order 4821.
    expect(tickets[0]!.orderNumber).toBe("DLV-4821");
    expect(tickets[0]!.customerName).toBe("Camille Roy");
  });

  it.todo(
    "records it as a collection, so nobody is sent out with it — " +
      "handleNewOrder (convex/deliverooWebhook.ts:336) maps only the values " +
      "collection and pickup to a pickup, while the Deliveroo fulfillment " +
      "vocabulary is deliveroo | restaurant | customer, so that branch never " +
      "fires: a click & collect order is stored with type delivery, and its " +
      "kitchen ticket says delivery too",
  );

  it("carries no delivery address, because there is no delivery", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, collectOrder(generateOrderId("no-address")));

    const [order] = await readOrders(t);
    expect(order!.deliveryAddress).toBeUndefined();
  });

  it("holds nothing back: an ASAP collection is not parked on the scheduler", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, collectOrder(generateOrderId("asap")));

    expect(await readScheduledJobs(t)).toHaveLength(0);
    const [order] = await readOrders(t);
    expect(order!.status).toBe("pending");
  });

  it("does not let a collection prep stage move the order", async () => {
    // `ready_for_collection` reads like the natural final status for this
    // scenario, and it is not a status at all: it is a prep stage we PUSH to
    // `/prep_stages`. Deliveroo's order vocabulary is pending, placed,
    // accepted, confirmed, rejected, canceled — nothing else. Treating a stage
    // as a status is how an order advanced on an event Deliveroo never sent.
    for (const stage of ["ready_for_collection", "out_for_delivery", "delivered"]) {
      expect(mapDeliverooStatus(stage), `${stage} is a prep stage, not a status`).toBeNull();
    }

    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("stage");
    await postSigned(t, collectOrder(orderId));

    const [created] = await readOrders(t);
    await t.run((ctx) => ctx.db.patch(created!._id, { status: "confirmed" as const }));

    for (const stage of ["ready_for_collection", "out_for_delivery", "delivered"]) {
      const response = await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, stage)),
      );
      // Acknowledged — nothing was lost, and a redelivery would be ignored
      // again — but the order must not move.
      expect(response.status).toBe(200);
    }

    const [after] = await readOrders(t);
    expect(after!.status).toBe("confirmed");
  });
});
