import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

test.describe("Screens that must render, whether or not they are built", () => {
  // The four gamification screens left this list when the player flow moved to
  // `@be-yours/admin/game`: both apps now render the real
  // `Game{Catalog,QrCodes,Actions,Winners}Page`, and `games.spec.ts` asserts
  // them. `/dashboard/games/settings` is absent for a different reason — the
  // route has no page in either app. It was declared in `adminRoutes` and
  // linked from nowhere, so the constant went rather than the 404 being
  // tolerated here.
  // The list was named for a fact that had stopped being true, and then the
  // correction went stale in turn: `/dashboard/content/components` is now the
  // ONLY route here that renders `<ComingSoon/>`. Email, CMS pages and blog
  // became real screens, and `/dashboard/customers` did too — it renders
  // `CustomersPage`, the customer book #364 built, since #481. They stay in the
  // list — a smoke test over the routes an owner opens first is worth keeping —
  // but neither the name nor the describe claims otherwise any more.
  const smokeTestedPages = [
    "/dashboard/customers",
    "/dashboard/content/components",
    "/dashboard/email",
    "/dashboard/email/campaigns",
    "/dashboard/content/pages",
    "/dashboard/content/blog",
  ]

  for (const pagePath of smokeTestedPages) {
    test(`should render ${pagePath} without crashing`, async ({ page }) => {
      const { getErrors, cleanup } = collectConsoleErrors(page)

      const response = await page.goto(pagePath, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      // Page should not return a 500 server error
      expect(response?.status()).toBeLessThan(500)

      // Page body should not be empty
      await expect(page.locator("body")).not.toBeEmpty()

      // Wait for any async rendering
      await page.waitForTimeout(2_000)

      cleanup()

      const errors = getErrors()
      expect(errors).toEqual([])
    })
  }
})
