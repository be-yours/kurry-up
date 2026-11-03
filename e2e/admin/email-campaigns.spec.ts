import { test, expect, type Page } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByEscape,
  getDialog,
} from "../helpers/dialog.helpers"

const CAMPAIGNS_URL = "/dashboard/email/campaigns"

/**
 * Skips when the store has no sender address configured.
 *
 * "Nouvelle campagne" is deliberately disabled until then — the page says so in
 * an amber banner — so the wizard tests were waiting thirty seconds on a button
 * that is correct to refuse the click. A missing configuration is a state to
 * recognise, not a failure to report.
 */
async function skipIfEmailUnconfigured(page: Page) {
  const banner = page.getByText("Configuration email requise")
  const createButton = page.getByRole("button", { name: "Nouvelle campagne" })

  // Wait for the page to settle before deciding, for the same reason as
  // `campaignTable` below: a five-second one-shot read on the banner answered
  // "not there" while the page was still loading, so the guard concluded the
  // store was configured and the test went on to click a disabled button.
  await expect(banner.or(createButton).first()).toBeVisible({ timeout: 30_000 })

  test.skip(
    await banner.isVisible().catch(() => false),
    "no sender address configured for this store"
  )
}

/**
 * Returns the campaign table once the page has settled, or skips.
 *
 * The seven dropdown tests each opened with
 *
 *   const hasTable = await table.isVisible({ timeout: 5_000 }).catch(() => false)
 *   test.skip(!hasTable, "No campaigns in table to test")
 *
 * which is a one-shot read, not an assertion: it does not retry. Five seconds
 * is also less than the Convex query needs on a busy machine, so the check ran
 * while the page was still empty, concluded there were no campaigns, and the
 * tests excused themselves — three of them in one run, a different three in the
 * next.
 *
 * Waiting for the page to settle on one of its two real shapes — a table, or
 * "Aucune campagne" — removes the race. The skip then means what it says.
 */
async function campaignTable(page: Page) {
  const table = page.locator("table")
  const empty = page.getByText("Aucune campagne").first()

  await expect(table.or(empty).first()).toBeVisible({ timeout: 30_000 })

  test.skip(
    !(await table.isVisible().catch(() => false)),
    "this store has no campaign to act on"
  )
  return table
}

test.describe("Email Campaigns Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CAMPAIGNS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Campagnes" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test('should display "Nouvelle campagne" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Nouvelle campagne" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display search input", async ({ page }) => {
      await expect(
        page.getByPlaceholder("Rechercher une campagne...")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display status filter", async ({ page }) => {
      await expect(
        page.getByRole("combobox").filter({ hasText: "Tous les statuts" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display table or empty state", async ({ page }) => {
      const table = page.locator("table")
      const emptyState = page.getByText("Aucune campagne")

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Campaign Wizard", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CAMPAIGNS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
      await skipIfEmailUnconfigured(page)
    })

    test("should open wizard dialog when clicking create button", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: "Nouvelle campagne" })
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText("Nouvelle campagne")).toBeVisible()
    })

    test("should display wizard steps", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouvelle campagne" })
        .click()

      const dialog = await waitForDialog(page)

      // First step should show information fields
      await expect(dialog.getByText("Informations")).toBeVisible()
    })

    test("should display form fields in first step", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouvelle campagne" })
        .click()

      const dialog = await waitForDialog(page)

      await expect(dialog.getByLabel(/Nom de la campagne/)).toBeVisible()
      await expect(dialog.getByLabel(/Objet/)).toBeVisible()
    })

    test("should close wizard on Escape", async ({ page }) => {
      await page
        .getByRole("button", { name: "Nouvelle campagne" })
        .click()

      await waitForDialog(page)
      await closeDialogByEscape(page)

      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("Search & Filter", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CAMPAIGNS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should filter campaigns by search", async ({ page }) => {
      const searchInput = page.getByPlaceholder("Rechercher une campagne...")
      await expect(searchInput).toBeVisible({ timeout: 15_000 })

      await searchInput.fill("test")
      await page.waitForTimeout(1_000)

      await expect(
        page.getByRole("heading", { name: "Campagnes", level: 1 })
      ).toBeVisible()
    })

    test("should clear search", async ({ page }) => {
      const searchInput = page.getByPlaceholder("Rechercher une campagne...")
      await expect(searchInput).toBeVisible({ timeout: 15_000 })

      await searchInput.fill("test")
      await page.waitForTimeout(500)
      await searchInput.clear()
      await page.waitForTimeout(500)

      await expect(
        page.getByRole("heading", { name: "Campagnes", level: 1 })
      ).toBeVisible()
    })
  })

  test.describe("Campaign Actions (Dropdown Menu)", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CAMPAIGNS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display dropdown menu on campaign row", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      // Dropdown should contain common actions
      await expect(page.getByRole("menuitem", { name: "Aperçu" })).toBeVisible({ timeout: 5_000 })
      await expect(page.getByRole("menuitem", { name: "Envoyer un test" })).toBeVisible()
      await expect(page.getByRole("menuitem", { name: "Dupliquer" })).toBeVisible()
    })

    test("should open send test dialog from dropdown", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Envoyer un test" }).click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText("Envoyer un email test")).toBeVisible()
      await expect(dialog.getByLabel("Adresse email de test")).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Envoyer le test" })).toBeVisible()
    })

    test("should validate email in send test dialog", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Envoyer un test" }).click()

      const dialog = await waitForDialog(page)
      const sendButton = dialog.getByRole("button", { name: "Envoyer le test" })

      // Button should be disabled with empty email
      await expect(sendButton).toBeDisabled()

      // Fill invalid email (no @)
      await dialog.getByLabel("Adresse email de test").fill("invalid")
      await expect(sendButton).toBeDisabled()

      // Fill valid email
      await dialog.getByLabel("Adresse email de test").fill("test@example.com")
      await expect(sendButton).toBeEnabled()
    })

    test("should close send test dialog on cancel", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Envoyer un test" }).click()
      await waitForDialog(page)

      await page.getByRole("button", { name: "Annuler" }).click()
      await expect(getDialog(page)).toBeHidden({ timeout: 5_000 })
    })

    test("should open preview dialog from dropdown", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Aperçu" }).click()

      const dialog = await waitForDialog(page)
      await expect(dialog.getByText(/Aperçu/)).toBeVisible()
      await expect(dialog.getByText(/Objet :/)).toBeVisible()
    })

    test("should toggle desktop/mobile preview", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Aperçu" }).click()

      const dialog = await waitForDialog(page)

      // Should have desktop and mobile toggle buttons
      const buttons = dialog.locator("button[class*='h-7']")
      await expect(buttons).toHaveCount(2)

      // Check iframe exists (may show content or error depending on template)
      const iframe = dialog.locator("iframe")
      const errorMsg = dialog.getByText("Modèle introuvable")
      await expect(iframe.or(errorMsg)).toBeVisible({ timeout: 5_000 })
    })

    test("should close preview dialog on escape", async ({ page }) => {
      const table = await campaignTable(page)

      const firstRow = table.locator("tbody tr").first()
      const menuButton = firstRow.getByRole("button").last()
      await menuButton.click()

      await page.getByRole("menuitem", { name: "Aperçu" }).click()
      await waitForDialog(page)

      await closeDialogByEscape(page)
      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(CAMPAIGNS_URL, {
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
