// @vitest-environment edge-runtime

/**
 * Deliveroo Menu API - Scenario 1: Fetch Brand ID
 *
 * The brand and site identifiers, and what the platform does with them: mint a
 * token, address a path, route a menu webhook to the right établissement.
 *
 * FIVE BLOCKS CALLED THE DELIVEROO SANDBOX FOR REAL, and they are gone (#635).
 * They were gated on `it.runIf(hasDeliverooSandbox)` — real OAuth credentials
 * against Deliveroo's own API — which nobody has wired up, so they skipped on
 * every run this repository has ever made. Everything remaining runs everywhere,
 * against either the real client with `fetch` replaced, or the real Convex route
 * with `convex-test`.
 *
 * Two blocks used to assert on nothing at all: one checked that
 * `config.SITE_ID` was a non-empty string, the other declared an inline
 * `if (!id) throw` and then asserted that it threw. Both are replaced below by
 * the product code they were named after — `validatePathParam` from the
 * Deliveroo client, and the menu webhook route itself.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { deliveroo } from "@be-yours/integrations";

const { fetchDeliveroo, getAccessToken, clearTokenCache, validatePathParam } = deliveroo;
type DeliverooCredentials = Parameters<typeof getAccessToken>[0];
import { config, log } from "../test-config";
import {
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readIntegrations,
  seedStore,
  seedDeliverooIntegration,
} from "../convex-harness";

// ============================================================================
// Credentials for sandbox
// ============================================================================

const credentials: DeliverooCredentials = {
  clientId: config.CLIENT_ID,
  clientSecret: config.CLIENT_SECRET,
  sandboxMode: config.IS_SANDBOX,
};


// ============================================================================
// Fetch mocking
// ============================================================================

/** Build a JSON Response the way the Deliveroo API would. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Run `body` with global fetch replaced by `handler`.
 *
 * The client caches tokens in a module-level Map, so the cache is cleared on
 * both sides: a token minted here must not leak into the live suites above,
 * and a live token must not satisfy the mocked ones.
 */
