import type { Page, Locator } from "@playwright/test"

/**
 * Get the count of rows in a table body.
 */
export async function getTableRowCount(page: Page): Promise<number> {
  return page.locator("tbody tr").count()
}

/**
 * Find a table row containing specific text.
 */
export function findRowByText(page: Page, text: string): Locator {
  return page.locator("tbody tr").filter({ hasText: text })
}

/**
 * Click the action menu button on a table row containing specific text.
 * The action menu is typically a "..." or kebab menu button.
 */
export async function clickRowActionMenu(page: Page, rowText: string) {
  const row = findRowByText(page, rowText)
  // Look for the action menu trigger (usually a button with MoreHorizontal icon)
  const actionButton = row.getByRole("button").last()
  await actionButton.click()
}

/**
 * Click a dropdown menu item by text.
 */
export async function clickDropdownItem(page: Page, text: string) {
  await page.getByRole("menuitem", { name: text }).click()
}

/**
 * Get all visible table headers as text.
 */
export async function getTableHeaders(page: Page): Promise<string[]> {
  const headers = page.locator("thead th")
  const count = await headers.count()
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const text = await headers.nth(i).textContent()
    if (text) texts.push(text.trim())
  }
  return texts
}
