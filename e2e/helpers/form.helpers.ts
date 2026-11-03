import type { Page } from "@playwright/test"

/**
 * Fill an input field by its label text.
 */
export async function fillInput(page: Page, label: string, value: string) {
  await page.getByLabel(label).fill(value)
}

/**
 * Fill an input field by its placeholder text.
 */
export async function fillByPlaceholder(
  page: Page,
  placeholder: string,
  value: string
) {
  await page.getByPlaceholder(placeholder).fill(value)
}

/**
 * Select an option in a shadcn Select component.
 * Clicks the trigger (identified by current display text), then clicks the option.
 */
export async function selectOption(
  page: Page,
  triggerText: string,
  optionText: string
) {
  await page.getByRole("combobox").filter({ hasText: triggerText }).click()
  await page.getByRole("option", { name: optionText }).click()
}

/**
 * Select an option in a shadcn Select inside a specific container.
 */
export async function selectOptionInContainer(
  page: Page,
  container: ReturnType<Page["locator"]>,
  optionText: string
) {
  await container.getByRole("combobox").click()
  await page.getByRole("option", { name: optionText }).click()
}

/**
 * Toggle a Switch component by its label.
 */
export async function toggleSwitch(page: Page, label: string) {
  await page.getByRole("switch", { name: label }).click()
}

/**
 * Click a button by its text label.
 */
export async function clickButton(page: Page, name: string) {
  await page.getByRole("button", { name }).click()
}

/**
 * Submit a form by clicking a submit button with specific text.
 */
export async function submitForm(page: Page, buttonText: string) {
  await page.getByRole("button", { name: buttonText }).click()
}
