// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A backend error reaching somebody who can act on it.
 *
 * Until this existed, it did not. The only trace of a failure inside a Convex
 * function was one of 112 `console.error` calls in `apps/reference/convex`, and
 * a Convex log line lands in the dashboard of ONE client's deployment. With one
 * deployment per client, a Saturday-night order that failed in a webhook was
 * seen by nobody at BeYours, and finding it meant opening each client's console
 * in turn — while the maintenance contract sells support.
 *
 * What is asserted here is the property, not the plumbing: an error that occurs
 * inside a Convex function ends up as an HTTP request to Sentry's ingestion
 * endpoint, correctly addressed and with the credentials stripped out of it.
 * `packages/core/src/sentry/__tests__/envelope.test.ts` proves the wire format
 * in isolation; this proves it is actually reached from the runtime that has
 * the errors.
 *
 * The reporter is also the one piece of code that must never fail: it runs
 * inside `catch` blocks, and an exception raised there would replace the
 * original fault with its own. Half of this file is about that.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { _resetEnvCache } from "@be-yours/core/env"
import { internal } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const DSN = "https://publickey123@o42.ingest.sentry.io/4505"
const ENVELOPE_URL = "https://o42.ingest.sentry.io/api/4505/envelope/"

const harnesses: ReturnType<typeof convexTest>[] = []
function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/** One recorded ingest request, already split into its three envelope lines. */
interface CapturedEnvelope {
  url: string
  authHeader: string
  contentType: string
  header: Record<string, unknown>
  itemHeader: Record<string, unknown>
  event: {
    event_id: string
    timestamp: number
    level: string
    environment: string
    logger: string
    tags: Record<string, string>
    extra?: Record<string, unknown>
    exception: { values: Array<{ type: string; value: string; stacktrace?: unknown }> }
  }
}

const captured: CapturedEnvelope[] = []

/**
 * Runs the reports the handlers scheduled.
 *
 * `captureBackendError` uses `ctx.scheduler.runAfter(0, …)` so a webhook
 * answers its provider before Sentry answers us — which means that at the
 * moment the handler returns, nothing has been sent yet and the job is
 * `pending`.
 *
 * Both halves below are load-bearing, and neither alone works. `convex-test`
 * starts a scheduled job from a REAL `setTimeout(…, 0)` registered when the job
 * was inserted, so one macrotask tick is what moves it from `pending` to
 * `inProgress`; `finishInProgressScheduledFunctions` then waits for it to
 * finish. The fake-timer form used in `store-deletion.test.ts` cannot help
 * here — `vi.useFakeTimers()` installed after the handler ran does not own a
 * timer that was already registered, so `vi.runAllTimers()` advances nothing
 * and the queue reads as empty. Written out because the failure is a silent
 * one: the assertions simply see zero reports and look like a broken reporter.
 */
async function drainReports(t: ReturnType<typeof convexTest>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await t.finishInProgressScheduledFunctions()
}

