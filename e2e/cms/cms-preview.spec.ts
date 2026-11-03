import { test, expect } from "@playwright/test"

/**
 * The CMS preview renders the storefront inside a same-origin `<iframe>`
 * (`app/preview/[pageSlug]/PreviewClient.tsx`).
 *
 * What this file used to assert, and why it was worthless
 * ------------------------------------------------------
 * Two tests, neither of which could report the defect they were named for:
 *
 *   - "should redirect unauthenticated user from preview to sign-in" ended in
 *     `expect(url.includes("/preview/sign-in") || url.includes("/sign-in"))`.
 *     `"/preview/sign-in"` *contains* `"/sign-in"`, so the two branches are the
 *     same branch. It also runs in the "admin" Playwright project, which
 *     carries a saved storage state — so it was never unauthenticated.
 *
 *   - "should display preview banner when authenticated" wrapped its only
 *     assertion in `if (page.url().includes("/preview/"))`, and asserted the
 *     yellow banner, which `PreviewClient` renders *outside* the frame. A
 *     permanently blank frame leaves that banner exactly where it is.
 *
 * Meanwhile `next.config.ts` sent `X-Frame-Options: DENY` and the CSP said
 * `frame-ancestors 'none'`, so the browser refused the frame on every page load
 * and the preview was blank in every environment. The suite stayed green.
 *
 * These tests fail on a blank frame.
 */

const PREVIEW_PATH = "/preview/about"
const FRAME_SELECTOR = "iframe[title^='Preview']"

test.describe("CMS Preview", () => {
  test("serves framing headers that permit a same-origin frame", async ({
    page,
  }) => {
    const response = await page.goto(PREVIEW_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    expect(response, "no response for the preview route").not.toBeNull()
    const headers = response!.headers()

    // DENY refuses a same-origin frame as flatly as a cross-origin one, and
    // where a browser honours both it overrides `frame-ancestors`.
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN")
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'")
  })

  test("renders the storefront page inside the preview frame", async ({
    page,
  }) => {
    await page.goto(PREVIEW_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })

    // The banner is outside the frame; asserting it alone is what the previous
    // version of this file did. It is kept only to prove we are on the preview
    // screen before looking inside the frame.
    await expect(page.getByText(/mode preview/i)).toBeVisible({
      timeout: 30_000,
    })

    const frameElement = page.locator(FRAME_SELECTOR)
    await expect(frameElement).toBeVisible({ timeout: 15_000 })

    // The frame must have loaded the storefront route, not a browser error
    // document. A refused frame never reaches this URL.
    //
    // Polled, not read once. `toBeVisible` resolves as soon as React has put
    // the <iframe> element in the layout, which is before the browser has
    // committed a navigation to its `src`. The frame object exists in that
    // window — so the `not.toBeNull()` this replaces was satisfied — and its
    // url() is the empty string. Measured, by delaying the framed document with
    // page.route(): the previous version, which snapshotted url() on the next
    // line with a plain expect() and no retry, reported
    // `Expected substring: "/about" / Received string: ""`.
    //
    // On an idle machine the navigation lands inside that gap and the test
    // passes; in a full run it does not. Green alone, red under load, which is
    // the failure mode that teaches an integrator to distrust the whole suite.
    let frameUrl = ""
    await expect
      .poll(
        async () => {
          // Re-resolved each iteration: React can replace the element, and a
          // handle taken once would go stale rather than follow it.
          const handle = await frameElement.elementHandle()
          frameUrl = (await handle?.contentFrame())?.url() ?? ""
          return frameUrl
        },
        {
          timeout: 30_000,
          message: "the preview iframe never navigated to the storefront route",
        },
      )
      .toContain("/about")

    // Read from what the poll settled on, so this cannot describe a different
    // navigation than the one just asserted.
    expect(frameUrl).toContain("preview=true")

    // And it must have rendered something. Chrome's blocked-frame document has
    // no heading; the About page's hero does.
    const heading = page.frameLocator(FRAME_SELECTOR).locator("h1").first()
    await expect(heading).toBeVisible({ timeout: 30_000 })
    await expect(heading).not.toBeEmpty()
  })
})
