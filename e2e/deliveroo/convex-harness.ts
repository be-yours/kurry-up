/**
 * The Convex harness the Deliveroo scenario suites run against.
 *
 * WHY THIS FILE EXISTS
 *
 * Every suite in this directory used to build a fixture with the helpers in
 * `test-config.ts` and then assert on that same fixture:
 *
 *     const webhook = createNewOrderWebhook({ fulfillment_type: "restaurant" })
 *     expect(webhook.body.order.fulfillment_type).toBe("restaurant")
 *
 * That reads `createNewOrderWebhook` back to itself. It cannot fail, it touches
 * no product code, and 188 blocks across the two apps were shaped exactly like
 * it — which is how eleven Deliveroo defects survived five green CI runs.
 *
 * The fixtures were never the problem: they encode real payload shapes from
 * Deliveroo's API docs — meal cards, offer discounts, scheduled orders,
 * remakes, missing PLUs. What was missing was a receiver. This file is that
 * receiver: `convex-test` mounts the app's real Convex backend, and
 * `postSigned()` sends a fixture at the real HTTP route with a real Deliveroo
 * HMAC, so a suite can assert on what the handler WROTE rather than on what
 * the test itself passed in.
 *
 * The live blocks in scenarios 2 and 8 that posted at a DEPLOYED backend are
 * gone (#635): they sat behind `it.runIf(hasWebhookTarget)`, nothing ever set
 * that variable, and they skipped on every run. Everything here runs against
 * `convexTest`, which needs no deployment and no credential.
 */

import { convexTest } from "convex-test";
import { deliveroo } from "@be-yours/integrations";
// Loaded for its side effect: the webhook handler reaches this module through
// `await import("@be-yours/core/env")` inside the request, and on a cold
// module graph that dynamic import has been observed resolving to a namespace
// whose exports were not yet bound — `getPackageEnv is not a function`, a 500,
// and an assertion failing for a reason that has nothing to do with the
// subject. Importing it statically here settles it before any test runs.
import "@be-yours/core/env";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { config } from "./test-config";

// `import.meta.glob` is Vite's, and it is the supported way to hand
// `convex-test` the module graph. `vite/client` cannot be referenced here the
// way the suites under `tests/` reference it: pnpm keeps vite in the store,
// off this app's type-resolution path, and unlike `tests/` this directory IS
// type-checked by `tsc --noEmit`. So the single member used is declared.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../../convex/**/*.ts");

// ============================================================================
// Constants
// ============================================================================

/** A fixed clock for seeded rows, so nothing in an assertion depends on today. */
export const NOW = 1_700_000_000_000;

/**
 * The signing secret these suites configure and sign with.
 *
 * Deliberately not read from the environment: a suite that signed with
 * whatever `DELIVEROO_WEBHOOK_SECRET` happened to hold would pass locally and
 * do nothing in CI, which is the failure mode this whole directory is being
 * dug out of.
 */
export const WEBHOOK_SECRET = "test-deliveroo-webhook-secret";

/** The `X-Deliveroo-Sequence-Guid` every signed request below carries. */
export const SEQUENCE_GUID = "4f1c1b7e-6a2b-4f4e-9a3a-2f6f0f9a1b2c";

/** Sandbox client credentials, for the suites that exercise the API dialogue. */
export const CLIENT_ID = "test-deliveroo-client-id";
export const CLIENT_SECRET = "test-deliveroo-client-secret";

// ============================================================================
// Environment
// ============================================================================

/**
 * Configure the platform environment for a suite. Call once, from `beforeAll`.
 *
 * `@be-yours/core/env` parses `process.env` on first use and caches the
 * result, so this must not be flipped mid-file — hence one call per suite and
 * an explicit choice about the API credentials.
 *
 * `OPENAI_API_KEY` is not optional here despite having nothing to do with
 * Deliveroo: the same schema validates it, and without it the handler fails
 * during the env parse — 503, no signature check, no processing — and a
 * response-policy assertion then passes on a lie.
 *
 * @param options.withApiCredentials
 *   `true` puts sandbox client credentials in the environment, so the handler
 *   takes the branches that talk back to Deliveroo (accept, confirm, sync
 *   status). Those suites must also wrap the request in `withDeliverooApi()`,
 *   or the client will try to reach the real sandbox.
 *   `false` (the default) leaves them unset, which is the "kitchen first"
 *   path: the order and its ticket must land whether or not we can answer
 *   Deliveroo.
 */
