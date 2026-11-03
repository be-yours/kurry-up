// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 4: Fulfilled ASAP Order     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 4: an ASAP order the RESTAURANT delivers
 * with its own riders (`fulfillment_type: "restaurant"`), which is the only
 * case where the customer's name, phone and address reach us at all.
 *
 * Every block below posts a signed `order.new` or `order.status_update` at the
 * real Convex route and asserts on what the handler wrote — the `orders` row,
 * the `kitchenTickets` row, and the requests the product made back to
 * Deliveroo. It asserts nothing about the fixture it sent.
 *
 * It used to do the opposite. `createNewOrderWebhook({ fulfillment_type:
 * "restaurant" })` was followed by `expect(order.fulfillment_type).toBe(
 * "restaurant")` — the builder read back to itself — under a docblock claiming
 * the file validated the full order lifecycle and the sync status sent after
 * acceptance. It validated neither, and eight of its eight blocks were shaped
 * that way.
 *
 * @reference https://api-docs.deliveroo.com/docs/order-integration
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readKitchenTickets,
  readOrders,
  seedStoreWithDeliveroo,
  withDeliverooApi,
} from "./convex-harness";
import {
  createNewOrderWebhook,
  createStatusUpdateWebhook,
  generateOrderId,
} from "./test-config";

// The Deliveroo dialogue is half of this scenario — acceptance is what the
// sync status is reported against — so the suite runs with client credentials
// and every request that can reach the API is wrapped in `withDeliverooApi`.
beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }));
afterEach(cancelPendingScheduledJobs);

/** The customer a restaurant-fulfilled order carries, as Deliveroo sends one. */
const CUSTOMER = {
  name: "Camille Roy",
  phone_number: "+33612345678",
};

const DELIVERY_ADDRESS = {
  street1: "123 rue de la Paix",
  street2: "Appartement 4B",
  city: "Paris",
  postcode: "75001",
  country: "FR",
  latitude: 48.8566,
  longitude: 2.3522,
};

function restaurantFulfilledOrder(id: string) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      fulfillment_type: "restaurant",
      asap: true,
      customer: CUSTOMER,
      delivery_address: DELIVERY_ADDRESS,
    }),
  );
}

describe("Scenario 4: a restaurant-fulfilled ASAP order arrives", () => {
  it("creates the order and puts a ticket on the pass", async () => {
    const t = newHarness();
    const storeId = await seedStoreWithDeliveroo(t);

    const response = await postSigned(t, restaurantFulfilledOrder(generateOrderId("fulfilled")));
    expect(response.status).toBe(200);

    const orders = await readOrders(t);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.storeId).toEqual(storeId);
    expect(orders[0]!.source).toBe("deliveroo");
    // Manual mode: the staff accepts on the KDS, so the order waits.
    expect(orders[0]!.status).toBe("pending");

    const tickets = await readKitchenTickets(t);
    expect(tickets, "a Deliveroo order that never reaches the kitchen is lost").toHaveLength(1);
    expect(tickets[0]!.orderId).toEqual(orders[0]!._id);
    expect(tickets[0]!.source).toBe("deliveroo");
  });

  it("carries the customer's name and phone to the order and the ticket", async () => {
    // The restaurant's own rider has to be able to call this person. On a
    // Deliveroo-fulfilled order neither field is sent; here they are, and they
    // have to survive the mapping, the order validator and the ticket insert.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, restaurantFulfilledOrder(generateOrderId("customer")));

    const [order] = await readOrders(t);
    expect(order!.customerInfo.name).toBe("Camille Roy");
    expect(order!.customerInfo.phone).toBe("+33612345678");

    const [ticket] = await readKitchenTickets(t);
    expect(ticket!.customerName).toBe("Camille Roy");
    expect(ticket!.customerPhone).toBe("+33612345678");
  });

  it("stores the delivery address the rider is sent to", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, restaurantFulfilledOrder(generateOrderId("address")));

    const [order] = await readOrders(t);
    expect(order!.deliveryAddress).toBeDefined();
    expect(order!.deliveryAddress!.street).toContain("123 rue de la Paix");
    expect(order!.deliveryAddress!.city).toBe("Paris");
    expect(order!.deliveryAddress!.postalCode).toBe("75001");
    expect(order!.deliveryAddress!.country).toBe("FR");
  });

  it.todo(
    "keeps the second address line, so the rider has the apartment number — " +
      "handleNewOrder (convex/deliverooWebhook.ts:376) builds the street from " +
      "`street1 ?? address_line_1` followed by `address_line_2`, so the " +
      "`street2` Deliveroo pairs with `street1` is dropped: the stored address " +
      'reads "123 rue de la Paix" and "Appartement 4B" is nowhere',
  );

  it("records a restaurant-fulfilled order as a delivery, not a collection", async () => {
    // Somebody is taking this to a door, so `pickup` would be wrong on the
    // ticket, on the KDS and in every report that groups by order type.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, restaurantFulfilledOrder(generateOrderId("type")));

    const [order] = await readOrders(t);
    expect(order!.type).toBe("delivery");
    const [ticket] = await readKitchenTickets(t);
    expect(ticket!.orderType).toBe("delivery");
  });

  it.todo(
    "records WHO delivers, so the kitchen can tell its own rider from " +
      "Deliveroo's — `fulfillment_type` is read once in handleNewOrder " +
      "(convex/deliverooWebhook.ts:336) to choose delivery vs pickup and is " +
      "then discarded; `deliveryType` (convex-schema/src/tables/orders.ts:107) " +
      "is never written by createFromWebhook, so the stored order is " +
      "indistinguishable from a Deliveroo-fulfilled one",
  );

  it("moves the order to confirmed when Deliveroo reports the acceptance", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("lifecycle");

    await withDeliverooApi(async () => {
      await postSigned(t, restaurantFulfilledOrder(orderId));
      const accepted = await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, "accepted")),
      );
      expect(accepted.status).toBe(200);
    });

    const [order] = await readOrders(t);
    expect(order!.status).toBe("confirmed");
  });

  it("reports the sync status to Deliveroo once the order is accepted", async () => {
    // The contract this scenario is certified on: "send sync status only after
    // you receive a webhook call with the accepted status present in the
    // status log". Asserted on the request the product actually made — the
    // URL it went to and the body it sent — not on a comment saying it should.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("sync");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, restaurantFulfilledOrder(orderId));
      const beforeAcceptance = apiCallsExcludingAuth(recorded).length;
      // Nothing may be reported while the order is merely placed.
      expect(beforeAcceptance).toBe(0);

      await postSigned(t, JSON.stringify(createStatusUpdateWebhook(orderId, "accepted")));
      return apiCallsExcludingAuth(recorded);
    });

    const sync = calls.find((c) => c.url.includes("sync_status"));
    expect(sync, "no sync status was reported for an accepted order").toBeDefined();
    expect(sync!.method).toBe("POST");
    expect(sync!.url).toContain(encodeURIComponent(orderId));
    expect(JSON.parse(sync!.body ?? "{}")).toMatchObject({ status: "succeeded" });
  });

  it("does not report a sync status for an order nobody has accepted", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("unaccepted");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, restaurantFulfilledOrder(orderId));
      // A status update that is not an acceptance, and carries none in its log.
      await postSigned(t, JSON.stringify(createStatusUpdateWebhook(orderId, "pending")));
      return apiCallsExcludingAuth(recorded);
    });

    expect(calls.filter((c) => c.url.includes("sync_status"))).toHaveLength(0);
  });
});
