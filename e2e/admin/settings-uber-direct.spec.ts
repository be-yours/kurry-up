import { test, expect } from "@playwright/test"

/**
 * Saving the Integrations tab must not delete the Uber Direct credentials
 * (#169).
 *
 * `useSettingsForm` read `api.globalSettings.get` — the *public* storefront
 * query, which strips `customerId`, `clientId` and `clientSecret`. So the three
 * fields came up empty on every visit, and pressing Enregistrer patched those
 * empty values over the stored ones. Opening the tab and saving anything at all
 * deleted the deliveries integration, silently; it surfaced later as couriers
 * no longer being dispatched.
 *
 * The convex suite covers the write. What only a browser can show is the half
 * that caused it: whether the form comes up holding what is stored.
 *
 * Uber Direct is left disabled throughout — `handleSaveIntegrations` calls Uber
 * to validate the credentials before saving an *enabled* integration, and these
 * are not real ones.
 */

const SETTINGS_URL = "/dashboard/settings"

const CUSTOMER_ID = "cus_e2e_uberdirect"
const CLIENT_ID = "cli_e2e_uberdirect"
const CLIENT_SECRET = "sec_e2e_uberdirect"

type Page = import("@playwright/test").Page

async function openIntegrations(page: Page) {
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.getByRole("tab", { name: "Intégrations" }).click()
  await expect(page.locator("#uberDirectCustomerId")).toBeVisible({ timeout: 60_000 })
}

/**
 * Type the three credentials and save them, with the integration off.
 *
 * The fields are only editable while Uber Direct is enabled, and an *enabled*
 * save calls Uber to check the credentials first — which returns 401 for these.
 * Enabling to type and disabling to save takes the same path through
 * `upsert` without the network call. `force` on the switch because the control
 * is a `sr-only` checkbox behind a styled label.
 */
async function writeCredentials(
  page: Page,
  values: { customerId: string; clientId: string; clientSecret: string }
) {
  await page.locator("#uberDirectEnabled").setChecked(true, { force: true })
  await page.locator("#uberDirectCustomerId").fill(values.customerId)
  await page.locator("#uberDirectClientId").fill(values.clientId)
  await page.locator("#uberDirectClientSecret").fill(values.clientSecret)
  await page.locator("#uberDirectEnabled").setChecked(false, { force: true })

  await page.getByRole("button", { name: "Enregistrer les intégrations" }).click()
  await expect(page.getByText("Intégrations enregistrées")).toBeVisible({
    timeout: 30_000,
  })
}

/** What the form shows after a fresh load — i.e. what the query returned. */
async function expectFields(
  page: Page,
  values: { customerId: string; clientId: string; clientSecret: string }
) {
  await expect(page.locator("#uberDirectCustomerId")).toHaveValue(values.customerId)
  await expect(page.locator("#uberDirectClientId")).toHaveValue(values.clientId)
  await expect(page.locator("#uberDirectClientSecret")).toHaveValue(values.clientSecret)
}

const CREDENTIALS = {
  customerId: CUSTOMER_ID,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
}
const CLEARED = { customerId: "", clientId: "", clientSecret: "" }

test.describe("Uber Direct credentials", () => {
  test("survive being stored, reloaded and saved again", async ({ page }) => {
    await openIntegrations(page)
    await writeCredentials(page, CREDENTIALS)

    // 1. The form comes back holding them. This is the half that broke: the
    //    public query strips all three, so these fields were empty here.
    await openIntegrations(page)
    await expectFields(page, CREDENTIALS)

    // 2. Saving without touching them keeps them. This is the reported bug:
    //    open the tab, press Enregistrer, credentials gone.
    await page.getByRole("button", { name: "Enregistrer les intégrations" }).click()
    await expect(page.getByText("Intégrations enregistrées")).toBeVisible({
      timeout: 30_000,
    })

    await openIntegrations(page)
    await expectFields(page, CREDENTIALS)
  })

  test("can still be cleared on purpose", async ({ page }) => {
    // The mirror. A fix that could not forget would be its own bug: an owner
    // who disconnects Uber Direct has to be able to.
    await openIntegrations(page)
    await writeCredentials(page, CREDENTIALS)

    await openIntegrations(page)
    await writeCredentials(page, CLEARED)

    await openIntegrations(page)
    await expectFields(page, CLEARED)
  })
})