beforeEach(() => {
  captured.length = 0
  // `getPackageEnv()` parses once and caches for the life of the module, so a
  // test that changes a package variable is invisible to the next one unless
  // the cache is dropped. Two suites here turn OPENAI_API_KEY on and off.
  _resetEnvCache()
  vi.stubEnv("SENTRY_DSN", DSN)
  vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "production")

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const [header, itemHeader, event] = String(init?.body ?? "").split("\n")
      captured.push({
        url: String(input),
        authHeader: headers.get("X-Sentry-Auth") ?? "",
        contentType: headers.get("Content-Type") ?? "",
        header: JSON.parse(header ?? "{}") as Record<string, unknown>,
        itemHeader: JSON.parse(itemHeader ?? "{}") as Record<string, unknown>,
        event: JSON.parse(event ?? "{}") as CapturedEnvelope["event"],
      })
      return new Response("{}", { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  _resetEnvCache()
  harnesses.length = 0
})

describe("an error becomes a request to Sentry", () => {
  test("the envelope is addressed and authenticated from the DSN", async () => {
    const t = newHarness()

    const outcome = await t.action(internal.errorReporting.reportError, {
      source: "stripeWebhook",
      name: "Error",
      message: "Stripe returned 502 for payment_intent.succeeded",
      stack: "Error: boom\n    at handleWebhook (convex/stripeWebhook.ts:210:9)",
      tags: { eventType: "payment_intent.succeeded" },
    })

    expect(outcome).toEqual({ reported: true, eventId: expect.any(String) })
    expect(captured).toHaveLength(1)

    const sent = captured[0]
    expect(sent?.url).toBe(ENVELOPE_URL)
    expect(sent?.authHeader).toContain("sentry_key=publickey123")
    expect(sent?.authHeader).toContain("sentry_version=7")
    expect(sent?.contentType).toBe("application/x-sentry-envelope")
  })

  test("the event carries what an on-call engineer needs to find it", async () => {
    const t = newHarness()

    await t.action(internal.errorReporting.reportError, {
      source: "deliverooWebhook",
      name: "TimeoutError",
      message: "Deliveroo did not answer within 10s",
      stack: "TimeoutError: slow\n    at handleWebhook (convex/deliverooWebhookHandler.ts:96:7)",
      level: "fatal",
      tags: { step: "unhandled" },
      extra: { orderId: "ord_1029" },
    })

    const event = captured[0]?.event
    expect(event?.level).toBe("fatal")
    expect(event?.logger).toBe("convex")
    expect(event?.environment).toBe("production")
    // `runtime` is what separates a Convex issue from the browser and server
    // issues sharing this project; `source` is what separates one handler from
    // another inside it.
    expect(event?.tags.runtime).toBe("convex")
    expect(event?.tags.source).toBe("deliverooWebhook")
    expect(event?.tags.step).toBe("unhandled")
    expect(event?.extra).toEqual({ orderId: "ord_1029" })
    expect(event?.exception.values[0]?.type).toBe("TimeoutError")
    expect(event?.exception.values[0]?.value).toContain("did not answer")
    expect(event?.exception.values[0]?.stacktrace).toBeDefined()
  })

  /**
   * The reporter is called from `catch` blocks holding a webhook body, and a
   * call site that attaches the raw payload is a reasonable thing to write. The
   * signature on that payload is a live credential for forging deliveries.
   */
  test("a credential in the context never leaves the deployment", async () => {
    const t = newHarness()

    await t.action(internal.errorReporting.reportError, {
      source: "deliverooWebhook",
      name: "Error",
      message: "signature mismatch",
      extra: {
        signature: "sha256=8f2b1c9e",
        deliveroo_client_secret: "live-secret-value",
        orderId: "ord_77",
      },
    })

    const extra = captured[0]?.event.extra
    expect(extra?.signature).toBe("[Filtered]")
    expect(extra?.deliveroo_client_secret).toBe("[Filtered]")
    expect(extra?.orderId).toBe("ord_77")
    expect(JSON.stringify(captured[0])).not.toContain("live-secret-value")
  })

  /**
   * The envelope declares how many bytes the event is and Sentry reads exactly
   * that many. Every refusal this backend throws is in French, so a length
   * counted in characters would have reported ASCII errors and silently
   * rejected accented ones — the worst possible split, and invisible.
   */
  test("an accented message is framed in bytes, not characters", async () => {
    const t = newHarness()

    await t.action(internal.errorReporting.reportError, {
      source: "orders.create",
      name: "Error",
      message: "Commande déjà payée — établissement introuvable",
    })

    const sent = captured[0]
    const body = JSON.stringify(sent?.event)
    expect(sent?.itemHeader.length).toBe(new TextEncoder().encode(body).length)
    expect(sent?.itemHeader.length).toBeGreaterThan(body.length)
  })
})

describe("the reporter never becomes the failure", () => {
  /**
   * The normal state of a fresh client site, of CI and of local development. It
   * has to cost nothing, say nothing, and above all not throw — `captureBackendError`
   * is called from inside `catch`.
   */
  test("no DSN is silence, not an error", async () => {
    vi.stubEnv("SENTRY_DSN", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    const t = newHarness()

    const outcome = await t.action(internal.errorReporting.reportError, {
      source: "orders.create",
      name: "Error",
      message: "boom",
    })

    expect(outcome).toEqual({ reported: false, reason: "no-dsn" })
    expect(captured).toHaveLength(0)
  })

  /**
   * A DSN that is set but unusable is the failure `sentry.md` warns about: the
   * operator filled the variable in, saw no error, and believed monitoring was
   * live. Shipping the variable without the integration behind it is worse than
   * shipping neither — it buys the confidence without the coverage — so this
   * case must be LOUD, and it must name the variable the operator has to go and
   * fix. It reads as `no-dsn` because the DSN is rejected one layer up, in
   * `resolveSentryOptions`; what makes that acceptable rather than silent is
   * the warning asserted here.
   */
  test("a malformed DSN warns by name instead of reporting nothing", async () => {
    const warnings: string[] = []
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    })
    vi.stubEnv("SENTRY_DSN", "https://o42.ingest.sentry.io/4505")
    const t = newHarness()

    const outcome = await t.action(internal.errorReporting.reportError, {
      source: "orders.create",
      name: "Error",
      message: "boom",
    })

    expect(outcome).toEqual({ reported: false, reason: "no-dsn" })
    expect(captured).toHaveLength(0)
    expect(warnings.join("\n")).toContain("SENTRY_DSN")
    expect(warnings.join("\n")).toContain("Error reporting is OFF")
  })

  test("Sentry refusing the event does not raise one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })))
    const t = newHarness()

    await expect(
      t.action(internal.errorReporting.reportError, {
        source: "orders.create",
        name: "Error",
        message: "boom",
      }),
    ).resolves.toEqual({ reported: false, reason: "rejected" })
  })

  test("the network failing does not raise either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const t = newHarness()

    await expect(
      t.action(internal.errorReporting.reportError, {
        source: "orders.create",
        name: "Error",
        message: "boom",
      }),
    ).resolves.toEqual({ reported: false, reason: "threw" })
  })
})