async function withMockedFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  clearTokenCache();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    clearTokenCache();
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Deliveroo Menu - Scenario 1: Fetch Brand ID", () => {
  // A result that succeeds books the availability push; leave nothing on the scheduler.
  afterEach(cancelPendingScheduledJobs);

  beforeAll(() => {
    configureDeliverooEnv();
    log.info("Starting Fetch Brand ID Test Suite");
    log.info(`Sandbox Mode: ${config.IS_SANDBOX}`);
    log.info(`Site ID: ${config.SITE_ID}`);
    log.info(`Brand ID (configured): ${config.BRAND_ID}`);
  });

  // ========================================================================
  // Test 1: OAuth Token Retrieval
  // ========================================================================

  // ========================================================================
  // Test 2: Fetch Brand ID via Site API
  // ========================================================================

  // ========================================================================
  // Test 3: Brand ID Format Validation
  // ========================================================================

  // ========================================================================
  // Test 4: Consistent Token for Same Credentials
  // ========================================================================

  // ========================================================================
  // Test 5: The site location id is what routes a menu webhook
  // ========================================================================

  /**
   * The body Deliveroo sends once it has finished processing an upload:
   * `{ event: "menu.upload_result", body: { menu_upload_result: {...} } }`.
   * It names EVERY site the menu was published to, and carries no top-level
   * `site_id` or `brand_id`.
   */
  const menuUploadResult = (
    result: {
      http_status?: number;
      brand_id?: string;
      menu_id?: string;
      site_ids: string[];
      errors?: Record<string, unknown>;
    },
  ) =>
    JSON.stringify({
      event: "menu.upload_result",
      body: {
        menu_upload_result: {
          http_status: 200,
          brand_id: "brand-under-test",
          menu_id: "menu-under-test",
          ...result,
        },
      },
    });

  it("routes a menu upload result to the établissement holding that site id", async () => {
    log.test("Test 5: Routing a menu.upload_result by site location id");

    // What the site id is FOR. `menu.upload_result` lists it in `site_ids`, the
    // handler matches it against `storeIntegrations.platformStoreId`, and the
    // result is the sync status the admin screen reads.
    const t = newHarness();
    const ours = await seedStore(t, "Chez Luigi");
    const theirs = await seedStore(t, "Chez Amina");
    await seedDeliverooIntegration(t, ours, { platformStoreId: config.SITE_ID });
    await seedDeliverooIntegration(t, theirs, { platformStoreId: "another-site" });

    const response = await postSigned(
      t,
      menuUploadResult({ site_ids: [config.SITE_ID] }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const integrations = await readIntegrations(t);
    const mine = integrations.find((i) => i.storeId === ours);
    const other = integrations.find((i) => i.storeId === theirs);
    expect(mine!.menuSyncStatus).toBe("success");
    // The neighbour's menu status is not ours to touch.
    expect(other!.menuSyncStatus).toBeUndefined();

    log.success("Menu upload result routed by site location id");
  });

  it("applies one upload result to every site it names", async () => {
    const t = newHarness();
    const first = await seedStore(t, "Chez Luigi");
    const second = await seedStore(t, "Chez Amina");
    const bystander = await seedStore(t, "Chez Bob");
    await seedDeliverooIntegration(t, first, { platformStoreId: "site-a" });
    await seedDeliverooIntegration(t, second, { platformStoreId: "site-b" });
    await seedDeliverooIntegration(t, bystander, { platformStoreId: "site-c" });

    const response = await postSigned(
      t,
      menuUploadResult({ site_ids: ["site-a", "site-b"] }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const integrations = await readIntegrations(t);
    expect(integrations.find((i) => i.storeId === first)!.menuSyncStatus).toBe("success");
    expect(integrations.find((i) => i.storeId === second)!.menuSyncStatus).toBe("success");
    expect(integrations.find((i) => i.storeId === bystander)!.menuSyncStatus).toBeUndefined();
  });

  it("reports a failed menu upload against the same site", async () => {
    log.test("Test 5b: Recording a failed menu upload");

    const t = newHarness();
    const storeId = await seedStore(t);
    await seedDeliverooIntegration(t, storeId, { platformStoreId: config.SITE_ID });

    const response = await postSigned(
      t,
      menuUploadResult({
        site_ids: [config.SITE_ID],
        errors: { processing: "item 12 has no price" },
      }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const [integration] = await readIntegrations(t);
    expect(integration!.menuSyncStatus).toBe("error");
    // The reason has to survive: "sync failed" with no cause is unactionable.
    expect(integration!.menuSyncError).toBe("item 12 has no price");

    log.success("Menu upload failure recorded with its reason");
  });

  it("treats a non-2xx http_status as a failed upload even with no message", async () => {
    const t = newHarness();
    const storeId = await seedStore(t);
    await seedDeliverooIntegration(t, storeId, { platformStoreId: config.SITE_ID });

    const response = await postSigned(
      t,
      menuUploadResult({ http_status: 422, site_ids: [config.SITE_ID] }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const [integration] = await readIntegrations(t);
    expect(integration!.menuSyncStatus).toBe("error");
    expect(integration!.menuSyncError).toContain("422");
  });

  it("does not fail an upload for an unreachable image, and says so", async () => {
    // Image and barcode lists are advisory: the menu is live without them.
    const t = newHarness();
    const storeId = await seedStore(t);
    await seedDeliverooIntegration(t, storeId, { platformStoreId: config.SITE_ID });

    const response = await postSigned(
      t,
      menuUploadResult({
        site_ids: [config.SITE_ID],
        errors: { images: [{ url: "https://x/y.jpg", message: "unreachable" }] },
      }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const [integration] = await readIntegrations(t);
    expect(integration!.menuSyncStatus).toBe("success");
  });

  it("acknowledges a result for a site we do not hold instead of asking for a retry", async () => {
    // The integration row exists before any menu is pushed, so a retry would
    // be answered the same way for thirty minutes.
    const t = newHarness();
    const storeId = await seedStore(t);
    await seedDeliverooIntegration(t, storeId, { platformStoreId: config.SITE_ID });

    const response = await postSigned(
      t,
      menuUploadResult({ site_ids: ["a-site-nobody-registered"] }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const [integration] = await readIntegrations(t);
    expect(integration!.menuSyncStatus).toBeUndefined();
  });

  it("acknowledges the event names Deliveroo does not send, and changes nothing", async () => {
    // `menu.upload_completed` / `menu.upload_failed` were this handler's
    // vocabulary; Deliveroo never spoke it.
    const t = newHarness();
    const storeId = await seedStore(t);
    await seedDeliverooIntegration(t, storeId, { platformStoreId: config.SITE_ID });

    const response = await postSigned(
      t,
      JSON.stringify({ event: "menu.upload_completed", site_id: config.SITE_ID, brand_id: "b" }),
      config.MENU_WEBHOOK_PATH,
    );
    expect(response.status).toBe(200);

    const [integration] = await readIntegrations(t);
    expect(integration!.menuSyncStatus).toBeUndefined();
  });

  // ========================================================================
  // Test 6: Error Handling for Invalid Credentials
  // ========================================================================

  it("should fail gracefully for invalid credentials", async () => {
    log.test("Test 6: Testing error handling for invalid credentials");

    // Deliveroo answers 401 to a bad client id or secret. Asserted against a
    // 401 we serve, not against the real endpoint: unconfigured, this block
    // used to pass because the request failed to leave the machine, which is
    // the same green whether the client handles a rejection or not.
    const invalidCredentials: DeliverooCredentials = {
      clientId: "invalid-client-id",
      clientSecret: "invalid-client-secret",
      sandboxMode: config.IS_SANDBOX,
    };

    await withMockedFetch(
      () => new Response("invalid_client", { status: 401 }),
      async () => {
        const error = await getAccessToken(invalidCredentials).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(Error);
        const integrationError = error as Error & { statusCode?: number };
        expect(integrationError.name).toBe("IntegrationError");
        expect(integrationError.statusCode).toBe(401);
        // The secret must not travel in the message: this is logged.
        expect(integrationError.message).not.toContain("invalid-client-secret");
      },
    );

    log.success("Invalid credentials error handling validated");
    log.info("  OAuth token request correctly rejected");
  }, 15000);

  // ========================================================================
  // Test 7: API Types Distinction
  // ========================================================================

});

describe("Deliveroo Menu - Brand ID Error Handling", () => {
  // ========================================================================
  // Test 1: Invalid Brand ID Format
  // ========================================================================

  it("should reject invalid brand ID format", async () => {
    log.test("Error Test 1: Invalid brand ID format");

    // `validatePathParam` is the guard the client puts every id through before
    // it reaches a URL — path traversal and SSRF, in one place. This block
    // used to declare its own `if (!id) throw` inline and then assert that its
    // own throw had thrown, which said nothing about the guard.
    for (const invalidId of ["../etc/passwd", "brand/../../../secret", "brand id", "b%2f"]) {
      expect(
        () => validatePathParam(invalidId, "brandId"),
        `"${invalidId}" must not reach a URL`,
      ).toThrow(/invalid characters/);
    }

    expect(() => validatePathParam("", "brandId")).toThrow(/non-empty string/);

    // And a real brand id still passes, so the guard is not simply refusing
    // everything.
    expect(validatePathParam("4c2b1a3e-1111-2222-3333-444455556666", "brandId")).toBe(
      "4c2b1a3e-1111-2222-3333-444455556666",
    );

    log.success("Invalid brand ID formats rejected by the client guard");
  });

  // ========================================================================
  // Test 2: Handle 401 Unauthorized
  // ========================================================================

  it("should retry once with a fresh token when the API answers 401", async () => {
    log.test("Error Test 2: Handling 401 Unauthorized");

    // Deliveroo's gateway answers 401/403 for an expired token. The client is
    // expected to drop the cached token, mint a new one and replay the request
    // exactly once — so a stale token must not surface as a failed call.
    const calls: Array<{ url: string; auth?: string }> = [];
    let tokensIssued = 0;

    await withMockedFetch(
      (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url, auth: headers.Authorization });

        if (url.endsWith("/oauth2/token")) {
          tokensIssued += 1;
          return jsonResponse(
            { access_token: `token-${tokensIssued}`, token_type: "Bearer", expires_in: 3600 },
            200,
          );
        }

        const apiCalls = calls.filter((c) => !c.url.endsWith("/oauth2/token"));
        return apiCalls.length === 1
          ? new Response("token expired", { status: 401 })
          : jsonResponse({ ok: true }, 200);
      },
      async () => {
        const response = await fetchDeliveroo(
          credentials,
          "/v1/brands/brand-1/sites/site-1/status",
          { method: "GET" },
          "site",
        );

        expect(response.status).toBe(200);
      },
    );

    const apiCalls = calls.filter((c) => !c.url.endsWith("/oauth2/token"));
    expect(tokensIssued).toBe(2);
    // Exactly one replay, and it must carry the new token, not the rejected one.
    expect(apiCalls.map((c) => c.auth)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);

    log.success("401 triggers exactly one retry with a refreshed token");
  });

  // ========================================================================
  // Test 3: Handle 404 Not Found
  // ========================================================================

  it("should hand a 404 back to the caller without retrying it", async () => {
    log.test("Error Test 3: Handling 404 Not Found");

    // REWRITTEN. The previous version called the real sandbox inside a
    // try/catch whose catch asserted `expect(error).toBeDefined()` — so it
    // passed when the site existed, when it did not, and when the request
    // never left the machine. It could not fail.
    //
    // What actually matters about a 404: the site is not there, no number of
    // retries will conjure it, and a fresh token would not help either. So it
    // is one attempt, one token, and the response handed straight back.
    const calls: string[] = [];

    await withMockedFetch(
      (url) => {
        calls.push(url);
        return url.endsWith("/oauth2/token")
          ? jsonResponse({ access_token: "token-1", token_type: "Bearer", expires_in: 3600 }, 200)
          : new Response("site not found", { status: 404 });
      },
      async () => {
        const response = await fetchDeliveroo(
          credentials,
          "/v1/brands/brand-1/sites/nonexistent-site-404/status",
          { method: "GET" },
          "site",
        );

        expect(response.status).toBe(404);
        expect(await response.text()).toBe("site not found");
      },
    );

    expect(calls.filter((u) => !u.endsWith("/oauth2/token"))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith("/oauth2/token"))).toHaveLength(1);

    log.success("404 handed back on one attempt, with one token");
  }, 15000);

  // ========================================================================
  // Test 4: Handle 500 Server Error
  // ========================================================================

  it("should back off on a 500, a bounded number of times, without re-minting the token", async () => {
    log.test("Error Test 4: Handling 500 Server Error");

    // REWRITTEN. This test used to assert exactly one attempt — "surface 500
    // without retrying". That blessed the defect: Deliveroo documents
    // 500/502/503/504 as "server error on Deliveroo's side — retry after
    // backoff", and this is an idempotent GET, so replaying it is safe. The
    // client had no backoff at all, so one transient 500 failed a menu push
    // outright.
    //
    // What the old test was really protecting still holds, and is asserted
    // below: a 500 is NOT a stale token. The token refresh stays gated on
    // 401/403, so the whole sequence mints exactly one token, and the body is
    // handed back untouched once the attempts run out — the caller decides
    // what a persistent 500 means.
    //
    // Fake timers: the real delays are hundreds of milliseconds of deliberate
    // sleep, and a suite that actually waits them out is a suite that times out.
    const calls: string[] = [];

    vi.useFakeTimers();
    try {
      await withMockedFetch(
        (url) => {
          calls.push(url);
          return url.endsWith("/oauth2/token")
            ? jsonResponse({ access_token: "token-1", token_type: "Bearer", expires_in: 3600 }, 200)
            : new Response("upstream exploded", { status: 500 });
        },
        async () => {
          const pending = fetchDeliveroo(
            credentials,
            "/v1/brands/brand-1/sites/site-1/status",
            { method: "GET" },
            "site",
          );

          await vi.runAllTimersAsync();
          const response = await pending;

          expect(response.status).toBe(500);
          expect(await response.text()).toBe("upstream exploded");
        },
      );
    } finally {
      vi.useRealTimers();
    }

    const apiCalls = calls.filter((u) => !u.endsWith("/oauth2/token"));
    const tokenCalls = calls.filter((u) => u.endsWith("/oauth2/token"));

    // Bounded, so a platform outage costs three requests and not a loop.
    expect(apiCalls).toHaveLength(3);
    // The original point of this test: no fresh token burnt on a 500.
    expect(tokenCalls).toHaveLength(1);

    log.success("500 is retried with backoff, bounded, and on one token");
  });

  it("should raise an IntegrationError when the OAuth endpoint fails", async () => {
    log.test("Error Test 5: OAuth endpoint failure");

    // A failing token endpoint must not leak as a bare fetch error: the client
    // wraps it so callers can read the status and the platform.
    await withMockedFetch(
      () => new Response("service unavailable", { status: 500 }),
      async () => {
        const error = await getAccessToken(credentials).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(Error);
        const integrationError = error as Error & {
          statusCode?: number;
          platform?: string;
        };
        expect(integrationError.name).toBe("IntegrationError");
        expect(integrationError.message).toBe("Deliveroo OAuth failed");
        expect(integrationError.statusCode).toBe(500);
        expect(integrationError.platform).toBe("deliveroo");
      },
    );

    log.success("OAuth failure surfaces as IntegrationError");
  });
});
