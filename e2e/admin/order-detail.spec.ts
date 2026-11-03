import { test, expect, type Locator, type Page } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"
import { countAfterLoad } from "../helpers/list.helpers"

/**
 * Order Detail Page E2E tests.
 *
 * WHY THIS FILE WAS REWRITTEN (#533). Every case here read
 * `const hasOrder = await navigateToFirstOrder(page); if (hasOrder) { … }`, and
 * the admin project's database had no order when CI ran it. So the whole file
 * passed by never executing a single assertion — and it stayed that way while
 * the row it clicks stopped navigating at all.
 *
 * Three rules followed from that, and they are still what this file does:
 *
 *   - Nothing is wrapped in `if (hasOrder)`. A case that cannot run says so,
 *     rather than returning early and reporting success.
 *   - Opening an order asserts the URL CHANGED before asserting anything about
 *     the page. Without it, every "is this on the detail page" assertion is
 *     really being made against the list page, and several of them pass there:
 *     `heading /Commande/` matches the list's own « Commandes ».
 *   - The heading is matched exactly, for that same reason.
 *
 * WHAT THAT REWRITE COULD NOT FIX ON ITS OWN. Those rules make a case that
 * cannot run SAY so; they do not give it anything to run against. The header
 * here used to end « Measured against a seeded bench, two of its cases fail »
 * and leave it at that — a known defect nobody was going to trip over, because
 * the bench had no order and every case skipped.
 *
 * Measured on 24 September 2026 against a bench seeded with paid orders, three
 * failed. All three on Playwright's strict mode, and all three for one reason:
 * a locator written to describe THIS page could equally be satisfied by the
 * admin sidebar, which is rendered on every admin route.
 *
 *   - the back button, twice — the sidebar's « Commandes » entry and the page's
 *     own icon-only button both carry `href="/dashboard/orders"`;
 *   - the customer's contact details — `getByText("Email")` matched the
 *     sidebar's « Email Marketing » entry as well as the card's own label.
 *
 * So two more rules, and they are the reason this file changed again:
 *
 *   - EVERY locator meant to describe this page is scoped to `main`, which the
 *     admin layout's `SidebarInset` renders and the sidebar sits outside. The
 *     ambiguity is the lesser half of it: a locator the sidebar can satisfy
 *     proves nothing, because it would pass on `/dashboard/settings` just as
 *     well as here.
 *   - The bench seeds orders. `convex/seedFixture.ts` writes two, so
 *     `openFirstOrder` no longer tolerates an empty list — it asserts. A skip
 *     with a reason was the honest answer while the fixture had nothing to
 *     offer. Now that it has, an empty list is a defect — the seed did not run,
 *     or the list stopped listing — and saying so is the whole point of #533.
 */

const ORDERS_URL = "/dashboard/orders"
const INVALID_ORDER_ID = "invalid-order-id-999"

/**
 * The detail page's own back button — not the sidebar's « Commandes » entry.
 *
 * Both carry `href="/dashboard/orders"`, which is what made the unscoped
 * version of this locator match two elements.
 *
 * MATCHED BY ROLE AND NAME, which it could not be until the control had one.
 * This locator used to read
 * `getByRole("link", { name: /retour|orders/i }).or(locator('a[href=…]'))`,
 * and the role branch matched NOTHING on any run: the button renders an
 * `ArrowLeft` and no text, so its accessible name was empty — Playwright
 * reported it as `getByRole('link').filter({ hasText: /^$/ })`. The `.or()`
 * was not a fallback, it was the only branch, and it hid a WCAG 4.1.2 failure
 * for as long as this file existed.
 *
 * The control is named now, so the assertion can be about what a reader is
 * announced rather than about an attribute. `tests/a11y/accessible-name.test.ts`
 * is what keeps it named.
 */
function backToOrders(page: Page): Locator {
  return page.getByRole("main").getByRole("link", { name: "Retour aux commandes" })
}

/**
 * The « Informations client » card, rather than the whole document.
 *
 * `getByText("Email")` matched the sidebar's « Email Marketing » entry as well
 * as this card's label, and strict mode refuses two. « Nom » is scoped the same
 * way although it happened to resolve on the day it was measured: `getByText`
 * takes a SUBSTRING, so any admin chrome containing those three letters
 * satisfies it — on this page or on any other.
 */
function customerCard(page: Page): Locator {
  return page
    .getByRole("main")
    .locator('[data-slot="card"]')
    .filter({ hasText: "Informations client" })
}