/**
 * The wiring, end to end, through the router.
 *
 * Everything above proves the reporter works when it is called. This proves it
 * is CALLED — which is the half that was missing, and the half a unit test
 * cannot see. It goes in at `/webhooks/deliveroo` on the real HTTP router and
 * comes out as a request to Sentry's ingestion endpoint, with nothing stubbed
 * in between except the network.
 */
describe("a real webhook failure reaches Sentry", () => {
  /**
   * The scenario is not hypothetical: with neither Deliveroo secret set, the
   * handler answers 503 to EVERY delivery. The restaurant sees orders stop
   * arriving; Deliveroo sees a refusal; and before this, the only record was a
   * log line in that one client's dashboard. It is reported as `fatal` because
   * nothing will fix itself — someone has to go and set a variable.
   */
  test("a missing Deliveroo signing secret raises a fatal issue", async () => {
    // Deleted, not blanked. `getPackageEnv()` runs a Zod schema that rejects
    // `''` outright, so an EMPTY variable never reaches the guard below — it
    // throws first, which is the case the next test covers.
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key")
    vi.stubEnv("DELIVEROO_WEBHOOK_SECRET", undefined)
    vi.stubEnv("DELIVEROO_CLIENT_SECRET", undefined)
    const t = newHarness()

    const response = await t.fetch("/webhooks/deliveroo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "order.new" }),
    })
    expect(response.status).toBe(503)

    // The report is scheduled rather than awaited, so the webhook answers its
    // provider first. Nothing has been sent at this point on purpose.
    expect(captured).toHaveLength(0)
    await drainReports(t)

    expect(captured).toHaveLength(1)
    const event = captured[0]?.event
    expect(event?.level).toBe("fatal")
    expect(event?.tags.source).toBe("deliverooWebhook")
    expect(event?.tags.step).toBe("no-signing-secret")
    expect(event?.exception.values[0]?.value).toContain("DELIVEROO_WEBHOOK_SECRET")
  })

  /**
   * The deployment with no Sentry project is the common one, and the webhook
   * must behave identically on it — same status, same body, no exception
   * escaping the scheduled reporter.
   */
  test("the same failure on a deployment with no Sentry project behaves identically", async () => {
    vi.stubEnv("SENTRY_DSN", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key")
    vi.stubEnv("DELIVEROO_WEBHOOK_SECRET", undefined)
    vi.stubEnv("DELIVEROO_CLIENT_SECRET", undefined)
    const t = newHarness()

    const response = await t.fetch("/webhooks/deliveroo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "order.new" }),
    })

    expect(response.status).toBe(503)
    await expect(drainReports(t)).resolves.not.toThrow()
    expect(captured).toHaveLength(0)
  })

  /**
   * The failure with no branch written for it, which is the one that matters.
   *
   * `getPackageEnv()` validates the whole package tier with Zod, and
   * `OPENAI_API_KEY` is REQUIRED there — so a Convex deployment missing it
   * throws a `ZodError` at the top of this handler, before any Deliveroo logic
   * runs. Every delivery then answers 500 and Deliveroo retries forever. No
   * guard anticipates it; only the catch-all sees it. Reporting it is the whole
   * argument for wiring the catch-all rather than only the named branches.
   */
  test("an unanticipated fault in the same handler is reported too", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined)
    const t = newHarness()

    const response = await t.fetch("/webhooks/deliveroo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "order.new" }),
    })
    expect(response.status).toBe(500)

    await drainReports(t)
    expect(captured).toHaveLength(1)
    const event = captured[0]?.event
    expect(event?.tags.source).toBe("deliverooWebhook")
    expect(event?.tags.step).toBe("unhandled")
    expect(event?.exception.values[0]?.type).toBe("ZodError")
  })
})

