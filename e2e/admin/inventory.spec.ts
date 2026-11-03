import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { applySearch } from "../helpers/filter.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

test.describe("Inventory Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Inventaire" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Gérez le stock de vos produits en temps réel")
      ).toBeVisible()
    })

    test("should display 4 status summary cards", async ({ page }) => {
      // `.first()` on each: these words are also the status badge of every
      // product row below, so "Non suivi" alone matched once per product and
      // strict mode refused to choose. The summary tiles come first in the DOM.
      for (const label of ["En stock", "Stock faible", "Rupture", "Non suivi"]) {
        await expect(
          page.getByText(label, { exact: true }).first()
        ).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should display search input", async ({ page }) => {
      await expect(
        page.getByPlaceholder("Rechercher un produit par nom...")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display inventory table or loading state", async ({
      page,
    }) => {
      const table = page.locator("table")
      const loading = page.getByText("Chargement de l'inventaire...")
      const emptyState = page.getByText("Aucun produit trouvé")
      const noStore = page.getByText(
        "Veuillez sélectionner un établissement pour afficher l'inventaire"
      )

      await expect(
        table.or(loading).or(emptyState).or(noStore)
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Status Card Filters", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test('should filter by "En stock" card click', async ({ page }) => {
      // Click the "En stock" status card
      const enStockCard = page
        .getByRole("button")
        .filter({ hasText: "En stock" })
        .first()

      // Only proceed if the card is visible (store selected and data loaded)
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await enStockCard.isVisible({ timeout: 15_000 }).catch(() => false)), "the status summary cards are not on screen")

      await enStockCard.click()
      await page.waitForTimeout(500)

      // Active filters indicator or filtered table should be visible
      const table = page.locator("table")
      const emptyState = page.getByText("Aucun produit trouvé")
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test('should filter by "Stock faible" card click', async ({ page }) => {
      const card = page
        .getByRole("button")
        .filter({ hasText: "Stock faible" })
        .first()

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await card.isVisible({ timeout: 15_000 }).catch(() => false)), "the status summary card is not on screen")

      await card.click()
      await page.waitForTimeout(500)

      const table = page.locator("table")
      const emptyState = page.getByText("Aucun produit trouvé")
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test('should filter by "Rupture" card click', async ({ page }) => {
      const card = page
        .getByRole("button")
        .filter({ hasText: "Rupture" })
        .first()

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await card.isVisible({ timeout: 15_000 }).catch(() => false)), "the status summary card is not on screen")

      await card.click()
      await page.waitForTimeout(500)

      const table = page.locator("table")
      const emptyState = page.getByText("Aucun produit trouvé")
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test('should filter by "Non suivi" card click', async ({ page }) => {
      const card = page
        .getByRole("button")
        .filter({ hasText: "Non suivi" })
        .first()

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await card.isVisible({ timeout: 15_000 }).catch(() => false)), "the status summary card is not on screen")

      await card.click()
      await page.waitForTimeout(500)

      const table = page.locator("table")
      const emptyState = page.getByText("Aucun produit trouvé")
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Search", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should filter products by name", async ({ page }) => {
      await applySearch(page, "Rechercher un produit par nom...", "pizza")
      await page.waitForTimeout(1_000)

      const table = page.locator("table")
      const emptyState = page.getByText("Aucun produit trouvé")
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should show empty state for no matches", async ({ page }) => {
      await applySearch(
        page,
        "Rechercher un produit par nom...",
        "zzzznonexistent99999"
      )
      await page.waitForTimeout(1_000)

      await expect(
        page.getByText("Aucun produit trouvé")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should clear filters with reset button", async ({ page }) => {
      await applySearch(page, "Rechercher un produit par nom...", "test")
      await page.waitForTimeout(1_000)

      const resetButton = page.getByRole("button", {
        name: /[Rr]éinitialiser/,
      })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await resetButton.isVisible({ timeout: 5_000 }).catch(() => false)), "no reset button - no filter is applied")

      await resetButton.click()
      await page.waitForTimeout(500)

      // Search input should be cleared
      const searchInput = page.getByPlaceholder(
        "Rechercher un produit par nom..."
      )
      await expect(searchInput).toHaveValue("")
    })
  })

  test.describe("Inline Editing", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display quantity editor with +/- buttons", async ({
      page,
    }) => {
      const table = page.locator("table")

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 }).catch(() => false)), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      // Only a product that tracks its stock gets the editor — an untracked
      // one shows a dash. Asserting on the first row regardless found zero
      // buttons and read as a missing feature.
      const tracked = rows.filter({ hasNot: page.getByText("Non suivi") })
      const trackedCount = await countAfterLoad(tracked)
      test.skip(
        trackedCount === 0,
        "no product in this store tracks its stock"
      )

      const buttons = tracked.first().getByRole("button")
      expect(await countAfterLoad(buttons)).toBeGreaterThanOrEqual(2)
    })

    test("should display threshold input", async ({ page }) => {
      const table = page.locator("table")

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 }).catch(() => false)), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      // Threshold column should contain an input or editable value
      const thresholdHeader = page.getByText("Seuil alerte", {
        exact: false,
      })
      await expect(thresholdHeader).toBeVisible()
    })

    test("should display auto-disable switch", async ({ page }) => {
      const table = page.locator("table")

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 }).catch(() => false)), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      const autoDisableHeader = page.getByText("Auto-désactivation", {
        exact: false,
      })
      await expect(autoDisableHeader).toBeVisible()
    })

    test("should display tracking switch", async ({ page }) => {
      const table = page.locator("table")

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 }).catch(() => false)), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 1, "the list is empty on this deployment")

      // The column header, not the "Non suivi" badge repeated on each row.
      const trackingHeader = page
        .locator("thead")
        .getByText("Suivi", { exact: true })
      await expect(trackingHeader).toBeVisible()
    })
  })

  test.describe("Pagination", () => {
    test("should display pagination when enough items", async ({ page }) => {
      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const table = page.locator("table")

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 }).catch(() => false)), "this store has no table to inspect")

      // Pagination may or may not appear depending on item count
      const pagination = page.locator("nav[aria-label]").or(
        page.getByRole("button", { name: /[Ss]uivant|[Nn]ext/ })
      )

      // Just verify pagination exists if there are enough rows
      const rows = page.locator("tbody tr")
      const rowCount = await countAfterLoad(rows)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(rowCount < 10, "the list is empty on this deployment")

      await expect(pagination.first()).toBeVisible({ timeout: 5_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/inventory", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Wait for async operations to complete
      await page.waitForTimeout(3_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
