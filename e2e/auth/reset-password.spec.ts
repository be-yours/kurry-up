import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

test.describe("Reset Password Page", () => {
  test("should render the page without crashing", async ({ page }) => {
    const response = await page.goto("/reset-password", {
      waitUntil: "domcontentloaded",
    })

    expect(response?.status()).toBeLessThan(500)
  })

  test("should display invalid link message without token", async ({
    page,
  }) => {
    await page.goto("/reset-password", { waitUntil: "domcontentloaded" })

    await expect(
      page.getByRole("heading", { name: /invalide/i })
    ).toBeVisible({ timeout: 30_000 })

    await expect(
      page.getByText(/invalide ou a expiré/i)
    ).toBeVisible()
  })

  test("should handle missing token parameter gracefully", async ({
    page,
  }) => {
    const response = await page.goto("/reset-password", {
      waitUntil: "domcontentloaded",
    })

    expect(response?.status()).toBeLessThan(500)
    await expect(page.locator("body")).not.toBeEmpty()
  })

  test("should handle invalid token gracefully", async ({ page }) => {
    const response = await page.goto(
      "/reset-password?token=invalid-fake-token-12345",
      { waitUntil: "domcontentloaded" }
    )

    expect(response?.status()).toBeLessThan(500)
    await expect(page.locator("body")).not.toBeEmpty()
  })

  test("should not produce unexpected console errors", async ({ page }) => {
    const { getErrors, cleanup } = collectConsoleErrors(page)

    await page.goto("/reset-password", { waitUntil: "domcontentloaded" })

    await page.waitForTimeout(3_000)

    cleanup()
    expect(getErrors()).toEqual([])
  })
})
