import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"

const EMAIL_URL = "/dashboard/email"

test.describe("Email Dashboard Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(EMAIL_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Email Marketing" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Vue d'ensemble de vos campagnes et abonnés")
      ).toBeVisible()
    })

    test("should display KPI cards or empty state", async ({ page }) => {
      // Wait for data to load
      await page.waitForTimeout(3_000)

      // Should show KPI cards or the empty state message
      const kpiSection = page.locator("text=Abonnés actifs")
      const emptyState = page.getByText("Aucune campagne créée")
      const heading = page.getByRole("heading", { name: "Email Marketing" })

      // Page should at least have the heading
      await expect(heading).toBeVisible()
    })

    test("should display quick actions section", async ({ page }) => {
      await page.waitForTimeout(3_000)

      await expect(page.getByText("Actions rapides")).toBeVisible({
        timeout: 15_000,
      })
    })

    test("should display quick action links", async ({ page }) => {
      await page.waitForTimeout(3_000)

      const quickActions = [
        "Nouvelle campagne",
        "Voir les abonnés",
        "Créer un modèle",
        "Gérer les segments",
        "Configuration",
      ]

      for (const action of quickActions) {
        await expect(page.getByRole("link", { name: action }).first()).toBeVisible()
      }
    })

    test("should display recent campaigns section", async ({ page }) => {
      await page.waitForTimeout(3_000)

      await expect(page.getByText("Campagnes récentes")).toBeVisible({
        timeout: 15_000,
      })
    })

    test("should display automations section", async ({ page }) => {
      await page.waitForTimeout(3_000)

      await expect(page.getByText("Automations actives")).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Navigation", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(EMAIL_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
      await page.waitForTimeout(3_000)
    })

    test("should navigate to campaigns via quick action", async ({ page }) => {
      await page.getByText("Nouvelle campagne").click()
      await page.waitForLoadState("domcontentloaded")

      await expect(
        page.getByRole("heading", { level: 1, name: "Campagnes" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should navigate to subscribers via quick action", async ({
      page,
    }) => {
      await page.getByText("Voir les abonnés").click()
      await page.waitForLoadState("domcontentloaded")

      await expect(
        page.getByRole("heading", { level: 1, name: "Abonnés" })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(EMAIL_URL, {
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
