import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByCancel,
  closeDialogByEscape,
  getDialog,
} from "../helpers/dialog.helpers"

const TEMPLATES_URL = "/dashboard/email/templates"

test.describe("Email Templates Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(TEMPLATES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Modèles d'email" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test('should display "Nouveau modèle" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Nouveau modèle" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display category filter buttons", async ({ page }) => {
      await expect(page.getByText("Tous")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole("button", { name: "Marketing", exact: true })).toBeVisible()
      await expect(page.getByText("Transactionnel")).toBeVisible()
      await expect(page.getByText("Automation")).toBeVisible()
    })

    test("should display cards grid or empty state", async ({ page }) => {
      // Wait for data loading
      await page.waitForTimeout(3_000)

      const card = page.locator(".rounded-lg.border.bg-card")
      const emptyState = page.getByText("Aucun modèle")

      await expect(card.first().or(emptyState)).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Category Filter", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(TEMPLATES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should filter by Marketing category", async ({ page }) => {
      await page.waitForTimeout(2_000)

      // Click on Marketing filter button
      const marketingBtn = page.getByRole("button", { name: "Marketing", exact: true })
      await marketingBtn.click()
      await page.waitForTimeout(500)

      // Page should remain functional
      await expect(
        page.getByRole("heading", { name: "Modèles d'email", level: 1 })
      ).toBeVisible()
    })

    test("should reset to all categories", async ({ page }) => {
      await page.waitForTimeout(2_000)

      // Click Marketing then All
      await page.getByRole("button", { name: "Marketing", exact: true }).click()
      await page.waitForTimeout(300)
      await page.locator("button", { hasText: "Tous" }).click()
      await page.waitForTimeout(300)

      await expect(
        page.getByRole("heading", { name: "Modèles d'email", level: 1 })
      ).toBeVisible()
    })
  })

  test.describe("Create Template Dialog", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(TEMPLATES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should open dialog when clicking create button", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: "Nouveau modèle" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText("Nouveau modèle d'email")).toBeVisible()
    })

    test("should display form fields in dialog", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau modèle" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(dialog.getByLabel("Nom du modèle *")).toBeVisible()
      await expect(dialog.getByLabel("Objet de l'email *")).toBeVisible()
      await expect(dialog.getByText("Catégorie")).toBeVisible()
    })

    test("should close dialog on cancel", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau modèle" })
        .click()

      await waitForDialog(page)
      await closeDialogByCancel(page)

      await expect(getDialog(page)).toBeHidden()
    })

    test("should close dialog on Escape", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau modèle" })
        .click()

      await waitForDialog(page)
      await closeDialogByEscape(page)

      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(TEMPLATES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
      await page.waitForTimeout(3_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
