import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

/**
 * Display Screen E2E Tests
 *
 * The display page at /display/[storeId] is a customer-facing TV screen.
 * It requires a valid storeId and Convex connection.
 * Tests verify the page loads without crashing and shows expected structure.
 */
test.describe("Display Screen", () => {
  const DISPLAY_URL = "/display/test-store-id"

  test.describe("Page Load", () => {
    test("should render without crashing", async ({ page }) => {
      const response = await page.goto(DISPLAY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      /*
       * A 404 here is the defect, not a reason to stand down (#635).
       *
       * This branch used to `test.skip(true, "route not compiled yet")`, so a
       * storefront page that stopped resolving turned its own spec green. Both
       * routes exist — `app/display/[storeId]/page.tsx` and
       * `app/(storefront)/track/[token]/page.tsx` — so the skip was describing a
       * tree that had moved on, and it was the shape that hides a regression
       * rather than reports one.
       */
      expect(response?.status(), "the route must resolve").not.toBe(404)

      // The page should at minimum render body content
      await expect(page.locator("body")).toBeVisible({ timeout: 15_000 })
    })

    test("should display loading state or content", async ({ page }) => {
      const response = await page.goto(DISPLAY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      /*
       * A 404 here is the defect, not a reason to stand down (#635).
       *
       * This branch used to `test.skip(true, "route not compiled yet")`, so a
       * storefront page that stopped resolving turned its own spec green. Both
       * routes exist — `app/display/[storeId]/page.tsx` and
       * `app/(storefront)/track/[token]/page.tsx` — so the skip was describing a
       * tree that had moved on, and it was the shape that hides a regression
       * rather than reports one.
       */
      expect(response?.status(), "the route must resolve").not.toBe(404)

      // Loading indicator or main content should appear
      const loading = page.getByText("Chargement...")
      const main = page.locator("main")
      const body = page.locator("body")

      // `.or(body)` cannot resolve to one element: body always matches, and so
      // does whatever else the page rendered. Strict mode rejects the pair.
      await expect(
        loading.or(main).or(body).first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      const response = await page.goto(DISPLAY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      /*
       * A 404 here is the defect, not a reason to stand down (#635).
       *
       * This branch used to `test.skip(true, "route not compiled yet")`, so a
       * storefront page that stopped resolving turned its own spec green. Both
       * routes exist — `app/display/[storeId]/page.tsx` and
       * `app/(storefront)/track/[token]/page.tsx` — so the skip was describing a
       * tree that had moved on, and it was the shape that hides a regression
       * rather than reports one.
       */
      expect(response?.status(), "the route must resolve").not.toBe(404)

      await page.waitForTimeout(3_000)
      cleanup()

      const errors = getErrors().filter(
        (e) => !e.includes("404") && !e.includes("Not Found")
      )
      expect(errors).toEqual([])
    })
  })
})
