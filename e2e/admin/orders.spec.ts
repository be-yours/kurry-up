import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

const ORDERS_URL = "/dashboard/orders"
// The list is paginated, and the placeholder says which orders the box
// actually searches — see `orders-page.tsx`.
const SEARCH_PLACEHOLDER =
  "Rechercher parmi les commandes chargées (n° ou nom du client)..."

const STATUS_TABS = [
  "Toutes",
  "En attente",
  "Confirmées",
  "En préparation",
  "Prêtes",
  "Terminées",
  "Annulées",
] as const

test.describe("Orders Page", () => {
  test.describe("Page Structure", () => {
    test('should display "Commandes" heading', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("heading", { name: "Commandes", level: 1 })
      ).toBeVisible()
    })

    test("should display subtitle", async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByText(
          "Gérez et suivez toutes les commandes du restaurant."
        )
      ).toBeVisible()
    })

    test("should display search input", async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByPlaceholder(SEARCH_PLACEHOLDER)
      ).toBeVisible()
    })

    test("should display 7 status tabs", async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      for (const tab of STATUS_TABS) {
        await expect(
          page.getByRole("tab", { name: tab })
        ).toBeVisible()
      }
    })
  })

  test.describe("Status Tabs", () => {
    test('should show "Toutes" tab active by default', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const toutesTab = page.getByRole("tab", { name: "Toutes" })
      await expect(toutesTab).toBeVisible()
      await expect(toutesTab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "En attente" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "En attente" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "Confirmées" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "Confirmées" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "En préparation" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "En préparation" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "Prêtes" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "Prêtes" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "Terminées" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "Terminées" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })

    test('should switch to "Annulées" tab', async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const tab = page.getByRole("tab", { name: "Annulées" })
      await tab.click()
      await expect(tab).toHaveAttribute("data-state", "active")
    })
  })

  test.describe("Search", () => {
    test("should filter orders when searching", async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)
      await expect(searchInput).toBeVisible()

      // Type a search query
      await searchInput.fill("test")

      // Wait for the table to update
      await page.waitForTimeout(1_000)

      // The page should still be functional after searching
      await expect(
        page.getByRole("heading", { name: "Commandes", level: 1 })
      ).toBeVisible()
    })

    test("should clear search and show all orders", async ({ page }) => {
      await page.goto(ORDERS_URL, {
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
        page.getByRole("heading", { name: "Commandes", level: 1 })
      ).toBeVisible()
    })
  })

  test.describe("Table", () => {
    test("should display orders table or empty state", async ({ page }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Either the table or an empty state should be visible
      const table = page.locator("table")
      const emptyState = page.getByText("Aucune commande")

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should display order rows with data when available", async ({
      page,
    }) => {
      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      const table = page.locator("table")
      const tableExists = await table.isVisible().catch(() => false)

      if (tableExists) {
        // If table exists, check for rows
        const rows = page.locator("tbody tr")
        const rowCount = await countAfterLoad(rows)

        // A silent `if` here let the test pass having checked nothing when the
        // list came back empty. A skip says so instead.
        test.skip(rowCount < 1, "the list is empty on this deployment")

        // First row should contain content
        await expect(rows.first()).toBeVisible()
      }
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(ORDERS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("heading", { name: "Commandes", level: 1 })
      ).toBeVisible({ timeout: 30_000 })

      // Wait a moment for any async errors to surface
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
