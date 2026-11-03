import { test, expect } from "@playwright/test"

/**
 * Creating an establishment, submitted for real (#125).
 *
 * The rest of `stores.spec.ts` says it out loud: "not one of them submits a
 * form". That is precisely how this shipped broken. The create dialog sent a
 * `settings` object the mutation does not declare, Convex refused the whole
 * call, and the only thing an owner ever saw was "Échec de la création de
 * l'établissement" — on a product billed per store.
 *
 * So this spec clicks the button. It is the one path that crosses every seam
 * at once: the React handler, the Convex validator, the schema, and back to
 * the table.
 *
 * The establishment it creates is named after the moment it ran, so the slug is
 * unique and the suite survives being run twice against the same backend.
 */

const STORES_URL = "/dashboard/stores"

/** A name unique to this run — the slug is derived from it and must not collide. */
function uniqueStoreName() {
  return `E2E Pizzeria ${Date.now().toString(36)}`
}

test.describe("Creating an establishment", () => {
  test("creates it, and it lands in the list", async ({ page }) => {
    const name = uniqueStoreName()

    await page.goto(STORES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    await page.getByRole("button", { name: "Créer un établissement" }).click()

    const dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Créer un nouvel établissement" })
    ).toBeVisible({ timeout: 15_000 })

    await dialog.getByLabel("Nom de l'établissement *").fill(name)
    await dialog.getByLabel("Rue").fill("12 rue Oberkampf")
    await dialog.getByLabel("Ville").fill("Paris")
    await dialog.getByLabel("Code postal").fill("75011")
    await dialog.getByLabel("Pays").fill("France")

    await dialog
      .getByRole("button", { name: "Créer un établissement" })
      .click()

    // The failure this covers surfaced as one toast and nothing else, so wait
    // for whichever of the two arrives and name the one that did.
    const success = page.getByText("Établissement créé avec succès")
    const failure = page.getByText("Échec de la création de l'établissement")
    await expect(success.or(failure)).toBeVisible({ timeout: 20_000 })
    await expect(failure).toHaveCount(0)
    await expect(success).toBeVisible()

    // The dialog closes and the establishment is in the table — a draft, which
    // is what `stores.create` opens every new location as.
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    const row = page.getByRole("row").filter({ hasText: name })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText("Brouillon")
  })

  test("refuses to submit without the required fields", async ({ page }) => {
    // The guard in front of the mutation. It must keep failing on the client,
    // rather than sending an incomplete payload for the validator to reject.
    await page.goto(STORES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    await page.getByRole("button", { name: "Créer un établissement" }).click()

    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Nom de l'établissement *").fill("Sans adresse")
    await dialog
      .getByRole("button", { name: "Créer un établissement" })
      .click()

    await expect(
      page.getByText("Veuillez remplir tous les champs obligatoires")
    ).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toBeVisible()
  })
})
