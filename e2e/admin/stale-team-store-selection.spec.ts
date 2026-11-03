import { test, expect } from "@playwright/test"

/**
 * A stale admin selection must not take `/dashboard/team` down (#224).
 *
 * The persisted admin store id is a bare id in localStorage, and localStorage
 * outlives the deployment that issued it. `teamMembers.list` declares
 * `storeId: v.id("stores")`, which refuses an id belonging to another
 * deployment, and Convex raises that refusal out of `useQuery` during render.
 *
 * `/dashboard/team` is one of `StoreGuard`'s `BYPASS_ROUTES`, so the page
 * renders before the guard has settled the selection. The guard does repair it
 * — its effect runs on bypassed routes too — but one render happens first, and
 * one render was all it took. This is the same shape as #119, which was fixed
 * for the storefront and not here.
 */

/** Written by the admin selection store (packages/restaurant). */
const SELECTION_KEY = "beyours-admin-store"

/**
 * A well-formed Convex id belonging to no table here. Nothing about its shape
 * marks it out — only this deployment's list can tell.
 */
const FOREIGN_STORE_ID = "j91b7c3d5e7f9g1h3j5k7m9n1p3q5r7s"

const TEAM_URL = "/dashboard/team"

test.describe("A stale admin store selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ key, storeId }: { key: string; storeId: string }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({ state: { storeId }, version: 0 })
        )
      },
      { key: SELECTION_KEY, storeId: FOREIGN_STORE_ID }
    )
  })

  test("still renders the team page", async ({ page }) => {
    await page.goto(TEAM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

    // The heading is below the point the render used to throw at.
    await expect(page.getByRole("heading", { name: /Équipe/i }).first()).toBeVisible({
      timeout: 60_000,
    })
  })

  test("recovers onto a real establishment rather than staying empty", async ({
    page,
  }) => {
    // `StoreGuard` replaces the unknown id; the page then asks about a store
    // this deployment actually has. Waiting for the invite control to appear
    // cannot pass early the way asserting the absence of an error could.
    await page.goto(TEAM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

    await expect(
      page.getByRole("button", { name: /Inviter/i }).first()
    ).toBeVisible({ timeout: 60_000 })

    const persisted = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      SELECTION_KEY
    )
    expect(JSON.parse(persisted as string).state.storeId).not.toBe(
      FOREIGN_STORE_ID
    )
  })
})
