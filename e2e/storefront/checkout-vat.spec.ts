import { test, expect } from "@playwright/test"
// The version the seed below must carry. `migrateCartState` recomputes every
// `lineId` when it runs, so a stale version here silently replaces the ids this
// spec selects on.
import { CART_STORAGE_VERSION } from "@be-yours/restaurant"

/**
 * The total on screen is the total that will be charged.
 *
 * The summary showed the sum of the lines under "TVA incluse" while the server
 * added VAT on top of it — 20 € displayed, 22 € debited at 10 %, 24 € at the
 * default 20. Both sides now run the same `computeOrderTotals`, and it takes
 * the tax *out* of the price: the rate moves the "dont TVA" line and nothing
 * else.
 *
 * `order-vat.test.ts` holds the server half — what Stripe is asked to charge.
 * This holds the half the customer reads before deciding.
 */

/** Written by the cart store (packages/restaurant). */
const CART_KEY = "beindigital-cart"

/** A menu at 10 % and a bottle at 20 %: no single rate describes this basket. */
const ITEMS = [
  {
    lineId: "line-menu",
    productId: "p1",
    name: "Menu du jour",
    price: 2_400,
    quantity: 1,
    options: [],
    taxRate: 10,
  },
  {
    lineId: "line-wine",
    productId: "p2",
    name: "Côtes-du-Rhône",
    price: 1_800,
    quantity: 1,
    options: [],
    taxRate: 20,
  },
]

test.describe("The checkout total", () => {
  // The width most customers order from.
  test.use({ viewport: { width: 375, height: 812 } })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, items, version }: { key: string; items: unknown[]; version: number }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            // No store: the storefront resolves one on load, and the cart
            // empties itself when the one it was filled from changes.
            state: { items, orderType: "pickup", storeId: null },
            version,
          }),
        )
      },
      { key: CART_KEY, items: ITEMS, version: CART_STORAGE_VERSION },
    )
  })

  test("is the sum of the prices on the menu, with the VAT inside it", async ({
    page,
  }) => {
    await page.goto("/checkout", { waitUntil: "domcontentloaded" })

    // The summary is the one block that names the tax: the cart sheet in the
    // layout shows the same total without it.
    await expect(page.getByText("dont TVA")).toBeVisible({ timeout: 30_000 })

    // 24,00 € + 18,00 €. VAT added on top would have read 46,20 €.
    await expect(page.getByText("42,00 €").first()).toBeVisible()

    // 2,18 € in the menu at 10 % plus 3,00 € in the bottle at 20 %. One global
    // rate over the basket declared 3,82 €.
    await expect(page.getByText("5,18 €")).toBeVisible()

    await expect(page.getByText("TVA incluse")).toBeVisible()
  })
})
