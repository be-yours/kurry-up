import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"

test.describe("Settings Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Paramètres Globaux" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText(
          "Définissez les valeurs par défaut héritées par tous les établissements"
        )
      ).toBeVisible()
    })

    test("should display 5 tabs with icons", async ({ page }) => {
      await expect(
        page.getByRole("tab", { name: "Général" })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByRole("tab", { name: "Horaires" })
      ).toBeVisible()
      await expect(
        page.getByRole("tab", { name: "Livraison" })
      ).toBeVisible()
      await expect(
        page.getByRole("tab", { name: "Paiements" })
      ).toBeVisible()
      await expect(
        page.getByRole("tab", { name: "Intégrations" })
      ).toBeVisible()
    })
  })

  test.describe("General Tab", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display currency select, and say it is not applied", async ({
      page,
    }) => {
      // `exact: true` matches the <Label> and nothing else. A substring match
      // now resolves to three nodes — the label, the "Indisponible" badge
      // beside it, and the sentence below that legitimately says "devise"
      // twice — and strict mode refuses to choose between them.
      await expect(
        page.getByText("Devise", { exact: true })
      ).toBeVisible({ timeout: 15_000 })

      // The picker stores a currency the storefront never reads, so it is
      // deliberately inert. If someone re-enables it without wiring the
      // storefront's formatPrice call sites, this is what fails.
      await expect(page.getByLabel("Devise")).toBeDisabled()
      await expect(
        page.getByText("affiche encore tous les prix en euros", {
          exact: false,
        })
      ).toBeVisible()
    })

    test("should display timezone select", async ({ page }) => {
      await expect(
        page.getByText("Fuseau horaire", { exact: false })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display TVA input", async ({ page }) => {
      await expect(
        page.getByLabel("TVA (%)")
          .or(page.getByText("TVA", { exact: false }))
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display service toggles", async ({ page }) => {
      // Check for service type toggles within the General tab panel
      const generalPanel = page.getByRole("tabpanel")
      await expect(
        generalPanel.getByText("Sur place", { exact: false })
      ).toBeVisible({ timeout: 15_000 })
      // Exact, because the Click & Collect note below these switches points
      // the owner at « À emporter » by name.
      await expect(
        generalPanel.getByText("À emporter", { exact: true })
      ).toBeVisible()
      await expect(
        generalPanel.getByText("Livraison", { exact: true }).first()
      ).toBeVisible()
      await expect(
        generalPanel.getByText("Click & Collect", { exact: true })
      ).toBeVisible()

      // Present but inert: ORDER_TYPE_SERVICE maps the three real order types
      // onto the switches above and never reads this one.
      await expect(generalPanel.getByLabel("Click & Collect")).toBeDisabled()
    })

    test("should display save button", async ({ page }) => {
      await expect(
        page.getByRole("button", {
          name: "Enregistrer les paramètres généraux",
        })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Hours Tab", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should switch to Horaires tab", async ({ page }) => {
      await page.getByRole("tab", { name: "Horaires" }).click()

      await expect(
        page.getByRole("tab", { name: "Horaires" })
      ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })
    })

    test("should display 7 day rows", async ({ page }) => {
      await page.getByRole("tab", { name: "Horaires" }).click()

      const days = [
        "Lundi",
        "Mardi",
        "Mercredi",
        "Jeudi",
        "Vendredi",
        "Samedi",
        "Dimanche",
      ]

      for (const day of days) {
        await expect(
          page.getByText(day, { exact: false })
        ).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should display shortcut buttons", async ({ page }) => {
      await page.getByRole("tab", { name: "Horaires" }).click()

      await expect(
        page.getByRole("button", { name: "Lun-Ven même horaire" })
          .or(page.getByText("Lun-Ven même horaire"))
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByRole("button", { name: "Tous les jours" })
          .or(page.getByText("Tous les jours"))
      ).toBeVisible()
    })
  })

  test.describe("Delivery Tab", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should switch to Livraison tab", async ({ page }) => {
      await page.getByRole("tab", { name: "Livraison" }).click()

      await expect(
        page.getByRole("tab", { name: "Livraison" })
      ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })
    })

    test("should display fee mode options", async ({ page }) => {
      await page.getByRole("tab", { name: "Livraison" }).click()

      await expect(
        page.getByText("Prix fixe", { exact: true }).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display radius and free-above inputs", async ({ page }) => {
      await page.getByRole("tab", { name: "Livraison" }).click()

      await expect(
        page.getByText("Rayon de livraison", { exact: false })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Livraison gratuite à partir de", { exact: false })
      ).toBeVisible()
    })

    test("should display save button", async ({ page }) => {
      await page.getByRole("tab", { name: "Livraison" }).click()

      await expect(
        page.getByRole("button", {
          name: "Enregistrer les paramètres de livraison",
        })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Payments Tab", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should switch to Paiements tab", async ({ page }) => {
      await page.getByRole("tab", { name: "Paiements" }).click()

      await expect(
        page.getByRole("tab", { name: "Paiements" })
      ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })
    })

    test("should display Stripe and SumUp provider cards", async ({
      page,
    }) => {
      await page.getByRole("tab", { name: "Paiements" }).click()

      await expect(
        page.getByText("Stripe", { exact: false })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("SumUp", { exact: false })
      ).toBeVisible()
    })

    test("should display PayPal toggle", async ({ page }) => {
      await page.getByRole("tab", { name: "Paiements" }).click()

      await expect(
        page.getByText("PayPal", { exact: true }).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display cash toggle", async ({ page }) => {
      await page.getByRole("tab", { name: "Paiements" }).click()

      await expect(
        page.getByText("Cash", { exact: false })
          .or(page.getByText("Espèces", { exact: false }))
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Integrations Tab", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/settings", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should switch to Intégrations tab", async ({ page }) => {
      await page.getByRole("tab", { name: "Intégrations" }).click()

      await expect(
        page.getByRole("tab", { name: "Intégrations" })
      ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })
    })

    test("should display Uber Direct fields", async ({ page }) => {
      await page.getByRole("tab", { name: "Intégrations" }).click()

      await expect(
        page.getByRole("heading", { name: "Uber Direct" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByRole("textbox", { name: /Customer ID/ })
      ).toBeVisible()
    })

    test("should display Uber Eats section", async ({ page }) => {
      await page.getByRole("tab", { name: "Intégrations" }).click()

      await expect(
        page.getByRole("heading", { name: "Uber Eats" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display Deliveroo section", async ({ page }) => {
      await page.getByRole("tab", { name: "Intégrations" }).click()

      await expect(
        page.getByRole("heading", { name: "Deliveroo" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display save button", async ({ page }) => {
      await page.getByRole("tab", { name: "Intégrations" }).click()

      await expect(
        page.getByRole("button", {
          name: "Enregistrer les intégrations",
        })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/settings", {
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
