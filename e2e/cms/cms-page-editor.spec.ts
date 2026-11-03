import { test, expect } from "@playwright/test"
import {
  waitForAdminPage,
} from "../helpers/navigation.helpers"

test.describe("CMS Page Editor", () => {
  test.describe("Pages List", () => {
    test("should display CMS pages list", async ({ page }) => {
      await page.goto("/dashboard/content/pages", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display the heading
      await expect(page.getByRole("heading", { name: "Pages" })).toBeVisible()

      // One table per page group, so the list is several tables, not one.
      const table = page.locator("table").first()
      await expect(table).toBeVisible({ timeout: 15_000 })
    })

    test("should navigate to page editor on row click", async ({ page }) => {
      await page.goto("/dashboard/content/pages", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Click on first "Modifier" button
      const modifierButton = page
        .getByRole("button", { name: "Modifier" })
        .first()
      await expect(modifierButton).toBeVisible({ timeout: 15_000 })
      await modifierButton.click()

      // Should navigate to a page editor (URL should contain a slug after /content/pages/)
      await page.waitForURL("**/content/pages/*", { timeout: 15_000 })
      expect(page.url()).toMatch(/\/content\/pages\/[a-z-]+/)
    })
  })

  test.describe("Page Editor", () => {
    test("should load sign-in page editor", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display page title (h1)
      await expect(
        page.getByRole("heading", { level: 1, name: /connexion/i }),
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display block accordions", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display block sections (collapsible)
      const sections = page.locator("[data-state]")
      await expect(sections.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should have publish button", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should have a publish button (either "Publier" or "Traduction...")
      await expect(
        page.getByRole("button", { name: /publier|traduction/i }),
      ).toBeVisible({ timeout: 15_000 })
    })

    /* « Aperçu » IS TWO CONTROLS, AND BOTH ARE ASSERTED (#630). It used to be
       one link on every page, falling back to `/${pageSlug}` — and `homepage`
       is the only page in the registry that declares a `route`, so the other
       nineteen previewed into a 404. The editor now renders a link where there
       is an address and a disabled button, carrying its reason, where there is
       not. A test for the link alone would pass on a regression that gave the
       404 back to all twenty. */
    test("previews a page that has a public address", async ({ page }) => {
      await page.goto("/dashboard/content/pages/homepage", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      const previewLink = page.getByRole("link", { name: /aperçu/i })
      await expect(previewLink).toBeVisible({ timeout: 15_000 })
      await expect(previewLink).toHaveAttribute("href", /\/preview\/homepage/)
    })

    test("offers no preview for a page that has none, and says why", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Still on screen, so the absence is legible rather than a missing
      // control an owner would hunt for.
      const preview = page.getByRole("button", { name: /aperçu/i })
      await expect(preview).toBeVisible({ timeout: 15_000 })
      await expect(preview).toBeDisabled()
      await expect(preview).toHaveAttribute("title", /adresse publique/i)

      // And it is not a link, which is the regression this pins.
      await expect(page.getByRole("link", { name: /aperçu/i })).toHaveCount(0)
    })

    test("should display block labels from registry", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // sign-in page has two blocks: "Section principale" (hero) and "Formulaire de connexion" (form)
      await expect(
        page.getByText("Section principale"),
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Formulaire de connexion"),
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display field labels from registry", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Sign-in page hero block fields (exact match to avoid "Titre du formulaire")
      await expect(page.getByText("Titre", { exact: true })).toBeVisible({
        timeout: 15_000,
      })
      await expect(page.getByText("Sous-titre", { exact: true })).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Autosave", () => {
    test("should show save status after editing a field", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Use placeholder-based selector (shadcn inputs may not have explicit type="text")
      const textInput = page
        .getByPlaceholder("Laisser vide pour utiliser la valeur par défaut")
        .first()
      await expect(textInput).toBeVisible({ timeout: 15_000 })

      const originalValue = await textInput.inputValue()
      await textInput.fill("Test autosave E2E")

      // Wait for autosave debounce (1.5s)
      await page.waitForTimeout(2_000)

      // Should show some save indicator (checkmark or "Enregistré")
      const savedIndicator = page.getByText(/enregistré|sauvegardé/i)
      // Addressed by a data attribute, not by a colour class. The two palette
      // classes this used to name are exactly what #410 routes through the
      // token layer, and a selector written against a palette is one that rots
      // silently the next time the palette moves.
      const checkIcon = page.locator("[data-save-status='saved']")

      const hasSavedText = await savedIndicator
        .isVisible({ timeout: 5_000 })
        .catch(() => false)
      const hasCheckIcon = await checkIcon
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)

      // At least one indicator should appear
      expect(hasSavedText || hasCheckIcon).toBe(true)

      // Restore original value
      await textInput.fill(originalValue || "Connexion")
      await page.waitForTimeout(2_000)
    })
  })

  test.describe("SEO Block", () => {
    test("should display SEO block on homepage editor", async ({ page }) => {
      await page.goto("/dashboard/content/pages/homepage", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Homepage should have an SEO block (from seoBlock registry)
      await expect(page.getByText("SEO")).toBeVisible({ timeout: 15_000 })
    })

    test("should display SEO fields on menu page", async ({ page }) => {
      await page.goto("/dashboard/content/pages/menu", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Menu page should have SEO block with meta title and description
      await expect(page.getByText("SEO")).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByText("Meta Title"),
      ).toBeVisible({ timeout: 10_000 })
      await expect(
        page.getByText("Meta Description"),
      ).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe("Reset", () => {
    test("should have reset buttons on fields", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Wait for the blocks to load first, exactly as the sibling test below
      // already does. `count()` is a one-shot read that does not retry, so
      // counting straight after `waitForAdminPage` counted a page whose CMS
      // fields had not arrived yet and reported zero buttons as a missing
      // feature.
      await expect(
        page.getByText("Section principale"),
      ).toBeVisible({ timeout: 15_000 })

      // Each field should have a "Réinitialiser" button
      const resetButtons = page.getByRole("button", {
        name: /réinitialiser$/i,
      })
      await expect(resetButtons.first()).toBeVisible({ timeout: 10_000 })
      expect(await resetButtons.count()).toBeGreaterThan(0)
    })

    test("should have block-level reset button", async ({ page }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Wait for blocks to load first
      await expect(
        page.getByText("Section principale"),
      ).toBeVisible({ timeout: 15_000 })

      // Should have "Réinitialiser le bloc" buttons
      const blockResetButtons = page.getByRole("button", {
        name: /réinitialiser le bloc/i,
      })
      await expect(blockResetButtons.first()).toBeVisible({ timeout: 10_000 })
      const count = await blockResetButtons.count()
      expect(count).toBeGreaterThan(0)
    })
  })
})
