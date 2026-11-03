import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

test.describe("CMS Translation", () => {
  test.describe("Translation Controls", () => {
    test("should display translate button on text fields", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display translation buttons (either "Traduire" or a count)
      const translateButtons = page.getByRole("button", {
        name: /traduire|\d+/i,
      })

      await expect(translateButtons.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should not display translate button on image fields", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // The hero block has an image field — it should NOT have a translate button
      const imageLabel = page.getByText("Image d'illustration")
      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await imageLabel.isVisible({ timeout: 5_000 }).catch(() => false)), "this page has no image field")

      const imageSection = imageLabel.locator("..")
      const translateInImage = imageSection.getByRole("button", {
        name: /traduire/i,
      })
      await expect(translateInImage).toHaveCount(0)
    })
  })

  test.describe("Translation Drawer", () => {
    test("should open translation drawer on button click", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // "Traduire", not "Traduire tout": the first /traduire/i match is the
      // page-wide bulk action in the toolbar, which does not open the per-field
      // drawer this test is about.
      const translateButton = page
        .getByRole("button", { name: "Traduire", exact: true })
        .first()

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await translateButton.isVisible({ timeout: 15_000 })), "this page has no per-field translate button")

      await translateButton.click()

      // Should open the translation drawer/sheet
      await expect(
        page.getByText(/traductions/i),
      ).toBeVisible({ timeout: 10_000 })
    })

    test("should show language sections in translation drawer", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // "Traduire", not "Traduire tout": the first /traduire/i match is the
      // page-wide bulk action in the toolbar, which does not open the per-field
      // drawer this test is about.
      const translateButton = page
        .getByRole("button", { name: "Traduire", exact: true })
        .first()

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await translateButton.isVisible({ timeout: 15_000 })), "this page has no per-field translate button")

      await translateButton.click()

      // Should display the "Langue par défaut" label
      await expect(
        page.getByText("Langue par défaut"),
      ).toBeVisible({ timeout: 10_000 })

      // Should display at least one secondary language or a "no languages" message
      const hasLanguages = await page
        .getByText(/english|español|العربية|deutsch/i)
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)

      const noLanguages = await page
        .getByText(/aucune langue secondaire/i)
        .isVisible({ timeout: 2_000 })
        .catch(() => false)

      expect(hasLanguages || noLanguages).toBe(true)
    })

    test("should show translation count when translations exist", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Look for translation buttons showing a number (translations exist)
      const countButtons = page.getByRole("button", { name: /^\d+$/ })
      const count = await countAfterLoad(countButtons)

      // A silent `if` here let the test pass having checked nothing when the
      // list came back empty. A skip says so instead.
      test.skip(count < 1, "there is nothing to translate on this page")

      const text = await countButtons.first().textContent()
      expect(Number(text)).toBeGreaterThan(0)
    })
  })

  test.describe("Auto-Translation & Publish Lock", () => {
    test("should disable publish button while translation is pending", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Verify publish button is initially enabled
      const publishButton = page.getByRole("button", { name: /publier/i })
      await expect(publishButton).toBeVisible({ timeout: 15_000 })
      await expect(publishButton).toBeEnabled({ timeout: 30_000 })

      // Find and modify a text input to trigger autosave → translation
      const textInput = page
        .getByPlaceholder("Laisser vide pour utiliser la valeur par défaut")
        .first()
      await expect(textInput).toBeVisible({ timeout: 15_000 })

      const originalValue = await textInput.inputValue()
      await textInput.fill("")
      await textInput.fill("Test verrou traduction E2E")

      // Wait for autosave debounce (1.5s) to fire
      await page.waitForTimeout(2_000)

      // The button should now show "Traduction..." and be disabled
      const translatingButton = page.getByRole("button", {
        name: /traduction/i,
      })
      const isTranslating = await translatingButton
        .isVisible({ timeout: 3_000 })
        .catch(() => false)

      if (isTranslating) {
        await expect(translatingButton).toBeDisabled()
      }

      // Wait for translations to complete — button should switch back to "Publier"
      await expect(
        page.getByRole("button", { name: /publier/i }),
      ).toBeEnabled({ timeout: 30_000 })

      // Restore original value
      await textInput.fill(originalValue || "Connexion")
      await page.waitForTimeout(2_000)

      // Wait for post-restore translation to finish
      await expect(
        page.getByRole("button", { name: /publier/i }),
      ).toBeEnabled({ timeout: 30_000 })
    })

    test("publish button should re-enable after translation completes", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      const publishButton = page.getByRole("button", { name: /publier/i })
      await expect(publishButton).toBeEnabled({ timeout: 30_000 })

      // Modify a text field
      const textInput = page
        .getByPlaceholder("Laisser vide pour utiliser la valeur par défaut")
        .first()
      await expect(textInput).toBeVisible({ timeout: 15_000 })

      const originalValue = await textInput.inputValue()
      await textInput.fill("Vérification re-activation bouton")

      // Wait for autosave
      await page.waitForTimeout(2_000)

      // Eventually the button must be enabled again (translations complete)
      await expect(
        page.getByRole("button", { name: /publier/i }),
      ).toBeEnabled({ timeout: 30_000 })

      // Restore
      await textInput.fill(originalValue || "Connexion")
      await page.waitForTimeout(2_000)
      await expect(
        page.getByRole("button", { name: /publier/i }),
      ).toBeEnabled({ timeout: 30_000 })
    })
  })

  test.describe("Publish with Translations", () => {
    test("should successfully publish page after translations complete", async ({
      page,
    }) => {
      await page.goto("/dashboard/content/pages/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Wait for publish button to be enabled
      const publishButton = page.getByRole("button", { name: /publier/i })
      await expect(publishButton).toBeVisible({ timeout: 15_000 })
      await expect(publishButton).toBeEnabled({ timeout: 30_000 })

      // Click publish
      await publishButton.click()

      // Wait for the publish operation to complete
      await page.waitForTimeout(3_000)

      // After publish, the button should be enabled again
      await expect(
        page.getByRole("button", { name: /publier/i }),
      ).toBeEnabled({ timeout: 15_000 })
    })
  })
})
