import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

test.describe("Forgot Password Page", () => {
  test("should render the page without crashing", async ({ page }) => {
    const response = await page.goto("/forgot-password", {
      waitUntil: "domcontentloaded",
    })

    expect(response?.status()).toBeLessThan(500)
  })

  test("should display an email input field", async ({ page }) => {
    await page.goto("/forgot-password", { waitUntil: "domcontentloaded" })

    const emailInput = page.getByLabel("Email")
    await expect(emailInput).toBeVisible({ timeout: 30_000 })
    await expect(emailInput).toHaveAttribute("type", "email")
  })

  test("should display a submit button", async ({ page }) => {
    await page.goto("/forgot-password", { waitUntil: "domcontentloaded" })

    await expect(page.getByLabel("Email")).toBeVisible({ timeout: 30_000 })

    const submitButton = page.getByRole("button", {
      name: /envoyer|réinitialiser|soumettre/i,
    })
    await expect(submitButton).toBeVisible()
  })

  test("should not produce unexpected console errors", async ({ page }) => {
    const { getErrors, cleanup } = collectConsoleErrors(page)

    await page.goto("/forgot-password", { waitUntil: "domcontentloaded" })

    await page.waitForTimeout(3_000)

    cleanup()
    expect(getErrors()).toEqual([])
  })
})
