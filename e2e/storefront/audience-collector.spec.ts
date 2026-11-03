import { test, expect } from "@playwright/test"
import { collectConsoleErrors } from "../helpers/console.helpers"

/**
 * The collector, watched from the diner's side.
 *
 * WHAT THIS CAN AND CANNOT SEE. The hits themselves leave over Convex's
 * websocket, which Playwright cannot usefully intercept, so this does not
 * assert what reaches the database. What it does assert is the whole of the
 * contract the collector has with the browser it runs in: it mounts, it marks
 * the visit exactly once, it survives a route with no page key, and it never
 * puts an error on a diner's console. Those are the parts that break silently.
 *
 * The visit marker is also the whole of the identity this feature has, so its
 * shape is worth pinning: one key, one character, in `sessionStorage` and not
 * in `localStorage` or a cookie.
 */

const VISIT_KEY = "beyours.audience.visit"

const visitMarker = (page: import("@playwright/test").Page) =>
  page.evaluate((key) => window.sessionStorage.getItem(key), VISIT_KEY)

test.describe("Audience collector", () => {
  test("marks the visit on the first storefront page", async ({ page }) => {
    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 })

    await expect.poll(() => visitMarker(page), { timeout: 15_000 }).toBe("1")
  })

  /*
   * A visit is one run of activity in one tab. Counting a second one because
   * the diner opened the menu after the home page is the commonest way an
   * audience figure ends up meaning nothing.
   */
  test("does not start a second visit when the diner moves around the site", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect.poll(() => visitMarker(page), { timeout: 15_000 }).toBe("1")

    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await page.goto("/contact", { waitUntil: "domcontentloaded" })
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 })

    expect(await visitMarker(page)).toBe("1")
  })

  /*
   * `sessionStorage`, not `localStorage` and not a cookie. A marker that
   * outlived the tab would make a diner who comes back tomorrow look like the
   * same visit; a cookie would need a consent banner, which is the one thing
   * this design exists to avoid.
   */
  test("keeps the marker out of localStorage and out of the cookie jar", async ({
    page,
    context,
  }) => {
    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await expect.poll(() => visitMarker(page), { timeout: 15_000 }).toBe("1")

    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), VISIT_KEY)
    ).toBeNull()

    const cookies = await context.cookies()
    expect(cookies.filter((cookie) => cookie.name.includes("audience"))).toEqual([])
  })

  /*
   * `/account` is deliberately outside `PAGE_KEYS` — it is a signed-in diner's
   * own dossier. The collector must record nothing there and carry on working,
   * rather than throwing on a route it cannot classify.
   */
  test("records nothing on a route it cannot classify, and does not break", async ({
    page,
  }) => {
    const consoleErrors = collectConsoleErrors(page)

    await page.goto("/account", { waitUntil: "domcontentloaded" })
    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 })

    await expect.poll(() => visitMarker(page), { timeout: 15_000 }).toBe("1")
    expect(consoleErrors.getErrors()).toEqual([])
    consoleErrors.cleanup()
  })

  test("puts no error on a diner's console while they browse", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)

    await page.goto("/menu", { waitUntil: "domcontentloaded" })
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 })
    // Long enough for the five-second flush to fire at least once.
    await page.waitForTimeout(6_000)

    expect(consoleErrors.getErrors()).toEqual([])
    consoleErrors.cleanup()
  })
})
