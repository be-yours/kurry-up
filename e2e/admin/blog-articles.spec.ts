import { test, expect, type Locator } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { waitForDialog, getDialog } from "../helpers/dialog.helpers"

/**
 * Skips when the AI generator is not part of the account's plan.
 *
 * The dialog opens either on its form or on "Cette fonctionnalite necessite un
 * abonnement Auto Blog actif", and a gated account only ever sees the second.
 * Asserting on a topic field there is asserting an entitlement.
 */
async function skipIfNoCategory(dialog: Locator) {
  // The create dialog needs at least one blog category: without one it offers
  // to create a category instead of showing the article form, so a test about
  // that form was really a test about the seed data.
  const needsCategory = dialog
    .getByText(/Creer une categorie|Créer une catégorie/)
    .first()
  const form = dialog.getByLabel(/titre/i).first()

  await expect(needsCategory.or(form)).toBeVisible({ timeout: 20_000 })
  test.skip(
    await needsCategory.isVisible().catch(() => false),
    "this store has no blog category yet"
  )
}

async function skipIfGeneratorLocked(dialog: Locator) {
  const locked = dialog.getByText(/abonnement Auto Blog/i).first()
  const form = dialog.getByLabel(/sujet|th[eè]me|topic/i).first()

  await expect(locked.or(form)).toBeVisible({ timeout: 20_000 })
  test.skip(
    await locked.isVisible().catch(() => false),
    "the AI generator is not enabled on this account's plan"
  )
}

test.describe("Blog Articles", () => {
  test.describe("Page Loading", () => {
    test("should load blog articles page", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await expect(
        page.getByRole("heading", { name: /articles|blog/i })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display create article button", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await expect(
        page.getByRole("button", { name: /nouvel|cr[eé]er|ajouter/i }).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display generate article button", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await expect(
        page.getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i }).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Create Article Dialog", () => {
    test("should open create article dialog", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /nouvel|cr[eé]er|ajouter/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog).toBeVisible()
    })

    test("should close create article dialog with Escape", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /nouvel|cr[eé]er|ajouter/i })
        .first()
        .click()

      await waitForDialog(page)

      await page.keyboard.press("Escape")

      await expect(getDialog(page)).toBeHidden({ timeout: 5_000 })
    })

    test("should have required fields in create dialog", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /nouvel|cr[eé]er|ajouter/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await skipIfNoCategory(dialog)

      // Should have a title input
      await expect(
        dialog.getByLabel(/titre/i).or(dialog.getByPlaceholder(/titre/i))
      ).toBeVisible({ timeout: 5_000 })
    })
  })

  test.describe("Generate Article Dialog", () => {
    test("should open generate article dialog", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await expect(dialog).toBeVisible()
    })

    test("should have topic input in generate dialog", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await skipIfGeneratorLocked(dialog)

      // Should have a topic/subject input
      await expect(
        dialog
          .getByLabel(/sujet|th[eè]me|topic/i)
          .or(dialog.getByPlaceholder(/sujet|th[eè]me/i))
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should have tone selector in generate dialog", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await skipIfGeneratorLocked(dialog)

      // Should have a tone selector (radio group or select)
      await expect(
        dialog.getByLabel(/ton|style/i).first()
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should have category selector in generate dialog", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i })
        .first()
        .click()

      const dialog = await waitForDialog(page)
      await skipIfGeneratorLocked(dialog)

      // Should have a category selector
      await expect(
        dialog.getByText(/cat[eé]gorie|langue/i).first()
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should close generate dialog with Escape", async ({ page }) => {
      await page.goto("/dashboard/content/blog", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      await page
        .getByRole("button", { name: /g[eé]n[eé]rer|auto|ia/i })
        .first()
        .click()

      await waitForDialog(page)

      await page.keyboard.press("Escape")

      await expect(getDialog(page)).toBeHidden({ timeout: 5_000 })
    })
  })
})
