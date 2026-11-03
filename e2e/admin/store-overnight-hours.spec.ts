import { test, expect } from "@playwright/test"

/**
 * A service that crosses midnight sells (#126).
 *
 * `isStoreOpen` compared `"HH:mm"` strings with no wrap, so an 18:00–02:00
 * restaurant read as closed at 23:00 *and* at 01:00 — closed all evening, every
 * evening. That boolean drives the "Restaurant actuellement fermé" banner, the
 * add-to-cart button on every product card, and a hard block in checkout, so
 * the `fast-food-minuit` vertical and the food trucks could not take a single
 * order.
 *
 * The unit suite pins the arithmetic. This walks the whole loop the way an
 * owner does: type 02:00 into the closing field in the dashboard — which the
 * editor has to keep accepting — save, and then look at the storefront at the
 * hours that used to be dead.
 *
 * The clock is fixed per test with `page.clock`, since the answer depends
 * entirely on when it is asked.
 */

const STORES_URL = "/dashboard/stores"
const SEEDED_STORE = "Chez Luigi (test)"

/**
 * 2026-08-28 is a Friday; the 29th a Saturday. The offset is not decoration.
 *
 * These are the RESTAURANT's hours, and `use-store-status` resolves them
 * against `globalSettings.timezone`, which defaults to `Europe/Paris`
 * (`packages/convex-functions/src/globalSettings.ts:148`). Written without an
 * offset, `new Date("2026-08-29T01:00:00")` is parsed on whatever clock the
 * test PROCESS keeps, so the instant handed to `page.clock` differs by machine:
 * 01:00 in Paris on a French laptop, 01:00 UTC on a CI runner, which the app
 * then reads as 03:00 in Paris. Past the 02:00 close, and Saturday's own
 * service does not start until 18:00, so the storefront answered "closed" and
 * the two 01:00 tests failed on CI while passing everywhere they were written.
 *
 * Fixing only those two would have left the other two green for the wrong
 * reason: on a UTC runner `FRIDAY_23H` was exercising 01:00 in Paris and
 * `FRIDAY_10H` was exercising 12:00. All three are pinned, so every machine
 * sends the same instant and the names mean what they say.
 *
 * +02:00 is CEST, which is the offset in force on both these August dates.
 */
const FRIDAY_23H = new Date("2026-08-28T23:00:00+02:00")
const SATURDAY_01H = new Date("2026-08-29T01:00:00+02:00")
const FRIDAY_10H = new Date("2026-08-28T10:00:00+02:00")

const CLOSED_BANNER = "Restaurant actuellement fermé"

/**
 * Put the seeded establishment on an 18:00–02:00 week, through the dashboard.
 *
 * Both hours editors are plain `<input type="time">` with no `close > open`
 * check, and that is deliberate: 02:00 is a legitimate closing time. This is
 * the half of the fix that must not regress.
 */
async function setOvernightHours(page: import("@playwright/test").Page) {
  await page.goto(STORES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

  // Filter first: the list paginates, and other specs leave establishments of
  // their own behind.
  const search = page.getByPlaceholder("Rechercher par nom, ville...")
  // The first visit compiles the route; the dev server can take most of a
  // minute over it, and that is not this test's subject.
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.fill("Chez Luigi")
  const storeLink = page.getByRole("link", { name: SEEDED_STORE })
  await expect(storeLink).toBeVisible({ timeout: 30_000 })
  await storeLink.click()

  await page.getByRole("tab", { name: "Horaires" }).click()

  // Custom hours, not the global ones — the editor only appears with the
  // switch off. `force` because the control is a `sr-only` checkbox behind a
  // styled label: it is in the accessibility tree, not in the layout.
  await page
    .getByRole("switch", { name: "Horaires globaux" })
    .setChecked(false, { force: true })
  await expect(page.locator("#open-1")).toBeVisible({ timeout: 15_000 })

  // Monday is seeded closed; open it, so every day of the week is an evening
  // service and the test does not depend on which day it runs.
  await page.locator("#closed-1").setChecked(false, { force: true })

  await page.locator("#open-1").fill("18:00")
  await page.locator("#close-1").fill("02:00")
  await page.getByRole("button", { name: "Appliquer à tous les jours" }).click()
  await page.getByRole("button", { name: "Enregistrer les horaires" }).click()

  await expect(page.getByText("Horaires mis à jour avec succès")).toBeVisible({
    timeout: 20_000,
  })
}

test.describe("An 18:00–02:00 establishment", () => {
  test.beforeEach(async ({ page }) => {
    await setOvernightHours(page)
  })

  test("is open at 23:00, and the products can be added", async ({ page }) => {
    await page.clock.setFixedTime(FRIDAY_23H)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("heading", { name: "Pizza Margherita" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)
  })

  test("is still open at 01:00, on the next calendar day", async ({ page }) => {
    // The hour the previous evening's service is still running. Saturday's own
    // row cannot answer for it — Saturday opens at 18:00.
    await page.clock.setFixedTime(SATURDAY_01H)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("heading", { name: "Pizza Margherita" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)
  })

  test("is closed at 10:00, between two services", async ({ page }) => {
    // The mirror. A wrap that answers "open" at every hour would pass the two
    // tests above and be just as wrong.
    await page.clock.setFixedTime(FRIDAY_10H)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByText(CLOSED_BANNER)).toBeVisible({ timeout: 30_000 })
  })

  test("lets checkout through at 01:00", async ({ page }) => {
    // `checkout/page.tsx` refuses to submit while `isOpen` is false, with
    // "Le restaurant est actuellement fermé." — the last gate in front of an
    // order, and the one that made the evening unsellable.
    await page.clock.setFixedTime(SATURDAY_01H)
    await page.goto("/menu", { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("heading", { name: "Pizza Margherita" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)

    await page.goto("/checkout", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await expect(page.getByText(CLOSED_BANNER)).toHaveCount(0)
  })
})
