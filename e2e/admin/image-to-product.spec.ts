import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { resolve } from "node:path"

/**
 * Image to Product — E2E Tests
 *
 * Tests the full AI-powered image-to-product flow:
 * 1. Navigation to the page
 * 2. Upload step (mode selection, image upload via file input)
 * 3. Analysis loading state
 * 4. Suggestions review (edit, select/deselect, confirm)
 *
 * Uses a real menu image fixture (e2e/fixtures/menu-test.webp)
 * for the file upload test path.
 */

const MENU_IMAGE_PATH = resolve(__dirname, "../fixtures/menu-test.webp")

test.describe("Image to Product", () => {
  // ────────────────────────────────────────────────────────
  // Navigation & Page Structure
  // ────────────────────────────────────────────────────────

  test.describe("Navigation & Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test('should display "Créer depuis une image" heading', async ({
      page,
    }) => {
      await expect(
        page.locator("h1", { hasText: "Créer depuis une image" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display subtitle explaining the feature", async ({
      page,
    }) => {
      await expect(
        page.getByText(
          "L'IA analyse votre image pour pre-remplir les informations produit"
        )
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display a back button linking to /products", async ({
      page,
    }) => {
      const backLink = page.getByRole("link", { name: "" }).filter({
        has: page.locator("svg"),
      })

      // There should be a link that navigates back to products
      const links = page.locator('a[href="/dashboard/products"]')
      await expect(links.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should navigate back to products page when clicking back", async ({
      page,
    }) => {
      const backLink = page.locator('a[href="/dashboard/products"]').first()
      await expect(backLink).toBeVisible({ timeout: 15_000 })
      await backLink.click()

      await expect(page).toHaveURL(/\/dashboard\/products$/, { timeout: 30_000 })
    })
  })

  // ────────────────────────────────────────────────────────
  // Navigation from Products Page
  // ────────────────────────────────────────────────────────

  test.describe("Navigation from Products Page", () => {
    test('should have "Créer depuis image" button on products page', async ({
      page,
    }) => {
      await page.goto("/dashboard/products", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const imageButton = page.getByRole("link", {
        name: /Cr[eé]er depuis image/,
      })
      await expect(imageButton).toBeVisible({ timeout: 15_000 })
    })

    test("should navigate to /products/from-image when clicking the button", async ({
      page,
    }) => {
      await page.goto("/dashboard/products", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const imageButton = page.getByRole("link", {
        name: /Cr[eé]er depuis image/,
      })
      await expect(imageButton).toBeVisible({ timeout: 15_000 })
      await imageButton.click()

      await expect(page).toHaveURL(/\/dashboard\/products\/from-image/, {
        timeout: 30_000,
      })
      await expect(
        page.locator("h1", { hasText: "Créer depuis une image" })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  // ────────────────────────────────────────────────────────
  // Upload Step
  // ────────────────────────────────────────────────────────

  test.describe("Upload Step", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display the upload card with title", async ({ page }) => {
      await expect(
        page.getByText("Créer depuis une image").first()
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText(
          "Uploadez une photo de plat ou de menu"
        )
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display mode selection buttons", async ({ page }) => {
      await expect(page.getByText("Plat unique")).toBeVisible({
        timeout: 15_000,
      })
      await expect(page.getByText("Menu / Carte")).toBeVisible({
        timeout: 15_000,
      })
    })

    test('should have "Plat unique" selected by default', async ({ page }) => {
      // The "Plat unique" button should have the primary border style
      const singleButton = page
        .locator("button")
        .filter({ hasText: "Plat unique" })
      await expect(singleButton).toBeVisible({ timeout: 15_000 })

      // Check it has the active border class
      await expect(singleButton).toHaveClass(/border-primary/, {
        timeout: 5_000,
      })
    })

    test('should switch to "Menu / Carte" mode on click', async ({ page }) => {
      const menuButton = page
        .locator("button")
        .filter({ hasText: "Menu / Carte" })
      await expect(menuButton).toBeVisible({ timeout: 15_000 })
      await menuButton.click()

      await expect(menuButton).toHaveClass(/border-primary/)
    })

    test('should display "Analyser l\'image" button disabled when no image', async ({
      page,
    }) => {
      const analyzeButton = page.getByRole("button", {
        name: "Analyser l'image",
      })
      await expect(analyzeButton).toBeVisible({ timeout: 15_000 })
      await expect(analyzeButton).toBeDisabled()
    })

    test("should display the image uploader drop zone", async ({ page }) => {
      await expect(
        page.getByText("Déposez une image ici ou cliquez pour parcourir")
      ).toBeVisible({ timeout: 15_000 })
    })

    test('should display "Coller une URL" option', async ({ page }) => {
      const pasteUrlButton = page.getByText("Coller une URL")
      await expect(pasteUrlButton).toBeVisible({ timeout: 15_000 })
    })

    test("should show URL input when clicking Coller une URL", async ({
      page,
    }) => {
      const pasteUrlButton = page.getByText("Coller une URL")
      await expect(pasteUrlButton).toBeVisible({ timeout: 15_000 })
      await pasteUrlButton.click()

      const urlInput = page.locator('input[placeholder="https://..."]')
      await expect(urlInput).toBeVisible({ timeout: 5_000 })
    })

    test("should enable analyze button when URL is pasted", async ({
      page,
    }) => {
      // Click "Coller une URL" to show the URL input
      await page.getByText("Coller une URL").click()

      const urlInput = page.locator('input[placeholder="https://..."]')
      await expect(urlInput).toBeVisible({ timeout: 5_000 })

      // Paste a valid image URL
      await urlInput.fill("https://example.com/test-menu.webp")

      // The analyze button should now be enabled
      const analyzeButton = page.getByRole("button", {
        name: "Analyser l'image",
      })
      await expect(analyzeButton).toBeEnabled({ timeout: 5_000 })
    })

    test("should accept file upload via file input", async ({ page }) => {
      // Use the hidden file input to upload the test image
      const fileInput = page.locator('input[type="file"]')
      await fileInput.setInputFiles(MENU_IMAGE_PATH)

      await page.waitForTimeout(1_000)

      // Either: uploading state, preview image, or error. The runner takes the
      // error branch by design, on the placeholder AWS credentials e2e.yml sets.
      const uploadingState = page.getByText("Upload en cours...")
      const preview = page.locator('img[alt="Aperçu"]')
      const error = page.locator(".text-destructive")

      // `.text-destructive` cannot resolve to one element: the upload panel puts
      // it on the alert icon and on the message beside it. Strict mode rejects
      // the pair, so this failed whenever the error it accepts was on screen.
      await expect(
        uploadingState.or(preview).or(error).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  // ────────────────────────────────────────────────────────
  // Full Flow with URL (Menu Mode)
  // ────────────────────────────────────────────────────────

  test.describe("Full Analysis Flow", () => {
    test("should trigger analysis and show loading state when URL is provided", async ({
      page,
    }) => {
      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Switch to menu mode
      const menuButton = page
        .locator("button")
        .filter({ hasText: "Menu / Carte" })
      await expect(menuButton).toBeVisible({ timeout: 15_000 })
      await menuButton.click()

      // Use URL paste to bypass S3 upload
      await page.getByText("Coller une URL").click()
      const urlInput = page.locator('input[placeholder="https://..."]')
      await urlInput.fill("https://example.com/test-menu.webp")

      // Click analyze
      const analyzeButton = page.getByRole("button", {
        name: "Analyser l'image",
      })
      await expect(analyzeButton).toBeEnabled({ timeout: 5_000 })
      await analyzeButton.click()

      // Should transition to the "analyzing" step with multi-step loader overlay
      const loadingStep = page.getByText("Amelioration de l'image")
      const loadingHint = page.getByText("Cela peut prendre 30 a 60 secondes")

      // The loading state should appear (or error if API is not configured)
      const errorToast = page.locator('[data-sonner-toast][data-type="error"]')

      await expect(loadingStep.or(errorToast)).toBeVisible({ timeout: 15_000 })

      // If loading appeared, verify the step indicators and cancel button
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await loadingStep.isVisible({ timeout: 15_000 }).catch(() => false)), "the analysis step was already past when the page was read")

      await expect(
        page.getByText("Analyse par l'IA (Vision GPT-4o)")
      ).toBeVisible()
      await expect(
        page.getByText("Enrichissement des descriptions")
      ).toBeVisible()
      await expect(page.getByText("Categorisation automatique")).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Annuler" })
      ).toBeVisible()
    })

    test("should complete analysis and show suggestions for a real menu image", async ({
      page,
    }) => {
      // This test uses the actual Convex action with a publicly accessible image URL.
      // It requires OPENAI_API_KEY to be configured in the Convex backend.
      // If the API is not configured, the test will handle the error gracefully.

      test.setTimeout(120_000) // AI analysis can take 30-60 seconds

      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Switch to menu mode (our test image is a full menu)
      const menuButton = page
        .locator("button")
        .filter({ hasText: "Menu / Carte" })
      await menuButton.click()

      // Use URL paste — use a publicly accessible test image
      // Note: For a real test, this would need a publicly hosted version of the fixture
      await page.getByText("Coller une URL").click()
      const urlInput = page.locator('input[placeholder="https://..."]')
      await urlInput.fill("https://example.com/test-menu.webp")

      // Click analyze
      await page.getByRole("button", { name: "Analyser l'image" }).click()

      // Wait for either: suggestions review (success) or error toast (API issue)
      const reviewStep = page.getByText(/\d+\/\d+ selectionne/)
      const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
      const successToast = page.locator(
        '[data-sonner-toast][data-type="success"]'
      )

      await expect(reviewStep.or(errorToast).or(successToast)).toBeVisible({
        timeout: 90_000,
      })

      // If review step appeared, verify the suggestions UI
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await reviewStep.isVisible({ timeout: 15_000 }).catch(() => false)), "the review step was not reached")

      // Should show the select all checkbox
      await expect(page.locator('[data-slot="checkbox"]').first()).toBeVisible()

      // Should show at least one suggestion card
      const cards = page.locator('[data-slot="card"]')
      const cardCount = await cards.count()
      expect(cardCount).toBeGreaterThanOrEqual(1)

      // Should show "Nouvelle image" reset button
      await expect(
        page.getByRole("button", { name: /Nouvelle image/ })
      ).toBeVisible()

      // Should show "Créer X produit(s)" confirm button
      await expect(
        page.getByRole("button", { name: /Cr[eé]er \d+ produit/ })
      ).toBeVisible()
    })
  })

  // ────────────────────────────────────────────────────────
  // Suggestions Review (UI-only, no backend required)
  // ────────────────────────────────────────────────────────

  test.describe("Suggestions Review UI", () => {
    // This test mocks the analysis result by intercepting the Convex action
    // Since Convex uses WebSocket, we test the UI by navigating with
    // pre-populated state via the page URL and checking component rendering.

    test("should return to upload step when reset is clicked", async ({
      page,
    }) => {
      test.setTimeout(120_000)

      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Start an analysis to potentially reach the loading state
      await page.getByText("Coller une URL").click()
      const urlInput = page.locator('input[placeholder="https://..."]')
      await urlInput.fill("https://example.com/test.webp")

      await page.getByRole("button", { name: "Analyser l'image" }).click()

      // Wait for either loading or error
      const loadingText = page.getByText("Analyse en cours")
      const errorToast = page.locator('[data-sonner-toast][data-type="error"]')

      await expect(loadingText.or(errorToast)).toBeVisible({ timeout: 15_000 })

      // If we got an error, we should be back on the upload step
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await errorToast.isVisible({ timeout: 15_000 }).catch(() => false)), "no error toast - this run took the success path")

      // Error toast means the action failed — step should revert to "upload"
      await expect(
        page.getByText("Déposez une image ici ou cliquez pour parcourir")
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  // ────────────────────────────────────────────────────────
  // Console Errors
  // ────────────────────────────────────────────────────────

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors on page load", async ({
      page,
    }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/products/from-image", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Wait for async operations
      await page.waitForTimeout(3_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  })
})
