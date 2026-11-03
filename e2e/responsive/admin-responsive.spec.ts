import { test, expect } from "@playwright/test"
import { waitForAdminPage } from "../helpers/navigation.helpers"
import {
  adminRoutesFromSidebar,
  clippedElements,
  describeOffenders,
} from "../helpers/layout.helpers"

/**
 * The narrow-screen sweep, over every page the sidebar offers.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. This file used to ask
 * `document.documentElement.scrollWidth > window.innerWidth` on four
 * hard-coded routes. That is not the question it was trying to answer: the
 * admin shell wraps its content in `overflow-x-hidden`, so anything wider than
 * the viewport is CLIPPED rather than made scrollable and the document never
 * grows. Measured on `/dashboard/audience` at 390px: `scrollWidth` 390,
 * `clientWidth` 390 — and six elements at 404–406px with a card's figures and
 * its explanatory footnote cut off mid-word. The check was green throughout.
 *
 * It now measures each element against the viewport and reports the ones the
 * reader cannot get to, and it reads the routes off the sidebar so a page added
 * tomorrow is covered tomorrow rather than whenever somebody remembers this
 * file.
 */
const NARROW_VIEWPORTS = [
  { label: "phone", width: 390, height: 844 },
  { label: "tablet", width: 768, height: 1024 },
]

/**
 * The fewest sidebar links a `client_admin` should ever see.
 *
 * A floor, not a count. Without it, a change to the sidebar markup that made
 * the selector match nothing would leave this suite sweeping zero pages and
 * reporting success — which is the failure mode the check it replaces actually
 * had.
 */
const MINIMUM_SIDEBAR_LINKS = 15

/**
 * Clipping this suite is allowed to ignore. Empty, and meant to stay empty.
 *
 * It held NINE entries across the three runs that added them — the defects the
 * sweep found and did not cause, pinned by route and by the text of what was
 * cut rather than silenced, so that a NEW one still failed. All nine are fixed,
 * so all nine are gone.
 *
 *  - **Cards in a grid**, four of them. A grid item defaults to
 *    `min-width: auto`, so it grows to its own min-content width and its track
 *    grows with it instead of shrinking the item. `min-w-0` on each item the
 *    grid lays out — on `/dashboard/email` that is the right-hand column
 *    `div`, not the cards inside it. On `/dashboard` only one of the two cards
 *    was ever too wide: `ChartContainer` is `aspect-video` and the call site
 *    gives it a definite `h-[200px]`, for an automatic minimum of 356px, and
 *    the 406px measured on « Plats populaires » was the shared track following
 *    its neighbour.
 *  - **Tab lists**, four of them — `/dashboard/orders` at 790px,
 *    `/dashboard/settings` 689px, `/dashboard/system` 465px, and
 *    `/dashboard/languages` at 404px on CI. `TabsList` laid its tabs in a row
 *    that never scrolled, so everything past the visible edge was unreachable.
 *    Fixed in `@be-yours/ui` rather than on the four screens, because the
 *    defect is in that component's own CSS and sixteen call sites render it —
 *    which is also why the count of tabs a screen happens to have stopped
 *    mattering.
 *  - **A row of controls**, one. `/dashboard/products` puts « Dupliquer la
 *    carte », « Créer depuis image » and « Ajouter un produit » side by side in
 *    a `flex` row that neither wrapped nor scrolled, and asked for 576px. It
 *    wraps now, the way the customers header already did.
 *
 * WHY IT REACHED NINE ONE ENTRY AT A TIME, since two different causes were at
 * work and only one of them is what it looks like.
 *
 * MOST OF IT WAS DATA. A screen only clips once it has something to draw, and
 * `/dashboard` is the clearest case: both its cards render an empty state that
 * cannot overflow, and the chart that does overflow appears only once the
 * establishment has traded — 76 paid orders had to be imported before either
 * card could be measured at 406px at all. A laptop with an empty bench is not
 * evidence that a screen is clean.
 *
 * `/dashboard/languages` IS NOT ONE OF THOSE, whatever e0342549's message says
 * — it reasoned that two of that screen's three tabs had not rendered for want
 * of seeded languages, and that is not so. All three `TabsTrigger` children of
 * its `TabsList` are static (`packages/admin/src/pages/languages/languages-page.tsx`),
 * gated on nothing. The 385px measured on macOS and the 404px measured on CI
 * are the same three tabs under different font metrics, which is a thing to
 * expect from any row of text measured against a fixed viewport.
 *
 * Neither cause survives the fixes above, and that is the point of having made
 * them at the source: a `min-w-0`, a scroll container and a `flex-wrap` hold
 * whatever there is to draw at whatever width it renders. In particular the
 * tab strip is no longer reported because its ancestor SCROLLS, not because it
 * got narrower, so the platform's font metrics stopped mattering here.
 *
 * Add an entry only to pin a defect you are not fixing in the same change, and
 * write down what it is. Do not loosen `clippedElements`.
 */
const KNOWN_CLIPPING: ReadonlyArray<{ route: string; contains: string }> = []

/** Is this one of the defects above, rather than a new one? */
function isKnown(route: string, line: string): boolean {
  return KNOWN_CLIPPING.some(
    (known) => known.route === route && line.includes(known.contains)
  )
}

