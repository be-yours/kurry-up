import { test, expect, type Page } from "@playwright/test"

/**
 * A restaurant only offers the kinds of order it runs (#224).
 *
 * `globalSettings.services` is four switches on the settings page. The
 * storefront read `store.overrides.services` instead — `undefined` on every
 * establishment that has not customised it — and the selector treated
 * `undefined` as "offer everything". A restaurant that does not deliver put
 * Livraison in front of its customers, and `orders.create` never looked at
 * `args.type`, so the order went through.
 *
 * The convex suite pins the server rule. This is the button: what a customer
 * can actually press.
 */

const SETTINGS_URL = "/dashboard/settings"
const MENU_URL = "/menu"
const CART_URL = "/cart"

/** Flip a service switch on the settings page and save. */
async function setGlobalServices(
  page: Page,
  services: { dineIn: boolean; takeaway: boolean; delivery: boolean }
) {
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

  const dineIn = page.locator("#dineIn")
  await expect(dineIn).toBeVisible({ timeout: 60_000 })

  // `force`: the control is a `sr-only` checkbox behind a styled label.
  await dineIn.setChecked(services.dineIn, { force: true })
  await page.locator("#takeaway").setChecked(services.takeaway, { force: true })
  await page.locator("#delivery").setChecked(services.delivery, { force: true })

  await page
    .getByRole("button", { name: "Enregistrer les paramètres généraux" })
    .click()
  await expect(page.getByText("Paramètres généraux enregistrés")).toBeVisible({
    timeout: 30_000,
  })
}

/**
 * Put one product in the cart, the way a customer does.
 *
 * The clock is fixed inside the seeded establishment's week (Friday, noon in
 * Paris — it opens 09:00–22:00 and is closed on Mondays). Add-to-cart is
 * disabled outside opening hours, so without this the suite passes or fails on
 * the time of day it happens to run at.
 */
const OPEN_HOUR = new Date("2026-08-28T10:00:00Z") // Friday, 12:00 in Paris

async function fillCart(page: Page) {
  await page.clock.setFixedTime(OPEN_HOUR)
  await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
  const card = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "Pizza Margherita" }) })
    .last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole("button").last().click()

  await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await expect(page.getByRole("heading", { name: "Type de commande" })).toBeVisible({
    timeout: 30_000,
  })
}

const DELIVERY = "Livraison"
const TAKEAWAY = "À emporter"
const DINE_IN = "Sur place"

test.describe("The order-type selector", () => {
  test("hides Livraison when the restaurant does not deliver", async ({ page }) => {
    // The reported symptom, exactly: no store override, delivery off globally.
    await setGlobalServices(page, { dineIn: true, takeaway: true, delivery: false })
    await fillCart(page)

    await expect(page.getByRole("button", { name: TAKEAWAY })).toBeVisible()
    await expect(page.getByRole("button", { name: DINE_IN })).toBeVisible()
    await expect(page.getByRole("button", { name: DELIVERY })).toHaveCount(0)
  })

  test("offers all three when all three are on", async ({ page }) => {
    // The mirror. A selector that hides everything would pass the test above.
    await setGlobalServices(page, { dineIn: true, takeaway: true, delivery: true })
    await fillCart(page)

    await expect(page.getByRole("button", { name: DELIVERY })).toBeVisible()
    await expect(page.getByRole("button", { name: TAKEAWAY })).toBeVisible()
    await expect(page.getByRole("button", { name: DINE_IN })).toBeVisible()
  })

  test("moves a cart off a service the restaurant has stopped running", async ({
    page,
  }) => {
    // The order type is persisted with the cart, so it outlives the switch
    // being turned off. Left alone it reaches checkout and is refused there;
    // `orders.create` would throw. The selection follows the restaurant.
    await setGlobalServices(page, { dineIn: true, takeaway: true, delivery: true })
    await fillCart(page)
    await page.getByRole("button", { name: DELIVERY }).click()

    await setGlobalServices(page, { dineIn: true, takeaway: true, delivery: false })
    await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(page.getByRole("button", { name: TAKEAWAY })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole("button", { name: DELIVERY })).toHaveCount(0)

    // Read the persisted cart rather than the styling: the selection is what
    // checkout sends to `orders.create`, and it is the thing that has to move.
    const persisted = await page.evaluate(() =>
      window.localStorage.getItem("beindigital-cart")
    )
    expect(persisted).toBeTruthy()
    expect(JSON.parse(persisted as string).state.orderType).not.toBe("delivery")
  })
})
