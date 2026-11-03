import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  formatUnnamed,
  scanAccessibleNames,
  scanIconOnlyControls,
} from "./accessible-name-scan"

/**
 * No icon-only control announces nothing.
 *
 * WCAG 4.1.2 Name, Role, Value and 2.4.4 Link Purpose, both Level A: a control
 * exposes a name. An `<svg>` contributes none, so a button whose only child is
 * an icon is announced as "button" and nothing else.
 *
 * WHAT FOUND IT, and it was not an audit. `order-detail.spec.ts` matched the
 * order screen's back button with
 * `getByRole("link", { name: /retour|orders/i })`; that branch matched nothing
 * on any run, and the `.or(locator('a[href=…]'))` beside it carried the locator
 * alone for as long as the file existed. Asked what it HAD resolved, Playwright
 * answered `getByRole('link').filter({ hasText: /^$/ })` — an empty name, in as
 * many words.
 *
 * CLAUDE.md's Accessibility section listed three guards — contrast, motion,
 * live regions — and accessible names were not among them. That is why a Level
 * A failure on the order screen survived a rewrite of the very spec that
 * touched it.
 *
 * MEASURED ON 25 SEPTEMBER 2026: 167 icon-only controls across these regions,
 * 77 of them with no name. This change names the fifteen on the order, store,
 * e-mail, language, promotion and team screens — the two back buttons and the
 * row menus a reader meets first — and PINS the rest.
 *
 * WHY A LEDGER RATHER THAN A CLEAN SWEEP. The same reason
 * `e2e-not-vacuous.test.ts` keeps one: a label is a sentence somebody has to
 * mean. Writing seventy-seven of them in one pass produces seventy-seven
 * plausible strings and no judgement — "Actions", "Bouton", "Fermer" — and a
 * screen reader is no better served by a wrong name than by none. Each file
 * below is a decision somebody still has to make, and the count is what stops
 * it growing while they do.
 *
 * REMOVE A FILE when its controls are named. The second case fails if you
 * forget, so the ledger cannot drift upward OR stay stale.
 *
 * The scanner, and what it does and does not resolve — `asChild`, `sr-only`,
 * spreads it cannot follow — is documented at
 * `tests/a11y/accessible-name-scan.ts`.
 */

/** The same regions `target-size.test.ts` sweeps, for the same reason. */
const DIRS = [
  "app",
  "components",
  "lib",
  "node_modules/@be-yours/ui/src",
  "node_modules/@be-yours/admin/src",
]

const SWEEP_BUDGET_MS = 120_000

/**
 * Files whose icon-only controls are still unnamed, with how many.
 *
 * Every entry is a Level A failure that a reader using a screen reader meets
 * today. They are pinned, not forgiven.
 */
const PINNED: Record<string, number> = {
  "app/(auth)/forgot-password/page.tsx": 1,
  "app/(auth)/reset-password/page.tsx": 1,
  "app/(auth)/sign-up/page.tsx": 1,
  "app/(storefront)/_components/HomepageContent.tsx": 1,
  "app/(storefront)/cart/_components/CartContent.tsx": 1,
  "app/(storefront)/contact/_components/ContactContent.tsx": 1,
  "components/admin/blog/BlogArticleEditor.tsx": 6,
  "components/admin/blog/BlogArticlesTable.tsx": 1,
  "components/admin/blog/BlogAutoConfigForm.tsx": 2,
  "components/admin/blog/BlogCategoryManager.tsx": 4,
  "components/admin/blog/BlogRichTextEditor.tsx": 1,
  "components/admin/blog/GenerateArticleDialog.tsx": 2,
  "components/admin/blog/GenerateImageDialog.tsx": 1,
  "components/admin/blog/UnsplashImagePicker.tsx": 1,
  "components/admin/cms/CmsFieldRenderer.tsx": 3,
  "components/admin/cms/CmsMediaLibrary.tsx": 2,
  "components/admin/cms/CmsMediaPicker.tsx": 1,
  "components/admin/cms/CmsPageEditor.tsx": 2,
  "components/admin/cms/CmsRichTextEditor.tsx": 5,
  "components/admin/cms/TrendingProductsPicker.tsx": 1,
  "components/admin/subscription/PricingView.tsx": 1,
  "components/storefront/checkout-form.tsx": 1,
  "components/website/favorite-button.tsx": 1,
  "components/website/meal-card.tsx": 1,
  "node_modules/@be-yours/admin/src/components/image-uploader.tsx": 1,
  "node_modules/@be-yours/admin/src/pages/categories/categories-page.tsx": 4,
  "node_modules/@be-yours/admin/src/pages/games/qr-codes-page.tsx": 1,
  "node_modules/@be-yours/admin/src/pages/inventory/inventory-page.tsx": 2,
  /* Was 4. The Deliveroo-accepted cancel button — a control that cannot do
     what it says, and is now disabled rather than removed — gained
     `aria-label="Annulation indisponible pour une commande Deliveroo
     acceptée"`, so a screen reader is told why it is dead instead of
     meeting an unnamed disabled button. One down, three to go. */
  "node_modules/@be-yours/admin/src/pages/kitchen/ticket-card.tsx": 3,
  "node_modules/@be-yours/admin/src/pages/payments/payments-page.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/products/edit-product-page.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/products/image-to-product/image-to-product-page.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/products/menu-form-dialog.tsx": 3,
  "node_modules/@be-yours/admin/src/pages/products/new-product-page.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/products/product-form.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/products/products-page.tsx": 2,
  "node_modules/@be-yours/admin/src/pages/promotions/promotion-form.tsx": 3,
  "node_modules/@be-yours/ui/src/components/AlertDialog.tsx": 2,
  "node_modules/@be-yours/ui/src/components/InputGroup.tsx": 1,
  "node_modules/@be-yours/ui/src/components/Pagination.tsx": 1,
}

