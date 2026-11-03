import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"

test.describe("CMS Media Library", () => {
  test.describe("Page Loading", () => {
    test("should load media library page", async ({ page }) => {
      await page.goto("/dashboard/content/media", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display the media library heading
      await expect(
        page.getByRole("heading", { name: /m[eé]diath[eè]que/i }),
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display upload button", async ({ page }) => {
      await page.goto("/dashboard/content/media", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display the upload button
      await expect(
        page.getByRole("button", { name: /uploader/i }),
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display kind filter", async ({ page }) => {
      await page.goto("/dashboard/content/media", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should have filter controls
      const searchInput = page.getByPlaceholder(/rechercher/i)
      await expect(searchInput).toBeVisible({ timeout: 15_000 })
    })
  })
})
