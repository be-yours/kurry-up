import { test as setup, expect } from "@playwright/test"

/**
 * Authentication setup for admin E2E tests.
 *
 * Logs in as the test admin user (client_admin role) and saves the
 * browser storage state so subsequent tests can reuse the session.
 *
 * Requires:
 *   - A running Convex backend with seeded users (npx tsx scripts/seed-users.mts)
 *   - NEXT_PUBLIC_CONVEX_URL in .env.local
 *   - SEED_PASSWORD, the same value the seed script used
 */

const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json"

/**
 * The account `scripts/seed-users.mts` creates with the `client_admin` role.
 *
 * `SEED_ADMIN_EMAIL` overrides it, and the seed script reads the same variable:
 * a password cannot be reset from the script, so an address whose password has
 * been lost is replaced rather than recovered.
 */
const ADMIN_EMAIL =
  process.env.SEED_ADMIN_EMAIL ?? "test.owner@beindigital.fr"

/**
 * The seeded password, which only the environment knows.
 *
 * This file used to carry a literal — and not even the right one, since
 * `seed-users.mts` reads `SEED_PASSWORD`. So the setup only ever worked on a
 * machine where the two happened to agree, and failed with "wrong credentials"
 * everywhere else. The seed script's own comment says it: never hardcode a
 * password, not even a throwaway.
 */
const ADMIN_PASSWORD = process.env.SEED_PASSWORD ?? ""

/**
 * This step needs its own budget.
 *
 * The suite-wide timeout is 60 s, while the waits below asked for 60 + 30 + 30
 * + 30 + 60 = 210 s. None of those limits was reachable: the test could only
 * ever die at 60 s total — and it did, every time, on a cold Turbopack server
 * where compiling `/sign-in` alone takes about twenty seconds and `/menu`
 * compiles on demand right after. The login itself was never the problem;
 * verified by capturing the network, where sign-in, session and the Convex
 * token exchange all return 200 and the browser does reach `/menu`.
 */
setup.setTimeout(180_000)

setup("authenticate as admin", async ({ page }) => {
  // Fail here, with the reason, rather than thirty seconds later on a login
  // form that simply refused an empty password.
  expect(
    ADMIN_PASSWORD,
    "SEED_PASSWORD is not set — run the seed script and export the same value"
  ).not.toBe("")

  // Wait for full network idle to ensure Convex backend is connected
  await page.goto("/sign-in", {
    waitUntil: "networkidle",
    timeout: 60_000,
  })

  await expect(
    page.getByText("Bon retour").or(page.getByRole("heading", { name: "Connexion" }))
  ).toBeVisible({ timeout: 30_000 })

  // Wait for Next.js compilation to finish (dev mode indicator)
  const compilingIndicator = page.getByText("Compiling")
  try {
    await compilingIndicator.waitFor({ state: "hidden", timeout: 30_000 })
  } catch {
    // Indicator may not appear if already compiled
  }

  // Extra wait for Convex WebSocket connection to stabilize
  await page.waitForLoadState("networkidle")

  // Fill credentials using input IDs (labels are ambiguous due to "Mot de passe oublié" link)
  await page.locator("#email").fill(ADMIN_EMAIL)
  await page.locator("#password").fill(ADMIN_PASSWORD)

  await page.getByRole("button", { name: /se connecter/i }).click()

  // Wait on the URL, not on "networkidle".
  //
  // Convex holds an open WebSocket, so the network is never idle on this app;
  // that wait could only burn budget and then hand what was left to the check
  // that actually matters. The redirect IS the signal.
  await expect(page).toHaveURL(/\/(dashboard|menu)/, { timeout: 90_000 })

  // Mark the onboarding tour as already seen, before the state is saved.
  //
  // On a fresh account the tour opens by itself and lays a `reactour__mask`
  // over the page, which swallows every click — `sidebar.spec.ts` timed out
  // trying to reach a link the mask was covering. The provider records
  // completion under `bid-tour-<userId>`, so writing that key is the same thing
  // a human does by closing the tour once. The tour itself deserves its own
  // test; it must not silently break every other one.
  const session = await page.evaluate(async () => {
    const res = await fetch("/api/auth/get-session")
    return (await res.json()) as { user?: { id?: string } } | null
  })
  const userId = session?.user?.id
  expect(userId, "no session user id after login").toBeTruthy()

  await page.evaluate((id) => {
    localStorage.setItem(`bid-tour-${id}`, "done")
  }, userId)

  await page.context().storageState({ path: ADMIN_STORAGE_STATE })
})