export function configureDeliverooEnv(
  options: { withApiCredentials?: boolean } = {},
): void {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.DELIVEROO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  // Explicit, so the "non définie — bascule en SANDBOX" warning does not
  // appear in every suite's output as if something were misconfigured.
  process.env.DELIVEROO_IS_SANDBOX = "true";

  if (options.withApiCredentials) {
    process.env.DELIVEROO_CLIENT_ID = CLIENT_ID;
    process.env.DELIVEROO_CLIENT_SECRET = CLIENT_SECRET;
  } else {
    delete process.env.DELIVEROO_CLIENT_ID;
    delete process.env.DELIVEROO_CLIENT_SECRET;
  }
}

// ============================================================================
// Harness
// ============================================================================

/**
 * A `convex-test` instance running this app's real schema and functions.
 *
 * Inferred from the call rather than written out. `convex-test` returns a type
 * parameterised by the whole schema, and naming it — `TestConvex<typeof
 * schema>` or `ReturnType<typeof convexTest<typeof schema>>` — makes `tsc`
 * widen it to the generic instantiation and then report every helper below as
 * taking an incompatible harness. Unlike the suites under `tests/`, this
 * directory IS in the type-check, so the type has to stay inferred.
 */
function createHarness() {
  return convexTest(schema, modules);
}

export type Harness = ReturnType<typeof createHarness>;

const harnesses: Harness[] = [];

/** Start a backend for one test. Register it so `afterEach` can drain it. */
export function newHarness(): Harness {
  const t = createHarness();
  harnesses.push(t);
  return t;
}

/**
 * Cancel whatever one harness left on the scheduler, and leave the registry alone.
 *
 * A test that cancels midway needs this one: the retries it books afterwards
 * still have to be found by `afterEach`. A scheduled order parks a
 * `confirmScheduledOrder` job up to half an hour out; left pending, `convex-test`
 * keeps the backend alive and the run hangs at the end of the file.
 */
