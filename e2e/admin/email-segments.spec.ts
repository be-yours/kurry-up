import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByCancel,
  closeDialogByEscape,
  getDialog,
} from "../helpers/dialog.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

const SEGMENTS_URL = "/dashboard/email/segments"

test.describe("Email Segments Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SEGMENTS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Segments" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Groupes d'abonnés filtrés par règles")
      ).toBeVisible()
    })

    test('should display "Nouveau segment" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Nouveau segment" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display table or empty state", async ({ page }) => {
      const table = page.locator("table")
      const emptyState = page.getByText("Aucun segment")

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Create Segment Dialog", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SEGMENTS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should open dialog when clicking create button", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText("Nouveau segment")).toBeVisible()
    })

    test("should display segment form fields", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(dialog.getByLabel("Nom du segment *")).toBeVisible()
      await expect(dialog.getByLabel("Description")).toBeVisible()
    })

    test("should display rule builder", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(dialog.getByText("Règles de filtrage")).toBeVisible()
      await expect(dialog.getByText("Condition globale")).toBeVisible()
    })

    test("should display AND/OR toggle", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(
        dialog.getByText("ET (toutes les règles)")
      ).toBeVisible()
      await expect(
        dialog.getByText("OU (au moins une règle)")
      ).toBeVisible()
    })

    test("should display add rule button", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(
        dialog.getByRole("button", { name: "Ajouter une règle" })
      ).toBeVisible()
    })

    test("should display subscriber count preview", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      // Should show the preview count area (loading or count)
      const previewArea = dialog.getByText(/^\d+ abonné|^Calcul en cours/)
      await expect(previewArea).toBeVisible({ timeout: 15_000 })
    })

    test("should add a new rule when clicking add button", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      const dialog = await waitForDialog(page)

      // Count initial rule rows (should be 1)
      const valuePlaceholders = dialog.getByPlaceholder("Valeur")
      const initialCount = await countAfterLoad(valuePlaceholders)

      await dialog
        .getByRole("button", { name: "Ajouter une règle" })
        .click()

      await expect(valuePlaceholders).toHaveCount(initialCount + 1)
    })

    test("should close dialog on cancel", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      await waitForDialog(page)
      await closeDialogByCancel(page)

      await expect(getDialog(page)).toBeHidden()
    })

    test("should close dialog on Escape", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouveau segment" })
        .click()

      await waitForDialog(page)
      await closeDialogByEscape(page)

      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(SEGMENTS_URL, {
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
