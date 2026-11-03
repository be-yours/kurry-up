import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

/**
 * Tracking Page E2E Tests
 *
 * The tracking page at /track/[token] is a customer-facing mobile page.
 * With an invalid token it should show the "Commande introuvable" error state.
 * With no token / loading, it shows skeleton loading.
 */
test.describe("Tracking Page", () => {
  test.describe("Invalid Token", () => {
    const TRACKING_URL = "/track/invalid-token-abc123"

    test("should show loading skeleton or invalid message", async ({ page }) => {
      const response = await page.goto(TRACKING_URL, {
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

      // Either skeleton loading or the invalid message should appear
      const skeleton = page.locator(".animate-pulse")
      const invalidMsg = page.getByText("Commande introuvable")
      const body = page.locator("body")

      await expect(
        skeleton.first().or(invalidMsg).or(body).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should eventually display invalid token message", async ({ page }) => {
      const response = await page.goto(TRACKING_URL, {
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

      // After Convex resolves, the invalid token message should appear
      await expect(
        page.getByText("Commande introuvable")
      ).toBeVisible({ timeout: 30_000 })
    })
  })

  test.describe("Page Structure", () => {
    const TRACKING_URL = "/track/test-token-xyz"

    test("should render page container", async ({ page }) => {
      const response = await page.goto(TRACKING_URL, {
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

      // The page should render within a container
      await expect(page.locator("body")).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Console Errors", () => {
    test("should not produce unexpected console errors", async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      const response = await page.goto("/track/invalid-token-test", {
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
