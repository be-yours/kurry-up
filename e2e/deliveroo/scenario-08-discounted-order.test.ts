// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 8: Discounted Order      │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 8: an order carrying a promotion —
 * `offer_discount` at basket level, `discount_amount` on a line, or both. What
 * the restaurant needs from us is a receipt that adds up: the total it will be
 * paid, and lines that do not contradict it.
 *
 * The blocks below post signed payloads at the real Convex route and read back
 * the `orders` row. Two of them are `it.todo`, because pointing a truthful
 * assertion at the handler showed the discount is not carried at all — see the
 * text of each for what it does instead.
 *
 * The two live blocks that POSTed at a DEPLOYED backend are gone (#635). They
 * sat behind `it.runIf(hasWebhookTarget)`, nothing ever set that variable, and
 * they skipped on every run this repository has made.
 *
 * @reference https://api-docs.deliveroo.com/docs/order-integration
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
  assertWebhookSuccess,
  createNewOrderWebhook,
  generateOrderId,
  log,
  sendWebhook,
} from "./test-config";


beforeAll(() => {
  configureDeliverooEnv();
});
afterEach(cancelPendingScheduledJobs);

/** 25,00 € of food sold for 20,00 € — a five-euro basket promotion. */
function discountedOrder(id: string) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      total_price: { fractional: 2000, currency_code: "EUR" },
      partner_order_total: { fractional: 2000, currency_code: "EUR" },
      offer_discount: { fractional: 500, currency_code: "EUR" },
    }),
  );
}

describe("Scenario 8: a discounted order arrives", () => {
  it("stores the total the partner is actually owed", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    const response = await postSigned(t, discountedOrder(generateOrderId("discounted")));
    expect(response.status).toBe(200);

    const [order] = await readOrders(t);
    // `total_price` is the post-discount figure. Storing the pre-discount one
    // would overstate every promoted order in the takings.
    expect(order!.total).toBe(2000);
  });

  it("still sends a promoted order to the kitchen", async () => {
    // Including the extreme: a fully discounted basket is worth 0 € and is
    // still food somebody has to cook.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(
      t,
      JSON.stringify(
        createNewOrderWebhook({
          id: generateOrderId("free"),
          total_price: { fractional: 0, currency_code: "EUR" },
          partner_order_total: { fractional: 0, currency_code: "EUR" },
          offer_discount: { fractional: 2500, currency_code: "EUR" },
        }),
      ),
    );

    const [order] = await readOrders(t);
    expect(order!.total).toBe(0);
    expect(await readKitchenTickets(t)).toHaveLength(1);
  });

  it("leaves an undiscounted order at its full price", async () => {
    // The baseline the two above are read against: with no promotion the
    // stored total is the basket, and nothing has quietly subtracted anything.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(
      t,
      JSON.stringify(
        createNewOrderWebhook({
          id: generateOrderId("undiscounted"),
          total_price: { fractional: 2500, currency_code: "EUR" },
          partner_order_total: { fractional: 2500, currency_code: "EUR" },
          offer_discount: { fractional: 0, currency_code: "EUR" },
        }),
      ),
    );

    const [order] = await readOrders(t);
    expect(order!.total).toBe(2500);
    expect(order!.subtotal).toBe(2500);
  });

  it.todo(
    "records the discount, so the receipt explains itself — handleNewOrder " +
      "(convex/deliverooWebhook.ts:383-386) reads `total_price` and " +
      "`payment.subtotal` and never looks at `offer_discount`, so a 25,00 EUR " +
      "basket sold for 20,00 EUR is stored with subtotal 2000, total 2000 and " +
      "lines summing to 2500, with nothing anywhere naming the 5,00 EUR; " +
      "`discountAmount` exists on the orders table " +
      "(convex-schema/src/tables/orders.ts:72) and createFromWebhook leaves it " +
      "undefined",
  );

  it.todo(
    "prices a discounted LINE at what the customer paid for it — a line sent " +
      "as unit_price 800, discount_amount 200, total_price 600 is mapped in " +
      "handleNewOrder (convex/deliverooWebhook.ts:340-346) from `unit_price` " +
      "alone, so createFromWebhook stores unitPrice 800 and subtotal 800: the " +
      "line overstates by the discount, and an order carrying per-item " +
      "promotions has lines summing to more than its own total",
  );

  // ========================================================================
  // Live round trip — unchanged, and skipped unless a deployment is configured
  // ========================================================================

});
