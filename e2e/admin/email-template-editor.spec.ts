import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"

const TEMPLATES_URL = "/dashboard/email/templates"

/**
 * Helper: open the template editor by creating a new template.
 * Returns once the 3-panel editor is visible.
 */
async function createTemplateAndOpenEditor(page: import("@playwright/test").Page) {
  await page.goto(TEMPLATES_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })
  await waitForAdminPage(page)

  // Click "Nouveau modèle" button
  await page.getByRole("button", { name: "Nouveau modèle" }).click()

  // Wait for dialog
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  // Fill out the create form
  await dialog.getByLabel("Nom du modèle *").fill("E2E Test Template")
  await dialog.getByLabel("Objet de l'email *").fill("Objet de test E2E")

  // Submit
  await dialog.getByRole("button", { name: "Créer et éditer" }).click()

  // Wait for dialog to close before checking editor
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

  // Wait for the editor to appear (3-panel layout)
  await expect(
    page.locator("aside").first().getByText("Blocs", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Aucun bloc", { exact: true })).toBeVisible({ timeout: 10_000 })
}

test.describe("Email Template Editor", () => {
  test.describe("Editor Layout", () => {
    test("should display 3-panel layout after creating template", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Left panel: block palette with "Blocs" label
      await expect(
        page.locator("aside").first().getByText("Blocs", { exact: true })
      ).toBeVisible()

      // Center panel: empty state
      await expect(page.getByText("Aucun bloc", { exact: true })).toBeVisible()
      await expect(
        page.getByText("Cliquez sur un bloc dans le panneau gauche")
      ).toBeVisible()

      // Right panel: "Aucun bloc sélectionné"
      await expect(page.getByText("Aucun bloc sélectionné")).toBeVisible()

      // Toolbar: subject and preview fields
      await expect(page.locator("#subject")).toBeVisible()
      await expect(page.locator("#preview-text")).toBeVisible()
    })

    test("should display Back button in toolbar", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await expect(
        page.getByRole("button", { name: "Retour" })
      ).toBeVisible()
    })

    test("should display Save button in toolbar", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await expect(
        page.getByRole("button", { name: "Sauvegarder" })
      ).toBeVisible()
    })
  })

  test.describe("Block Palette", () => {
    test("should display all 19 block types in palette", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      const expectedBlocks = [
        "Texte",
        "Image",
        "Bouton",
        "Produit",
        "Séparateur",
        "Espace",
        "Titre",
        "Réseaux sociaux",
        "Coupon",
        "Colonnes",
        "Vidéo",
        "Hero",
        "Menu vedette",
        "Compte à rebours",
        "Galerie",
        "Localisation",
        "Horaires",
        "Témoignage",
        "Séparateur décoratif",
      ]

      for (const blockLabel of expectedBlocks) {
        await expect(
          page.locator("aside").first().getByText(blockLabel, { exact: true })
        ).toBeVisible()
      }
    })

    test("should add a Text block when clicking Texte in palette", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Click "Texte" in the palette
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()

      // The empty state should disappear
      await expect(page.getByText("Aucun bloc", { exact: true })).toBeHidden({ timeout: 5_000 })

      // Block type label should appear on hover (text block)
      await expect(page.getByText("Bloc texte vide...")).toBeVisible()
    })

    test("should add a Heading block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Titre", { exact: true })
        .click()

      // Heading preview should show the default "Titre" text
      await expect(
        page.locator("main").getByRole("heading", { name: "Titre" })
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should add a Coupon block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Coupon", { exact: true })
        .click()

      // The coupon code "PROMO10" should be visible
      await expect(page.locator("main").getByText("PROMO10")).toBeVisible({
        timeout: 5_000,
      })
    })

    test("should add a Hero block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Hero", { exact: true })
        .click()

      // The hero should show placeholder (no image by default)
      await expect(
        page.locator("main").last().getByText("Hero (aucune image)")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should add a Testimonial block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Témoignage", { exact: true })
        .click()

      await expect(
        page.locator("main").last().getByText("Un excellent restaurant !")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should add an Hours block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Horaires", { exact: true })
        .click()

      await expect(
        page.locator("main").getByText("Nos horaires")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should add a Decorative Divider block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Séparateur décoratif", { exact: true })
        .click()

      // Should show the dots pattern
      await expect(
        page.locator("main").getByText("• • • • • • • • •")
      ).toBeVisible({ timeout: 5_000 })
    })
  })

  test.describe("Block Selection & Configuration", () => {
    test("should show config panel when block is selected", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Add a text block
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()

      // Click on the block to select it
      await page.locator("main").getByText("Bloc texte vide...").click()

      // Config panel should show "Configuration : Texte"
      await expect(
        page.getByText("Configuration : Texte")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should update text block content via config panel", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Add a text block
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()

      // Click to select it
      await page.locator("main").getByText("Bloc texte vide...").click()

      // Type content in the textarea in the config panel (last aside)
      const textarea = page.locator("aside").last().getByRole("textbox").first()
      await textarea.fill("Bonjour, bienvenue dans notre restaurant !")

      // The preview should update
      await expect(
        page
          .locator("main").last()
          .getByText("Bonjour, bienvenue dans notre restaurant !")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should show heading config with level selector", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Titre", { exact: true })
        .click()

      // Click to select the heading block
      await page
        .locator("main")
        .getByRole("heading", { name: "Titre" })
        .click()

      // Config should show level selector
      await expect(
        page.getByText("Configuration : Titre")
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.getByText("Niveau")).toBeVisible()
    })

    test("should show testimonial config with quote and author fields", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Témoignage", { exact: true })
        .click()

      // Click to select
      await page
        .locator("main").last()
        .getByText("Un excellent restaurant !")
        .click()

      await expect(
        page.getByText("Configuration : Témoignage")
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.getByText("Citation")).toBeVisible()
      await expect(page.getByText("Auteur")).toBeVisible()
      await expect(page.getByText("Note (1-5)")).toBeVisible()
    })

    test("should show hours config with rows", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Horaires", { exact: true })
        .click()

      await page.locator("main").getByText("Nos horaires").click()

      await expect(
        page.getByText("Configuration : Horaires")
      ).toBeVisible({ timeout: 5_000 })
      await expect(
        page.getByRole("button", { name: "+ Ajouter un créneau" })
      ).toBeVisible()
    })

    test("should show gallery config with image management", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Galerie", { exact: true })
        .click()

      // Click to select it (empty gallery shows italic text)
      await page
        .locator("main")
        .getByText("Aucune image dans la galerie")
        .click()

      await expect(
        page.getByText("Configuration : Galerie")
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.locator("aside").last().locator("label", { hasText: "Colonnes" })).toBeVisible()
      await expect(
        page.getByRole("button", { name: "+ Ajouter une image" })
      ).toBeVisible()
    })

    test("should show location config with address fields", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Localisation", { exact: true })
        .click()

      // Click to select (empty address shows placeholder)
      await page.locator("main").getByText("Adresse...").click()

      await expect(
        page.getByText("Configuration : Localisation")
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.locator("aside").last().getByText("Adresse")).toBeVisible()
      await expect(page.locator("aside").last().getByText("Ville")).toBeVisible()
      await expect(page.locator("aside").last().getByText("Téléphone")).toBeVisible()
    })

    test("should show decorative divider config with style selector", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      await page
        .locator("aside")
        .first()
        .getByText("Séparateur décoratif", { exact: true })
        .click()

      await page.locator("main").getByText("• • • • • • • • •").click()

      await expect(
        page.getByText("Configuration : Séparateur décoratif")
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.locator("aside").last().getByText("Style")).toBeVisible()
    })
  })

  test.describe("Multiple Blocks", () => {
    test("should add multiple blocks and display them in order", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Add text block
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()

      // Add heading block
      await page
        .locator("aside")
        .first()
        .getByText("Titre", { exact: true })
        .click()

      // Add coupon block
      await page
        .locator("aside")
        .first()
        .getByText("Coupon", { exact: true })
        .click()

      // All three should be visible
      await expect(
        page.locator("main").getByText("Bloc texte vide...")
      ).toBeVisible()
      await expect(
        page.locator("main").getByRole("heading", { name: "Titre" })
      ).toBeVisible()
      await expect(
        page.locator("main").getByText("PROMO10")
      ).toBeVisible()
    })

    test("should remove a block when clicking delete button", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Add a coupon block
      await page
        .locator("aside")
        .first()
        .getByText("Coupon", { exact: true })
        .click()

      await expect(
        page.locator("main").getByText("PROMO10")
      ).toBeVisible({ timeout: 5_000 })

      // Hover over the block to reveal actions
      await page.locator("main").getByText("PROMO10").hover()

      // Click the delete button (✕)
      await page
        .locator("main")
        .locator('button[title="Supprimer"]')
        .click()

      // Block should disappear, empty state should return
      await expect(page.getByText("Aucun bloc", { exact: true })).toBeVisible({
        timeout: 5_000,
      })
    })

    test("should duplicate a block", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      // Add heading block
      await page
        .locator("aside")
        .first()
        .getByText("Titre", { exact: true })
        .click()

      await expect(
        page.locator("main").getByRole("heading", { name: "Titre" })
      ).toHaveCount(1, { timeout: 5_000 })

      // Hover and click duplicate
      await page
        .locator("main")
        .getByRole("heading", { name: "Titre" })
        .hover()

      await page
        .locator("main")
        .getByRole("button", { name: "Dupliquer" })
        .click()

      // Should now have 2 heading blocks
      await expect(
        page.locator("main").getByRole("heading", { name: "Titre" })
      ).toHaveCount(2, { timeout: 5_000 })
    })
  })

  test.describe("HTML Preview Toggle", () => {
    test("should toggle between editor and HTML preview", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      // Add a text block first
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()

      // Click "Aperçu" button to switch to HTML preview
      await page.getByRole("button", { name: "Aperçu" }).click()

      // An iframe should appear for the HTML preview
      await expect(
        page.locator('iframe[title="Aperçu email HTML"]')
      ).toBeVisible({ timeout: 10_000 })

      // The editor canvas should be hidden
      await expect(page.getByText("Bloc texte vide...")).toBeHidden()

      // Click "Éditeur" button to switch back
      await page.getByRole("button", { name: "Éditeur" }).click()

      // The iframe should disappear
      await expect(
        page.locator('iframe[title="Aperçu email HTML"]')
      ).toBeHidden()

      // The editor canvas should be back
      await expect(page.getByText("Bloc texte vide...")).toBeVisible()
    })
  })

  test.describe("Subject & Preview Text", () => {
    test("should update subject line", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      const subjectInput = page.locator("#subject")
      await subjectInput.clear()
      await subjectInput.fill("Nouveau sujet de test")

      // The "Modifications non sauvegardées" indicator should appear
      await expect(
        page.getByText("Modifications non sauvegardées")
      ).toBeVisible({ timeout: 5_000 })
    })

    test("should update preview text", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      const previewInput = page.locator("#preview-text")
      await previewInput.fill("Texte de prévisualisation")

      await expect(
        page.getByText("Modifications non sauvegardées")
      ).toBeVisible({ timeout: 5_000 })
    })
  })

  test.describe("Undo", () => {
    test("should undo block addition", async ({ page }) => {
      await createTemplateAndOpenEditor(page)

      // Add a block
      await page
        .locator("aside")
        .first()
        .getByText("Coupon", { exact: true })
        .click()

      await expect(
        page.locator("main").getByText("PROMO10")
      ).toBeVisible({ timeout: 5_000 })

      // Click undo
      await page.getByTitle("Annuler (Ctrl+Z)").click()

      // The block should be removed
      await expect(page.getByText("Aucun bloc", { exact: true })).toBeVisible({
        timeout: 5_000,
      })
    })
  })

  test.describe("Back Navigation", () => {
    test("should return to templates list when clicking Back", async ({
      page,
    }) => {
      await createTemplateAndOpenEditor(page)

      // Click the Back button
      await page.getByRole("button", { name: "Retour" }).click()

      // Should see the templates list page
      await expect(
        page.getByRole("heading", { level: 1, name: "Modèles d'email" })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors in editor", async ({
      page,
    }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await createTemplateAndOpenEditor(page)

      // Add a few blocks to exercise the editor
      await page
        .locator("aside")
        .first()
        .getByText("Texte", { exact: true })
        .click()
      await page
        .locator("aside")
        .first()
        .getByText("Titre", { exact: true })
        .click()
      await page
        .locator("aside")
        .first()
        .getByText("Coupon", { exact: true })
        .click()

      // Toggle HTML preview
      await page.getByRole("button", { name: "Aperçu" }).click()
      await page.waitForTimeout(2_000)
      await page.getByRole("button", { name: "Éditeur" }).click()

      await page.waitForTimeout(2_000)
      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
