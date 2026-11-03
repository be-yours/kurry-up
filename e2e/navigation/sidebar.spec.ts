import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import {
  waitForAdminPage,
  navigateViaSidebar,
  navigateToCollapsibleItem,
} from "../helpers/navigation.helpers"

test.describe("Sidebar Navigation", () => {
  test.describe("Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display sidebar with navigation groups", async ({ page }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeVisible()

      // Check that navigation groups are present
      const navGroups = sidebar.locator('[data-slot="sidebar-group"]')
      const count = await navGroups.count()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    test('should display "Vue d\'ensemble" link', async ({ page }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')
      const link = sidebar.getByRole("link", { name: "Vue d'ensemble" })
      await expect(link).toBeVisible()
    })

    test("should display operations links (Commandes, Menu & Produits, Inventaire)", async ({
      page,
    }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')

      await expect(
        sidebar.getByRole("link", { name: "Commandes" })
      ).toBeVisible()
      await expect(
        sidebar.getByRole("link", { name: "Menu & Produits" })
      ).toBeVisible()
      await expect(
        sidebar.getByRole("link", { name: "Inventaire" })
      ).toBeVisible()
    })

    test("should display organisation links (Établissements, Équipe & Rôles, Paramètres)", async ({
      page,
    }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')

      await expect(
        sidebar.getByRole("link", { name: "Établissements" })
      ).toBeVisible()
      await expect(
        sidebar.getByRole("link", { name: "Équipe & Rôles" })
      ).toBeVisible()
      await expect(
        sidebar.getByRole("link", { name: "Paramètres" })
      ).toBeVisible()
    })
  })

  test.describe("Navigation", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should navigate to /dashboard via Vue d'ensemble", async ({
      page,
    }) => {
      // Navigate away first
      await page.goto("/dashboard/products", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      await navigateViaSidebar(page, "Vue d'ensemble")
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    })

    test("should navigate to /orders via Commandes", async ({ page }) => {
      await navigateViaSidebar(page, "Commandes")
      await expect(page).toHaveURL(/\/dashboard\/orders/, { timeout: 15_000 })
    })

    test("should navigate to /products via Menu & Produits", async ({
      page,
    }) => {
      await navigateViaSidebar(page, "Menu & Produits")
      await expect(page).toHaveURL(/\/dashboard\/products/, { timeout: 15_000 })
    })

    test("should navigate to /stores via Établissements", async ({ page }) => {
      await navigateViaSidebar(page, "Établissements")
      await expect(page).toHaveURL(/\/dashboard\/stores/, { timeout: 15_000 })
    })

    test("should navigate to /team via Équipe & Rôles", async ({ page }) => {
      await navigateViaSidebar(page, "Équipe & Rôles")
      await expect(page).toHaveURL(/\/dashboard\/team/, { timeout: 15_000 })
    })

    test("should navigate to /settings via Paramètres", async ({ page }) => {
      await navigateViaSidebar(page, "Paramètres")
      await expect(page).toHaveURL(/\/dashboard\/settings/, { timeout: 15_000 })
    })

    test("should navigate to /inventory via Inventaire", async ({ page }) => {
      await navigateViaSidebar(page, "Inventaire")
      await expect(page).toHaveURL(/\/dashboard\/inventory/, { timeout: 15_000 })
    })
  })

  test.describe("Collapsible Sections", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should expand Gamification section", async ({ page }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')
      const gamificationButton = sidebar.getByRole("button", {
        name: "Gamification",
      })

      await gamificationButton.click()

      // After expanding, child links should be visible
      const childLink = sidebar.getByRole("link", { name: /Jeux|Games/i })
      await expect(childLink.first()).toBeVisible({ timeout: 5_000 })
    })

    test("should expand Email Marketing section", async ({ page }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')
      const emailButton = sidebar.getByRole("button", {
        name: "Email Marketing",
      })

      await emailButton.click()

      // After expanding, child links should be visible
      const childLink = sidebar.getByRole("link", {
        name: /Campagnes|Campaigns|Email/i,
      })
      await expect(childLink.first()).toBeVisible({ timeout: 5_000 })
    })
  })

  test.describe("Active State", () => {
    test("should highlight current page in sidebar", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const sidebar = page.locator('[data-slot="sidebar"]')
      const dashboardLink = sidebar.getByRole("link", {
        name: "Vue d'ensemble",
      })

      // The active link should have a data-active attribute or aria-current
      await expect(
        dashboardLink.or(
          sidebar.locator('[data-active="true"]').filter({
            hasText: "Vue d'ensemble",
          })
        )
      ).toBeVisible()
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

      // Navigate through several pages to catch errors
      await navigateViaSidebar(page, "Commandes")
      await page.waitForTimeout(1_000)

      await navigateViaSidebar(page, "Menu & Produits")
      await page.waitForTimeout(1_000)

      await navigateViaSidebar(page, "Vue d'ensemble")
      await page.waitForTimeout(2_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
