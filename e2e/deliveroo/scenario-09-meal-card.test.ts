// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 9: Meal Card Payment        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 9: an order paid in part with a titre-
 * restaurant (`meal_card_payment`), leaving the rest to collect (`cash_due`).
 * From the restaurant's side there are two questions — is the order worth what
 * Deliveroo says it is worth, and does anyone find out that money is still
 * owed at the door.
 *
 * Each block posts a signed payload at the real Convex route and reads the
 * `orders` row back. The first question is answered; the second is an
 * `it.todo`, because asking it truthfully showed nothing carries the split.
 *
 * The ten blocks this replaces added `meal_card_payment` and `cash_due` to a
 * fixture and then asserted that the two summed to the `total_price` the same
 * fixture had just been given — arithmetic on constants, run ten times.
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
import { createNewOrderWebhook, generateOrderId } from "./test-config";

beforeAll(() => configureDeliverooEnv());
afterEach(cancelPendingScheduledJobs);

/** 25,00 €: 10,00 € on the meal card, 15,00 € still to collect. */
function mealCardOrder(id: string, mealCard = 1000, cashDue = 1500) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      total_price: { fractional: mealCard + cashDue, currency_code: "EUR" },
      partner_order_total: { fractional: mealCard + cashDue, currency_code: "EUR" },
      meal_card_payment: { fractional: mealCard, currency_code: "EUR" },
      cash_due: { fractional: cashDue, currency_code: "EUR" },
    }),
  );
}

describe("Scenario 9: an order paid with a meal card", () => {
  it("is created and reaches the kitchen like any other", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    const response = await postSigned(t, mealCardOrder(generateOrderId("meal-card")));
    expect(response.status).toBe(200);

    expect(await readOrders(t)).toHaveLength(1);
    expect(await readKitchenTickets(t)).toHaveLength(1);
  });

  it("is worth the whole basket, however the customer split the payment", async () => {
    // The split is between the customer, the card issuer and Deliveroo. What
    // the restaurant sold is the full 25,00 €, and a total that quietly became
    // the meal-card half would understate the day's takings.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, mealCardOrder(generateOrderId("split")));

    const [order] = await readOrders(t);
    expect(order!.total).toBe(2500);
    expect(order!.subtotal).toBe(2500);
  });

  it("prices the lines the same whether a meal card was used or not", async () => {
    // The payment split must not reach the items. Deliveroo sends the same
    // `unit_price` either way, and a line that moved with the payment method
    // would break every takings report that groups by product.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, mealCardOrder(generateOrderId("lines"), 2500, 0));

    const [order] = await readOrders(t);
    expect(order!.items).toHaveLength(1);
    expect(order!.items[0]!.unitPrice).toBe(2500);
    expect(order!.items[0]!.subtotal).toBe(2500);
  });

  it("records an order settled entirely on the card as paid", async () => {
    // Nothing is owed at the door here, so `paid` is the truth — and it is the
    // baseline the `it.todo` below is measured against.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, mealCardOrder(generateOrderId("full-card"), 2500, 0));

    const [order] = await readOrders(t);
    expect(order!.paymentStatus).toBe("paid");
  });

  it.todo(
    "does not call an order fully paid while cash is still due at the door — " +
      "`meal_card_payment` and `cash_due` are never read: handleNewOrder " +
      "(convex/deliverooWebhook.ts:383-386) takes only `total_price`, and " +
      "createFromWebhook (convex-functions/src/orders.ts:1387) writes " +
      'paymentStatus "paid" unconditionally, so an order with 15,00 € left to ' +
      "collect looks identical to one settled in full and nothing on the slip " +
      "or the KDS tells whoever hands the bag over",
  );
});
