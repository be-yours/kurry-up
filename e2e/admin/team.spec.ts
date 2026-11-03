import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  waitForDialog,
  closeDialogByCancel,
  closeDialogByEscape,
  getDialog,
} from "../helpers/dialog.helpers"
import { applySearch, selectFilter } from "../helpers/filter.helpers"
import {
  getTableHeaders,
  clickRowActionMenu,
  clickDropdownItem,
  findRowByText,
} from "../helpers/table.helpers"

test.describe("Team Page", () => {
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

  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Gestion de l'équipe" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText(
          "Gérez les membres de votre équipe, leurs rôles et permissions"
        )
      ).toBeVisible()
    })

    test('should display "Inviter un membre" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Inviter un membre" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display search and filter inputs", async ({ page }) => {
      // Search input
      await expect(
        page.getByPlaceholder("Rechercher par nom ou email...")
      ).toBeVisible({ timeout: 15_000 })

      // Status filter
      const statusFilter = page
        .getByRole("combobox")
        .filter({ hasText: "Tous les statuts" })
      await expect(statusFilter).toBeVisible()

      // Role filter
      const roleFilter = page
        .getByRole("combobox")
        .filter({ hasText: "Tous les rôles" })
      await expect(roleFilter).toBeVisible()
    })

    test("should display team table with correct columns", async ({
      page,
    }) => {
      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 })), "this store has no table to inspect")

      const headers = await getTableHeaders(page)
      expect(headers).toEqual(
        expect.arrayContaining([
          "Membre",
          "Rôle",
          "Statut",
          "Périmètre",
          "Date d'ajout",
        ])
      )
    })
  })

  test.describe("Search & Filters", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should filter by name", async ({ page }) => {
      await applySearch(page, "Rechercher par nom ou email...", "test")
      // Wait for filter to apply
      await page.waitForTimeout(1_000)

      // Either filtered results or empty state should be visible
      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should filter by status", async ({ page }) => {
      await selectFilter(page, "Tous les statuts", "Actifs")
      await page.waitForTimeout(1_000)

      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should filter by role", async ({ page }) => {
      await selectFilter(page, "Tous les rôles", "Manager")
      await page.waitForTimeout(1_000)

      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))
      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })
    })

    test("should show empty state for no matches", async ({ page }) => {
      await applySearch(
        page,
        "Rechercher par nom ou email...",
        "zzzznonexistent99999"
      )
      await page.waitForTimeout(1_000)

      await expect(
        page
          .getByText("Aucun membre")
          .or(page.getByText("Aucun résultat"))
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Invite Member Dialog", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should open invite dialog", async ({ page }) => {
      await page.getByRole("button", { name: "Inviter un membre" }).click()
      const dialog = await waitForDialog(page)

      await expect(
        dialog.getByText("Inviter un membre")
      ).toBeVisible()
    })

    test("should display all form fields (name, email, role, permissions)", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "Inviter un membre" }).click()
      const dialog = await waitForDialog(page)

      // Name field
      await expect(dialog.getByLabel("Nom complet")).toBeVisible()

      // Email field
      await expect(dialog.getByLabel("Email")).toBeVisible()

      // Role select
      await expect(dialog.getByText("Rôle")).toBeVisible()

      // Submit button
      await expect(
        dialog.getByRole("button", { name: "Envoyer l'invitation" })
      ).toBeVisible()
    })

    test("should display permission checkboxes", async ({ page }) => {
      await page.getByRole("button", { name: "Inviter un membre" }).click()
      const dialog = await waitForDialog(page)

      const permissions = [
        "Dashboard",
        "Commandes",
        "Produits / Menu",
        "Cuisine (KDS)",
        "Équipe",
        "Paramètres",
        "Intégrations",
        "Jeux / Marketing",
      ]

      for (const perm of permissions) {
        await expect(dialog.getByText(perm, { exact: false })).toBeVisible()
      }
    })

    test("should close on cancel", async ({ page }) => {
      await page.getByRole("button", { name: "Inviter un membre" }).click()
      await waitForDialog(page)

      await closeDialogByCancel(page)

      await expect(getDialog(page)).toBeHidden()
    })

    test("should close on Escape", async ({ page }) => {
      await page.getByRole("button", { name: "Inviter un membre" }).click()
      await waitForDialog(page)

      await closeDialogByEscape(page)

      await expect(getDialog(page)).toBeHidden()
    })
  })

  test.describe("Row Actions", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display action dropdown menu on row", async ({ page }) => {
      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // Only test if table has rows
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 })), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await rows.count()

      // A silent `if` here let the test finish green having asserted nothing
      // when the list came back empty. A skip states the gap instead.
      test.skip(rowCount === 0, "the list is empty on this deployment")

      // Click the action menu on the first row
      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      // Dropdown menu should appear
      await expect(
        page.getByRole("menuitem").first()
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should show Modifier, Renvoyer, Désactiver, Supprimer options", async ({
      page,
    }) => {
      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 })), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await rows.count()

      // A silent `if` here let the test finish green having asserted nothing
      // when the list came back empty. A skip states the gap instead.
      test.skip(rowCount === 0, "the list is empty on this deployment")

      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      await expect(
        page.getByRole("menuitem", { name: "Modifier" })
      ).toBeVisible({ timeout: 5_000 })
      await expect(
        page.getByRole("menuitem", { name: "Renvoyer l'invitation" })
          .or(page.getByRole("menuitem", { name: "Désactiver" }))
          .or(page.getByRole("menuitem", { name: "Activer" }))
      ).toBeVisible()
      await expect(
        page.getByRole("menuitem", { name: "Supprimer" })
      ).toBeVisible()
    })
  })

  test.describe("Edit Dialog", () => {
    test("should open edit dialog from row action", async ({ page }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 })), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await rows.count()

      // A silent `if` here let the test finish green having asserted nothing
      // when the list came back empty. A skip states the gap instead.
      test.skip(rowCount === 0, "the list is empty on this deployment")

      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      await clickDropdownItem(page, "Modifier")

      const dialog = await waitForDialog(page)
      await expect(
        dialog.getByText("Modifier le membre")
      ).toBeVisible()
    })
  })

  test.describe("Delete Dialog", () => {
    test("should open delete confirmation from row action", async ({
      page,
    }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const table = page.locator("table")
      const emptyState = page
        .getByText("Aucun membre")
        .or(page.getByText("Aucun résultat"))

      await expect(table.or(emptyState)).toBeVisible({ timeout: 15_000 })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await table.isVisible({ timeout: 15_000 })), "this store has no table to inspect")

      const rows = page.locator("tbody tr")
      const rowCount = await rows.count()

      // A silent `if` here let the test finish green having asserted nothing
      // when the list came back empty. A skip states the gap instead.
      test.skip(rowCount === 0, "the list is empty on this deployment")

      const actionButton = rows.first().getByRole("button").last()
      await actionButton.click()

      await clickDropdownItem(page, "Supprimer")

      const dialog = await waitForDialog(page)
      await expect(
        dialog.getByText("Supprimer le membre")
      ).toBeVisible()
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/team", {
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
