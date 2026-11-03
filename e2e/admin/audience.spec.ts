import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import {
  navigateViaSidebar,
  waitForAdminPage,
} from "../helpers/navigation.helpers"

/**
 * « Fréquentation », opened the way an owner opens it.
 *
 * WHAT THIS IS FOR. Every other check on this feature is a unit test against a
 * fake database or a type-check. None of them would notice the screen failing
 * to render, the query being refused, the nav entry missing, or the period
 * picker changing nothing. This is the first thing in the feature that opens
 * the page.
 *
 * A SEEDED DEPLOYMENT HAS NO AUDIENCE DATA — the seed writes orders, not page
 * views — so every panel is legitimately empty. That is the case worth pinning
 * anyway: an empty establishment is what every client sees on their first day,
 * and a panel that renders a blank card instead of saying "aucune visite" is a
 * screen that reads as broken.
 */

test.describe("Audience page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard/audience", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)
  })

  test("loads, and says what it is", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Fréquentation", level: 1 })
    ).toBeVisible({ timeout: 30_000 })

    // The promise the whole design rests on, made to the owner in one line.
    await expect(page.getByText(/sans cookie/i)).toBeVisible({ timeout: 15_000 })
  })

  test("shows the three headline figures", async ({ page }) => {
    for (const label of ["Visites", "Pages vues", "Pages par visite"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      })
    }
  })

  test("shows every panel, and names each one", async ({ page }) => {
    const panels = [
      "Pages les plus vues",
      "D'où viennent vos visiteurs",
      "Sur quel appareil",
      "Ce que font vos visiteurs",
      "Du visiteur à la commande",
      "Quand votre site est consulté",
    ]

    for (const title of panels) {
      await expect(page.getByText(title, { exact: true })).toBeVisible({
        timeout: 30_000,
      })
    }
  })

  /*
   * An establishment with no traffic yet must be told so in words. A blank card
   * where a chart belongs is indistinguishable from a screen that failed.
   */
  test("says 'aucune' rather than showing a blank card when there is no traffic", async ({
    page,
  }) => {
    const empties = page.getByText(/Aucune (visite|page vue|action)/i)
    await expect(empties.first()).toBeVisible({ timeout: 30_000 })
  })

  test("changes period when the picker is used", async ({ page }) => {
    const picker = page.getByRole("group", { name: "Période affichée" })
    await expect(picker).toBeVisible({ timeout: 30_000 })

    const thirty = picker.getByRole("button", { name: "30 jours" })
    await thirty.click()

    // The state is on the control, not only in its colour — which is what a
    // screen reader reads and what this asserts.
    await expect(thirty).toHaveAttribute("aria-pressed", "true")
    await expect(picker.getByRole("button", { name: "7 jours" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  test("is reachable from the sidebar, under its own name", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await waitForAdminPage(page)

    await navigateViaSidebar(page, "Fréquentation")

    await expect(page).toHaveURL(/\/dashboard\/audience/, { timeout: 30_000 })
  })

  test("renders without putting an error on the console", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)

    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForAdminPage(page)
    await expect(
      page.getByRole("heading", { name: "Fréquentation", level: 1 })
    ).toBeVisible({ timeout: 30_000 })

    expect(consoleErrors.getErrors()).toEqual([])
    consoleErrors.cleanup()
  })
})

test.describe("The audience retention window", () => {
  /*
   * The one control a client can reach for this feature, and the reason it
   * exists: 25 months is the condition of the CNIL exemption, so the field has
   * to refuse anything above it rather than accept it and lose the exemption
   * quietly.
   */
  test("is on the personal-data screen, capped at the CNIL ceiling", async ({
    page,
  }) => {
    await page.goto("/dashboard/privacy", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    const field = page.getByLabel(/Statistiques de fréquentation/i)
    await expect(field).toBeVisible({ timeout: 30_000 })
    await expect(field).toHaveAttribute("max", "760")
    await expect(field).toHaveAttribute("min", "30")
  })
})
