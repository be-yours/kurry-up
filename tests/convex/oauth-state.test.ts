// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * CSRF state on the payment connect callbacks — ISSUE #162, sub-point 3.
 *
 * Three HTTP routes took a provider redirect and acted on it with nothing to
 * prove the redirect was ours. The worst was `/connect/sumup/callback`: it read
 * `code` out of the query string and handed it straight to the SumUp token
 * exchange, which upserts `paymentConnections` with `status: "connected"`. An
 * injected authorization code therefore bound a THIRD PARTY's SumUp merchant
 * account to the restaurant, and the restaurant's card takings followed it.
 * `/connect/stripe/callback` wrote whatever `account_id` it was given, and
 * `/connect/stripe/refresh` minted a live Stripe onboarding link for any
 * account id that could be named.
 *
 * The infrastructure to stop this already existed and was used correctly by
 * `uberEatsOAuthHttp.ts` — these routes simply never called it.
 *
 * WHY THESE TESTS ASSERT ON THE REDIRECT MESSAGE, NOT ONLY ON THE ABSENT ROW:
 *
 * "No `paymentConnections` row was written" is green whether the callback was
 * refused or ran all the way into the exchange and failed there for want of
 * `SUMUP_CLIENT_ID` — and this environment has no credentials, so that
 * assertion passes against the UNFIXED code. It was measured doing exactly
 * that. The load-bearing assertion is therefore the error the browser is
 * redirected to: "Missing OAuth state" and "Invalid or expired OAuth state" can
 * only be produced by the state gate, so seeing one is proof the request was
 * stopped BEFORE the exchange. The absent row is kept as a second, weaker
 * witness rather than the primary one.
 *
 * `guards the guard` at the bottom exists for the same reason: four refusals
 * would also be green if `consume` refused everything, which would break the
 * real flow while looking perfect here.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { internal } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Convex mutations in this codebase queue work through `ctx.scheduler.runAfter`.
 * A test finishes in milliseconds and leaves those pending; whatever fires them
 * next writes against a transaction that closed, and because nothing awaits it
 * that arrives as an unhandled rejection. The run then reports every test green
 * and still exits 1, blaming whichever file happened to be running rather than
 * the one that queued the work. Same block, and the same reasoning, as
 * `authorization.test.ts`.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

const GATE_REFUSALS = ["Missing OAuth state", "Invalid or expired OAuth state"]

/** The `error` the callback redirected the browser to. */
function errorOf(response: Response): string {
  const location = response.headers.get("Location") ?? ""
  return new URL(location).searchParams.get("error") ?? "(no error param)"
}

function paymentConnections(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("paymentConnections").collect())
}

function oauthStates(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("oauthStates").collect())
}

/** A state row this deployment issued, exactly as `generateOAuthUrl` does. */
async function issueState(
  t: ReturnType<typeof convexTest>,
  provider: string,
  state: string
) {
  await t.mutation(internal.oauthState.create, { provider, state })
}

