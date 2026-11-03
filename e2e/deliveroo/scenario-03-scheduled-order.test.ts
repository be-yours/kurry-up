// @vitest-environment edge-runtime

/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 3: Scheduled Orders      │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 3: an order placed now for later
 * (`asap: false` with a `confirm_at`). The contract has two halves and this
 * file drives both through the real Convex route:
 *
 *  - the order is ACCEPTED straight away, so Deliveroo stops waiting on us,
 *    and its CONFIRMATION is parked on the scheduler until `confirm_at`;
 *  - the kitchen gets the ticket immediately, because a scheduled order still
 *    has to be planned for.
 *
 * The Deliveroo API is recorded rather than called (`withDeliverooApi`), so
 * what the product actually sent — the URL, the method, the body — is what
 * gets asserted.
 *
 * Before this rewrite the file had six blocks and none of them ran any of the
 * above: each built a payload with `createNewOrderWebhook({ asap: false, … })`
 * and then checked that `asap` was false and that `confirm_at` parsed to a
 * date after now. It was testing `Date`.
 *
 * @reference https://api-docs.deliveroo.com/docs/scheduled-orders-1
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  cancelScheduledJobsOf,
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

// Scheduled orders are a dialogue with Deliveroo — accept now, confirm later —
// so this suite runs with credentials and records every outbound call.
beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }));
afterEach(cancelPendingScheduledJobs);

const HALF_AN_HOUR = 30 * 60 * 1000;
const AN_HOUR = 60 * 60 * 1000;

function scheduledOrder(id: string, confirmAt: number) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      asap: false,
      confirm_at: new Date(confirmAt).toISOString(),
      start_preparing_at: new Date(confirmAt + HALF_AN_HOUR).toISOString(),
      prepare_for: new Date(confirmAt + AN_HOUR).toISOString(),
    }),
  );
}

