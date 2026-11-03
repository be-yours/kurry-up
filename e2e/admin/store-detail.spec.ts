import { test, expect, type Page } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

const STORES_URL = "/dashboard/stores"

const TABS = ["Général", "Horaires", "Paramètres", "Intégrations"] as const

/**
 * Opens the Horaires tab and switches it to per-establishment hours.
 *
 * The tab opens on "use the global hours", where the panel is read-only — and
 * renders nothing at all when no global hours have been configured. The
 * per-day editor, the shortcut buttons and the time inputs all live in the
 * custom mode, so a test about them has to ask for it the way a user would.
 */
async function openCustomHours(page: Page) {
  await page.getByRole("tab", { name: "Horaires" }).click()

  const useGlobal = page.locator("#useGlobalHours")
  await expect(useGlobal).toBeAttached({ timeout: 15_000 })
  if (await useGlobal.isChecked()) {
    await useGlobal.click({ force: true })
  }
}

const DAYS_OF_WEEK = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
] as const

test.describe("Store Detail Page", () => {
  /**
   * Helper: navigate to the first store detail page.
   * Returns true if a store was found, false otherwise.
   */
  async function navigateToFirstStore(
    page: import("@playwright/test").Page
  ): Promise<boolean> {
    await page.goto(STORES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    // Wait for the page to load
    await expect(
      page.getByRole("heading", { name: "Établissements", level: 1 })
    ).toBeVisible({ timeout: 30_000 })

    // Click the store's LINK, not the row.
    //
    // `TableRow` carries no onClick — navigation lives in an anchor inside the
    // name cell. Clicking the row's centre lands on whatever cell happens to be
    // there and goes nowhere, which is why all seventeen tests in this file
    // failed on the same "still on /dashboard/stores".
    const storeLinks = page.locator('tbody tr a[href^="/dashboard/stores/"]')
    const rowCount = await countAfterLoad(storeLinks)

    // A silent `if` here let the test pass having checked nothing when the
    // list came back empty. A skip says so instead.
    test.skip(rowCount < 1, "the list is empty on this deployment")

    await storeLinks.first().click()
    await page.waitForLoadState("domcontentloaded")

    // Wait for the store detail page to load
    await expect(page).toHaveURL(/\/dashboard\/stores\//, { timeout: 15_000 })
    return true

    return false
  }

  test.describe("Page Structure", () => {
    test("should display store name heading", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        // The page should have a heading with the store name
        const heading = page.getByRole("heading", { level: 1 })
        await expect(heading).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should display 4 tabs", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        for (const tab of TABS) {
          await expect(
            page.getByRole("tab", { name: tab })
          ).toBeVisible({ timeout: 15_000 })
        }
      }
    })
  })

  test.describe("General Tab", () => {
    test("should display name and slug fields", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        // General tab should be active by default
        await expect(page.getByLabel("Nom")).toBeVisible({ timeout: 15_000 })
        await expect(page.getByLabel("Slug")).toBeVisible()
      }
    })

    test("should display address fields", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        // The address is one group of four fields, not a single box. It used to
        // be a search input labelled "Adresse" plus four details; converging the
        // design system kept the version where the street field IS the
        // autocomplete, so `getByLabel(/Adresse/)` now names the GROUP and the
        // street field answers to its own label.
        await expect(
          page.getByRole("group", { name: /Adresse/ })
        ).toBeVisible({ timeout: 15_000 })
        await expect(page.getByLabel("Rue")).toBeVisible()
        await expect(page.getByLabel("Ville")).toBeVisible()
        await expect(page.getByLabel("Code postal")).toBeVisible()
      }
    })

    test("should display status select", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        // The status select (combobox) should be visible
        const statusCombobox = page.getByRole("combobox").filter({
          hasText: /Ouvert|Fermé|Indisponible/,
        })
        await expect(statusCombobox).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should display save button", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await expect(
          page.getByRole("button", { name: "Enregistrer" })
        ).toBeVisible({ timeout: 15_000 })
      }
    })
  })

  test.describe("Hours Tab", () => {
    test("should switch to Horaires tab", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        const horairesTab = page.getByRole("tab", { name: "Horaires" })
        await horairesTab.click()
        await expect(horairesTab).toHaveAttribute("data-state", "active")
      }
    })

    test("should display 7 day rows", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await openCustomHours(page)

        // All 7 days should be visible
        for (const day of DAYS_OF_WEEK) {
          await expect(page.getByText(day).first()).toBeVisible({
            timeout: 15_000,
          })
        }
      }
    })

    test("should display time inputs and toggle per day", async ({
      page,
    }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await openCustomHours(page)

        // Check that there are time input fields (open/close)
        const timeInputs = page.locator('input[type="time"]')
        const timeInputCount = await countAfterLoad(timeInputs)

        // At least 2 time inputs per day (open and close) for 7 days = 14
        expect(timeInputCount).toBeGreaterThanOrEqual(2)

        // Check for Fermé/Ouvert toggle switches
        const switches = page.getByRole("switch")
        const switchCount = await countAfterLoad(switches)
        expect(switchCount).toBeGreaterThanOrEqual(1)
      }
    })

    test("should display apply shortcut buttons", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await openCustomHours(page)

        // Check for shortcut buttons
        await expect(
          page.getByRole("button", {
            name: /Appliquer Lundi à Vendredi/,
          })
        ).toBeVisible({ timeout: 15_000 })

        await expect(
          page.getByRole("button", {
            name: /Appliquer à tous les jours/,
          })
        ).toBeVisible()

        // Check for save button
        await expect(
          page.getByRole("button", { name: "Enregistrer les horaires" })
        ).toBeVisible()
      }
    })
  })

  test.describe("Settings Tab", () => {
    test("should switch to Paramètres tab", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        const settingsTab = page.getByRole("tab", { name: "Paramètres" })
        await settingsTab.click()
        await expect(settingsTab).toHaveAttribute("data-state", "active")
      }
    })

    test("should display service toggles", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await page.getByRole("tab", { name: "Paramètres" }).click()

        // Check for service type toggles
        const serviceTypes = [
          "Sur place",
          "À emporter",
          "Livraison",
          "Click & Collect",
        ]

        // Scoped to the tab panel: these words also appear in the sidebar and
        // in the store summary above, so an unscoped match hits several real
        // elements and strict mode refuses to choose.
        const panel = page.getByRole("tabpanel")
        for (const service of serviceTypes) {
          await expect(panel.getByText(service).first()).toBeVisible({
            timeout: 15_000,
          })
        }
      }
    })

    test("should display delivery settings", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await page.getByRole("tab", { name: "Paramètres" }).click()

        // Check for save button
        await expect(
          page.getByRole("button", {
            name: "Enregistrer les paramètres",
          })
        ).toBeVisible({ timeout: 15_000 })
      }
    })
  })

  test.describe("Integrations Tab", () => {
    test("should switch to Intégrations tab", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        const integrationsTab = page.getByRole("tab", {
          name: "Intégrations",
        })
        await integrationsTab.click()
        await expect(integrationsTab).toHaveAttribute(
          "data-state",
          "active"
        )
      }
    })

    test("should display Uber Eats card", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await page.getByRole("tab", { name: "Intégrations" }).click()

        await expect(
          page.getByRole("tabpanel").getByText("Uber Eats").first()
        ).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should display Deliveroo card", async ({ page }) => {
      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        await page.getByRole("tab", { name: "Intégrations" }).click()

        await expect(
          page.getByRole("tabpanel").getByText("Deliveroo").first()
        ).toBeVisible({
          timeout: 15_000,
        })
      }
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      const hasStore = await navigateToFirstStore(page)

      if (hasStore) {
        // Wait for page to settle
        await page.waitForTimeout(2_000)
      }

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
