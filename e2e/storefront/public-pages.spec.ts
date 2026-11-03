import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

test.describe("Public Pages", () => {
  test.describe("Home Page", () => {
    test("should load the home page", async ({ page }) => {
      const response = await page.goto("/", { waitUntil: "domcontentloaded" })

      expect(response?.status()).toBeLessThan(500)
      await expect(page.locator("body")).not.toBeEmpty()
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })

  test.describe("Menu Page", () => {
    test("should display the heading", async ({ page }) => {
      await page.goto("/menu", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Menu" })
      ).toBeVisible({ timeout: 30_000 })
    })

    test("should display description paragraph", async ({ page }) => {
      await page.goto("/menu", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Menu" })
      ).toBeVisible({ timeout: 30_000 })

      const paragraph = page.locator("p").first()
      await expect(paragraph).toBeVisible()
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/menu", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })

  test.describe("Blog", () => {
    /**
     * The hero, which always renders — not the "Tous les articles" heading,
     * which does not.
     *
     * That heading sits above the grid of everything after the featured
     * article, so a store with exactly one published article shows it as the
     * featured card and the section is correctly absent. Asserting it would
     * have failed on a real, healthy blog and passed here only because the
     * fixture seeds no articles at all — a test that holds for the wrong
     * reason. The hero is unconditional.
     *
     * Its text comes from the CMS and an owner may rewrite it, so the
     * assertion is that the page has a first-level heading and that it says
     * something, not what it says.
     */
    test("renders its hero", async ({ page }) => {
      const response = await page.goto("/blog", { waitUntil: "domcontentloaded" })
      expect(response?.status()).toBeLessThan(400)

      const hero = page.getByRole("heading", { level: 1 })
      await expect(hero).toBeVisible({ timeout: 30_000 })
      await expect(hero).not.toBeEmpty()
    })

    /**
     * The list used to be six hard-coded demo posts linking to a route that did
     * not exist. Whatever it shows now comes from the database, so the check is
     * that every card leads somewhere real rather than that any card is there.
     */
    test("every article card links to an article page that exists", async ({ page }) => {
      await page.goto("/blog", { waitUntil: "domcontentloaded" })

      // The articles arrive from a client-side Convex query, so the list is
      // settled only once it has resolved into one of its two end states:
      // at least one card, or the empty notice. Waiting on the hero alone
      // would race the query and read an empty page as "no dead links".
      await expect(
        page
          .locator('a[href^="/blog/"]')
          .first()
          .or(page.getByText("Aucun article pour le moment"))
      ).toBeVisible({ timeout: 30_000 })

      const hrefs = await page.locator('a[href^="/blog/"]').evaluateAll((links) =>
        links.map((a) => a.getAttribute("href")).filter((h): h is string => !!h)
      )

      for (const href of [...new Set(hrefs)]) {
        const response = await page.request.get(href)
        expect(response.status(), `${href} should not be a dead link`).toBeLessThan(400)
      }
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/blog", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })

  test.describe("Cart Page", () => {
    test("should display the heading", async ({ page }) => {
      await page.goto("/cart", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Votre Box", level: 1 })
      ).toBeVisible({ timeout: 30_000 })
    })

    test("should display description paragraph", async ({ page }) => {
      await page.goto("/cart", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Votre Box", level: 1 })
      ).toBeVisible({ timeout: 30_000 })

      const paragraph = page.locator("p").first()
      await expect(paragraph).toBeVisible()
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/cart", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })

  // An anonymous visitor arrives at /checkout with an empty cart, and the page
  // answers with its empty-Box state rather than the order form. That is the
  // page working; exercising "Finaliser Commande" means adding a product first,
  // which is a flow test, not a does-this-route-render test.
  test.describe("Checkout Page", () => {
    test("should display the heading", async ({ page }) => {
      await page.goto("/checkout", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Votre Box", level: 1 })
      ).toBeVisible({ timeout: 30_000 })
    })

    test("should display description paragraph", async ({ page }) => {
      await page.goto("/checkout", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Votre Box", level: 1 })
      ).toBeVisible({ timeout: 30_000 })

      const paragraph = page.locator("p").first()
      await expect(paragraph).toBeVisible()
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/checkout", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })

  test.describe("Store Selector Page", () => {
    test("should display the heading", async ({ page }) => {
      await page.goto("/store-selector", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Choisir un restaurant" })
      ).toBeVisible({ timeout: 30_000 })
    })

    test("should display description paragraph", async ({ page }) => {
      await page.goto("/store-selector", { waitUntil: "domcontentloaded" })

      await expect(
        page.getByRole("heading", { name: "Choisir un restaurant" })
      ).toBeVisible({ timeout: 30_000 })

      const paragraph = page.locator("p").first()
      await expect(paragraph).toBeVisible()
    })

    test("should not produce console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      await page.goto("/store-selector", { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(2_000)

      cleanup()
      expect(getErrors()).toEqual([])
    })
  })
})
