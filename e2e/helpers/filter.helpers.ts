import type { Page } from "@playwright/test"

/**
 * Apply a search query using the SearchInput component by placeholder.
 */
export async function applySearch(
  page: Page,
  placeholder: string,
  query: string
) {
  const input = page.getByPlaceholder(placeholder)
  await input.fill(query)
}

/**
 * Clear a search input by placeholder.
 */
export async function clearSearch(page: Page, placeholder: string) {
  const input = page.getByPlaceholder(placeholder)
  await input.clear()
}

/**
 * Select a filter option using a shadcn Select component.
 * Identifies the select by its current text (placeholder or value).
 */
export async function selectFilter(
  page: Page,
  currentText: string,
  optionText: string
) {
  await page.getByRole("combobox").filter({ hasText: currentText }).click()

  // Scoped to the open listbox.
  //
  // Radix renders each item twice — the styled one the user sees, and a hidden
  // native option it keeps for accessibility — so an unscoped
  // `getByRole("option")` matches both and Playwright refuses to guess. The
  // listbox is the popup that just opened, which is the one being clicked.
  await page
    .getByRole("listbox")
    .getByRole("option", { name: optionText })
    .first()
    .click()
}

/**
 * Click the reset/clear filters button.
 */
export async function clearFilters(page: Page) {
  const resetButton = page.getByRole("button", { name: /[Rr]einitialiser/ })
  if (await resetButton.isVisible()) {
    await resetButton.click()
  }
}

/**
 * Click an option in the listbox that is currently open.
 *
 * Radix renders every item twice - the styled one the user sees and a hidden
 * native option it keeps for accessibility - so an unscoped
 * `getByRole("option")` matches both and Playwright refuses to guess between
 * them. Scoping to the open listbox and taking the first match picks the one
 * being clicked.
 */
export async function chooseOption(
  page: Page,
  name: string | RegExp,
  options?: { exact?: boolean }
) {
  await page
    .getByRole("listbox")
    .getByRole("option", { name, exact: options?.exact })
    .first()
    .click()
}