describe("GET /connect/sumup/callback", () => {
  test("a callback carrying no state never reaches the token exchange", async () => {
    const t = newHarness()

    const response = await t.fetch("/connect/sumup/callback?code=injected_by_attacker")

    expect(response.status).toBe(302)
    // Stopped at the gate. Any other message would mean the code travelled on
    // into `exchangeOAuthToken`, which is where the account gets bound.
    expect(errorOf(response)).toBe("Missing OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("a forged state never reaches the token exchange", async () => {
    const t = newHarness()

    const response = await t.fetch(
      "/connect/sumup/callback?code=injected_by_attacker&state=forged_never_issued"
    )

    expect(errorOf(response)).toBe("Invalid or expired OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("a state issued for another provider is refused", async () => {
    const t = newHarness()
    await issueState(t, "uberEats", "cross_provider_state")

    // `consume` matches by state alone, then judges the provider — so a state
    // minted for the Uber Eats flow must not open the SumUp one.
    const response = await t.fetch(
      "/connect/sumup/callback?code=injected_by_attacker&state=cross_provider_state"
    )

    expect(errorOf(response)).toBe("Invalid or expired OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("a state is single-use: the same one replayed is refused", async () => {
    const t = newHarness()
    await issueState(t, "sumup", "replayed_state")

    // First presentation spends it. It gets past the gate and fails further in
    // for want of SumUp credentials, which is not what this test is about.
    await t.fetch("/connect/sumup/callback?code=first&state=replayed_state")

    const replay = await t.fetch(
      "/connect/sumup/callback?code=second&state=replayed_state"
    )

    // The replay is the attack: an intercepted redirect resent with a code of
    // the attacker's choosing.
    expect(errorOf(replay)).toBe("Invalid or expired OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("an expired state is refused", async () => {
    const t = newHarness()
    // Inserted directly: `oauthState.create` always stamps a live TTL, so the
    // only way to age one is to write the row.
    await t.run((ctx) =>
      ctx.db.insert("oauthStates", {
        provider: "sumup",
        state: "long_expired_state",
        expiresAt: Date.now() - 1,
      })
    )

    const response = await t.fetch(
      "/connect/sumup/callback?code=injected_by_attacker&state=long_expired_state"
    )

    expect(errorOf(response)).toBe("Invalid or expired OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("a refused state is still consumed, so it cannot be retried", async () => {
    const t = newHarness()
    await issueState(t, "uberEats", "wrong_provider_state")

    await t.fetch(
      "/connect/sumup/callback?code=injected_by_attacker&state=wrong_provider_state"
    )

    // `consume` deletes the matched row BEFORE it judges provider and expiry.
    // That ordering is the security property: were the row left behind on a
    // mismatch, an attacker could hold a state and keep presenting it until
    // some other condition changed.
    expect(await oauthStates(t)).toHaveLength(0)
  })
})

describe("GET /connect/stripe/callback", () => {
  test("an account id with no state is refused", async () => {
    const t = newHarness()

    const response = await t.fetch("/connect/stripe/callback?account_id=acct_attacker")

    expect(response.status).toBe(302)
    expect(errorOf(response)).toBe("Missing OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })

  test("a forged state is refused before the row is written", async () => {
    const t = newHarness()

    const response = await t.fetch(
      "/connect/stripe/callback?account_id=acct_attacker&state=forged_never_issued"
    )

    expect(errorOf(response)).toBe("Invalid or expired OAuth state")
    expect(await paymentConnections(t)).toHaveLength(0)
  })
})

describe("GET /connect/stripe/refresh", () => {
  test("no state means no onboarding link is minted", async () => {
    const t = newHarness()

    const response = await t.fetch("/connect/stripe/refresh?account_id=acct_attacker")

    expect(errorOf(response)).toBe("Missing OAuth state")
  })

  test("a forged state means no onboarding link is minted", async () => {
    const t = newHarness()

    const response = await t.fetch(
      "/connect/stripe/refresh?account_id=acct_attacker&state=forged_never_issued"
    )

    expect(errorOf(response)).toBe("Invalid or expired OAuth state")
  })
})

describe("guards the guard", () => {
  /**
   * Without these two, every refusal above would also pass against a `consume`
   * that returned `false` unconditionally — a change that would break the real
   * connect flow for every restaurant while leaving this file entirely green.
   */

  test("consume accepts a state this deployment just issued", async () => {
    const t = newHarness()
    await issueState(t, "sumup", "freshly_issued_state")

    const accepted = await t.mutation(internal.oauthState.consume, {
      provider: "sumup",
      state: "freshly_issued_state",
    })

    expect(accepted).toBe(true)
  })

  test("a valid state gets a callback PAST the gate", async () => {
    const t = newHarness()
    await issueState(t, "stripe", "genuine_stripe_state")

    const response = await t.fetch(
      "/connect/stripe/callback?account_id=acct_1234&state=genuine_stripe_state"
    )

    // What happens after the gate depends on Stripe configuration this suite
    // deliberately does not supply, so assert only that the gate opened —
    // whatever the callback answered, it was not a state refusal.
    expect(GATE_REFUSALS).not.toContain(errorOf(response))
    // And the state was spent on the way through.
    expect(await oauthStates(t)).toHaveLength(0)
  })
})

/**
 * Per-provider TTL — ISSUE #162, sub-point 4.
 *
 * One module-level `STATE_TTL_MS = 10 minutes` served all four flows. Ten
 * minutes is right for a consent screen: Uber Eats and SumUp show a page with a
 * button, and the round trip is one click. Stripe Connect is KYC — a long form,
 * bank details, and an identity document to photograph and upload. An owner who
 * took twenty-five minutes over it came back to "Invalid or expired OAuth
 * state", was refused, and had to start again; and starting again mints a BRAND
 * NEW connected account, so the abandoned ones accumulate on the Stripe side.
 *
 * Only Stripe is widened, to 45 minutes. The security properties that actually
 * matter are unchanged and are asserted below: the state is 16 random bytes, so
 * a longer window does not make it guessable, and it stays SINGLE-USE — the row
 * is deleted on every match, before provider or expiry is judged.
 *
 * Only `Date` is faked. Faking timers wholesale strands convex-test's own
 * promises and the suite hangs.
 */
describe("how long a state stays valid, per provider", () => {
  const NOW = 1_770_000_000_000
  const MINUTE = 60_000

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Issue a state now, let `minutes` pass, present it back.
   *
   * The clock is wound back to NOW first. Without that, a second call in the
   * same test issues its state at the time the previous call left behind, so
   * "eleven minutes old" is really "two minutes old" and the assertion measures
   * nothing. Both Uber Eats cases passed that way before this line existed.
   */
  async function afterMinutes(provider: string, minutes: number): Promise<boolean> {
    vi.setSystemTime(NOW)
    const t = newHarness()
    const state = `state_${provider}_${minutes}`
    await issueState(t, provider, state)
    vi.setSystemTime(NOW + minutes * MINUTE)
    return t.mutation(internal.oauthState.consume, { provider, state })
  }

  test("a Stripe onboarding state outlives the ten-minute consent window", async () => {
    // The reproduction: this was false before the TTL was made per-provider,
    // and 11 minutes is an unremarkable pace for a form with a document upload.
    expect(await afterMinutes("stripe", 11)).toBe(true)
    expect(await afterMinutes("stripe", 25)).toBe(true)
    expect(await afterMinutes("stripe", 44)).toBe(true)
  })

  test("a Stripe onboarding state does eventually expire", async () => {
    // Longer, not unbounded. 45 minutes is the window; past it the state is as
    // dead as any other.
    expect(await afterMinutes("stripe", 46)).toBe(false)
    expect(await afterMinutes("stripe", 24 * 60)).toBe(false)
  })

  test("an Uber Eats consent state still expires at ten minutes", async () => {
    // The reason the TTL is per provider rather than simply raised: there is no
    // case for giving a one-click consent a longer window.
    expect(await afterMinutes("uberEats", 9)).toBe(true)
    expect(await afterMinutes("uberEats", 11)).toBe(false)
  })

  test("a SumUp consent state still expires at ten minutes", async () => {
    expect(await afterMinutes("sumup", 9)).toBe(true)
    expect(await afterMinutes("sumup", 11)).toBe(false)
  })

  test("a provider nobody has configured gets the short window", async () => {
    // The map is a lookup with a default, and the default is the strict one:
    // adding a provider gives it ten minutes until somebody decides otherwise.
    expect(await afterMinutes("deliveroo", 11)).toBe(false)
  })

  test("the longer Stripe window is still single-use", async () => {
    // The property a longer TTL could plausibly weaken, so it is asserted at
    // the new length rather than at the old one.
    const t = newHarness()
    await issueState(t, "stripe", "long_lived_but_single_use")
    vi.setSystemTime(NOW + 30 * MINUTE)

    const first = await t.mutation(internal.oauthState.consume, {
      provider: "stripe",
      state: "long_lived_but_single_use",
    })
    const replay = await t.mutation(internal.oauthState.consume, {
      provider: "stripe",
      state: "long_lived_but_single_use",
    })

    expect(first).toBe(true)
    expect(replay).toBe(false)
    expect(await oauthStates(t)).toHaveLength(0)
  })

  test("a long-lived Stripe state still cannot open another provider's flow", async () => {
    const t = newHarness()
    await issueState(t, "stripe", "cross_provider_long_lived")
    vi.setSystemTime(NOW + 30 * MINUTE)

    const accepted = await t.mutation(internal.oauthState.consume, {
      provider: "sumup",
      state: "cross_provider_long_lived",
    })

    expect(accepted).toBe(false)
    // And spent on the way through, as on every other mismatch.
    expect(await oauthStates(t)).toHaveLength(0)
  })

  test("the expiry is the server's decision, not the caller's", async () => {
    // A TTL a caller could pass would make this guard advisory. `create` takes
    // the provider and the state and nothing else; the argument validator is
    // what enforces that.
    const t = newHarness()

    await expect(
      t.mutation(internal.oauthState.create, {
        provider: "uberEats",
        state: "caller_supplied_ttl",
        // @ts-expect-error -- the argument the validator must refuse. The
        // suppression is itself an assertion: TypeScript rejects this call too,
        // and `@ts-expect-error` fails the build if it ever stops doing so.
        ttlMs: 24 * 60 * MINUTE,
      })
    ).rejects.toThrow()
  })

  test("the two windows are the ones this file claims", async () => {
    // The numbers, stated once and legibly, so a future change to either shows
    // up here as well as in the round trips above.
    const t = newHarness()
    await issueState(t, "stripe", "window_stripe")
    await issueState(t, "uberEats", "window_uber")

    const rows = await oauthStates(t)
    const windowOf = (state: string) =>
      (rows.find((r) => r.state === state)?.expiresAt ?? 0) - NOW

    expect(windowOf("window_stripe")).toBe(45 * MINUTE)
    expect(windowOf("window_uber")).toBe(10 * MINUTE)
  })
})
