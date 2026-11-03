import type { Locator } from "@playwright/test"

/**
 * Counts a list after giving it a chance to appear.
 *
 * `count()` is a one-shot read: it counts what is in the DOM at that instant
 * and never retries, unlike `expect(...)` which polls until its deadline. Every
 * list in this admin arrives from a Convex query a moment after the page does,
 * so counting straight after navigation counts an empty page — and then either
 * reports a missing feature or, worse, silently skips the body of a test that
 * goes on to pass having verified nothing.
 *
 * Waiting for the first row before counting removes the race. A genuinely empty
 * list still returns 0, at the cost of the grace period — which is the right
 * trade: five seconds to tell "not loaded yet" from "really empty".
 */
export async function countAfterLoad(
  locator: Locator,
  timeout = 5_000
): Promise<number> {
  await locator
    .first()
    .waitFor({ state: "visible", timeout })
    .catch(() => {})
  return locator.count()
}
