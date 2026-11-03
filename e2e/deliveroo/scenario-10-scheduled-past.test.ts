// @vitest-environment edge-runtime

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 10: Scheduled in Past Order   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 10: an order that says `asap: false` but
 * whose times have already passed — the customer scheduled it, and the moment
 * came round while it was in flight. Deliveroo's instruction is one sentence:
 * "it should be treated the same as an ASAP order".
 *
 * So the question this file has to answer is whether the handler waits. It
 * posts the payload at the real route and looks at the scheduler: a
 * confirmation parked for a moment in the past must be due NOW, and the ticket
 * must already be on the pass.
 *
 * The ten blocks this replaces asked `Date` whether one timestamp was smaller
 * than another. Six of them differed only in how far in the past the fixture
 * put `start_preparing_at`.
 *
 * @reference https://api-docs.deliveroo.com/docs/scheduled-orders-1
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
  readScheduledJobs,
  seedStoreWithDeliveroo,
  withDeliverooApi,
} from "./convex-harness";
import { createNewOrderWebhook, generateOrderId } from "./test-config";

beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }));
afterEach(cancelPendingScheduledJobs);

const AN_HOUR = 60 * 60 * 1000;

/** `asap: false` with every time already gone by. */
function pastScheduledOrder(id: string, agoMs: number, overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      asap: false,
      confirm_at: new Date(Date.now() - agoMs).toISOString(),
      start_preparing_at: new Date(Date.now() - agoMs / 2).toISOString(),
      ...overrides,
    }),
  );
}

describe("Scenario 10: an order scheduled for a moment that has passed", () => {
  it("is confirmed immediately rather than waited on", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const postedAt = Date.now();

    await withDeliverooApi(async () => {
      const response = await postSigned(
        t,
        pastScheduledOrder(generateOrderId("past"), AN_HOUR),
      );
      expect(response.status).toBe(200);
    });

    const jobs = await readScheduledJobs(t);
    expect(jobs).toHaveLength(1);
    // `Math.max(confirmAt - now, 0)` is the whole of "treat it as ASAP": a
    // negative delay must clamp to zero, not schedule in the past and not be
    // used as-is.
    expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(postedAt);
    expect(jobs[0]!.scheduledTime - postedAt).toBeLessThan(5_000);
  });

  it("does not wait a day for an order that was due yesterday", async () => {
    // The far edge of the same clamp. A 24-hour-old `confirm_at` must not
    // produce a job 24 hours in the past (never runs) nor one 24 hours out.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const postedAt = Date.now();

    await withDeliverooApi(async () => {
      await postSigned(t, pastScheduledOrder(generateOrderId("yesterday"), 24 * AN_HOUR));
    });

    const jobs = await readScheduledJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.scheduledTime - postedAt).toBeLessThan(5_000);
  });

  it("still accepts it with Deliveroo and still feeds the kitchen", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("past");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, pastScheduledOrder(orderId, AN_HOUR));
      return apiCallsExcludingAuth(recorded);
    });

    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ status: "accepted" });
    expect(await readKitchenTickets(t)).toHaveLength(1);
    const [order] = await readOrders(t);
    expect(order!.status).toBe("pending");
  });

  it("treats asap:false with no confirm_at as an ordinary ASAP order", async () => {
    // Deliveroo omits `confirm_at` once there is nothing left to wait for.
    // Without it the scheduled branch cannot fire, and the order has to fall
    // through to the ASAP path instead of being parked forever.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("no-confirm");

    await withDeliverooApi(async () => {
      const response = await postSigned(
        t,
        JSON.stringify(
          createNewOrderWebhook({
            id: orderId,
            asap: false,
            start_preparing_at: new Date(Date.now() - AN_HOUR).toISOString(),
          }),
        ),
      );
      expect(response.status).toBe(200);
    });

    expect(await readScheduledJobs(t)).toHaveLength(0);
    expect(await readKitchenTickets(t)).toHaveLength(1);
    const [order] = await readOrders(t);
    // Manual mode: it waits for staff on the KDS, like any ASAP order.
    expect(order!.status).toBe("pending");
  });

  it.todo(
    "records when the order was actually due, so a late one can be spotted — " +
      "`start_preparing_at` and `prepare_for` are never read at all, and " +
      "`confirm_at` is read in handleNewOrder " +
      "(convex/deliverooWebhook.ts) only to compute a scheduler delay, then " +
      "discarded; the orders table has NO field left to record it in, because " +
      "`scheduledAt` and `scheduledFor` were both removed (#363, #413) as " +
      "unbacked customer-scheduling claims that no writer ever filled. So an " +
      "order an hour overdue is still indistinguishable on the KDS from one " +
      "placed this second, and closing this means adding a field for platform " +
      "due-time — a KDS lateness concern, not a diner-facing booking feature",
  );
});
