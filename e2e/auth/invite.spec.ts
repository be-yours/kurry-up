import { test, expect } from "@playwright/test"

/**
 * `/invite/[token]` — the route the invitation email has always pointed at.
 *
 * It did not exist, so every invitation ended on a 404 and `acceptInvitation`
 * — the only thing that writes `userProfiles` — was unreachable from a browser.
 * These tests are what makes "the route exists" a claim CI can check.
 *
 * They live in the `public` project: no session, so they run on a placeholder
 * backend as well as a real one. The half that needs a real invitation is
 * covered by `tests/convex/invitation-acceptance.test.ts`, which runs the real
 * functions against a real schema.
 */
test.describe("Invitation page", () => {
  const UNKNOWN_TOKEN = "e2e-token-that-does-not-exist"

  test("renders instead of 404ing", async ({ page }) => {
    const response = await page.goto(`/invite/${UNKNOWN_TOKEN}`, {
      waitUntil: "domcontentloaded",
    })

    // The whole defect, in one assertion: this used to be a 404.
    expect(response?.status()).toBeLessThan(400)
    await expect(
      page.getByRole("heading", { name: /rejoindre l'équipe/i })
    ).toBeVisible({ timeout: 30_000 })
  })

  test("tells an unusable link apart from a broken page", async ({ page }) => {
    await page.goto(`/invite/${UNKNOWN_TOKEN}`, { waitUntil: "domcontentloaded" })

    await expect(page.getByTestId("invite-not-found")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/invitation introuvable/i)).toBeVisible()
  })

  test("does not leak an admin shell to an anonymous visitor", async ({ page }) => {
    await page.goto(`/invite/${UNKNOWN_TOKEN}`, { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("invite-not-found")).toBeVisible({
      timeout: 30_000,
    })

    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)
  })
})

/**
 * The redirect that carries an invitee back.
 *
 * `/invite/<token>` needs a session, and sending someone to `/sign-in` without
 * remembering where they came from drops them on `/menu` holding a link they
 * have to find again. Both auth pages read `?redirect=`.
 */
test.describe("Auth pages honour ?redirect=", () => {
  test("sign-in keeps the destination on its sign-up link", async ({ page }) => {
    await page.goto("/sign-in?redirect=%2Finvite%2Fabc", {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByRole("button", { name: /se connecter/i })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole("link", { name: /créer un compte/i })).toHaveAttribute(
      "href",
      "/sign-up?redirect=%2Finvite%2Fabc"
    )
  })

  test("sign-up keeps the destination on its sign-in link", async ({ page }) => {
    await page.goto("/sign-up?redirect=%2Finvite%2Fabc", {
      waitUntil: "domcontentloaded",
    })

    await expect(
      page.getByRole("button", { name: /créer mon compte/i })
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("link", { name: /se connecter/i })).toHaveAttribute(
      "href",
      "/sign-in?redirect=%2Finvite%2Fabc"
    )
  })

  test("an absolute URL is refused, so neither page is an open redirect", async ({
    page,
  }) => {
    await page.goto("/sign-in?redirect=https%3A%2F%2Fevil.example%2Fsteal", {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByRole("button", { name: /se connecter/i })).toBeVisible({
      timeout: 30_000,
    })
    // Fell back to the default destination rather than carrying the attacker's.
    await expect(page.getByRole("link", { name: /créer un compte/i })).toHaveAttribute(
      "href",
      "/sign-up?redirect=%2Fmenu"
    )
  })
})
