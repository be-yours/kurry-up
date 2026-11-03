import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"

test.describe("Subscription Page", () => {
  test.describe("Page Loading", () => {
    test("should load subscription page", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should display subscription heading
      await expect(
        page.getByRole("heading", { name: /abonnement/i })
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Pricing View (no active subscription)", () => {
    test("should display pricing cards", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // `Promise.any` over three `isVisible()` reads resolves as soon as the
      // FIRST of them answers — including when it answers false, because a
      // fulfilled false is still a fulfilled promise. So this raced the cards
      // and lost roughly one run in three, in two seconds flat. One polling
      // assertion over the three names does what the comment intended.
      await expect(
        page
          .getByText("Starter")
          .or(page.getByText("Pro"))
          .or(page.getByText("Enterprise"))
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display monthly article quotas", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should show article quotas (2, 8, 30)
      await expect(
        page.getByText(/articles?\s*\/?\s*mois/i).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display image quotas", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should show image quotas feature line
      await expect(
        page.getByText(/images?\s*ia/i).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display Image vers Produit quotas", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Should show Image vers Produit feature line
      await expect(
        page.getByText(/image\s*vers\s*produit/i).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display billing toggle (monthly/annual)", async ({
      page,
    }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // `expect(typeof x).toBe("boolean")` cannot fail: it passed whether the
      // toggle was there or not, which is a test that reports nothing. This
      // describe block is the pricing view, and the pricing view has a billing
      // interval.
      await expect(
        page.getByRole("main").getByText(/mensuel|annuel/i).first()
      ).toBeVisible({ timeout: 15_000 })
    })

    test("should display subscribe buttons", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // `expect(...).toBeVisible()`, not `isVisible()`: the latter is a
      // one-shot read that does not retry, so whenever `.first()` landed on a
      // matching button the page had not shown yet it answered false in two
      // seconds and the test failed on timing rather than on content. The
      // assertion polls until the deadline.
      //
      // Scoped to the page, not the shell: the regex also matches chrome that
      // may be off screen at this width.
      await expect(
        page
          .getByRole("main")
          .getByRole("button", {
            name: /choisir|s'abonner|souscrire|commencer|g[eé]rer/i,
          })
          .first()
      ).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Current Plan View (active subscription)", () => {
    test("should display plan features list", async ({ page }) => {
      await page.goto("/dashboard/subscription", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })

      await waitForAdminPage(page)

      // Check for feature indicators (check/x icons)
      const featureList = page.locator("ul li").filter({
        hasText: /articles?|images?|langue|publication|produit/i,
      })

      // Same vacuous shape as the billing toggle above: a boolean is always a
      // boolean. Each plan lists what it includes, so assert that.
      await expect(featureList.first()).toBeVisible({ timeout: 15_000 })
    })
  })
})
