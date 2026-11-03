import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import { chooseOption } from "../helpers/filter.helpers"

/**
 * The screen a contact message is read on.
 *
 * `contactMessages.list` and `updateStatus` shipped guarded and correct, and
 * nothing called either: the storefront form wrote rows nobody could read
 * (issue #272). What this file holds is the way in — the sidebar link, the
 * screen behind it, the filter over the three statuses.
 *
 * The inbox of the bench is whatever the last run left in it, so the
 * assertions are on the screen and not on a message: seeding one would mean
 * writing through the public mutation and its rate limit.
 */

const MESSAGES_URL = "/dashboard/messages"

test.describe("Contact Messages Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(MESSAGES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)
  })

  test("should display heading", async ({ page }) => {
    await expect(
      page.getByRole("heading", { level: 1, name: "Messages" })
    ).toBeVisible({ timeout: 15_000 })
  })

  test("should be reachable from the sidebar", async ({ page }) => {
    await page.goto("/dashboard", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole("link", { name: "Messages" })
      .click()

    await expect(page).toHaveURL(new RegExp(`${MESSAGES_URL}$`))
    await expect(
      page.getByRole("heading", { level: 1, name: "Messages" })
    ).toBeVisible({ timeout: 15_000 })
  })

  test("should display table or empty state", async ({ page }) => {
    const table = page.locator("table")
    const emptyState = page.getByText("Aucun message")

    await expect(table.or(emptyState).first()).toBeVisible({ timeout: 15_000 })
  })

  test("should filter by status", async ({ page }) => {
    const statusFilter = page.getByRole("combobox").filter({ hasText: "Tous" })

    await statusFilter.click()
    await chooseOption(page, "Archivés")
    await page.waitForTimeout(1_000)

    await expect(
      page.getByRole("heading", { level: 1, name: "Messages" })
    ).toBeVisible()
  })

  test("should open a message when the inbox has one", async ({ page }) => {
    const rows = page.locator('[data-testid="message-row"]')
    await page.waitForTimeout(2_000)

    if ((await rows.count()) === 0) {
      test.skip(true, "no message in this deployment's inbox")
      return
    }

    await rows.first().click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByTestId("archive-message")).toBeVisible()
  })

  test("should not produce unexpected console errors", async ({ page }) => {
    const { getErrors, cleanup } = collectConsoleErrors(page)

    await page.goto(MESSAGES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    await waitForAdminPage(page)
    await page.waitForTimeout(3_000)

    cleanup()

    expect(getErrors()).toEqual([])
  })
})