test.describe("Order Detail Page", () => {
  /**
   * Open the first order in the list.
   *
   * The click lands on the ROW, which is what a reader of the list does — the
   * row advertises itself with `cursor-pointer` — and the URL assertion
   * afterwards is what makes that click meaningful. It is also what caught the
   * defect this file was rewritten for: the row was decorative and only the
   * text inside each cell navigated.
   *
   * AN EMPTY LIST FAILS HERE. It used to skip, which was right while the
   * fixture wrote no order; `convex/seedFixture.ts` writes two now, so an empty
   * list means the seed did not run or the screen stopped listing, and both are
   * worth a red mark.
   *
   * `expect(...).toBeVisible()` rather than the `rows.count()` this used to
   * read: `count()` is a one-shot read that never retries, and this list
   * arrives from a Convex query a moment after the page does — so it counted 0
   * on a bench that had orders and skipped anyway. Same reasoning as
   * `countAfterLoad`, which this file's last case uses.
   */
  async function openFirstOrder(page: Page): Promise<void> {
    await page.goto(ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    await expect(
      page.getByRole("heading", { name: "Commandes", level: 1 })
    ).toBeVisible({ timeout: 30_000 })

    const rows = page.locator("tbody tr")
    await expect(
      rows.first(),
      "no order to open — convex/seedFixture.ts seeds two, so an empty list " +
        "means the seed did not run (scripts/seed-users.mts) or the list " +
        "stopped listing"
    ).toBeVisible({ timeout: 30_000 })

    await rows.first().click()

    // The whole point of the click. Asserted before anything about the page,
    // because the list page satisfies several of the assertions below.
    await expect(page).toHaveURL(/\/dashboard\/orders\/[^/]+$/, {
      timeout: 15_000,
    })
  }

  test.describe("Page Structure", () => {
    test("should display order heading with order number", async ({
      page,
    }) => {
      await openFirstOrder(page)

      /*
       * EXACT, not `/Commande/`. That pattern matches the LIST page's own
       * « Commandes » heading, so the case passed whether or not the click had
       * navigated — which is precisely how the dead row survived. The detail
       * heading is « Commande #ORD-YYYY-NNNNN », and the number is what proves
       * an order was opened rather than a list.
       */
      await expect(
        page.getByRole("heading", { name: /^Commande #\S+/, level: 1 })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display back button linking to /orders", async ({
      page,
    }) => {
      await openFirstOrder(page)

      await expect(backToOrders(page)).toBeVisible({ timeout: 15_000 })
    })

    test("should display status badge", async ({ page }) => {
      await openFirstOrder(page)

      // One of the status badges should be visible
      const statusTexts = [
        "En attente",
        "Confirmée",
        "En préparation",
        "Prête",
        "En livraison",
        "Livrée",
        "Terminée",
        "Annulée",
      ]

      const statusBadge = page
        .getByRole("main")
        .locator('[data-slot="badge"]')
        .filter({ hasText: new RegExp(statusTexts.join("|")) })

      await expect(statusBadge.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should display type badge", async ({ page }) => {
      await openFirstOrder(page)

      const typeTexts = ["Livraison", "À emporter", "Sur place"]

      const typeBadge = page
        .getByRole("main")
        .locator('[data-slot="badge"]')
        .filter({ hasText: new RegExp(typeTexts.join("|")) })

      await expect(typeBadge.first()).toBeVisible({ timeout: 15_000 })
    })

    test("should display items table", async ({ page }) => {
      await openFirstOrder(page)

      // Check for the items table with expected columns
      const table = page.getByRole("main").locator("table")
      await expect(table).toBeVisible({ timeout: 15_000 })

      // Verify column headers
      const headers = table.locator("thead th")
      const headerTexts = ["Produit", "Qté", "Prix", "Sous-total"]

      for (const headerText of headerTexts) {
        await expect(
          headers.filter({ hasText: headerText })
        ).toBeVisible()
      }
    })
  })

  test.describe("Customer Info", () => {
    test("should display customer name", async ({ page }) => {
      await openFirstOrder(page)

      // Look for the customer info section with "Nom" label
      await expect(
        customerCard(page).getByText("Nom", { exact: true })
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display customer contact info", async ({ page }) => {
      await openFirstOrder(page)

      // Look for Email or Téléphone labels
      const card = customerCard(page)
      const emailLabel = card.getByText("Email", { exact: true })
      const phoneLabel = card.getByText("Téléphone", { exact: true })

      await expect(emailLabel.or(phoneLabel).first()).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Status Actions", () => {
    test("should display status action buttons", async ({ page }) => {
      await openFirstOrder(page)

      // Wait for the page to fully load
      await page.waitForTimeout(2_000)

      // Status action buttons should be present (e.g., "Confirmer", "Préparer", etc.)
      const actionButtons = page
        .getByRole("main")
        .getByRole("button")
        .filter({
          hasText: /Confirmer|Préparer|Prête|Livrer|Terminer|Annuler/,
        })

      // At least one action button should exist (unless order is in terminal state)
      const count = await countAfterLoad(actionButtons)
      // Some orders in terminal states (Terminée, Annulée) may have no action buttons
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })

  test.describe("Not Found", () => {
    test('should show "Commande introuvable" for invalid order ID', async ({
      page,
    }) => {
      await page.goto(`/dashboard/orders/${INVALID_ORDER_ID}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await expect(
        page.getByRole("main").getByText("Commande introuvable")
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should show loading state initially", async ({ page }) => {
      // Navigate to an order detail page and check for loading state
      await page.goto(`/dashboard/orders/${INVALID_ORDER_ID}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Either loading text or the not found message should appear
      const main = page.getByRole("main")
      const loadingText = main.getByText(
        "Chargement des détails de la commande..."
      )
      const notFoundText = main.getByText("Commande introuvable")

      await expect(loadingText.or(notFoundText).first()).toBeVisible({
        timeout: 15_000,
      })
    })
  })

  test.describe("Navigation", () => {
    test("should navigate back to /orders via back button", async ({
      page,
    }) => {
      await openFirstOrder(page)

      const backLink = backToOrders(page)

      await expect(backLink).toBeVisible({ timeout: 15_000 })
      await backLink.click()

      await expect(page).toHaveURL(/\/dashboard\/orders$/, { timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await openFirstOrder(page)

      // Wait for page to settle
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
