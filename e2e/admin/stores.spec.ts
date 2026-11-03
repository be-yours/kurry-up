import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { chooseOption } from "../helpers/filter.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

const STORES_URL = "/dashboard/stores"
const SEARCH_PLACEHOLDER = "Rechercher par nom, ville..."

test.describe("Stores Page", () => {
  // Not serial.
  //
  // These tests share nothing: no `beforeAll`, no describe-scope variables, and
  // not one of them submits a form — the delete tests open the confirmation and
  // cancel it. Each re-navigates in its own `beforeEach`.
  //
  // Serial mode arrived in a bulk monorepo-wiring commit, unexplained, and cost
  // far more than it gave: the first failure abandons the whole block, so four
  // failures were hiding 52 tests across these four files. Independent tests
  // each fail for their own reason, which is the only kind of failure worth
  // reading.

  test.describe("Page Structure", () => {
    test('should display "Établissements" heading', async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("heading", { name: "Établissements", level: 1 })
      ).toBeVisible()
    })

    test('should display "Créer un établissement" button', async ({
      page,
    }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("button", { name: "Créer un établissement" })
      ).toBeVisible()
    })

    test("should display search input", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByPlaceholder(SEARCH_PLACEHOLDER)
      ).toBeVisible()
    })

    test("should display status filter", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // The status filter combobox should be visible
      await expect(
        page.getByRole("combobox").filter({ hasText: "Tous les statuts" })
      ).toBeVisible()
    })

    test("should display stores table", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Either table or empty state should be visible
      const table = page.locator("table")
      const emptyState = page.getByText("Aucun établissement")

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Search & Filter", () => {
    test("should filter stores by name", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)
      await expect(searchInput).toBeVisible()

      // Type a search query
      await searchInput.fill("test")
      await page.waitForTimeout(1_000)

      // The page should still be functional
      await expect(
        page.getByRole("heading", { name: "Établissements", level: 1 })
      ).toBeVisible()
    })

    test("should filter by status", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Click the status filter combobox
      const statusFilter = page
        .getByRole("combobox")
        .filter({ hasText: "Tous les statuts" })
      await statusFilter.click()

      // Select "Ouvert" option
      await chooseOption(page, "Ouvert")

      // Wait for filter to apply
      await page.waitForTimeout(1_000)

      // The page should still be functional
      await expect(
        page.getByRole("heading", { name: "Établissements", level: 1 })
      ).toBeVisible()
    })

    test("should clear search", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)

      // Type and then clear
      await searchInput.fill("test")
      await page.waitForTimeout(500)
      await searchInput.clear()
      await page.waitForTimeout(500)

      // The page should still be functional
      await expect(
        page.getByRole("heading", { name: "Établissements", level: 1 })
      ).toBeVisible()
    })
  })

  test.describe("Create Store Dialog", () => {
    test("should open dialog when clicking create button", async ({
      page,
    }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await page
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      await expect(
        dialog.getByText("Créer un nouvel établissement")
      ).toBeVisible()
    })

    test("should display form fields in dialog", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await page
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Check for expected form fields
      await expect(
        dialog.getByLabel(/Nom de l'établissement/)
      ).toBeVisible()
      await expect(
        dialog.getByText("Slug (généré automatiquement)")
      ).toBeVisible()
      await expect(dialog.getByLabel("Description")).toBeVisible()
      // The address block is a named group of four fields — see
      // `store-detail.spec.ts` for why it stopped being one labelled input.
      await expect(dialog.getByRole("group", { name: /Adresse/ })).toBeVisible()
      await expect(dialog.getByLabel("Rue")).toBeVisible()
      await expect(dialog.getByLabel("Téléphone")).toBeVisible()
      await expect(dialog.getByLabel("E-mail")).toBeVisible()
    })

    test("should validate required fields", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await page
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Try to submit without filling required fields
      await dialog
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      // Dialog should still be open (validation prevents closing)
      await expect(dialog).toBeVisible()
    })

    test("should close dialog on cancel", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await page
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      await dialog.getByRole("button", { name: "Annuler" }).click()

      await expect(dialog).toBeHidden({ timeout: 5_000 })
    })

    test("should close dialog on Escape", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await page
        .getByRole("button", { name: "Créer un établissement" })
        .click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      await page.keyboard.press("Escape")

      await expect(dialog).toBeHidden({ timeout: 5_000 })
    })
  })

  test.describe("Table Interaction", () => {
    test("should display store rows with data", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const table = page.locator("table")
      const tableExists = await table.isVisible().catch(() => false)

      if (tableExists) {
        const rows = page.locator("tbody tr")
        const rowCount = await countAfterLoad(rows)

        // A silent `if` here let the test pass having checked nothing when the
        // list came back empty. A skip says so instead.
        test.skip(rowCount < 1, "the list is empty on this deployment")

        // First row should be visible and contain content
        await expect(rows.first()).toBeVisible()
      }
    })

    test("should navigate to store detail on row click", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // This test used to count rows the instant the DOM was ready — before
      // Convex had answered — find zero, skip the `if`, and report success
      // having asserted nothing. A test that cannot fail is worse than none.
      //
      // It also clicked the row rather than the link inside it. `TableRow` has
      // no onClick; the anchor in the name cell is what navigates.
      const storeLink = page
        .locator('tbody tr a[href^="/dashboard/stores/"]')
        .first()
      await expect(storeLink).toBeVisible({ timeout: 30_000 })

      await storeLink.click()
      await expect(page).toHaveURL(/\/dashboard\/stores\/.+/, { timeout: 15_000 })
    })
  })

  test.describe("Delete", () => {
    test("should show delete confirmation dialog", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      // Look for a delete action button (kebab menu or direct button)
      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      // Click the delete option in the dropdown
      const deleteOption = page.getByRole("menuitem", {
        name: /[Ss]upprimer/,
      })
      const deleteVisible = await deleteOption
        .isVisible()
        .catch(() => false)

      if (deleteVisible) {
        await deleteOption.click()

        // Confirmation dialog should appear
        const dialog = page.locator('[data-slot="dialog-content"]')
        await expect(dialog).toBeVisible({ timeout: 10_000 })
        await expect(
          dialog.getByText(/Supprimer l'établissement/)
        ).toBeVisible()
      }
    })

    test("should cancel deletion", async ({ page }) => {
      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      // Open action menu on first row
      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      const deleteOption = page.getByRole("menuitem", {
        name: /[Ss]upprimer/,
      })
      const deleteVisible = await deleteOption
        .isVisible()
        .catch(() => false)

      if (deleteVisible) {
        await deleteOption.click()

        const dialog = page.locator('[data-slot="dialog-content"]')
        await expect(dialog).toBeVisible({ timeout: 10_000 })

        // Click cancel to dismiss the dialog
        await dialog.getByRole("button", { name: "Annuler" }).click()
        await expect(dialog).toBeHidden({ timeout: 5_000 })
      }
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(STORES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("heading", { name: "Établissements", level: 1 })
      ).toBeVisible({ timeout: 30_000 })

      // Wait a moment for any async errors to surface
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
