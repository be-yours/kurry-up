import { test, expect } from '@playwright/test'
import { CART_STORAGE_VERSION } from '@be-yours/restaurant'

/**
 * The engine-owned legal pages, reachable from every footer and named at the
 * checkout.
 *
 * The content assertions — that a missing statement reads « non communiqué »
 * and nothing is invented — live in `tests/storefront/legal-pages.test.tsx`,
 * where the settings can be chosen. What only a browser can prove is here: the
 * routes exist and render, the footer links reach them, and the order button
 * has the CGV line beside it.
 */

const PAGES = [
  { path: '/mentions-legales', heading: 'Mentions légales', footer: 'Mentions légales' },
  {
    path: '/cgv',
    heading: 'Conditions générales de vente',
    footer: 'Conditions générales de vente',
  },
  {
    path: '/confidentialite',
    heading: 'Politique de confidentialité',
    footer: 'Politique de confidentialité',
  },
]

test.describe('Legal pages', () => {
  for (const { path, heading } of PAGES) {
    test(`${path} renders its heading`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBeLessThan(400)

      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
        timeout: 30_000,
      })
    })
  }

  test('the footer links all three', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const legalNav = page.getByRole('navigation', { name: 'Informations légales' })
    await expect(legalNav).toBeVisible({ timeout: 30_000 })

    for (const { path, footer } of PAGES) {
      await expect(legalNav.getByRole('link', { name: footer })).toHaveAttribute('href', path)
    }
  })

  test('the footer shows no social icon that goes nowhere', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('navigation', { name: 'Informations légales' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('footer a[href="#"]')).toHaveCount(0)
  })

  test('the footer link opens the page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page
      .getByRole('navigation', { name: 'Informations légales' })
      .getByRole('link', { name: 'Conditions générales de vente' })
      .click()

    await expect(page).toHaveURL(/\/cgv$/, { timeout: 30_000 })
    await expect(
      page.getByRole('heading', { level: 1, name: 'Conditions générales de vente' }),
    ).toBeVisible({ timeout: 30_000 })
  })
})

test.describe("The checkout's CGV line", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ items, version }: { items: unknown[]; version: number }) => {
        window.localStorage.setItem(
          'beindigital-cart',
          JSON.stringify({
            state: { items, orderType: 'pickup', storeId: null },
            version,
          }),
        )
      },
      {
        items: [
          {
            lineId: 'line-menu',
            productId: 'p1',
            name: 'Menu du jour',
            price: 2_400,
            quantity: 1,
            options: [],
            taxRate: 10,
          },
        ],
        version: CART_STORAGE_VERSION,
      },
    )
  })

  test('names the CGV and the privacy policy beside the order button', async ({ page }) => {
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' })

    const line = page.getByTestId('checkout-terms-acceptance')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await expect(line).toContainText('vous acceptez nos')
    await expect(line.getByRole('link', { name: 'conditions générales de vente' })).toHaveAttribute(
      'href',
      '/cgv',
    )
    await expect(line.getByRole('link', { name: 'politique de confidentialité' })).toHaveAttribute(
      'href',
      '/confidentialite',
    )
  })
})