/**
 * `GET /health` on the Convex router.
 *
 * There was no health route in any app, in either half, so "is that client's
 * backend up?" had no answer an external monitor could ask for. This is the
 * Convex half; `app/api/health/route.ts` calls it and reports both.
 */
describe("the health route", () => {
  test("answers 200 with the database reachable", async () => {
    const t = newHarness()

    const response = await t.fetch("/health", { method: "GET" })
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toContain("no-store")

    const body = (await response.json()) as {
      status: string
      time: string
      checks: { database: string; errorReporting: string }
    }
    expect(body.status).toBe("ok")
    expect(body.checks.database).toBe("ok")
    expect(body.checks.errorReporting).toBe("configured")
    expect(Number.isNaN(Date.parse(body.time))).toBe(false)
  })

  /**
   * A deployment with no Sentry project is a normal, healthy deployment. If
   * this ever reported `degraded`, the monitor would page on a configuration
   * decision and whoever carries the pager would learn to ignore it.
   */
  test("no Sentry project is reported, but is not an outage", async () => {
    vi.stubEnv("SENTRY_DSN", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    const t = newHarness()

    const response = await t.fetch("/health", { method: "GET" })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { status: string; checks: { errorReporting: string } }
    expect(body.status).toBe("ok")
    expect(body.checks.errorReporting).toBe("off")
  })

  /**
   * The response is read by anyone who can reach the deployment, so it must not
   * become a configuration oracle: it says WHETHER Sentry is configured, never
   * what to, and names no host, key or internal identifier.
   */
  test("it leaks no configuration value", async () => {
    const t = newHarness()

    const raw = await (await t.fetch("/health", { method: "GET" })).text()
    expect(raw).not.toContain("publickey123")
    expect(raw).not.toContain("ingest.sentry.io")
    expect(raw).not.toContain(DSN)
  })
})
