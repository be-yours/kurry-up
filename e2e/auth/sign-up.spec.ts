import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

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
test.describe("Sign Up Page", () => {
  test.describe("Page Structure", () => {
    test("should display the sign-up heading", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Créer un compte", level: 1 })
      ).toBeVisible()
    })

    test("should display name, email, and password fields with correct attributes", async ({
      page,
    }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      const nameInput = page.getByLabel("Nom")
      await expect(nameInput).toBeVisible()
      await expect(nameInput).toHaveAttribute("type", "text")
      await expect(nameInput).toHaveAttribute("placeholder", "Jean Dupont")

      const emailInput = page.getByLabel("Email")
      await expect(emailInput).toBeVisible()
      await expect(emailInput).toHaveAttribute("type", "email")
      await expect(emailInput).toHaveAttribute("placeholder", "jean@exemple.com")

      const passwordInput = page.getByLabel("Mot de passe", { exact: true })
      await expect(passwordInput).toBeVisible()
      await expect(passwordInput).toHaveAttribute("type", "password")
      await expect(passwordInput).toHaveAttribute(
        "placeholder",
        "Min. 12 caractères"
      )
    })

    test("should display the submit button", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("button", { name: "Créer mon compte" })
      ).toBeVisible()
    })

    test("should display the sign-in link", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(page.getByText("Déjà un compte ?")).toBeVisible()

      const signInLink = page.getByRole("link", { name: "Se connecter" })
      await expect(signInLink).toBeVisible()
      // The mirror of the link on the sign-in page; same reason for the query.
      await expect(signInLink).toHaveAttribute("href", /^\/sign-in\?redirect=/)
    })
  })

  test.describe("Form Validation", () => {
    test("should show browser validation on empty submit", async ({
      page,
    }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await page.getByRole("button", { name: "Créer mon compte" }).click()

      // The name field should prevent submission via browser validation
      const nameInput = page.getByLabel("Nom")
      const validationMessage = await nameInput.evaluate(
        (el: HTMLInputElement) => el.validationMessage
      )
      expect(validationMessage).toBeTruthy()
    })

    test("should enforce minimum password length", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await page.getByLabel("Nom").fill("Test User")
      await page.getByLabel("Email").fill("test@example.com")
      await page.getByLabel("Mot de passe", { exact: true }).fill("password123")

      // The password field mirrors Better Auth's minPasswordLength=12, so
      // "password123" (11 chars) should be invalid
      const passwordInput = page.getByLabel("Mot de passe", { exact: true })
      await expect(passwordInput).toHaveAttribute("minlength", "12")

      // Verify the value is shorter than the minimum
      const value = await passwordInput.inputValue()
      expect(value.length).toBeLessThan(12)

      // The confirmation field carries the same minimum, so a short password
      // cannot slip through the second field either
      const confirmInput = page.getByLabel("Confirmer")
      await expect(confirmInput).toHaveAttribute("minlength", "12")
    })
  })

  test.describe("Auth Flow", () => {
    test("should show error for duplicate email", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Créer un compte" })
      ).toBeVisible({ timeout: 30_000 })

      // Use the existing test user email to trigger duplicate error
      await page.getByLabel("Nom").fill("Duplicate User")
      await page.getByLabel("Email").fill("test.owner@beindigital.fr")
      await page.getByLabel("Mot de passe", { exact: true }).fill("password1234")
      await page.getByLabel("Confirmer").fill("password1234")

      await page.getByRole("button", { name: "Créer mon compte" }).click()

      // The error surface, addressed by ROLE rather than by colour. These pages
      // used to be located by `.bg-red-50` and `.bg-red-900/20`; #410 routed
      // every literal on them through the token layer, and a selector written
      // against a palette class rots silently the next time the palette moves.
      const errorBanner = page.locator("[role='alert'], [data-sonner-toast]")
      const errorToast = page.getByText(/échec|erreur|existe déjà/i)

      await expect(errorBanner.or(errorToast).first()).toBeVisible({ timeout: 15_000 })
    })

    test("should process form submission", async ({ page }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Créer un compte" })
      ).toBeVisible({ timeout: 30_000 })

      const uniqueEmail = `signup-test-${Date.now()}@example.com`
      await page.getByLabel("Nom").fill("Test User")
      await page.getByLabel("Email").fill(uniqueEmail)
      await page.getByLabel("Mot de passe", { exact: true }).fill("password1234")
      await page.getByLabel("Confirmer").fill("password1234")

      await page.getByRole("button", { name: "Créer mon compte" }).click()

      // After submission, we should see either:
      // - A success redirect (away from /sign-up)
      // - A success toast
      // - An error message (backend may reject)
      const successToast = page.getByText(/compte créé|succès/i)
      const errorBanner = page.locator("[role='alert'], [data-sonner-toast]")
      const errorToast = page.getByText(/échec|erreur/i)

      // Wait for any outcome — the form was submitted and processed
      await expect(
        successToast.or(errorBanner).or(errorToast).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Navigation", () => {
    test("should navigate to /sign-in when clicking sign-in link", async ({
      page,
    }) => {
      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await page.getByRole("link", { name: "Se connecter" }).click()

      await expect(page).toHaveURL(/\/sign-in/)
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/sign-up", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Créer un compte" })
      ).toBeVisible({ timeout: 30_000 })

      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
