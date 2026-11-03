import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"

const CONFIG_URL = "/dashboard/email/config"

test.describe("Email Config Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display heading and subtitle", async ({ page }) => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Configuration Email" })
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByText("Expéditeur, branding et paramètres")
      ).toBeVisible()
    })

    test('should display "Enregistrer" button', async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Enregistrer" }).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Sender Section", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display sender section", async ({ page }) => {
      await expect(
        page.getByRole("heading", { name: "Expéditeur" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display sender name field", async ({ page }) => {
      await expect(
        page.getByLabel("Nom de l'expéditeur *")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display from email field", async ({ page }) => {
      await expect(
        page.getByLabel("Email d'envoi (from) *")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display reply-to email field", async ({ page }) => {
      await expect(
        page.getByLabel("Email de réponse (reply-to) *")
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Branding Section", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display branding section", async ({ page }) => {
      await expect(
        page.getByRole("heading", { name: "Branding" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display logo URL field", async ({ page }) => {
      await expect(
        page.getByLabel("URL du logo")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display color fields", async ({ page }) => {
      await expect(
        page.getByLabel("Couleur principale")
      ).toBeVisible({ timeout: 15_000 })

      await expect(
        page.getByLabel("Couleur secondaire")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display footer text field", async ({ page }) => {
      await expect(
        page.getByLabel("Texte du pied de page")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display social links fields", async ({ page }) => {
      await expect(
        page.getByText("Liens réseaux sociaux")
      ).toBeVisible({ timeout: 15_000 })

      await expect(page.getByLabel("Facebook")).toBeVisible()
      await expect(page.getByLabel("Instagram")).toBeVisible()
      await expect(page.getByLabel("Site web")).toBeVisible()
    })
  })

  test.describe("Settings Section", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display settings section", async ({ page }) => {
      await expect(
        page.getByRole("heading", { name: "Paramètres d'envoi" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display unsubscribe text field", async ({ page }) => {
      await expect(
        page.getByLabel("Texte du lien de désabonnement")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display max emails per week field", async ({ page }) => {
      await expect(
        page.getByLabel("Max emails par semaine (par abonné)")
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Automations Section", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display automations section", async ({ page }) => {
      await expect(
        page.getByRole("heading", { name: "Automations" })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display automation toggle switches", async ({ page }) => {
      const automationLabels = [
        "Email de bienvenue",
        "Email post-commande",
        "Email d'anniversaire",
        "Email de réengagement",
        "Panier abandonné",
      ]

      for (const label of automationLabels) {
        await expect(page.getByLabel(label)).toBeVisible({ timeout: 15_000 })
      }
    })

    test("should toggle an automation the engine can dispatch", async ({ page }) => {
      await page.waitForTimeout(2_000)

      // Was `birthdayEnabled`, which is now disabled by design: nothing
      // dispatches on it, so the switch no longer accepts a click. `welcome`
      // is a trigger the engine actually fires, so it is the one that still
      // answers the question this test is asking.
      const welcomeSwitch = page.locator('label[for="welcomeEnabled"]').last()
      await expect(welcomeSwitch).toBeVisible({ timeout: 15_000 })

      await welcomeSwitch.click()
      await page.waitForTimeout(500)

      await expect(
        page.getByRole("heading", { name: "Configuration Email", level: 1 })
      ).toBeVisible()
    })

    test("should disable the automations nothing can dispatch", async ({ page }) => {
      await page.waitForTimeout(2_000)

      // An owner switching on "Email d'anniversaire" used to see it save and
      // report itself on, while nothing would ever send: no record anywhere
      // carries a date of birth, and the cart is never persisted server-side.
      // The screen now says so instead of accepting the instruction.
      for (const id of ["birthdayEnabled", "abandonedCartEnabled"]) {
        await expect(page.locator(`#${id}`)).toBeDisabled({ timeout: 15_000 })
      }
      for (const id of ["welcomeEnabled", "postOrderEnabled", "inactiveEnabled"]) {
        await expect(page.locator(`#${id}`)).toBeEnabled({ timeout: 15_000 })
      }
    })
  })

  test.describe("Form Interaction", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(CONFIG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should allow filling sender name", async ({ page }) => {
      const senderInput = page.getByLabel("Nom de l'expéditeur *")
      await expect(senderInput).toBeVisible({ timeout: 15_000 })

      await senderInput.fill("Mon Restaurant")
      await expect(senderInput).toHaveValue("Mon Restaurant")
    })

    test("should display bottom save button", async ({ page }) => {
      await expect(
        page.getByRole("button", { name: "Enregistrer la configuration" })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto(CONFIG_URL, {
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
