import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

test.describe("Product Form", () => {
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

  test.describe("New Product Page", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/new", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test('should display "Créer un produit" heading', async ({ page }) => {
      await expect(
        page.getByRole("heading", { name: "Créer un produit" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display back button to /products", async ({ page }) => {
      // The back button/link should navigate to /products
      // Scoped to the page content: the sidebar also links to
      // /dashboard/products, so an unscoped lookup matched both it and the
      // breadcrumb. First test of a `serial` block — sixteen others never ran.
      const backLink = page
        .locator('[data-tour="main-content"]')
        .locator('a[href="/dashboard/products"]')
        .first()

      await expect(backLink).toBeVisible({ timeout: 15_000 })
    })

    test("should display 5 form tabs: General, Options, Stock, Planification, Allergenes", async ({
      page,
    }) => {
      await expect(
        page.getByRole("tab", { name: "General" }).or(
          page.getByRole("tab", { name: "Général" })
        )
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByRole("tab", { name: "Options" })
      ).toBeVisible()

      await expect(
        page.getByRole("tab", { name: "Stock" })
      ).toBeVisible()

      await expect(
        page.getByRole("tab", { name: "Planification" })
      ).toBeVisible()

      // The allergen tab is the one a restaurateur needs to meet the INCO
      // 1169/2011 disclosure. It did not exist: `allergens` was declared in the
      // form's zod schema and defaulted to `[]`, and no control rendered it.
      await expect(
        page.getByRole("tab", { name: "Allergènes" })
      ).toBeVisible()
    })

    test("should display form fields on General tab (name, slug, category, price)", async ({
      page,
    }) => {
      // Name field
      await expect(
        page.getByLabel("Nom du produit")
      ).toBeVisible({ timeout: 15_000 })

      // Slug field. The label reads "Identifiant technique" since #626 took the
      // field out of the required set: nothing resolves a product by slug —
      // `products.getBySlug` is registered in neither app and the only product
      // route is `[productId]` — so a label saying "Slug" promised an address
      // that does not exist. The field itself stays, generated from the name.
      await expect(page.getByLabel("Identifiant technique")).toBeVisible()

      // Category select
      await expect(
        page.getByLabel("Catégorie").or(
          page.getByRole("combobox").filter({ hasText: /catégorie/i })
        )
      ).toBeVisible()

      // Price field. The label is "Prix TTC (€)" since prices became the
      // amount the customer pays, with the VAT taken out rather than added —
      // the same work that put "dont TVA" on the storefront summary. `TTC` is
      // load-bearing here and not decoration: the form carries a second field,
      // "Prix barré TTC (€)", so a looser /Prix.*\(€\)/ would match both and
      // fail on strict mode.
      await expect(page.getByLabel(/Prix TTC \(€\)/)).toBeVisible()
    })

    test("should auto-generate slug from name", async ({ page }) => {
      const nameInput = page.getByLabel("Nom du produit")
      await expect(nameInput).toBeVisible({ timeout: 15_000 })

      // Type a product name
      await nameInput.fill("Pizza Margherita")

      // Wait for slug auto-generation
      await page.waitForTimeout(500)

      // Slug should be auto-generated from the name
      const slugInput = page.getByLabel("Identifiant technique")
      await expect(slugInput).toHaveValue(/pizza-margherita/i, {
        timeout: 5_000,
      })
    })

    test("should validate required fields", async ({ page }) => {
      // Try to submit the form without filling required fields
      const submitButton = page.getByRole("button", {
        name: "Créer un produit",
      })
      await expect(submitButton).toBeVisible({ timeout: 15_000 })

      await submitButton.click()

      // Validation errors should appear for required fields
      // Look for any validation message or error indication
      // Each side of this chain is plural — a form shows one message per
      // invalid field — so the chain has to resolve to one before it can be
      // asserted on.
      const validationError = page
        .getByText(/obligatoire|requis|required/i)
        .or(page.locator('[data-slot="form-message"]'))
        .or(page.locator('[role="alert"]'))
        .first()

      await expect(validationError).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe("Form Tabs", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/new", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should switch to Options tab", async ({ page }) => {
      const optionsTab = page.getByRole("tab", { name: "Options" })
      await expect(optionsTab).toBeVisible({ timeout: 15_000 })

      await optionsTab.click()

      await expect(optionsTab).toHaveAttribute("aria-selected", "true")
    })

    test('should display "Ajouter une option" button on Options tab', async ({
      page,
    }) => {
      const optionsTab = page.getByRole("tab", { name: "Options" })
      await expect(optionsTab).toBeVisible({ timeout: 15_000 })
      await optionsTab.click()

      await expect(
        page.getByRole("button", { name: "Ajouter une option" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should switch to Stock tab", async ({ page }) => {
      const stockTab = page.getByRole("tab", { name: "Stock" })
      await expect(stockTab).toBeVisible({ timeout: 15_000 })

      await stockTab.click()

      await expect(stockTab).toHaveAttribute("aria-selected", "true")
    })

    test("should display stock tracking toggle", async ({ page }) => {
      const stockTab = page.getByRole("tab", { name: "Stock" })
      await expect(stockTab).toBeVisible({ timeout: 15_000 })
      await stockTab.click()

      await expect(
        page
          .getByRole("switch", { name: /stock/i })
          .or(page.getByText("Suivre le stock de ce produit"))
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should switch to Planification tab", async ({ page }) => {
      const planTab = page.getByRole("tab", { name: "Planification" })
      await expect(planTab).toBeVisible({ timeout: 15_000 })

      await planTab.click()

      await expect(planTab).toHaveAttribute("aria-selected", "true")
    })

    test("should display scheduling fields", async ({ page }) => {
      const planTab = page.getByRole("tab", { name: "Planification" })
      await expect(planTab).toBeVisible({ timeout: 15_000 })
      await planTab.click()

      // Scheduling fields for availability dates
      await expect(
        page.getByText("Disponible à partir de").first()
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Disponible jusqu'à").first()
      ).toBeVisible()
    })
  })

  test.describe("Options Management", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/new", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Navigate to Options tab
      const optionsTab = page.getByRole("tab", { name: "Options" })
      await expect(optionsTab).toBeVisible({ timeout: 15_000 })
      await optionsTab.click()
    })

    test("should add a new option group", async ({ page }) => {
      const addOptionButton = page.getByRole("button", {
        name: "Ajouter une option",
      })
      await expect(addOptionButton).toBeVisible({ timeout: 15_000 })

      await addOptionButton.click()

      // A new option group form should appear with a name input
      const optionNameInput = page
        .getByPlaceholder(/nom de l'option|taille|sauce/i)
        .or(page.getByLabel(/nom de l'option/i))

      await expect(optionNameInput.first()).toBeVisible({ timeout: 10_000 })
    })

    test("should add choices to an option", async ({ page }) => {
      const addOptionButton = page.getByRole("button", {
        name: "Ajouter une option",
      })
      await expect(addOptionButton).toBeVisible({ timeout: 15_000 })

      await addOptionButton.click()

      // Exact names, because the component renders exactly these strings
      // (packages/admin/src/pages/products/product-form.tsx). What this
      // replaces guessed at a page nobody had opened: a button matching
      // /ajouter un choix|ajouter/i minus anything containing "option", then
      // `.first()`, then an input matched by /nom du choix|choix/i `.or()` a
      // label /choix/i — which would also accept the "Choix" section heading.
      // Loose enough that a failure said "not visible" without saying of what,
      // and `.first()` silently picked whichever element happened to be first.
      //
      // No `.first()` now either: one option group has exactly one add-choice
      // button, so a second match is a defect and Playwright should say so
      // rather than choose.
      const addChoiceButton = page.getByRole("button", {
        name: "Ajouter un choix",
      })
      await expect(addChoiceButton).toBeVisible({ timeout: 10_000 })

      await addChoiceButton.click()

      // The choice row the click is supposed to produce, by the placeholder the
      // component gives its name field.
      await expect(page.getByPlaceholder("Nom du choix")).toBeVisible({
        timeout: 10_000,
      })
    })

    test("should remove an option group", async ({ page }) => {
      const addOptionButton = page.getByRole("button", {
        name: "Ajouter une option",
      })
      await expect(addOptionButton).toBeVisible({ timeout: 15_000 })

      // Add an option group first
      await addOptionButton.click()

      // Wait for option group to appear
      await page.waitForTimeout(500)

      // Look for the remove/delete button on the option group
      const removeButton = page
        .getByRole("button", { name: /supprimer|retirer/i })
        .or(page.locator('button[aria-label*="supprimer" i]'))
        .or(page.locator('button:has(svg)').filter({ hasText: "" }).last())

      // Count option groups before removal
      const optionNameInputs = page
        .getByPlaceholder(/nom de l'option|taille|sauce/i)
        .or(page.getByLabel(/nom de l'option/i))

      const countBefore = await countAfterLoad(optionNameInputs)

      if (countBefore > 0 && (await removeButton.first().isVisible())) {
        await removeButton.first().click()

        // Wait for removal animation
        await page.waitForTimeout(500)

        const countAfter = await countAfterLoad(optionNameInputs)
        expect(countAfter).toBeLessThan(countBefore)
      }
    })
  })

  test.describe("Stock Management", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/new", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Navigate to Stock tab
      const stockTab = page.getByRole("tab", { name: "Stock" })
      await expect(stockTab).toBeVisible({ timeout: 15_000 })
      await stockTab.click()
    })

    test("should show quantity fields when tracking enabled", async ({
      page,
    }) => {
      // Find and enable the stock tracking toggle
      const stockToggle = page
        // The input is `sr-only` — visually hidden by design, the visible
        // toggle being drawn by the wrapping label. Playwright never reports an
        // sr-only element as visible, so asserting on the control could not
        // work whatever its ARIA role. Target what the user sees and clicks,
        // exactly as the sibling test at :168 already does.
        .getByText("Suivre le stock de ce produit")

      await expect(stockToggle).toBeVisible({ timeout: 15_000 })

      // State read from the input, not the label: `getAttribute` on a label
      // always returns null, so this branch was decorative — it clicked every
      // time and merely happened to be right.
      const stockInput = page.locator("#stock-tracked")
      if (!(await stockInput.isChecked())) {
        await stockToggle.click()
      }

      // Quantity and threshold fields should be visible
      await expect(
        page
          .getByLabel(/quantité/i)
          .or(page.getByPlaceholder(/quantité/i))
          .first()
      ).toBeVisible({ timeout: 10_000 })

      await expect(
        // The label and its visible text are two matches for the same field.
        page
          .getByLabel(/seuil/i)
          .or(page.getByText("Seuil de stock faible"))
          .first()
      ).toBeVisible()
    })

    test("should hide quantity fields when tracking disabled", async ({
      page,
    }) => {
      // Find the stock tracking toggle
      const stockToggle = page
        // The input is `sr-only` — visually hidden by design, the visible
        // toggle being drawn by the wrapping label. Playwright never reports an
        // sr-only element as visible, so asserting on the control could not
        // work whatever its ARIA role. Target what the user sees and clicks,
        // exactly as the sibling test at :168 already does.
        .getByText("Suivre le stock de ce produit")

      await expect(stockToggle).toBeVisible({ timeout: 15_000 })

      // Enable tracking first so the fields appear. State read from the input,
      // not the label — see the sibling test above.
      const stockInput = page.locator("#stock-tracked")
      if (!(await stockInput.isChecked())) {
        await stockToggle.click()
        await page.waitForTimeout(500)
      }

      // Now disable tracking
      await stockToggle.click()
      await page.waitForTimeout(500)

      // Quantity field should be hidden
      const quantityField = page
        .getByLabel(/quantité/i)
        .or(page.getByPlaceholder(/quantité/i))

      await expect(quantityField.first()).toBeHidden({ timeout: 10_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/products/new", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Navigate through all tabs to check for errors
      for (const tabName of ["Options", "Stock", "Planification"]) {
        const tab = page.getByRole("tab", { name: tabName })
        if (await tab.isVisible()) {
          await tab.click()
          await page.waitForTimeout(500)
        }
      }

      // Wait for async operations
      await page.waitForTimeout(2_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
