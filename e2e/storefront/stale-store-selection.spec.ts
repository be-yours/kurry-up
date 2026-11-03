import { test, expect } from "@playwright/test"
// The version the seed below must carry. `migrateCartState` recomputes every
// `lineId` when it runs, so a stale version here silently replaces the ids this
// spec selects on.
import { CART_STORAGE_VERSION } from "@be-yours/restaurant"

/**
 * The establishment `convex/seedFixture.ts` creates for the end-to-end run.
 *
 * Named here rather than inlined so that the two specs asserting the header and
 * the footer say WHY they expect it: since #613 the brand is the
 * establishment's own name, and the seed is what decides it.
 */
const STORE_NAME = "Chez Luigi (test)"

/**
 * A store id this browser kept, that this deployment never issued.
 *
 * It reached `cms.getPageBlocks` from the first render, and that query's
 * `storeId: v.id("stores")` validator refuses it. Convex raises the refusal out
 * of `useQuery`, during render, and `StorefrontShell` sits in the
 * `(storefront)` layout - so the throw took every storefront page down rather
 * than one component with it.
 *
 * lib/cms/cms-store-id.test.ts holds the decision. This holds what the visitor
 * gets, which is the part that was broken.
 */

/** Written by the storefront selection store (packages/restaurant). */
const SELECTION_KEY = "beyours-storefront-store"

/**
 * A well-formed Convex id that belongs to no table here - the reported case, a
 * browser carrying a selection from a deployment that no longer serves it.
 * Nothing about its shape marks it out; only this deployment's list can tell.
 */
const FOREIGN_STORE_ID = "j91b7c3d5e7f9g1h3j5k7m9n1p3q5r7s"

test.describe("Stale store selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, storeId }: { key: string; storeId: string }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({ state: { storeId }, version: 0 }),
        )
      },
      { key: SELECTION_KEY, storeId: FOREIGN_STORE_ID },
    )
  })

  test("renders the storefront rather than blanking on it", async ({
    page,
  }) => {
    await page.goto("/menu", { waitUntil: "domcontentloaded" })

    /* Header and footer both live above the page, in the layout that went down.
       The brand link names the ESTABLISHMENT now (#613): it used to read
       « BeYours » because `storefront-header.tsx` fell back to the vendor and
       the seed never wrote the block it reads. A spec asserting that literal
       would pin the defect back in place. */
    await expect(page.getByRole("link", { name: STORE_NAME })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/Tous droits réservés/)).toBeVisible({
      timeout: 30_000,
    })

    /* Those two are server-rendered, and against a dev server that HTML stays
       in the DOM behind the error overlay even once the client tree has thrown
       - so on their own they pass either way. This is the one that bites: the
       footer heading resolves to the establishment's own name and is EMPTY
       until the client has resolved a store the deployment has. Waiting for a
       value to appear cannot pass early, the way asserting the absence of the
       overlay could.

       It used to wait for the heading to stop reading « BeYours ». Since #613
       there is no vendor fallback to stop reading — an unresolved store gives
       an empty heading, deliberately, because an empty header is a gap
       somebody fixes and a vendor's name is a defect nobody notices. So the
       assertion is now that the establishment's name arrives. */
    await expect(page.locator("footer h2").first()).toHaveText(STORE_NAME, {
      timeout: 30_000,
    })

    // By now the overlay would have surfaced, so this no longer races it. Dev
    // only: a production server has no such dialog, and there the assertions
    // above carry the check.
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0)
  })

  test("recovers onto a store the deployment does have", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("link", { name: STORE_NAME })).toBeVisible({
      timeout: 30_000,
    })

    // `useStoreId` replaces a selection that is not in `stores.list`. It was
    // written to do exactly this and could never run: the CMS query threw
    // first. This assertion bites in both builds.
    await expect
      .poll(
        async () =>
          await page.evaluate((key) => {
            const raw = window.localStorage.getItem(key)
            return raw ? JSON.parse(raw).state?.storeId : null
          }, SELECTION_KEY),
        { timeout: 30_000 },
      )
      .not.toBe(FOREIGN_STORE_ID)
  })
})

/**
 * The other half of the same resolution: a visitor with no selection at all.
 *
 * `useStoreId` picks the store in an effect, and that effect runs in the same
 * commit as the checkout's own guard - which had already read `storeId: null`
 * out of the render before it. So the guard fired on a page that was one render
 * away from having a store, and a cold arrival at /checkout was sent to the
 * restaurant picker with a full basket: the visitor who deep-links to it, and
 * the one whose storage was cleared between the payment provider and the
 * return.
 *
 * storefront/checkout-vat.spec.ts fails on this too, three assertions deep and
 * with the wording of an arithmetic defect. This one says what it is.
 */
test.describe("A checkout reached without browsing first", () => {
  /** Written by the cart store (packages/restaurant). */
  const CART_KEY = "beindigital-cart"

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, version }: { key: string; version: number }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            // No store, and none in `beyours-storefront-store` either: this
            // browser has never been on the storefront before.
            state: {
              items: [
                {
                  lineId: "line-menu",
                  productId: "p1",
                  name: "Menu du jour",
                  price: 2_400,
                  quantity: 1,
                  options: [],
                  taxRate: 10,
                },
              ],
              orderType: "pickup",
              storeId: null,
            },
            version,
          }),
        )
      },
      { key: CART_KEY, version: CART_STORAGE_VERSION },
    )
  })

  test("stays on the checkout", async ({ page }) => {
    await page.goto("/checkout", { waitUntil: "domcontentloaded" })

    // The picker renders its own `h1`, so this fails rather than times out when
    // the redirect comes back.
    await expect(
      page.getByRole("heading", { name: /Finaliser/ }),
    ).toBeVisible({ timeout: 30_000 })

    await expect(page).toHaveURL(/\/checkout$/)
  })
})
