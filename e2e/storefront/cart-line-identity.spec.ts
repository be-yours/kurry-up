import { test, expect } from "@playwright/test"
// The version the seed below must carry. `migrateCartState` recomputes every
// `lineId` when it runs, so a stale version here silently replaces the ids this
// spec selects on.
import { CART_STORAGE_VERSION } from "@be-yours/restaurant"

/**
 * Two configurations of one dish are two lines.
 *
 * The cart keyed every action on `productId`. One pizza with extra cheese and
 * one plain looked like two lines and behaved like one: "+" on either raised
 * both and doubled the total before checkout, and the bin on either emptied
 * both. The unit tests hold the rule; this holds what the customer's thumb
 * actually does to it, at the width most of them order from.
 *
 * The cart is seeded through localStorage rather than by walking the menu:
 * this deployment may serve no catalogue at all, and the bug lives in the cart,
 * not in the path to it.
 */

/** Written by the cart store (packages/restaurant). */
const CART_KEY = "beindigital-cart"

// The shape of a line id is the store's business — these are seeded as
// opaque values, which is all the page ever treats them as.
const WITH_CHEESE = {
  lineId: "line-with-cheese",
  productId: "p1",
  name: "Margherita",
  price: 1200,
  quantity: 1,
  options: [{ name: "Supplément", choice: "Extra fromage", priceModifier: 150 }],
}

const PLAIN = {
  lineId: "line-plain",
  productId: "p1",
  name: "Margherita",
  price: 1200,
  quantity: 1,
  options: [],
}

test.describe("Two configurations of one dish", () => {
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
      { key: CART_KEY, items: [WITH_CHEESE, PLAIN], version: CART_STORAGE_VERSION },
    )
  })

  test("shows both lines and raises only the one that was tapped", async ({
    page,
  }) => {
    await page.goto("/cart", { waitUntil: "domcontentloaded" })

    // Scoped to the page: the cart sheet in the layout renders the same lines.
    const withCheese = page.locator(`main [data-line-id="${WITH_CHEESE.lineId}"]`)
    const plain = page.locator(`main [data-line-id="${PLAIN.lineId}"]`)

    await expect(withCheese).toBeVisible({ timeout: 30_000 })
    await expect(plain).toBeVisible()

    await plain
      .getByRole("button", { name: "Augmenter la quantité de Margherita" })
      .click()

    // The plain pizza goes to 2. The one with cheese stays at 1 — it used to
    // follow, and the total with it.
    await expect(plain.getByText("2", { exact: true })).toBeVisible()
    await expect(
      withCheese.getByText("1", { exact: true }).first(),
    ).toBeVisible()

    // 13,50 € + 2 × 12,00 € = 37,50 €. Keyed on the product, both lines went
    // to 2 and the cart asked for 51,00 €.
    await expect(page.getByText("37,50 €").first()).toBeVisible()
  })

  test("removes one line and leaves the other", async ({ page }) => {
    await page.goto("/cart", { waitUntil: "domcontentloaded" })

    // Scoped to the page: the cart sheet in the layout renders the same lines.
    const withCheese = page.locator(`main [data-line-id="${WITH_CHEESE.lineId}"]`)
    const plain = page.locator(`main [data-line-id="${PLAIN.lineId}"]`)
    await expect(withCheese).toBeVisible({ timeout: 30_000 })

    // At quantity 1 the minus button asks for confirmation before removing.
    await withCheese
      .getByRole("button", {
        name: "Retirer Margherita (Extra fromage)",
      })
      .click()
    await page.getByRole("button", { name: "Retirer maintenant" }).click()

    await expect(withCheese).toHaveCount(0)
    await expect(plain).toBeVisible()
  })
})
