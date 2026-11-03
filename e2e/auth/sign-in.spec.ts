import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import {
  SEED_EMAIL,
  SEED_PASSWORD,
  requireSeedPassword,
} from "../helpers/credentials.helpers"

/**
 * WHY THE PASSWORD FIELD IS SELECTED EXACTLY.
 *
 * `getByLabel("Mot de passe")` matches accessible names by CASE-INSENSITIVE
 * SUBSTRING, and the reveal toggle beside the field is named « Afficher le mot
 * de passe » / « Masquer le mot de passe ». Both contain the search string, so
 * the bare selector resolves to two elements and Playwright fails the whole
 * spec on strict mode.
 *
 * It was unambiguous before only because that toggle had NO accessible name at
 * all — an icon-only button reaching a screen reader as "button". This suite
 * was therefore depending on an accessibility defect to disambiguate its own
 * selector, and it went red the moment the defect was fixed.
 *
 * `exact: true` says what the selector always meant: the field labelled exactly
 * « Mot de passe », not everything mentioning one. It TIGHTENS the assertion —
 * nothing here is skipped, relaxed or waived.
 */
test.describe("Sign In Page", () => {
  test.describe("Page Structure", () => {
    test("should display the sign-in heading", async ({ page }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/, level: 1 })
      ).toBeVisible()
    })

    test("should display email and password fields with correct attributes", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      const emailInput = page.getByLabel("Email")
      await expect(emailInput).toBeVisible()
      await expect(emailInput).toHaveAttribute("type", "email")
      await expect(emailInput).toHaveAttribute("placeholder", "jean@exemple.com")

      const passwordInput = page.getByLabel("Mot de passe", { exact: true })
      await expect(passwordInput).toBeVisible()
      await expect(passwordInput).toHaveAttribute("type", "password")
      await expect(passwordInput).toHaveAttribute("placeholder", "••••••••")
    })

    test("should display the submit button", async ({ page }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("button", { name: "Se connecter" })
      ).toBeVisible()
    })

    test("should display the forgot password link", async ({ page }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      const forgotLink = page.getByRole("link", {
        name: "Mot de passe oublié ?",
      })
      await expect(forgotLink).toBeVisible()
      await expect(forgotLink).toHaveAttribute("href", "/forgot-password")
    })

    test("should display the create account link", async ({ page }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(page.getByText("Pas encore de compte ?")).toBeVisible()

      const createAccountLink = page.getByRole("link", {
        name: "Créer un compte",
      })
      await expect(createAccountLink).toBeVisible()
      // Not the bare path. The link carries the destination across the switch
      // between the two auth pages, so somebody who arrived at
      // `/sign-in?redirect=/checkout` and decides to register still lands on
      // the checkout afterwards. With no incoming parameter `safeRedirect`
      // supplies `/menu`, so the query is always there. Asserting `/sign-up`
      // alone pinned the state of this page before that existed.
      await expect(createAccountLink).toHaveAttribute(
        "href",
        /^\/sign-up\?redirect=/
      )
    })
  })

  test.describe("Form Validation", () => {
    test("should show browser validation on empty submit", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await page.getByRole("button", { name: "Se connecter" }).click()

      // The email field should prevent submission via browser validation
      const emailInput = page.getByLabel("Email")
      const validationMessage = await emailInput.evaluate(
        (el: HTMLInputElement) => el.validationMessage
      )
      expect(validationMessage).toBeTruthy()
    })

    test("should show browser validation for invalid email format", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await page.getByLabel("Email").fill("invalid-email")
      await page.getByLabel("Mot de passe", { exact: true }).fill("password123")
      await page.getByRole("button", { name: "Se connecter" }).click()

      const emailInput = page.getByLabel("Email")
      const isValid = await emailInput.evaluate(
        (el: HTMLInputElement) => el.checkValidity()
      )
      expect(isValid).toBe(false)
    })
  })

  test.describe("Auth Flow", () => {
    test("should attempt redirect on successful login", async ({
      page,
    }) => {
      requireSeedPassword()

      // Not "networkidle": Convex holds a WebSocket open for the life of the
      // page, so the network is never idle and the navigation times out at 60 s
      // without ever having failed at anything. The heading below is the real
      // signal that the page is ready.
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/ })
      ).toBeVisible({ timeout: 30_000 })

      await page.getByLabel("Email").fill(SEED_EMAIL)
      await page.getByLabel("Mot de passe", { exact: true }).fill(SEED_PASSWORD)

      await page.getByRole("button", { name: "Se connecter" }).click()

      // The page sends everyone to /menu after a successful sign-in, staff
      // included — `auth.setup.ts` accepts either destination for the same
      // reason. What this test can assert is that the sign-in took: the user
      // leaves /sign-in. Whether an owner should land on the dashboard instead
      // is a product decision, not something to settle by rewriting a redirect
      // under a test.
      await expect(page).toHaveURL(/\/(dashboard|menu)/, { timeout: 30_000 })
    })

    test("should show error banner on invalid credentials", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/ })
      ).toBeVisible({ timeout: 30_000 })

      await page.getByLabel("Email").fill("wrong@example.com")
      await page.getByLabel("Mot de passe", { exact: true }).fill("wrongpassword")

      await page.getByRole("button", { name: "Se connecter" }).click()

      // The error surface, addressed by ROLE rather than by colour. These pages
      // used to be located by `.bg-red-50` and `.bg-red-900/20`; #410 routed
      // every literal on them through the token layer, and a selector written
      // against a palette class rots silently the next time the palette moves.
      const errorBanner = page.locator("[role='alert'], [data-sonner-toast]")
      const errorToast = page.getByText(/échec|erreur|invalide/i)

      await expect(errorBanner.or(errorToast).first()).toBeVisible({ timeout: 15_000 })
    })

    test("should show loading state while authenticating", async ({
      page,
    }) => {
      requireSeedPassword()

      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/ })
      ).toBeVisible({ timeout: 30_000 })

      // Hold the sign-in response open for a moment.
      //
      // The loading state is transient by nature: against a local Convex the
      // request finishes in tens of milliseconds, so the button had usually
      // returned to "Se connecter" before the assertion ever looked. Polling
      // does not help — the state is already gone. Delaying the response is
      // what makes this a test about the loading state rather than about how
      // fast the backend happens to be today.
      await page.route("**/api/auth/sign-in/email", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        await route.continue()
      })

      await page.getByLabel("Email").fill(SEED_EMAIL)
      await page.getByLabel("Mot de passe", { exact: true }).fill(SEED_PASSWORD)

      await page.getByRole("button", { name: "Se connecter" }).click()

      // Button should show loading text
      await expect(
        page.getByRole("button", { name: "Connexion en cours..." })
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should navigate away from sign-in on login", async ({ page }) => {
      requireSeedPassword()

      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/ })
      ).toBeVisible({ timeout: 30_000 })

      await page.getByLabel("Email").fill(SEED_EMAIL)
      await page.getByLabel("Mot de passe", { exact: true }).fill(SEED_PASSWORD)

      await page.getByRole("button", { name: "Se connecter" }).click()

      // After login, user navigates away from sign-in
      // (may show a toast or redirect — both indicate success)
      const redirected = page.waitForURL(/(?!.*sign-in)/, { timeout: 15_000 })
      const toast = page.getByText(/connexion/i).first()

      // Either the redirect happens or a toast appears
      await Promise.race([redirected, expect(toast).toBeVisible({ timeout: 15_000 })])
    })
  })

  test.describe("Navigation", () => {
    test("should navigate to /forgot-password when clicking forgot password link", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await page
        .getByRole("link", { name: "Mot de passe oublié ?" })
        .click()

      await expect(page).toHaveURL(/\/forgot-password/)
    })

    test("should navigate to /sign-up when clicking create account link", async ({
      page,
    }) => {
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await page.getByRole("link", { name: "Créer un compte" }).click()

      await expect(page).toHaveURL(/\/sign-up/)
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/sign-in", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: /Bon retour/ })
      ).toBeVisible({ timeout: 30_000 })

      // Wait a moment for any async errors to surface
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