test.describe("Admin layout at narrow widths", () => {
  for (const viewport of NARROW_VIEWPORTS) {
    test.describe(`${viewport.label} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      test("clips nothing on any page the sidebar offers", async ({ page }) => {
        test.slow()

        await page.goto("/dashboard", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        await waitForAdminPage(page)

        const routes = await adminRoutesFromSidebar(page)
        expect(
          routes.length,
          "the sidebar offered almost nothing — the selector is wrong, and a sweep over nothing passes"
        ).toBeGreaterThanOrEqual(MINIMUM_SIDEBAR_LINKS)

        const problems: string[] = []
        for (const route of routes) {
          await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 })
          await waitForAdminPage(page)
          // Charts and tables settle a beat after the data lands, and a card
          // measured mid-render is a card measured at the wrong width.
          await page.waitForTimeout(1_200)

          for (const line of describeOffenders(await clippedElements(page))) {
            if (isKnown(route, line)) continue
            problems.push(`${route} — ${line}`)
          }
        }

        expect(problems, problems.join("\n")).toEqual([])
      })
    })
  }
})

test.describe("Admin Responsive", () => {
  test.describe("Mobile (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } })

    /* The three per-route overflow tests that were here are replaced by the
       sweep above, which covers every page the sidebar offers rather than
       three, and measures clipping rather than document scroll width. */

    test("should show sidebar trigger button on mobile", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Mobile should have a sidebar trigger button (hamburger menu)
      const trigger = page.locator('[data-slot="sidebar-trigger"]')
      await expect(trigger).toBeVisible({ timeout: 10_000 })
    })

    test("should hide sidebar by default on mobile", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Sidebar should not be visible on mobile by default
      const sidebar = page.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeHidden()
    })
  })

  /* The tablet block that was here checked the same three pages with the same
     `scrollWidth` question. The sweep above covers 768px across every page. */

  test.describe("Desktop (1920x1080)", () => {
    test.use({ viewport: { width: 1920, height: 1080 } })

    test("should show sidebar expanded", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const sidebar = page.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeVisible()
    })

    test("clips nothing on any page the sidebar offers", async ({ page }) => {
      test.slow()

      await page.goto("/dashboard", { waitUntil: "domcontentloaded", timeout: 60_000 })
      await waitForAdminPage(page)

      const routes = await adminRoutesFromSidebar(page)
      expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_SIDEBAR_LINKS)

      const problems: string[] = []
      for (const route of routes) {
        await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 })
        await waitForAdminPage(page)
        await expect(page.locator("main")).toBeVisible()
        await page.waitForTimeout(1_200)

        for (const line of describeOffenders(await clippedElements(page))) {
          if (isKnown(route, line)) continue
          problems.push(`${route} — ${line}`)
        }
      }

      expect(problems, problems.join("\n")).toEqual([])
    })

    test("should display stat cards in grid layout", async ({ page }) => {
      await page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      const statCards = page.locator('[data-slot="card"]')
      await expect(statCards.first()).toBeVisible({ timeout: 15_000 })

      // On desktop, stat cards should be laid out in a grid (multiple columns)
      // Check that at least 2 cards are side by side (similar y position)
      const count = await statCards.count()
      test.skip(count < 2, "fewer than two stat cards — no grid to check")
      {
        const box1 = await statCards.nth(0).boundingBox()
        const box2 = await statCards.nth(1).boundingBox()

        if (box1 && box2) {
          // Cards should be on the same row (similar top position)
          const yDiff = Math.abs(box1.y - box2.y)
          expect(yDiff).toBeLessThan(50)
        }
      }
    })
  })

  test.describe("Dialogs on Mobile", () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test("should display create store dialog properly at 375px", async ({
      page,
    }) => {
      await page.goto("/dashboard/stores", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Click the create store button
      const createButton = page.getByRole("button", {
        name: /Ajouter|Créer|Nouveau/i,
      })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await createButton.isVisible({ timeout: 15_000 }).catch(() => false)), "no create button at this width")

      await createButton.click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Dialog should not overflow the viewport
      const dialogBox = await dialog.boundingBox()
      if (dialogBox) {
        expect(dialogBox.width).toBeLessThanOrEqual(375)
      }

      await page.keyboard.press("Escape")
    })

    test("should display invite member dialog properly at 375px", async ({
      page,
    }) => {
      await page.goto("/dashboard/team", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await waitForAdminPage(page)

      // Click the invite button
      const inviteButton = page.getByRole("button", {
        name: /Inviter|Ajouter/i,
      })

      // A silent `if` here let the test finish green having asserted nothing
      // when the element never showed. A skip states the gap instead.
      test.skip(!(await inviteButton.isVisible({ timeout: 15_000 }).catch(() => false)), "no invite button at this width")

      await inviteButton.click()

      const dialog = page.locator('[data-slot="dialog-content"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Dialog should not overflow the viewport
      const dialogBox = await dialog.boundingBox()
      if (dialogBox) {
        expect(dialogBox.width).toBeLessThanOrEqual(375)
      }

      await page.keyboard.press("Escape")
    })
  })
})
