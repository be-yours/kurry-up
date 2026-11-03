import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByCancel,
  getDialog,
} from "../helpers/dialog.helpers"

/**
 * Gamification admin — split IA:
 *  /dashboard/games            overview (stats + setup links + latest plays)
 *  /dashboard/games/catalog    games & prizes CRUD
 *  /dashboard/games/qr-codes   printable QR codes
 *  /dashboard/games/actions    required social actions CRUD
 *  /dashboard/games/winners    stats + redemption validation
 */

test.describe("Gamification", () => {
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

  test.describe("Overview", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/games", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Gamification" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Vos clients scannent, jouent, reviennent")
      ).toBeVisible()
    })

    test("should display the pulse stats", async ({ page }) => {
      await expect(page.getByText("Parties jouées")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText("Victoires")).toBeVisible()
      await expect(page.getByText("Scans QR")).toBeVisible()
      await expect(page.getByText("Lots à valider")).toBeVisible()
    })

    test("should link to the four setup surfaces", async ({ page }) => {
      // Scoped to the page content: the sidebar links to these same four
      // routes, so an unscoped lookup matches twice and Playwright refuses.
      // This is the first test in a `serial` block, so its failure took
      // eleven others with it.
      const content = page.locator('[data-tour="main-content"]')

      await expect(
        content.getByRole("link", { name: /Jeux & Lots/ })
      ).toBeVisible({ timeout: 15_000 })
      await expect(content.getByRole("link", { name: /Codes QR/ })).toBeVisible()
      await expect(
        content.getByRole("link", { name: /Actions requises/ })
      ).toBeVisible()
      await expect(content.getByRole("link", { name: /Gagnants/ })).toBeVisible()
    })

    test("should show latest plays section", async ({ page }) => {
      await expect(page.getByText("Dernières parties")).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Catalog (games & prizes)", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/games/catalog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and both sections", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Jeux & Lots" })
      ).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText("Jeux", { exact: true }).first()).toBeVisible()
      await expect(page.getByText("Lots à gagner")).toBeVisible()
    })

    test("should open the game creation dialog with its fields", async ({ page }) => {
      await page.getByRole("button", { name: "Créer un jeu" }).click()
      const dialog = await waitForDialog(page)

      await expect(dialog.getByText("Nouveau jeu")).toBeVisible()
      await expect(dialog.getByLabel("Nom du jeu")).toBeVisible()
      await expect(dialog.getByText("Type", { exact: false })).toBeVisible()
      await expect(dialog.getByLabel("Description")).toBeVisible()
      await expect(dialog.getByText("Ratio de victoire")).toBeVisible()
      await expect(dialog.getByRole("slider")).toBeVisible()
      await expect(dialog.getByText(/%/).first()).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Créer le jeu" })).toBeVisible()
    })

    test("game dialog should close on cancel", async ({ page }) => {
      await page.getByRole("button", { name: "Créer un jeu" }).click()
      await waitForDialog(page)

      await closeDialogByCancel(page)

      await expect(getDialog(page)).toBeHidden()
    })

    test("should open the prize creation dialog with its fields", async ({ page }) => {
      await page.getByRole("button", { name: "Créer un lot" }).click()
      const dialog = await waitForDialog(page)

      await expect(dialog.getByText("Nouveau lot")).toBeVisible()
      await expect(dialog.getByLabel("Nom du lot")).toBeVisible()
      await expect(dialog.getByLabel("Validité (jours)")).toBeVisible()
      await expect(dialog.getByLabel("Quantité")).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Créer le lot" })).toBeVisible()
    })
  })

  test.describe("QR codes", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/games/qr-codes", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and create button", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Codes QR" })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByRole("button", { name: "Créer un code QR" })
      ).toBeVisible()
    })

    test("should open the creation dialog with table and code fields", async ({ page }) => {
      await page.getByRole("button", { name: "Créer un code QR" }).click()
      const dialog = await waitForDialog(page)

      await expect(dialog.getByText("Nouveau code QR")).toBeVisible()
      await expect(dialog.getByLabel("Numéro de table")).toBeVisible()
      await expect(dialog.getByLabel("Emplacement")).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Générer" })).toBeVisible()

      await closeDialogByCancel(page)
      await expect(getDialog(page)).toBeHidden()
    })

    test("should show QR cards or the empty state", async ({ page }) => {
      const qrCard = page.getByRole("button", { name: "PNG" }).first()
      const emptyState = page.getByText("Aucun code QR")

      await expect(qrCard.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Winners", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/games/winners", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading, stats and validation input", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Gagnants" })
      ).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText("Valider un lot")).toBeVisible()
      await expect(page.getByPlaceholder(/K7NP2XWQ/)).toBeVisible()
    })
  })

  test.describe("Required actions", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/games/actions", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and create button", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Actions requises" })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByRole("button", { name: "Ajouter une action" })
      ).toBeVisible()
    })

    test("should open the creation dialog", async ({ page }) => {
      await page.getByRole("button", { name: "Ajouter une action" }).click()
      const dialog = await waitForDialog(page)

      await expect(dialog.getByText("Nouvelle action")).toBeVisible()
      await expect(dialog.getByLabel("Nom affiché")).toBeVisible()
      await expect(dialog.getByLabel("Lien")).toBeVisible()

      await closeDialogByCancel(page)
      await expect(getDialog(page)).toBeHidden()
    })
  })
})
