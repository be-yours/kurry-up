import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import {
  waitForAdminPage,
  navigateViaSidebar,
} from "../helpers/navigation.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

test.describe("Dashboard Page", () => {
  test.describe("Page Loading", () => {
    test("should load dashboard after authentication", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // The dashboard should be visible with main content
      await expect(page.locator("main")).toBeVisible()
    })

    test("should display skeleton while data loads", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Either the skeleton or the loaded content should appear
      const skeleton = page.locator(".animate-pulse")
      const mainContent = page.locator("main")

      await expect(skeleton.first().or(mainContent)).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display stat cards section", async ({ page }) => {
      // Expect at least 4 stat cards (revenue, order count, average basket, active orders)
      const statCards = page.locator('[data-slot="card"]')
      await expect(statCards.first()).toBeVisible({ timeout: 15_000 })

      const count = await statCards.count()
      expect(count).toBeGreaterThanOrEqual(4)
    })

    test("should display chart section", async ({ page }) => {
      // The recharts bar chart container or a section heading for the chart
      const chartSection = page
        .locator(".recharts-responsive-container")
        .or(page.getByText("Commandes des 7 derniers jours"))
        .or(page.getByText("Commandes"))

      await expect(chartSection.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should display order breakdown section", async ({ page }) => {
      // The section is always there; its slices are not. With no orders the
      // chart renders "Aucune donnée", so asserting only on Livraison /
      // À emporter / Sur place made this a test about the seed data rather
      // than about the dashboard.
      await expect(
        page.getByText("Par type de commande")
      ).toBeVisible({ timeout: 15_000 })

      const breakdownSection = page
        .getByText("Livraison")
        .or(page.getByText("À emporter"))
        .or(page.getByText("Sur place"))
        .or(page.getByText("Aucune donnée"))

      await expect(breakdownSection.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should display recent orders table", async ({ page }) => {
      // The recent orders section should have a table or an empty state
      const ordersTable = page.locator("table")
      /*
       * The recent-orders empty state, by its OWN words.
       *
       * This was `getByText("Aucune commande")`, a substring — and « Aucune
       * commande » is a phrase more than one panel on this dashboard has a
       * reason to say. The « Heures de pointe » card says « Aucune commande sur
       * la période », so the loose locator resolved to two elements and
       * Playwright's strict mode failed the assertion rather than the product
       * failing. Anchored to the exact sentence `recent-orders-table.tsx:79`
       * prints.
       */
      const emptyState = page.getByText("Aucune commande pour le moment")

      await expect(ordersTable.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should display quick actions section", async ({ page }) => {
      // Quick actions section with action buttons/links
      const quickActions = page
        .getByText("Actions rapides")
        .or(page.getByRole("link", { name: /produit/i }))

      await expect(quickActions.first()).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Stats", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display numeric values in stat cards", async ({ page }) => {
      // Stat cards should contain numeric values (currency, count, etc.)
      const statCards = page.locator('[data-slot="card"]')

      // `allTextContents()` is a snapshot, like `count()`: it read the cards the
      // instant the first one appeared, before their figures had arrived, and
      // found no digit. Filtering and asserting polls until a card actually
      // carries a number — which is what the test is about.
      await expect(
        statCards.filter({ hasText: /\d/ }).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display 7-day chart with day labels", async ({ page }) => {
      // The chart should have day labels (Mon, Tue... or Lun, Mar... in French)
      const chartContainer = page.locator(".recharts-responsive-container")

      // Either the chart renders or we see day labels in the chart area
      const chartOrLabels = chartContainer.or(
        page.getByText(/Lun|Mar|Mer|Jeu|Ven|Sam|Dim/)
      )
      await expect(chartOrLabels.first()).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Recent Orders", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display table with order data or empty state", async ({
      page,
    }) => {
      const ordersTable = page.locator("table")
      /*
       * The recent-orders empty state, by its OWN words.
       *
       * This was `getByText("Aucune commande")`, a substring — and « Aucune
       * commande » is a phrase more than one panel on this dashboard has a
       * reason to say. The « Heures de pointe » card says « Aucune commande sur
       * la période », so the loose locator resolved to two elements and
       * Playwright's strict mode failed the assertion rather than the product
       * failing. Anchored to the exact sentence `recent-orders-table.tsx:79`
       * prints.
       */
      const emptyState = page.getByText("Aucune commande pour le moment")

      await expect(ordersTable.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // If table is visible, it should have at most 10 rows
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await ordersTable.isVisible({ timeout: 15_000 })), "the dashboard shows no orders table")

      const rowCount = await page.locator("tbody tr").count()
      expect(rowCount).toBeLessThanOrEqual(10)
    })

    test("should display order number, customer, amount in table", async ({
      page,
    }) => {
      const ordersTable = page.locator("table")
      /*
       * The recent-orders empty state, by its OWN words.
       *
       * This was `getByText("Aucune commande")`, a substring — and « Aucune
       * commande » is a phrase more than one panel on this dashboard has a
       * reason to say. The « Heures de pointe » card says « Aucune commande sur
       * la période », so the loose locator resolved to two elements and
       * Playwright's strict mode failed the assertion rather than the product
       * failing. Anchored to the exact sentence `recent-orders-table.tsx:79`
       * prints.
       */
      const emptyState = page.getByText("Aucune commande pour le moment")

      await expect(ordersTable.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // If table exists with rows, check for expected column content
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await ordersTable.isVisible({ timeout: 15_000 })), "the dashboard shows no orders table")

      const rows = page.locator("tbody tr")
      const rowCount = await rows.count()

      // A silent `if` here let the test finish green having asserted nothing
      // when the list came back empty. A skip states the gap instead.
      test.skip(rowCount === 0, "the list is empty on this deployment")

      // First row should contain data cells
      const firstRow = rows.first()
      const cells = firstRow.locator("td")
      const cellCount = await countAfterLoad(cells)
      expect(cellCount).toBeGreaterThanOrEqual(3)
    })
  })

  test.describe("Navigation", () => {
    test('should be accessible via sidebar "Vue d\'ensemble"', async ({
      page,
    }) => {
      // Navigate to a different page first
      await page.goto("/dashboard/products", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Navigate back to dashboard via sidebar
      await navigateViaSidebar(page, "Vue d'ensemble")

      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Wait a bit for any async operations to complete
      await page.waitForTimeout(3_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
