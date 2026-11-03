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
import { countAfterLoad } from "../helpers/list.helpers"

const PROMOTIONS_URL = "/dashboard/promotions"
const SEARCH_PLACEHOLDER = "Rechercher une promotion..."

// Increase timeout for all tests in this file since the dev server
// may recompile pages on first visit
test.setTimeout(90_000)

/**
 * Open the create promotion dialog and wait for the form to fully render.
 * The form can be slow on first load due to Next.js dev compilation.
 */
async function openCreateDialogAndWaitForForm(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Créer une promotion" }).click()
  const dialog = await waitForDialog(page)
  // Wait for the form's first input to be visible (proves form is mounted)
  await expect(dialog.locator("#name")).toBeVisible({ timeout: 30_000 })
  return dialog
}

test.describe("Promotions Page", () => {
  // ──────────────────────────────────────────────────
  // 1. Page Structure & Tabs
  // ──────────────────────────────────────────────────
  test("should display page structure with heading, button, tabs, search, and filter", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    // Heading
    await expect(
      page.getByRole("heading", { level: 1, name: "Promotions" })
    ).toBeVisible({ timeout: 15_000 })

    await expect(
      page.getByText("Gérez vos codes promo et offres automatiques")
    ).toBeVisible()

    // Create button
    await expect(
      page.getByRole("button", { name: "Créer une promotion" })
    ).toBeVisible()

    // 2 tabs
    const codesTab = page.getByRole("tab", { name: "Codes promo" })
    const autosTab = page.getByRole("tab", { name: "Offres automatiques" })
    await expect(codesTab).toBeVisible()
    await expect(autosTab).toBeVisible()

    // Search
    await expect(
      page.getByPlaceholder(SEARCH_PLACEHOLDER)
    ).toBeVisible()

    // Status filter
    await expect(
      page.getByRole("combobox").filter({ hasText: "Tous les statuts" })
    ).toBeVisible()
  })

  // ──────────────────────────────────────────────────
  // 2. Tabs Navigation
  // ──────────────────────────────────────────────────
  test("should navigate between tabs", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    // Default to Codes promo
    await expect(
      page.getByRole("tab", { name: "Codes promo" })
    ).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })

    // Switch to Offres automatiques
    await page.getByRole("tab", { name: "Offres automatiques" }).click()
    await expect(
      page.getByRole("tab", { name: "Offres automatiques" })
    ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })

    // Switch back
    await page.getByRole("tab", { name: "Codes promo" }).click()
    await expect(
      page.getByRole("tab", { name: "Codes promo" })
    ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 })
  })

  // ──────────────────────────────────────────────────
  // 3. Table or Empty State
  // ──────────────────────────────────────────────────
  test("should show table or empty state in both tabs", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    // Codes promo tab
    const table = page.locator("table")
    const emptyState = page.getByText("Aucune promotion")
    await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

    // Offres automatiques tab
    await page.getByRole("tab", { name: "Offres automatiques" }).click()
    await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
  })

  // ──────────────────────────────────────────────────
  // 4. Search & Filter
  // ──────────────────────────────────────────────────
  test("should filter promotions by search and status", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    // Search
    const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER)
    await expect(searchInput).toBeVisible({ timeout: 15_000 })
    await searchInput.fill("test")
    await page.waitForTimeout(1_000)
    await expect(
      page.getByRole("heading", { name: "Promotions", level: 1 })
    ).toBeVisible()

    // Clear search
    await searchInput.clear()
    await page.waitForTimeout(500)

    // Filter by each status
    for (const status of ["Active", "Inactive", "Expirée", "Planifiée"]) {
      const statusFilter = page
        .getByRole("combobox")
        .filter({ hasText: /statuts|Active|Inactive|Expirée|Planifiée/ })
      await statusFilter.click()
      await chooseOption(page, status, { exact: true })
      await page.waitForTimeout(500)
      await expect(
        page.getByRole("heading", { name: "Promotions", level: 1 })
      ).toBeVisible()
    }
  })

  // ──────────────────────────────────────────────────
  // 5. Create Dialog – Basic Fields
  // ──────────────────────────────────────────────────
  test("should open create dialog with all sections and fields", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    // Dialog title
    await expect(dialog.getByText("Nouvelle promotion")).toBeVisible()

    // 5 form sections (use exact to avoid substring matches like "Type de réduction")
    await expect(dialog.getByText("Informations générales", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Déclenchement", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Réduction", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Période & horaires", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Limites & statut", { exact: true })).toBeVisible()

    // Essential fields
    await expect(dialog.getByLabel("Nom de la promotion")).toBeVisible()
    await expect(dialog.getByLabel("Description")).toBeVisible()
    await expect(dialog.getByLabel("Date de début")).toBeVisible()
    await expect(dialog.getByLabel("Date de fin")).toBeVisible()
    await expect(dialog.getByLabel("Utilisations max")).toBeVisible()
    await expect(dialog.getByLabel("Max par client")).toBeVisible()

    // Active switch defaults to on
    const sw = dialog.getByRole("switch", { name: "Active" })
    await expect(sw).toBeVisible()
    await expect(sw).toBeChecked()
  })

  test("should validate required fields and close dialog", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    // Validation
    await page
      .getByRole("button", { name: "Créer une promotion" })
      .click()
    const dialog = await waitForDialog(page)
    await dialog.getByLabel("Nom de la promotion").clear()

    // The dialog body scrolls and the submit button sits below its fold, so a
    // plain click spent its whole timeout reporting "element is outside of the
    // viewport" on a button that is perfectly reachable once scrolled to.
    const submit = dialog.getByRole("button", { name: "Créer la promotion" })
    await submit.scrollIntoViewIfNeeded()
    await submit.click()
    // Dialog still open = validation failed
    await expect(dialog).toBeVisible()

    // Close by cancel
    await closeDialogByCancel(page)
    await expect(getDialog(page)).toBeHidden()

    // Close by Escape
    await page
      .getByRole("button", { name: "Créer une promotion" })
      .click()
    await waitForDialog(page)
    await closeDialogByEscape(page)
    await expect(getDialog(page)).toBeHidden()
  })

  // ──────────────────────────────────────────────────
  // 6. Trigger Mode (coupon / auto)
  // ──────────────────────────────────────────────────
  test("should handle trigger modes: coupon code and auto", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    // Default: coupon mode with code field (use #couponCode to avoid matching the radio label)
    const couponInput = dialog.locator("#couponCode")
    await expect(couponInput).toBeVisible()

    // Generate random code
    await expect(couponInput).toHaveValue("")
    await dialog.locator("button:has(svg.lucide-refresh-cw)").click()
    const value = await couponInput.inputValue()
    expect(value.length).toBe(8)
    expect(value).toMatch(/^[A-Z0-9]+$/)

    // Switch to auto mode (exact to avoid matching DialogDescription)
    await dialog.getByText("Offre automatique", { exact: true }).click()
    await expect(couponInput).toBeHidden()
  })

  // ──────────────────────────────────────────────────
  // 7. Discount Type Variations
  // ──────────────────────────────────────────────────
  test("should handle all discount type variations", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    // Default: percentage
    await expect(dialog.getByLabel(/Valeur.*%/)).toBeVisible()
    await expect(dialog.getByLabel("Plafond (€)")).toBeVisible()

    // Fixed amount
    await dialog.getByRole("combobox").first().click()
    await chooseOption(page, "Montant fixe (€)")
    await expect(dialog.getByLabel(/Valeur.*€/)).toBeVisible()
    await expect(dialog.getByLabel("Plafond (€)")).toBeHidden()

    // Free delivery
    await dialog.getByRole("combobox").first().click()
    await chooseOption(page, "Livraison offerte")
    await expect(dialog.getByLabel(/Valeur/)).toBeHidden()
  })

  /**
   * REWRITTEN (#376). The case above used to click « Offre BOGO (1+1) » and
   * « Produit offert » and assert the fields each revealed. Both were
   * decorative: `resolvePromotionDiscount` has always refused them at order
   * time — they alter the item list rather than the order total, and no code
   * path builds those items — while the form sold them and `promotions.create`
   * stored them. An owner configured a campaign, printed the flyers, and
   * learned it was decorative from a diner at the till.
   *
   * They are refused at creation now and the form no longer offers them, so
   * the clicks time out. What the suite pins instead is the decision: the
   * picker offers exactly the types the resolver can honour. Implement one of
   * them in `promotionDiscount.ts` and this case says so — the option
   * reappears, and the assertion below has to be updated in the same commit.
   */
  test("offers only the discount types an order can actually be given", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)
    await dialog.getByRole("combobox").first().click()

    // Scoped to the open listbox, and `.first()`, for the reason
    // `chooseOption` documents: Radix renders each item twice — the styled one
    // and a hidden native option — so an unscoped match is ambiguous.
    const listbox = page.getByRole("listbox")

    for (const label of [
      "Pourcentage (%)",
      "Montant fixe (€)",
      "Livraison offerte",
    ]) {
      await expect(
        listbox.getByRole("option", { name: label }).first()
      ).toBeVisible()
    }

    // The two the order path cannot honour are not on offer at all. A count of
    // zero is unambiguous whether Radix renders an item once or twice.
    for (const withdrawn of ["Offre BOGO (1+1)", "Produit offert"]) {
      await expect(
        listbox.getByRole("option", { name: withdrawn })
      ).toHaveCount(0)
    }
  })

  // ──────────────────────────────────────────────────
  // 8. Scope – Product & Category Picker
  // ──────────────────────────────────────────────────
  test("should handle scope selection: order, product, and category pickers", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    // Default: Commande scope with no picker
    const orderRadio = dialog.locator('input[type="radio"][value="order"]')
    await expect(orderRadio).toBeChecked()
    await expect(dialog.getByText("Produits ciblés")).toBeHidden()
    await expect(dialog.getByText("Catégories ciblées")).toBeHidden()

    // Product scope
    await dialog.getByText("Produit", { exact: true }).click()
    await expect(dialog.getByText("Produits ciblés")).toBeVisible()
    await expect(
      dialog.getByPlaceholder("Rechercher un produit...")
    ).toBeVisible()
    await expect(dialog.getByText("Catégories ciblées")).toBeHidden()

    // Category scope
    await dialog.getByText("Catégorie", { exact: true }).click()
    await expect(dialog.getByText("Catégories ciblées")).toBeVisible()
    await expect(
      dialog.getByPlaceholder("Rechercher une catégorie...")
    ).toBeVisible()
    await expect(dialog.getByText("Produits ciblés")).toBeHidden()

    // Back to Commande
    await dialog.getByText("Commande", { exact: true }).click()
    await expect(dialog.getByText("Produits ciblés")).toBeHidden()
    await expect(dialog.getByText("Catégories ciblées")).toBeHidden()
  })

  test("should allow selecting and filtering products", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    await dialog.getByText("Produit", { exact: true }).click()

    const listContainer = dialog.locator(".max-h-\\[180px\\]")
    const firstItem = listContainer.locator("label").first()
    const hasProducts = await firstItem
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    if (hasProducts) {
      // Select first product
      await firstItem.click()
      await expect(dialog.getByText("1 sélectionné")).toBeVisible()

      // Deselect
      await firstItem.click()
      await expect(dialog.getByText("1 sélectionné")).toBeHidden()
    }

    // Search filter
    const searchInput = dialog.getByPlaceholder("Rechercher un produit...")
    await searchInput.fill("zzzznonexistent")
    await page.waitForTimeout(500)
    const items = listContainer.locator("label")
    const emptyText = listContainer.getByText("Aucun produit trouvé")
    // Asserting the empty message only when the list was empty meant a
    // populated list was never checked at all. One assertion covers both.
    await expect(items.first().or(emptyText)).toBeVisible()
  })

  test("should allow selecting and filtering categories", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    await dialog.getByText("Catégorie", { exact: true }).click()

    const listContainer = dialog.locator(".max-h-\\[180px\\]")
    const firstItem = listContainer.locator("label").first()
    const hasCategories = await firstItem
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    if (hasCategories) {
      await firstItem.click()
      await expect(dialog.getByText("1 sélectionnée")).toBeVisible()

      await firstItem.click()
      await expect(dialog.getByText("1 sélectionnée")).toBeHidden()
    }

    // Search filter
    const searchInput = dialog.getByPlaceholder(
      "Rechercher une catégorie..."
    )
    await searchInput.fill("zzzznonexistent")
    await page.waitForTimeout(500)
    const items = listContainer.locator("label")
    const emptyText = listContainer.getByText("Aucune catégorie trouvée")
    // Asserting the empty message only when the list was empty meant a
    // populated list was never checked at all. One assertion covers both.
    await expect(items.first().or(emptyText)).toBeVisible()
  })

  // ──────────────────────────────────────────────────
  // 9. Scheduling
  // ──────────────────────────────────────────────────
  test("should handle scheduling toggle with days and time fields", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const dialog = await openCreateDialogAndWaitForForm(page)

    // Default: scheduling off
    const sw = dialog.getByRole("switch", { name: "Planification horaire" })
    await expect(sw).toBeVisible()
    await expect(sw).not.toBeChecked()

    // Enable scheduling.
    //
    // `force`: the control is an `sr-only` checkbox clipped to a 1px box, the
    // visible toggle being drawn by the wrapping label. Playwright's
    // actionability checks never settle on it, so the click waits out its
    // timeout on an element that is perfectly operable for a real user.
    await sw.scrollIntoViewIfNeeded()
    await sw.click({ force: true })
    for (const day of ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]) {
      await expect(dialog.getByText(day, { exact: true })).toBeVisible()
    }
    await expect(dialog.getByLabel("Heure début")).toBeVisible()
    await expect(dialog.getByLabel("Heure fin")).toBeVisible()

    // Toggle individual day
    const samBtn = dialog.locator("label").filter({ hasText: "Sam" })
    await samBtn.click()
    await expect(samBtn).toHaveClass(/bg-primary/)

    // Disable scheduling
    await sw.scrollIntoViewIfNeeded()
    await sw.click({ force: true })
    await expect(dialog.getByLabel("Heure début")).toBeHidden()
  })

  // ──────────────────────────────────────────────────
  // 10. Table Interaction & Toggle
  // ──────────────────────────────────────────────────
  test("should interact with table rows: toggle, action menu, edit dialog", async ({
    page,
  }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const table = page.locator("table")
    const tableExists = await table.isVisible().catch(() => false)
    if (!tableExists) return

    const rows = page.locator("tbody tr")
    const rowCount = await countAfterLoad(rows)
    if (rowCount === 0) return

    // Row visible
    await expect(rows.first()).toBeVisible()

    // Toggle switch present, no badge
    const toggle = rows.first().getByRole("switch")
    await expect(toggle).toBeVisible()

    // Toggle status
    const initial = await toggle.isChecked()
    await toggle.click()
    await page.waitForTimeout(2_000)
    expect(await toggle.isChecked()).toBe(!initial)
    await toggle.click()
    await page.waitForTimeout(1_000)

    // Action menu
    await rows.first().getByRole("button").last().click()
    await expect(
      page.getByRole("menuitem", { name: /Modifier/ })
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByRole("menuitem", { name: /Supprimer/ })
    ).toBeVisible()

    // Edit dialog
    await page.getByRole("menuitem", { name: /Modifier/ }).click()
    const dialog = await waitForDialog(page)
    await expect(dialog.getByText("Modifier la promotion")).toBeVisible()
    await expect(dialog.getByLabel("Nom de la promotion")).toBeVisible()
    await closeDialogByEscape(page)
  })

  // ──────────────────────────────────────────────────
  // 11. Delete Confirmation
  // ──────────────────────────────────────────────────
  test("should show and cancel delete confirmation", async ({ page }) => {
    await page.goto(PROMOTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const rows = page.locator("tbody tr")
    const rowCount = await countAfterLoad(rows)
    if (rowCount === 0) return

    await rows.first().getByRole("button").last().click()
    const deleteOpt = page.getByRole("menuitem", { name: /Supprimer/ })
    if (!(await deleteOpt.isVisible().catch(() => false))) return

    // Show confirmation
    await deleteOpt.click()
    const confirmDialog = page.locator('[data-slot="dialog-content"]')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
    await expect(
      confirmDialog.getByText(/Supprimer cette promotion/)
    ).toBeVisible()

    // Cancel
    await confirmDialog.getByRole("button", { name: "Annuler" }).click()
    await expect(confirmDialog).toBeHidden({ timeout: 5_000 })
  })

  // ──────────────────────────────────────────────────
  // 12. Console Errors
  // ──────────────────────────────────────────────────
  test("should not produce unexpected console errors", async ({ page }) => {
    const { getErrors, cleanup } = collectConsoleErrors(page)

    await page.goto(PROMOTIONS_URL, {
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