/** What the ledger claims, in total. */
const PINNED_TOTAL = Object.values(PINNED).reduce((sum, n) => sum + n, 0)

describe("WCAG 4.1.2 / 2.4.4 accessible names", () => {
  it("adds no icon-only control without a name", () => {
    const found = scanAccessibleNames({ appDir: process.cwd(), dirs: DIRS })

    const unpinned = found.filter((control) => !(control.file in PINNED))
    expect(
      formatUnnamed(unpinned),
      "a new icon-only control announces nothing — give it an aria-label"
    ).toBe("Every icon-only control has an accessible name.")

    // And a pinned file may not gain more than it had.
    const byFile = new Map<string, number>()
    for (const control of found) {
      byFile.set(control.file, (byFile.get(control.file) ?? 0) + 1)
    }
    const grown = [...byFile.entries()]
      .filter(([file, n]) => file in PINNED && n > (PINNED[file] as number))
      .map(([file, n]) => `${file}: ${PINNED[file]} pinned, ${n} found`)

    expect(grown, "a pinned file gained an unnamed control").toEqual([])
  }, SWEEP_BUDGET_MS)

  it("keeps the ledger honest — a file that is fixed must leave it", () => {
    const found = scanAccessibleNames({ appDir: process.cwd(), dirs: DIRS })
    const byFile = new Map<string, number>()
    for (const control of found) {
      byFile.set(control.file, (byFile.get(control.file) ?? 0) + 1)
    }

    const stale = Object.entries(PINNED)
      .filter(([file, n]) => (byFile.get(file) ?? 0) !== n)
      .map(([file, n]) => `${file}: ${n} pinned, ${byFile.get(file) ?? 0} found`)

    expect(
      stale,
      "a pinned file changed: drop it from PINNED if it is fixed, or lower its count"
    ).toEqual([])
  }, SWEEP_BUDGET_MS)

  it("is actually looking at something", () => {
    // A scanner that resolves nothing reports nothing, and "no findings" then
    // reads exactly like "no failures" — the trap `contrast.test.ts` was
    // written to close. The assertions above cannot tell the two apart on
    // their own, so this one counts what the walk DID resolve.
    //
    // Measured on 25 September 2026: 167 icon-only controls, 77 unnamed. A
    // number that collapses here means the scan stopped reading the markup,
    // not that the product became perfect.
    const all = scanIconOnlyControls({ appDir: process.cwd(), dirs: DIRS })
    expect(all.length).toBeGreaterThan(120)
    expect(PINNED_TOTAL).toBeLessThan(all.length)
  }, SWEEP_BUDGET_MS)

  /*
   * The five ways this scanner was blind, each pinned by a case.
   *
   * All five were raised on #664 and all five failed in the SAME direction:
   * they made the guard miss a genuinely unnamed control, which is the one
   * direction that matters — a false finding is answered by writing a label,
   * a missed one is answered by nobody. The docblock claimed the opposite
   * ("what it cannot follow it reports as missing"), so the claim was wrong
   * as well as the code.
   *
   * Fixing them moved the sweep from 162 resolved / 75 unnamed to 166 / 77.
   */
  describe("the ways it used to be blind", () => {
    const scanFixture = (source: string) => {
      const dir = mkdtempSync(join(tmpdir(), "a11y-name-"))
      mkdirSync(join(dir, "app"), { recursive: true })
      writeFileSync(join(dir, "app", "Fixture.tsx"), source)
      try {
        return scanAccessibleNames({ appDir: dir, dirs: ["app"] })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    /** The same fixture, asking what the scan RESOLVED rather than what failed. */
    const countFixture = (source: string) => {
      const dir = mkdtempSync(join(tmpdir(), "a11y-name-"))
      mkdirSync(join(dir, "app"), { recursive: true })
      writeFileSync(join(dir, "app", "Fixture.tsx"), source)
      try {
        return scanIconOnlyControls({ appDir: dir, dirs: ["app"] })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it("counts an empty aria-label as no name", () => {
      expect(scanFixture('<Button aria-label=""><X /></Button>')).toHaveLength(1)
      expect(scanFixture('<Button aria-label="Fermer"><X /></Button>')).toHaveLength(0)
      // A dynamic label is accepted: its value is not knowable here.
      expect(scanFixture("<Button aria-label={label}><X /></Button>")).toHaveLength(0)
    })

    it("counts an empty sr-only span as no name", () => {
      expect(
        scanFixture('<Button><X /><span className="sr-only" /></Button>')
      ).toHaveLength(1)
      expect(
        scanFixture('<Button><X /><span className="sr-only">Fermer</span></Button>')
      ).toHaveLength(0)
    })

    it("sees an icon written as `cond && <Icon/>`", () => {
      // This used to read as text, so the control was not icon-only and the
      // scan skipped it entirely. It is the commonest spelling in this
      // codebase — a spinner, a check beside a selected row.
      expect(scanFixture("<Button>{loading && <Loader />}</Button>")).toHaveLength(1)
      expect(
        scanFixture('<Button aria-label="Charger">{loading && <Loader />}</Button>')
      ).toHaveLength(0)
    })

    it("does not let `asChild={false}` name a child", () => {
      expect(
        scanFixture('<Button asChild={false} aria-label="Retour"><a href="/x"><X /></a></Button>')
      ).toHaveLength(1)
      // And the real `asChild` still does, because Radix merges the props.
      expect(
        scanFixture('<Button asChild aria-label="Retour"><a href="/x"><X /></a></Button>')
      ).toHaveLength(0)
    })

    it("lets `asChild` name its immediate child only", () => {
      // `Slot` merges onto the one child it is given and does not reach a
      // grandchild. Walking the whole ancestor chain let a named wrapper
      // silence every control nested anywhere beneath it.
      const nested = [
        '<Button asChild aria-label="Retour">',
        '  <a href="/x">',
        "    <span>",
        "      <button><X /></button>",
        "    </span>",
        "  </a>",
        "</Button>",
      ].join("\n")

      const found = scanFixture(nested)
      expect(found).toHaveLength(1)
      expect(found[0]?.tag).toBe("button")
    })

    it("examines a self-closing interactive element at all", () => {
      // `ts.isJsxSelfClosingElement` is a different node kind, and the walk
      // matched only `ts.isJsxElement` — so these were never looked at.
      expect(scanFixture('<Link href="/x" />')).toHaveLength(1)
      expect(scanFixture('<Link href="/x" aria-label="Accueil" />')).toHaveLength(0)
      expect(scanFixture('<Link href="/x" aria-hidden="true" />')).toHaveLength(0)
    })

    it("judges both spellings by the same rules", () => {
      // The self-closing form was handled by a second branch, and the branch
      // drifted at once: it ignored `onlyUnnamed`, so the liveness count
      // under-reported, and it skipped `namedByAsChildParent`, so a slot's
      // child was reported although the slot names it.
      const named = '<Link href="/x" aria-label="Accueil" />'
      expect(scanFixture(named)).toHaveLength(0)
      expect(countFixture(named)).toHaveLength(1)

      expect(
        scanFixture('<Button asChild aria-label="Retour"><Link href="/x" /></Button>')
      ).toHaveLength(0)
    })

    it("counts a statically empty expression as no name", () => {
      // `aria-label=""` was closed; the same hole one syntax along was not.
      // React renders none of these, so none of them is a name.
      expect(scanFixture("<Button aria-label={undefined}><X /></Button>")).toHaveLength(1)
      expect(scanFixture("<Button aria-label={null}><X /></Button>")).toHaveLength(1)
      expect(scanFixture('<Button aria-label={""}><X /></Button>')).toHaveLength(1)
      expect(
        scanFixture('<Button><X /><span className="sr-only">{null}</span></Button>')
      ).toHaveLength(1)

      // A value that is not provably empty stays accepted.
      expect(scanFixture("<Button aria-label={t('close')}><X /></Button>")).toHaveLength(0)
    })

    it("honours aria-hidden written as an expression, and on an ancestor", () => {
      // `aria-hidden={"true"}` is the string form in expression clothing.
      expect(scanFixture('<Button aria-hidden={"true"}><X /></Button>')).toHaveLength(0)
      expect(scanFixture("<Button aria-hidden={true}><X /></Button>")).toHaveLength(0)

      // And it is INHERITED: a control inside a hidden subtree is out of the
      // accessibility tree along with it, so naming it would fix nothing.
      expect(
        scanFixture('<div aria-hidden="true"><Button><X /></Button></div>')
      ).toHaveLength(0)
      expect(
        scanFixture('<div aria-hidden="false"><Button><X /></Button></div>')
      ).toHaveLength(1)

      // A dynamic value is not knowable, so the control is still examined.
      expect(scanFixture("<Button aria-hidden={busy}><X /></Button>")).toHaveLength(1)
    })
  })
})
