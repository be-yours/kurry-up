import { test, expect, type Page } from "@playwright/test"

/**
 * The kitchen display's sound alerts, configured from the dashboard (#243).
 *
 * `stores.soundConfig` decides which alerts sound and how loudly. The schema
 * field, the audited mutation and the reader — `KitchenContent` →
 * `KitchenSoundManager`, on the routed kitchen screen — were all there. No
 * screen wrote it, so every establishment ran on the display's hardcoded
 * fallbacks and a restaurant could not turn down a beep that repeats every
 * thirty seconds.
 *
 * The unit suite covers the catalogue and the resolution rules. This is the
 * loop an owner walks: open the tab, change something, save, come back.
 *
 * Each test opens a **new** establishment. Sound settings persist, so a suite
 * that shared one store would pass on the first run and then assert against
 * whatever the previous test saved.
 */

const STORES_URL = "/dashboard/stores"

const OVERDUE_SWITCH = "#sound-overdue"
const NEW_TICKET_SWITCH = "#sound-newTicket"
const PRINTER_SWITCH = "#sound-printerOffline"

function volumeReadout(page: Page, key: string) {
  return page.getByTestId(`sound-volume-${key}`)
}

function sliderThumb(page: Page, key: string) {
  return page.getByTestId(`sound-slider-${key}`).locator('[role="slider"]')
}

/** A name unique to this test — the slug is derived from it. */
function uniqueName() {
  return `E2E Sons ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
}

/** Create an establishment and land on its Cuisine tab. */
async function newStoreKitchenTab(page: Page): Promise<string> {
  const name = uniqueName()

  await page.goto(STORES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

  // The first visit compiles the route, which the dev server can take most of a
  // minute over. That is not this test's subject.
  const createButton = page.getByRole("button", { name: "Créer un établissement" })
  await expect(createButton).toBeVisible({ timeout: 60_000 })
  await createButton.click()

  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", { name: "Créer un nouvel établissement" })
  ).toBeVisible({ timeout: 30_000 })

  await dialog.getByLabel("Nom de l'établissement *").fill(name)
  await dialog.getByLabel("Rue").fill("12 rue Oberkampf")
  await dialog.getByLabel("Ville").fill("Paris")
  await dialog.getByLabel("Code postal").fill("75011")
  await dialog.getByLabel("Pays").fill("France")
  await dialog.getByRole("button", { name: "Créer un établissement" }).click()

  await expect(page.getByText("Établissement créé avec succès")).toBeVisible({
    timeout: 30_000,
  })
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  await openKitchenTab(page, name)
  return name
}

async function openKitchenTab(page: Page, name: string) {
  await page.goto(STORES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

  const search = page.getByPlaceholder("Rechercher par nom, ville...")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.fill(name)
  const storeLink = page.getByRole("link", { name })
  await expect(storeLink).toBeVisible({ timeout: 30_000 })
  await storeLink.click()

  await page.getByRole("tab", { name: "Cuisine" }).click()
  await expect(page.getByRole("heading", { name: "Alertes sonores" })).toBeVisible({
    timeout: 30_000,
  })
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Enregistrer les alertes" }).click()
  await expect(page.getByText("Alertes sonores mises à jour")).toBeVisible({
    timeout: 30_000,
  })
}

test.describe("Kitchen sound alerts", () => {
  test("open on what the kitchen is currently hearing", async ({ page }) => {
    // A brand-new establishment has no `soundConfig` at all. The form shows the
    // display's own fallbacks rather than zeroes — otherwise it would claim the
    // alerts are off while the kitchen is beeping.
    await newStoreKitchenTab(page)

    await expect(page.locator(NEW_TICKET_SWITCH)).toBeChecked()
    await expect(page.locator(OVERDUE_SWITCH)).toBeChecked()
    await expect(page.locator(PRINTER_SWITCH)).toBeChecked()
    await expect(volumeReadout(page, "newTicket")).toHaveText("80 %")
    await expect(volumeReadout(page, "overdue")).toHaveText("100 %")
  })

  test("a muted alert survives the round trip", async ({ page }) => {
    // The case that matters most: every default is `enabled: true`, so a mute
    // that does not persist is indistinguishable from no configuration — and
    // the overdue alarm keeps sounding every thirty seconds in a kitchen that
    // switched it off.
    const name = await newStoreKitchenTab(page)

    // `force`: the control is a `sr-only` checkbox behind a styled label.
    await page.locator(OVERDUE_SWITCH).setChecked(false, { force: true })
    await save(page)

    await openKitchenTab(page, name)
    await expect(page.locator(OVERDUE_SWITCH)).not.toBeChecked()
    await expect(page.locator(NEW_TICKET_SWITCH)).toBeChecked()
  })

  test("a volume survives the round trip", async ({ page }) => {
    const name = await newStoreKitchenTab(page)

    // The slider steps by 5; three presses take 80 to 65. The focusable element
    // is the thumb inside the Radix root, which carries no label of its own.
    const thumb = sliderThumb(page, "newTicket")
    await thumb.focus()
    await thumb.press("ArrowLeft")
    await thumb.press("ArrowLeft")
    await thumb.press("ArrowLeft")
    await expect(volumeReadout(page, "newTicket")).toHaveText("65 %")

    await save(page)

    await openKitchenTab(page, name)
    await expect(volumeReadout(page, "newTicket")).toHaveText("65 %")
  })

  test("offers no preview or volume for an alert that is off", async ({ page }) => {
    // A silent alert has no volume to choose and nothing to listen to.
    await newStoreKitchenTab(page)

    await page.locator(NEW_TICKET_SWITCH).setChecked(false, { force: true })

    await expect(
      page.getByRole("button", { name: /Écouter.*Nouveau ticket/ })
    ).toBeDisabled()
    // Radix marks a disabled slider with `data-disabled` rather than the
    // `disabled` attribute — it is a span, not a form control.
    await expect(page.getByTestId("sound-slider-newTicket")).toHaveAttribute(
      "data-disabled",
      ""
    )
  })
})
