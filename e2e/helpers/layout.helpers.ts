import type { Page } from "@playwright/test"

/**
 * Layout checks that a screenshot would show a human and `scrollWidth` does not.
 *
 * WHY THIS EXISTS. `admin-responsive.spec.ts` asked
 * `document.documentElement.scrollWidth > window.innerWidth` and called that
 * "no overflow". It is not the same question. The admin shell wraps its content
 * in `overflow-x-hidden`, so content wider than the viewport is CLIPPED rather
 * than made scrollable: the document never grows, the check stays green, and
 * the reader loses the right-hand edge of whatever it was.
 *
 * Measured on `/dashboard/audience` at 390px before this was written:
 * `scrollWidth` 390, `clientWidth` 390 — and six elements between 404 and
 * 406px, with a card's figures and its footnote cut off mid-word.
 */

export interface LayoutOffender {
  /** A description a developer can act on: tag, classes, and a slice of text. */
  description: string
  width: number
  viewport: number
}

/**
 * Elements inside `main` that are wider than the viewport AND clipped.
 *
 * WIDER IS NOT ENOUGH ON ITS OWN. A data table inside `overflow-x-auto` is
 * wider than the phone on purpose and the reader can scroll it; failing that
 * would make this check unusable in an admin full of tables. What is reported
 * is content the reader cannot reach: the nearest ancestor that constrains it
 * clips rather than scrolls.
 *
 * Only the outermost offender of a chain is reported, because that is the
 * element to fix — a card whose header and content also overflow is one bug,
 * not three.
 */
export async function clippedElements(page: Page): Promise<LayoutOffender[]> {
  return page.evaluate(() => {
    const viewport = window.innerWidth
    const overflows = (el: Element) =>
      el.getBoundingClientRect().width > viewport + 1

    /** Can the reader scroll to what sticks out, or is it cut off? */
    const isClipped = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX
        if (overflowX === "auto" || overflowX === "scroll") return false
        if (overflowX === "hidden") return true
      }
      // Nothing constrains it: the document itself grows and the page scrolls
      // sideways, which is ugly and visible rather than silent. Still a bug.
      return true
    }

    const found: LayoutOffender[] = []
    for (const el of Array.from(document.querySelectorAll("main *"))) {
      if (!overflows(el)) continue
      if (!isClipped(el)) continue
      // Outermost only: skip anything whose parent is already reported.
      const parent = el.parentElement
      if (parent && parent.closest("main") && overflows(parent) && isClipped(parent)) {
        continue
      }
      const classes = (el.className || "").toString().slice(0, 70)
      const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)
      found.push({
        description: `<${el.tagName.toLowerCase()} class="${classes}"> — "${text}"`,
        width: Math.round(el.getBoundingClientRect().width),
        viewport,
      })
    }
    return found
  })
}

/** One line per offender, for an assertion message somebody has to act on. */
export function describeOffenders(offenders: LayoutOffender[]): string[] {
  return offenders.map(
    (o) => `${o.width}px wide in a ${o.viewport}px viewport: ${o.description}`
  )
}

/**
 * Every admin route this operator can actually reach, read off the sidebar.
 *
 * FROM THE SIDEBAR RATHER THAN FROM A LIST. A hard-coded list covers the pages
 * somebody remembered on the day they wrote it — the previous version of this
 * suite checked four of them, and `/dashboard/audience` was not among them
 * because it did not exist yet. Reading the nav means a page added tomorrow is
 * covered tomorrow, and it covers what THIS role is shown rather than what the
 * config declares.
 *
 * READ AT A DESKTOP WIDTH, WHATEVER WIDTH IS BEING TESTED. The sidebar is
 * hidden below `lg` — `admin-responsive.spec.ts` asserts exactly that — so
 * asking it for links at 390px returns nothing, and a sweep over nothing
 * passes. The set of routes does not depend on the viewport; only the sidebar's
 * visibility does. This resizes, reads, and puts the viewport back.
 *
 * Collapsed sections are opened first: their children are not in the DOM until
 * they are.
 */
export async function adminRoutesFromSidebar(page: Page): Promise<string[]> {
  const original = page.viewportSize()

  await page.setViewportSize({ width: 1440, height: original?.height ?? 900 })
  await page.waitForTimeout(400)

  const sidebar = page.locator('[data-slot="sidebar"]')

  const triggers = sidebar.locator("button[data-state]")
  const count = await triggers.count()
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i)
    if ((await trigger.getAttribute("data-state")) === "closed") {
      await trigger.click().catch(() => {})
    }
  }
  await page.waitForTimeout(400)

  const hrefs = await sidebar.locator('a[href^="/dashboard"]').evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
  )

  if (original) await page.setViewportSize(original)

  return [...new Set(hrefs.filter(Boolean))].sort()
}
