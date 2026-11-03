import { test, expect, type Page } from "@playwright/test"

/**
 * "Horaires globaux" and the establishment's own time zone (#169).
 *
 * Two settings the dashboard wrote and the storefront never read.
 *
 * `useGlobalHours` decided nothing: `use-store-status` took `store.hours`
 * unconditionally, so an owner who edited the global week and left every
 * location on "horaires globaux" changed nothing a visitor could see — the
 * storefront kept showing the hard-coded 09:00–22:00 that `stores.create`
 * seeds.
 *
 * `globalSettings.timezone` was written and read by nobody: open/closed came
 * from `now.getDay()` and `now.getHours()`, the *visitor's* clock. A customer
 * abroad got the wrong answer, and anyone could change it by changing their
 * system clock.
 *
 * These drive both from the dashboard and then read the storefront, with the
 * browser's clock fixed and — for the last two — its time zone set to
 * Montréal, six hours behind the restaurant.
 */

const SETTINGS_URL = "/dashboard/settings"
const STORES_URL = "/dashboard/stores"
const SEEDED_STORE = "Chez Luigi (test)"
const CLOSED_BANNER = "Restaurant actuellement fermé"

/** 21:00 UTC on a Friday: 23:00 in Paris, 17:00 in Montréal. */
const PARIS_EVENING = new Date("2026-08-28T21:00:00Z")
/** 01:30 UTC on the Saturday: 03:30 in Paris, 21:30 in Montréal. */
const PARIS_SMALL_HOURS = new Date("2026-08-29T01:30:00Z")

/** The global week: an evening service, every day. */
async function setGlobalEveningHours(page: Page) {
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.getByRole("tab", { name: "Horaires" }).click()

  const monday = page.locator("#open-1")
  await expect(monday).toBeVisible({ timeout: 60_000 })
  await monday.fill("18:00")
  await page.locator("#close-1").fill("02:00")
  await page.getByRole("button", { name: "Tous les jours" }).click()
  await page.getByRole("button", { name: "Enregistrer les horaires" }).click()

  await expect(page.getByText("Horaires enregistrés")).toBeVisible({ timeout: 20_000 })
}

/**
 * The establishment's own week, and whether it follows the global one.
 *
 * The caller picks its own hours deliberately. For the "horaires globaux"
 * tests they are a daytime service, so "open at 23:00" can only come from the
 * global week. For the time-zone tests they are the evening service itself, so
 * that reading the visitor's clock instead of the restaurant's gives the
 * opposite answer in both directions.
 */
async function setStoreHours(
  page: Page,
  {
    followGlobal,
    open = "09:00",
    close = "12:00",
  }: { followGlobal: boolean; open?: string; close?: string }
) {
  await page.goto(STORES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

  const search = page.getByPlaceholder("Rechercher par nom, ville...")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.fill("Chez Luigi")
  const storeLink = page.getByRole("link", { name: SEEDED_STORE })
  await expect(storeLink).toBeVisible({ timeout: 30_000 })
  await storeLink.click()

  await page.getByRole("tab", { name: "Horaires" }).click()

  // Write the establishment's own daytime week first — the editor is only
  // rendered with the switch off.
  const globalSwitch = page.getByRole("switch", { name: "Horaires globaux" })
  await globalSwitch.setChecked(false, { force: true })
  await expect(page.locator("#open-1")).toBeVisible({ timeout: 15_000 })
  await page.locator("#closed-1").setChecked(false, { force: true })
  await page.locator("#open-1").fill(open)
  await page.locator("#close-1").fill(close)
  await page.getByRole("button", { name: "Appliquer à tous les jours" }).click()

  const save = page.getByRole("button", { name: "Enregistrer les horaires" })
  const saved = page.getByText("Horaires mis à jour avec succès")

  await save.click()
  await expect(saved).toBeVisible({ timeout: 20_000 })

  if (followGlobal) {
    // Both saves raise the same toast, and the first one stays up for four
    // seconds. Flipping the switch and asserting inside that window proved
    // nothing: the assertion passed on the toast that was already there, and
    // the test left for the storefront with `useGlobalHours: true` still in
    // flight — or already undone, because the form re-seeds itself from every
    // echo of the store document the first save produced, and one landing
    // between the toggle and the click puts the switch back.
    //
    // Waiting for the first toast to clear settles both: the toggle happens
    // after the echoes, and a toast appearing afterwards can only be the
    // second save's, which is raised once its mutation has returned.
    await expect(saved).toHaveCount(0, { timeout: 20_000 })

    await globalSwitch.setChecked(true, { force: true })
    await save.click()
    await expect(saved).toBeVisible({ timeout: 20_000 })

    // And read the flag back from the server, since the toast says the request
    // was accepted rather than that the storefront will now see it. The reload
    // is the point: the form re-seeds itself from the store document, so a
    // switch still on after it is one the backend actually kept. Read in the
    // page instead, an echo that undid the toggle would go unnoticed here and
    // arrive three navigations later as a "restaurant fermé" banner with no
    // visible reason to show one.
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("tab", { name: "Horaires" }).click()
    await expect(
      page.getByRole("switch", { name: "Horaires globaux" })
    ).toBeChecked({ timeout: 20_000 })
  }
}

test.describe("Horaires globaux", () => {
  test.beforeEach(async ({ page }) => {
    await setGlobalEveningHours(page)
  })

  test("govern an establishment that follows them", async ({ page }) => {
    // Its own hours say 09:00–12:00 and it is 23:00. Open can only mean the
    // global 18:00–02:00 was read.
    await setStoreHours(page, { followGlobal: true })

    await page.clock.setFixedTime(PARIS_EVENING)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("heading", { name: "Pizza Margherita" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)
  })

  test("are ignored by an establishment with its own", async ({ page }) => {
    // The mirror: the switch has to mean something in both positions.
    await setStoreHours(page, { followGlobal: false })

    await page.clock.setFixedTime(PARIS_EVENING)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByText(CLOSED_BANNER)).toBeVisible({ timeout: 30_000 })
  })
})

test.describe("The establishment's time zone", () => {
  // The visitor is in Montréal, six hours behind the restaurant. Every answer
  // below is the opposite of what their own clock would give.
  test.use({ timezoneId: "America/Montreal" })

  test.beforeEach(async ({ page }) => {
    // The establishment keeps its own evening week here, not the global one.
    // That is what makes both assertions below discriminating: on the
    // visitor's clock, 17:00 in Montréal reads closed and 21:30 reads open —
    // the exact opposite of the truth in Paris, in both directions.
    await setGlobalEveningHours(page)
    await setStoreHours(page, { followGlobal: false, open: "18:00", close: "02:00" })
  })

  test("is open at 23:00 in Paris, though it is 17:00 for the visitor", async ({
    page,
  }) => {
    await page.clock.setFixedTime(PARIS_EVENING)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("heading", { name: "Pizza Margherita" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)
  })

  test("is closed at 03:30 in Paris, though it is 21:30 for the visitor", async ({
    page,
  }) => {
    // The other direction. A storefront reading the visitor's clock would show
    // this one open — 21:30 is inside 18:00–02:00.
    await page.clock.setFixedTime(PARIS_SMALL_HOURS)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByText(CLOSED_BANNER)).toBeVisible({ timeout: 30_000 })
  })
})
