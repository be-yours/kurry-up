import { test, expect } from "@playwright/test"

/**
 * The player route renders the real flow, in both apps.
 *
 * This is the regression guard for #159. `apps/themes` shipped a placeholder
 * here for months — a purple card reading "Gamification flow will be
 * implemented here" — while the bench ran the whole wheel/scratch flow, and the
 * gap was recorded as deliberate instead of closed. The backend was live on
 * every client deployment the entire time.
 *
 * The assertions deliberately do not need seeded game data. Whatever the code
 * resolves to, the real flow answers with one of its own screens — the arena
 * shell while `getSession` is in flight, or "le jeu fait une pause" once it
 * comes back empty. The placeholder answers with neither. That is the whole
 * difference this spec exists to hold, and it holds with or without a backend.
 */

const UNKNOWN_CODE = "e2e-unknown-table"

test.describe("Game player flow", () => {
  test("renders the player flow, not a placeholder", async ({ page }) => {
    await page.goto(`/game/${UNKNOWN_CODE}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    // The placeholder's two strings. Neither may come back.
    await expect(page.getByText("Gamification flow will be implemented here")).toHaveCount(0)
    await expect(page.getByText("Play & Win!")).toHaveCount(0)

    // The real flow always renders one of these two: the loading arena while
    // the session query is in flight, or the unavailable screen once it
    // resolves to nothing.
    const loading = page.getByText("Préparation du jeu…")
    const unavailable = page.getByText("Le jeu fait une pause")
    await expect(loading.or(unavailable).first()).toBeVisible({ timeout: 30_000 })
  })

  test("serves the prize ticket route", async ({ page }) => {
    // `convex/customerEmail.ts` emails this URL and `RewardTicket` encodes it into
    // the QR the customer keeps. The route did not exist in the template at
    // all, so both already pointed at a 404 on every client site.
    const response = await page.goto("/game/prize/E2ENOSUCHCODE", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    expect(response?.status()).toBeLessThan(400)
    await expect(page.locator("body")).not.toBeEmpty()
  })
})
