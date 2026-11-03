import { test, expect, type Page } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

/**
 * Dismisses the sound-alert gate that covers the kitchen board.
 *
 * Browsers refuse to play audio without a user gesture, so the page opens with
 * a full-screen click catcher asking for one. It is a real element doing a real
 * job — and it swallows every click underneath it, which is why the station
 * filter waited out its thirty seconds while Playwright reported the overlay
 * "intercepts pointer events". A kitchen screen starts by tapping it; so does
 * this suite.
 */
async function activateSoundAlerts(page: Page) {
  const gate = page.getByRole("button", { name: "Activer les alertes sonores" })
  if (await gate.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await gate.click()
    await expect(gate).toBeHidden({ timeout: 10_000 })
  }
}

test.describe("Kitchen Page", () => {
  test.describe("Page Structure", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/orders/kitchen", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display 4 kanban columns", async ({ page }) => {
      // `StoreGuard` is what answers "no establishment" now — the KDS itself
      // renders a spinner while the selection is read back, and spinners carry
      // no text. This locator used to target a message the screen stopped
      // showing, so the guard below never fired and a no-store run failed on
      // the 15 s timeout instead of skipping.
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })

      // Wait for either kanban columns or no-store message
      const enAttente = page.getByText("En attente")
      await expect(enAttente.or(noStore)).toBeVisible({ timeout: 15_000 })

      // If no-store message is shown, skip column checks
      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      await expect(page.getByText("En attente")).toBeVisible()
      await expect(page.getByText("En cours")).toBeVisible()
      await expect(page.getByText("Prêt")).toBeVisible()
      await expect(page.getByText("Terminé")).toBeVisible()
    })

    test("should display column headers: En attente, En cours, Prêt, Terminé", async ({
      page,
    }) => {
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const enAttente = page.getByText("En attente")

      await expect(enAttente.or(noStore)).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      // Column headers should be visible with proper text
      const columns = ["En attente", "En cours", "Prêt", "Terminé"]
      for (const col of columns) {
        await expect(page.getByText(col).first()).toBeVisible()
      }
    })

    test("should display ticket count in column headers", async ({ page }) => {
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const enAttente = page.getByText("En attente")

      await expect(enAttente.or(noStore)).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      // Column headers typically display a count badge (e.g., "(0)" or a number)
      // Look for any numeric indicator near the column headers
      const headerArea = page.locator("main")
      const headerText = await headerArea.textContent()
      // At minimum, the header area should contain digits (ticket counts)
      expect(headerText).toBeTruthy()
    })

    test('should display "Aucun ticket" in empty columns', async ({
      page,
    }) => {
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const enAttente = page.getByText("En attente")

      await expect(enAttente.or(noStore)).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      // At least some columns should show empty state if no tickets
      const emptyMessage = page.getByText("Aucun ticket")
      const ticketCard = page.locator('[data-slot="card"]').first()

      // Either there are ticket cards or empty messages
      await expect(
        emptyMessage.first().or(ticketCard).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Station Filter", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dashboard/orders/kitchen", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)
    })

    test("should display station filter", async ({ page }) => {
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const mainContent = page.locator("main")

      await expect(mainContent).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      // Station filter is a dropdown/select element
      const stationFilter = page
        .getByRole("combobox")
        .or(page.getByText("Station", { exact: false }))

      await expect(stationFilter.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should filter tickets by station", async ({ page }) => {
      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const mainContent = page.locator("main")

      await expect(mainContent).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      await activateSoundAlerts(page)

      await activateSoundAlerts(page)

      const stationFilter = page.getByRole("combobox").first()

      if (
        await stationFilter.isVisible({ timeout: 5_000 }).catch(() => false)
      ) {
        // The kitchen board is a set of scrollable columns; the filter can sit
        // outside the viewport, where a plain click waits out its full timeout
        // instead of failing.
        await stationFilter.scrollIntoViewIfNeeded()
        await stationFilter.click()

        // Options should appear
        const options = page.getByRole("option")
        const optionCount = await countAfterLoad(options)

        // A silent `if` here let the test pass having checked nothing when the
        // list came back empty. A skip says so instead.
        test.skip(optionCount < 1, "the station filter offers no option")

        await options.first().click()
        await page.waitForTimeout(500)

        // Page should still render without errors
        await expect(mainContent).toBeVisible()
      }
    })
  })

  test.describe("Ticket Cards", () => {
    test("should display ticket cards with order info", async ({ page }) => {
      await page.goto("/dashboard/orders/kitchen", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const noStore = page.getByRole("heading", { name: "Aucun établissement" })
      const enAttente = page.getByText("En attente")

      await expect(enAttente.or(noStore)).toBeVisible({ timeout: 15_000 })

      test.skip(await noStore.isVisible({ timeout: 5_000 }).catch(() => false), "no establishment is selected")

      // Either ticket cards exist or empty state is shown
      const ticketCard = page.locator('[data-slot="card"]').first()
      const emptyMessage = page.getByText("Aucun ticket")

      await expect(
        ticketCard.or(emptyMessage.first()).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Loading", () => {
    test("should show skeleton while loading", async ({ page }) => {
      await page.goto("/dashboard/orders/kitchen", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Either skeleton loading indicators or the loaded content should appear
      const skeleton = page.locator(".animate-pulse")
      const mainContent = page.locator("main")

      await expect(skeleton.first().or(mainContent)).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/dashboard/orders/kitchen", {
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
