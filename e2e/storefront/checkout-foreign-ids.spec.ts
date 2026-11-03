import { test, expect } from '@playwright/test'
// The version the seed below must carry: `migrateCartState` rewrites a cart
// saved under an older one, and a stale version here would test the migration.
import { CART_STORAGE_VERSION } from '@be-yours/restaurant'

/**
 * The checkout, and the way back from a refused payment, survive an id this
 * deployment never issued.
 *
 * The order summary reads the dishes' preparation times by the ids in the
 * basket, and the cancel page reads the order it names off the URL. Both ids
 * come from the browser, and Convex refuses one it did not issue before the
 * query runs. `useQuery` re-throws that refusal, so each page answered « Cette
 * page n'a pas pu s'afficher » — over the payment form, and over the only
 * screen a diner sees after a payment fails. Neither was reachable from the
 * UI, which is why nothing caught it: a basket saved before a site moved to a
 * new backend, or a link edited by hand, is all it takes.
 *
 * `checkout-vat.spec.ts` and `legal-pages.spec.ts` seed the same kind of
 * basket and failed first; this names the cause, so the next failure says what
 * it is rather than « dont TVA not found ».
 */

const CART_KEY = 'beindigital-cart'

test.describe('A basket whose dishes this deployment never issued', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, version }: { key: string; version: number }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            state: {
              items: [
                {
                  lineId: 'line-foreign',
                  productId: 'an-id-no-backend-issued',
                  name: 'Pizza Regina',
                  price: 1_200,
                  quantity: 1,
                  options: [],
                  taxRate: 10,
                },
              ],
              orderType: 'pickup',
              storeId: null,
            },
            version,
          }),
        )
      },
      { key: CART_KEY, version: CART_STORAGE_VERSION },
    )
  })

  test('still gets its checkout, without a preparation time nobody can state', async ({ page }) => {
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: /Finaliser/ })).toBeVisible({ timeout: 30_000 })

    // The summary is on screen, and it simply has no estimate to print.
    await expect(page.getByText('dont TVA')).toBeVisible()
    await expect(page.getByText(/Préparation estimée/)).toHaveCount(0)
  })
})

test.describe('The way back from a refused payment', () => {
  test('renders when the link names no order of this deployment', async ({ page }) => {
    // The heading is on screen BEFORE the backend has answered, and a crash can
    // only arrive with the answer — so a check made on first paint passes over
    // the very failure this is for. Wait for the refusal itself: a `QueryFailed`
    // transition on Convex's sync socket.
    const refused = new Promise<void>((resolve) => {
      page.on('websocket', (socket) =>
        socket.on('framereceived', ({ payload }) => {
          if (String(payload).includes('QueryFailed')) resolve()
        }),
      )
    })

    await page.goto('/checkout/cancel?orderId=an-id-no-backend-issued', {
      waitUntil: 'domcontentloaded',
    })
    await refused
    // Two frames, so React has rendered what the refusal led to.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )

    await expect(page.getByRole('heading', { name: /Paiement annulé/ })).toBeVisible()

    // The way back is there, and no order number is invented for it.
    await expect(page.getByRole('link', { name: /Réessayer le paiement/ })).toBeVisible()
    await expect(page.getByText(/reste en attente de paiement/)).toHaveCount(0)
  })
})