export async function cancelScheduledJobsOf(t: Harness): Promise<void> {
  // A job already running writes its own result to `_scheduled_functions` when it
  // ends. Cancelling it, or ending the test under it, makes that write land after
  // the transaction is gone ("Write outside of transaction"), which vitest reports
  // as an unhandled error against whichever file is running. Let it finish first.
  for (let attempt = 0; attempt < 100; attempt++) {
    const running = await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.some((job) => job.state.kind === "inProgress");
    });
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await t.run(async (ctx) => {
    const pending = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of pending) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

/** Drain every harness the test started, then forget them. Call from `afterEach`. */
export async function cancelPendingScheduledJobs(): Promise<void> {
  for (const t of harnesses) await cancelScheduledJobsOf(t);
  harnesses.length = 0;
}

// ============================================================================
// Seeds
// ============================================================================

/** An open établissement, in French because that is what the data looks like. */
export async function seedStore(t: Harness, name = "Chez Luigi"): Promise<Id<"stores">> {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      address: {
        street: "12 rue de la Paix",
        city: "Marseille",
        postalCode: "13001",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

/**
 * The Deliveroo integration an order is routed by.
 *
 * `platformStoreId` defaults to `config.SITE_ID`, which is the same value the
 * fixture builders put in `location_id` — so a fixture posted at this harness
 * routes to this store, and overriding `DELIVEROO_SITE_ID` moves both together.
 */
export async function seedDeliverooIntegration(
  t: Harness,
  storeId: Id<"stores">,
  options: {
    platformStoreId?: string;
    orderMode?: "auto_accept" | "auto_reject" | "manual";
    brandId?: string;
    enabled?: boolean;
  } = {},
): Promise<Id<"storeIntegrations">> {
  return t.run((ctx) =>
    ctx.db.insert("storeIntegrations", {
      storeId,
      platform: "deliveroo" as const,
      platformStoreId: options.platformStoreId ?? config.SITE_ID,
      syncMenu: false,
      autoAccept: false,
      // Manual by default: the staff decides on the KDS, which is the screen a
      // Deliveroo order has to reach at all.
      orderMode: options.orderMode ?? ("manual" as const),
      brandId: options.brandId,
      enabled: options.enabled ?? true,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

/** A store with a Deliveroo integration, which is what most tests want. */
export async function seedStoreWithDeliveroo(
  t: Harness,
  options: Parameters<typeof seedDeliverooIntegration>[2] = {},
): Promise<Id<"stores">> {
  const storeId = await seedStore(t);
  await seedDeliverooIntegration(t, storeId, options);
  return storeId;
}

// ============================================================================
// Signed requests
// ============================================================================

/**
 * HMAC-SHA256 over `sequence_guid + " " + raw body`, hex — how Deliveroo signs.
 *
 * Web Crypto rather than `node:crypto`, because these suites run under
 * `edge-runtime` (the environment a Convex HTTP action actually executes in).
 * `createSignature()` in `test-config.ts` is the Node-side twin, and
 * `webhook-signing.test.ts` pins the two to the same digest.
 */
export async function signBody(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${SEQUENCE_GUID} ${body}`),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST a payload at the real route with a real signature.
 *
 * Defaults to `/webhooks/deliveroo/order`, the path the live suites and the
 * Developer Portal use — the generic `/webhooks/deliveroo` is covered by
 * `tests/convex/deliveroo-webhook.test.ts`, so between them all three routes
 * registered in `convex/http.ts` are exercised.
 *
 * Takes a string, not an object: the bytes that get signed have to be the
 * bytes that get sent, and re-serializing between the two is how a signature
 * silently stops matching.
 */
export async function postSigned(
  t: Harness,
  body: string,
  path: string = config.ORDER_WEBHOOK_PATH,
): Promise<Response> {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-deliveroo-hmac-sha256": await signBody(body),
      "x-deliveroo-sequence-guid": SEQUENCE_GUID,
    },
    body,
  });
}

/** The same POST with whatever headers the caller wants — or none. */
export async function postRaw(
  t: Harness,
  body: string,
  headers: Record<string, string>,
  path: string = config.ORDER_WEBHOOK_PATH,
): Promise<Response> {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// ============================================================================
// Reading back what the handler wrote
// ============================================================================

export async function readOrders(t: Harness) {
  return t.run((ctx) => ctx.db.query("orders").collect());
}

export async function readKitchenTickets(t: Harness) {
  return t.run((ctx) => ctx.db.query("kitchenTickets").collect());
}

export async function readIntegrations(t: Harness) {
  return t.run((ctx) => ctx.db.query("storeIntegrations").collect());
}

/** The dead-letter table an unroutable or refused event is kept in. */
export async function readWebhookFailures(t: Harness) {
  return t.run((ctx) => ctx.db.query("platformWebhookFailures").collect());
}

/** Pending scheduler jobs, for the scheduled-order path. */
export async function readScheduledJobs(t: Harness) {
  return t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

// ============================================================================
// The Deliveroo API side
// ============================================================================

/** One outbound request the product made to Deliveroo. */
export interface DeliverooApiCall {
  url: string;
  method: string;
  body?: string;
}

/**
 * Run `body` with the Deliveroo API replaced by a recorder.
 *
 * The handler's accept / confirm / sync-status calls are the half of the
 * contract Deliveroo certifies against, and a test that let them reach the
 * network would be slow, flaky and dependent on somebody's sandbox. Swapping
 * global fetch keeps the whole client — OAuth, retries, URL building, the
 * `sync_status` body — inside the assertion, and hands back exactly what the
 * product sent.
 *
 * The client caches tokens in a module-level map, so the cache is cleared on
 * both sides: a token minted here must not leak into another test, and no
 * earlier token may satisfy this one.
 *
 * @param respond optional per-call response; defaults to 200 `{"ok":true}`
 */
export async function withDeliverooApi<T>(
  run: (calls: DeliverooApiCall[]) => Promise<T>,
  respond?: (call: DeliverooApiCall) => Response,
): Promise<T> {
  const calls: DeliverooApiCall[] = [];
  const realFetch = globalThis.fetch;
  deliveroo.clearTokenCache();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: DeliverooApiCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);

    if (call.url.includes("/oauth2/token")) {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return (
      respond?.(call) ??
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
    deliveroo.clearTokenCache();
  }
}

/** The calls that are not the OAuth handshake — i.e. the ones with meaning. */
export function apiCallsExcludingAuth(calls: DeliverooApiCall[]): DeliverooApiCall[] {
  return calls.filter((c) => !c.url.includes("/oauth2/token"));
}
