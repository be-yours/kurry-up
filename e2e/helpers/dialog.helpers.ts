import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"

/**
 * Wait for a shadcn dialog to be visible.
 */
export async function waitForDialog(page: Page, timeout = 10_000) {
  const dialog = page.locator('[data-slot="dialog-content"]')
  await expect(dialog).toBeVisible({ timeout })
  return dialog
}

/**
 * Close a dialog by pressing the Escape key.
 */
export async function closeDialogByEscape(page: Page) {
  await page.keyboard.press("Escape")
  await expect(
    page.locator('[data-slot="dialog-content"]')
  ).toBeHidden({ timeout: 5_000 })
}

/**
 * Close a dialog by clicking the "Annuler" button.
 */
export async function closeDialogByCancel(page: Page) {
  const dialog = page.locator('[data-slot="dialog-content"]')
  await dialog.getByRole("button", { name: "Annuler" }).click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

/**
 * Confirm a delete action in a confirmation dialog.
 */
export async function confirmDelete(page: Page, buttonText = "Supprimer") {
  const dialog = page.locator('[data-slot="dialog-content"]')
  await dialog.getByRole("button", { name: buttonText }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
}

/**
 * Get the dialog content locator.
 */
export function getDialog(page: Page) {
  return page.locator('[data-slot="dialog-content"]')
}
