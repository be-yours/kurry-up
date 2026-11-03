import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"

test.describe("CMS Reset Functionality", () => {
  test.describe("Editor Reset Controls", () => {
    test("should display reset button per field", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display reset buttons
      const resetButtons = page.getByRole("button", {
        name: /r[eé]initialiser/i,
      })
      await expect(resetButtons.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should display reset block button", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display block-level reset
      const blockResetButtons = page.getByRole("button", {
        name: /r[eé]initialiser le bloc/i,
      })
      await expect(blockResetButtons.first()).toBeVisible({ timeout: 15_000 })
    })
  })
})
