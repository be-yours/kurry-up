import { test, expect, type Page } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"

/**
 * Skips when Auto Blog is not part of the account's plan.
 *
 * The page answers a gated account with "Auto Blog non disponible" and no
 * settings at all, so every assertion about a frequency, a theme list or a save
 * button was really asserting an entitlement. A locked plan is a legitimate
 * state, not a failure — and a test that cannot tell the two apart says nothing
 * about either.
 */
async function skipIfLocked(page: Page) {
  const locked = page
    .getByText(/Auto Blog non disponible|Quota mensuel atteint/)
    .first()
  const settings = page
    .getByText(/fr[eé]quence|hebdomadaire|mensuel|th[eé]matiques?/i)
    .first()

  // Wait for the page to settle on one of its two shapes before deciding.
  // Polling only for the locked banner made this a race: on a slower render it
  // was not there yet, the guard concluded "not locked", and the test went on
  // to assert controls that would never come.
  await expect(locked.or(settings)).toBeVisible({ timeout: 20_000 })

  test.skip(
    await locked.isVisible().catch(() => false),
    "Auto Blog is not enabled on this account's plan"
  )
}

test.describe("Blog Auto Config", () => {
  test.describe("Page Loading", () => {
    test("should load auto-config page", async ({ page }) => {
      await page.goto("/dashboard/content/blog/auto-config", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display the auto-config heading or form
      await expect(
        page
          .getByRole("heading", { name: /auto|configuration|param[eè]tres/i })
          .or(page.getByText(/configuration automatique/i))
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display frequency selector", async ({ page }) => {
      await page.goto("/dashboard/content/blog/auto-config", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)
      await skipIfLocked(page)

      // Should have frequency radio/select (hebdomadaire/mensuel)
      await expect(
        page
          .getByText(/fr[eé]quence|hebdomadaire|mensuel/i)
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display themes/topics section", async ({ page }) => {
      await page.goto("/dashboard/content/blog/auto-config", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)
      await skipIfLocked(page)

      // Should have themes/topics input area
      await expect(
        page
          .getByText(/th[eé]matiques?|sujets?|topics?/i)
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display approval mode selector", async ({ page }) => {
      await page.goto("/dashboard/content/blog/auto-config", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)
      await skipIfLocked(page)

      // Should have approval mode (brouillon / auto-publication)
      await expect(
        page
          .getByText(/approbation|brouillon|publication/i)
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display save button", async ({ page }) => {
      await page.goto("/dashboard/content/blog/auto-config", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)
      await skipIfLocked(page)

      await expect(
        page.getByRole("button", { name: /enregistrer|sauvegarder|save/i })
      ).toBeVisible({ timeout: 15_000 })
    })
  })
})
