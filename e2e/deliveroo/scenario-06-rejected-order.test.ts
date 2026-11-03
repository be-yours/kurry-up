// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 6: Rejected Order        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 6: an order the restaurant refuses. The
 * rejection arrives as an `order.status_update`, and what has to happen is
 * that it stops the kitchen — the order is off, the slip comes off the pass,
 * and nothing can put it back.
 *
 * Every block posts a signed payload at the real Convex route and reads back
 * the rows. What is asserted is the effect: the order's status and
 * `cancelledAt`, the ticket's status, the reason kept for the staff, and the
 * dead-letter row a refused move leaves behind.
 *
 * The previous version of this file asserted `createStatusUpdateWebhook(id,
 * "rejected").body.order.status === "rejected"` ten different ways, including
 * one block whose entire body was a list of six reason strings compared to
 * themselves. None of it reached the handler.
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
  readWebhookFailures,
  seedStoreWithDeliveroo,
} from "./convex-harness";
import {
  createNewOrderWebhook,
  createStatusUpdateWebhook,
  generateOrderId,
} from "./test-config";

// No client credentials: a rejection needs no answer to Deliveroo, and this
// suite must not depend on the network to say so.
beforeAll(() => configureDeliverooEnv());
afterEach(cancelPendingScheduledJobs);

/** Place an order the way Deliveroo does, and hand back its external id. */
async function placeOrder(t: ReturnType<typeof newHarness>): Promise<string> {
  const orderId = generateOrderId("rejected");
  const response = await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })));
  expect(response.status).toBe(200);
  return orderId;
}

describe("Scenario 6: a rejected order", () => {
  it("cancels the order and takes its ticket off the pass", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = await placeOrder(t);

    const before = await readKitchenTickets(t);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).not.toBe("cancelled");

    const response = await postSigned(
      t,
      JSON.stringify(createStatusUpdateWebhook(orderId, "rejected")),
    );
    expect(response.status).toBe(200);

    const [order] = await readOrders(t);
    const [ticket] = await readKitchenTickets(t);
    expect(order!.status).toBe("cancelled");
    expect(order!.cancelledAt).toBeTypeOf("number");
    // The kitchen reads tickets, not orders. Cancelling only the order row is
    // how a refused order stayed live on the display and in the print queue.
    expect(ticket!.status).toBe("cancelled");
  });

  it("keeps the reason the restaurant gave", async () => {
    // `rejection_reason` and `cancellation_reason` are different fields on
    // Deliveroo's payload and the same column here — a rejection that lost its
    // reason leaves staff with a cancelled order and no idea why.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = await placeOrder(t);

    await postSigned(
      t,
      JSON.stringify(
        createStatusUpdateWebhook(orderId, "rejected", { rejection_reason: "out_of_stock" }),
      ),
    );

    const [order] = await readOrders(t);
    expect(order!.cancellationReason).toBe("out_of_stock");
  });

  it("is final: a later acceptance cannot revive it", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = await placeOrder(t);

    await postSigned(t, JSON.stringify(createStatusUpdateWebhook(orderId, "rejected")));
    const revive = await postSigned(
      t,
      JSON.stringify(createStatusUpdateWebhook(orderId, "accepted")),
    );
    // Acknowledged, because a redelivery would be refused identically — but
    // refused, and kept, so the contradiction is not simply swallowed.
    expect(revive.status).toBe(200);

    const [order] = await readOrders(t);
    expect(order!.status).toBe("cancelled");

    const failures = await readWebhookFailures(t);
    expect(failures.some((f) => f.detail?.includes("cancelled -> confirmed"))).toBe(true);
  });

  it.todo(
    "keeps a rejection for an order we do not have, instead of dropping it — " +
      "a status update can land before the order.new that creates the row, or " +
      "for an order that never routed. handleStatusUpdate " +
      "(convex/deliverooWebhook.ts:571-592) retries the lookup three times, " +
      "then leaves a console.error and returns success, so the handler answers " +
      "200 and platformWebhookFailures stays empty: the rejection is gone, " +
      "along with the refund nobody now knows is owed. The routing failure " +
      "path records a dead letter (convex/deliverooWebhook.ts:249); this one " +
      "does not",
  );
});
