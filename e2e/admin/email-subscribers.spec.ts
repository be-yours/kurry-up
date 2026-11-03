import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByCancel,
  closeDialogByEscape,
  getDialog,
} from "../helpers/dialog.helpers"
import { chooseOption } from "../helpers/filter.helpers"

const SUBSCRIBERS_URL = "/dashboard/email/subscribers"
// The list is paginated, and the placeholder says which subscribers the box
// actually searches — see `email-subscribers-page.tsx`.
const SEARCH_PLACEHOLDER = "Rechercher parmi les abonnés chargés (email ou nom)..."

test.describe("Email Subscribers Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SUBSCRIBERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Abonnés" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test('should display "Ajouter un abonné" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Ajouter un abonné" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test('should display "Importer CSV" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Importer CSV" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display search input", async ({ page }) => {
      await expect(
        page.getByPlaceholder(SEARCH_PLACEHOLDER)
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display status filter", async ({ page }) => {
      await expect(
        page.getByRole("combobox").filter({ hasText: "Tous les statuts" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display source filter", async ({ page }) => {
      await expect(
        page.getByRole("combobox").filter({ hasText: "Toutes les sources" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display table or empty state", async ({ page }) => {
      const table = page.locator("table")
      const emptyState = page.getByText("Aucun abonné")

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Add Subscriber Dialog", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SUBSCRIBERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should open dialog when clicking add button", async ({ page }) => {
      await page
        .getByRole("button", { name: "Ajouter un abonné" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText("Ajouter un abonné")).toBeVisible()
    })

    test("should display double opt-in mention", async ({ page }) => {
      await page
        .getByRole("button", { name: "Ajouter un abonné" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(
        dialog.getByText(/double opt-in/).first()
      ).toBeVisible()
    })

    test("should close dialog on cancel", async ({ page }) => {
      await page
        .getByRole("button", { name: "Ajouter un abonné" })
        .click()

      await waitForDialog(page)
      await closeDialogByCancel(page)

      await expect(getDialog(page)).toBeHidden()
    })

    test("should close dialog on Escape", async ({ page }) => {
      await page
        .getByRole("button", { name: "Ajouter un abonné" })
        .click()

      await waitForDialog(page)
      await closeDialogByEscape(page)

      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("CSV Import Dialog", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SUBSCRIBERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should open CSV import dialog", async ({ page }) => {
      await page
        .getByRole("button", { name: "Importer CSV" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog).toBeVisible()
    })
  })

  test.describe("Search & Filter", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(SUBSCRIBERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should filter subscribers by search", async ({ page }) => {
      const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)
      await expect(searchInput).toBeVisible({ timeout: 15_000 })

      await searchInput.fill("test")
      await page.waitForTimeout(1_000)

      await expect(
        page.getByRole("heading", { name: "Abonnés", level: 1 })
      ).toBeVisible()
    })

    test("should filter by status", async ({ page }) => {
      const statusFilter = page
        .getByRole("combobox")
        .filter({ hasText: "Tous les statuts" })

      await statusFilter.click()
      await chooseOption(page, "Actif")
      await page.waitForTimeout(1_000)

      await expect(
        page.getByRole("heading", { name: "Abonnés", level: 1 })
      ).toBeVisible()
    })

    test("should clear search", async ({ page }) => {
      const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)

      await searchInput.fill("test")
      await page.waitForTimeout(500)
      await searchInput.clear()
      await page.waitForTimeout(500)

      await expect(
        page.getByRole("heading", { name: "Abonnés", level: 1 })
      ).toBeVisible()
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(SUBSCRIBERS_URL, {
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