describe("Scenario 3: a scheduled order arrives", () => {
  it("accepts it with Deliveroo straight away", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("scheduled");

    const calls = await withDeliverooApi(async (recorded) => {
      const response = await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
      expect(response.status).toBe(200);
      return apiCallsExcludingAuth(recorded);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain(encodeURIComponent(orderId));
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ status: "accepted" });
  });

  it("parks the confirmation on the scheduler for confirm_at", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("scheduled");
    const confirmAt = Date.now() + HALF_AN_HOUR;

    await withDeliverooApi(async () => {
      await postSigned(t, scheduledOrder(orderId, confirmAt));
    });

    const jobs = await readScheduledJobs(t);
    expect(jobs, "nothing was scheduled, so the order would never be confirmed").toHaveLength(1);
    expect(jobs[0]!.name).toBe("deliverooWebhook:confirmScheduledOrder");
    // Deliveroo's own time, not a delay we invented: a confirmation sent early
    // is as wrong as one that never comes.
    expect(Math.abs(jobs[0]!.scheduledTime - confirmAt)).toBeLessThan(5_000);
  });

  it("leaves the order pending until that confirmation runs", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("scheduled");

    await withDeliverooApi(async () => {
      await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
    });

    const [order] = await readOrders(t);
    expect(order!.status).toBe("pending");
  });

  it("sends the ticket to the kitchen now, not at confirm_at", async () => {
    // The food is not made yet, but the pass has to know it is coming — and
    // the ticket is created before the credentials check on purpose, so a
    // scheduled order reaches the kitchen even when Deliveroo is unreachable.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("scheduled");

    await withDeliverooApi(async () => {
      await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
    });

    const tickets = await readKitchenTickets(t);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.source).toBe("deliveroo");
  });

  it("confirms the order with Deliveroo when the scheduled job runs", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("scheduled");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
      const [order] = await readOrders(t);

      // Run the parked job itself rather than waiting half an hour for the
      // scheduler. It is the same action, with the arguments the handler gave
      // it — the scheduling of it is asserted separately above.
      await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
        orderId,
        internalOrderId: order!._id as Id<"orders">,
      });
      return apiCallsExcludingAuth(recorded);
    });

    const confirm = calls.find((c) => JSON.parse(c.body ?? "{}").status === "confirmed");
    expect(confirm, "the scheduled order was never confirmed with Deliveroo").toBeDefined();
    expect(confirm!.method).toBe("PATCH");

    const [order] = await readOrders(t);
    expect(order!.status).toBe("confirmed");
  });

  describe("when Deliveroo is not ready to confirm yet", () => {
    // Measured against Deliveroo's sandbox: `PATCH /v1/orders/{id}` with
    // `confirmed` answers `503 order_not_ready — please retry shortly` while the
    // order is still settling after its acceptance, and an order whose
    // `confirm_at` is already due is confirmed the instant it is accepted. The
    // handler used to log that and stop, so the order was never confirmed.
    const notReady = () =>
      new Response(
        JSON.stringify({
          error: { code: "order_not_ready", message: "retry shortly" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );

    /**
     * Confirmation attempts still waiting to run. A cancelled job stays listed
     * in the table, and the error report a final failure books is another job.
     */
    const pendingJobs = async (t: ReturnType<typeof newHarness>) =>
      (await readScheduledJobs(t)).filter(
        (j) => j.state.kind === "pending" && j.name === "deliverooWebhook:confirmScheduledOrder",
      );

    async function parkedConfirmation(t: ReturnType<typeof newHarness>) {
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");
      await withDeliverooApi(async () => {
        await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
      });
      const [order] = await readOrders(t);
      // Only the retry matters here, not the job the handler parked itself.
      await cancelScheduledJobsOf(t);
      return { orderId, internalOrderId: order!._id as Id<"orders"> };
    }

    it("schedules another attempt instead of giving up on a 503", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
          });
        },
        (call) => (call.method === "PATCH" ? notReady() : new Response("{}", { status: 200 })),
      );

      const [order] = await readOrders(t);
      expect(order!.status).toBe("pending");
      const jobs = await pendingJobs(t);
      expect(jobs, "no retry was booked").toHaveLength(1);
      expect(jobs[0]!.name).toBe("deliverooWebhook:confirmScheduledOrder");
      expect(jobs[0]!.args[0]).toMatchObject({ orderId, attempt: 2 });
      // A short delay, not Deliveroo's half hour: the order is already due.
      expect(jobs[0]!.scheduledTime - Date.now()).toBeLessThan(60_000);
    });

    it("waits longer when Deliveroo answers 429, its rate limit", async () => {
      // « api calls have exceeded the RPS limit, try again later in 1m0s ».
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 2,
          });
        },
        (call) =>
          call.method === "PATCH"
            ? new Response(JSON.stringify({ code: "too_many_requests" }), { status: 429 })
            : new Response("{}", { status: 200 }),
      );

      const jobs = await pendingJobs(t);
      expect(jobs, "a rate-limited confirmation was dropped").toHaveLength(1);
      expect(jobs[0]!.args[0]).toMatchObject({ orderId, attempt: 3 });
      // A minute, not fifteen seconds: sooner would only be refused again.
      expect(jobs[0]!.scheduledTime - Date.now()).toBeGreaterThan(50_000);
    });

    it("confirms on the attempt where Deliveroo is ready", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 3,
          });
        },
        () => new Response(null, { status: 204 }),
      );

      const [order] = await readOrders(t);
      expect(order!.status).toBe("confirmed");
      expect(await pendingJobs(t)).toHaveLength(0);
    });

    it("stops after the last attempt and leaves the order for a human", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 8,
          });
        },
        () => notReady(),
      );

      expect(await pendingJobs(t)).toHaveLength(0);
      const [order] = await readOrders(t);
      expect(order!.status).toBe("pending");
    });

    it("hands the preparation time to the confirmation as its deadline", async () => {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");
      const confirmAt = Date.now() + HALF_AN_HOUR;

      await withDeliverooApi(async () => {
        await postSigned(t, scheduledOrder(orderId, confirmAt));
      });

      const [job] = await pendingJobs(t);
      // `start_preparing_at` is confirm_at + half an hour in the fixture.
      expect(job!.args[0].deadline).toBe(Date.parse(new Date(confirmAt + HALF_AN_HOUR).toISOString()));
    });

    it("keeps trying every ten minutes after the fast attempts while the order is still ahead", async () => {
      // Sandbox: confirm_at two minutes after placement, start_preparing_at a day
      // later, and a 503 for as long as anyone watched.
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 8,
            deadline: Date.now() + 2 * AN_HOUR,
          });
        },
        () => notReady(),
      );

      const jobs = await pendingJobs(t);
      expect(jobs, "gave up while the order was still ahead of its preparation").toHaveLength(1);
      expect(jobs[0]!.args[0]).toMatchObject({ orderId, attempt: 9 });
      expect(jobs[0]!.scheduledTime - Date.now()).toBeGreaterThan(9 * 60_000);
    });

    it("stops once the preparation time is too close for another attempt", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 8,
            deadline: Date.now() + 5 * 60_000,
          });
        },
        () => notReady(),
      );

      expect(await pendingJobs(t)).toHaveLength(0);
    });

    it("does not retry an answer that will not change", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
          });
        },
        () => new Response("bad request", { status: 400 }),
      );

      expect(await pendingJobs(t)).toHaveLength(0);
    });

    it("tries again on a 409, because the acceptance may still be on its way", async () => {
      // The acceptance is retried on its own schedule and the confirmation can run
      // first; Deliveroo then answers 409 invalid_status_transition.
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 2,
          });
        },
        () => new Response("conflict", { status: 409 }),
      );

      const jobs = await pendingJobs(t);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.args[0]).toMatchObject({ orderId, attempt: 3 });
    });

    it("stops retrying a 409 after the fast attempts", async () => {
      const t = newHarness();
      const { orderId, internalOrderId } = await parkedConfirmation(t);

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.confirmScheduledOrder, {
            orderId,
            internalOrderId,
            attempt: 8,
            deadline: Date.now() + 24 * 60 * 60_000,
          });
        },
        () => new Response("conflict", { status: 409 }),
      );

      expect(await pendingJobs(t)).toHaveLength(0);
    });
  });

  describe("when Deliveroo is not ready to accept yet", () => {
    // Seen against the sandbox: `order.new` is delivered before Deliveroo takes
    // a status change on the order, so the immediate acceptance answers
    // `503 order_not_ready`. It used to be logged and dropped, and an order that
    // was never accepted could not be confirmed later either.
    const refuse = (status: number) => () =>
      new Response(JSON.stringify({ error: { code: "order_not_ready" } }), { status });

    const pendingAccepts = async (t: ReturnType<typeof newHarness>) =>
      (await readScheduledJobs(t)).filter(
        (j) => j.state.kind === "pending" && j.name === "deliverooWebhook:retryAcceptOrder",
      );

    it("books another acceptance when the first one is answered 503", async () => {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");

      await withDeliverooApi(
        async () => {
          await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
        },
        (call) => (call.method === "PATCH" ? refuse(503)() : new Response("{}", { status: 200 })),
      );

      const retries = await pendingAccepts(t);
      expect(retries, "the failed acceptance was dropped").toHaveLength(1);
      expect(retries[0]!.args[0]).toMatchObject({ orderId, attempt: 2 });
      // The confirmation is still parked for confirm_at.
      const confirmations = (await readScheduledJobs(t)).filter(
        (j) => j.name === "deliverooWebhook:confirmScheduledOrder",
      );
      expect(confirmations).toHaveLength(1);
    });

    it("books nothing for an acceptance Deliveroo refused for good", async () => {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");

      await withDeliverooApi(
        async () => {
          await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
        },
        (call) => (call.method === "PATCH" ? refuse(409)() : new Response("{}", { status: 200 })),
      );

      expect(await pendingAccepts(t)).toHaveLength(0);
    });

    it("treats « already accepted » (409) on a retry as done, not as an error", async () => {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.retryAcceptOrder, { orderId, attempt: 2 });
        },
        () =>
          new Response(
            JSON.stringify({ error: { code: "invalid_status_transition" } }),
            { status: 409 },
          ),
      );

      expect(await pendingAccepts(t)).toHaveLength(0);
      // No error report was booked either: nothing went wrong.
      expect((await readScheduledJobs(t)).filter((j) => j.state.kind === "pending")).toHaveLength(0);
    });

    it("waits a minute after a 429 and gives up after the eighth attempt", async () => {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);
      const orderId = generateOrderId("scheduled");

      await withDeliverooApi(
        async () => {
          await t.action(internal.deliverooWebhook.retryAcceptOrder, { orderId, attempt: 2 });
        },
        () => refuse(429)(),
      );
      const [next] = await pendingAccepts(t);
      expect(next!.args[0]).toMatchObject({ orderId, attempt: 3 });
      expect(next!.scheduledTime - Date.now()).toBeGreaterThan(50_000);
      await cancelScheduledJobsOf(t);

      const last = newHarness();
      await seedStoreWithDeliveroo(last);
      await withDeliverooApi(
        async () => {
          await last.action(internal.deliverooWebhook.retryAcceptOrder, { orderId, attempt: 8 });
        },
        () => refuse(503)(),
      );
      expect(await pendingAccepts(last)).toHaveLength(0);
    });
  });

  it("rejects the order instead of accepting it when the store is on auto_reject", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t, { orderMode: "auto_reject" });
    const orderId = generateOrderId("scheduled");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, scheduledOrder(orderId, Date.now() + HALF_AN_HOUR));
      return apiCallsExcludingAuth(recorded);
    });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toMatchObject({ status: "rejected" });
    // Nothing to confirm later: the order was refused.
    expect(await readScheduledJobs(t)).toHaveLength(0);
  });
});
