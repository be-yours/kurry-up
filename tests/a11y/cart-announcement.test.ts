/**
 * The cart's live region is mounted where it survives.
 *
 * WHAT WAS BROKEN, and it is the guard rather than the code. `CartAnnouncer`
 * carries the right attributes and says in its own comment why it sits in the
 * shell rather than in the cart sheet: "a live region has to be in the document
 * BEFORE its contents change, and the sheet is a dialog that unmounts when
 * closed. Every mutation made from a product card — which is most of them —
 * would happen while a region inside the sheet did not exist."
 *
 * That reasoning was held by nothing. Measured on this tree, deleting the single
 * `<CartAnnouncer />` line from `storefront-shell.tsx` left `tests/a11y/` at
 * **6 files, 33 tests, all green**: the component still existed, still declared
 * `role="status"`, still compiled, and announced nothing to anybody because it
 * was rendered nowhere.
 *
 * `reduced-motion.test.ts` learned this one file over and states it plainly —
 * "A provider that renders no children provides nothing. This is the failure
 * mode a source check exists to catch: it type-checks, it renders, and it
 * reaches nothing." It asserts `<MotionConfig>` is at the root AND wraps the
 * children. The same lesson had not been carried across to the announcer.
 *
 * A SOURCE ASSERTION, for the reason that file gives: what must not disappear
 * is the MOUNT, and a rendering test that mounts the shell itself would prove
 * the shell renders rather than that the region outlives the sheet.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { APP_ROOT } from "../lib/repo-layout"

const STOREFRONT = join(APP_ROOT, "components/storefront")

const read = (file: string): string => readFileSync(join(STOREFRONT, file), "utf8")

/** Source with comments removed: a comment naming the region is not the region. */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/[^\n]*/g, "")

describe("the announcer is a live region", () => {
  const announcer = code("cart-announcer.tsx")

  it("declares one, with both spellings", () => {
    // `role="status"` and `aria-live` together, because support for the two is
    // uneven — the component's own comment says so, and this is what holds it.
    expect(announcer).toMatch(/role="status"/)
    expect(announcer).toMatch(/aria-live="polite"/)
  })

  it("reads the whole message rather than the changed word", () => {
    expect(announcer).toMatch(/aria-atomic="true"/)
  })

  it("is visually silent", () => {
    // A live region that takes layout is a design change nobody asked for.
    expect(announcer).toMatch(/sr-only/)
  })
})

describe("it is mounted where it outlives the sheet", () => {
  const shell = code("storefront-shell.tsx")

  it("the shell renders it", () => {
    // The whole defect: deleting this one line changed no test.
    expect(shell).toMatch(/<CartAnnouncer\s*\/>/)
  })

  it("the shell imports it from the module that defines it", () => {
    // Guards the guard: a `<CartAnnouncer />` with no import is a build error,
    // but a rename that leaves both in place would satisfy the check above
    // while rendering something else entirely.
    expect(shell).toMatch(
      /import\s*\{[^}]*\bCartAnnouncer\b[^}]*\}\s*from\s*["']\.\/cart-announcer["']/
    )
    expect(code("cart-announcer.tsx")).toMatch(/export function CartAnnouncer\s*\(/)
  })

  it("the cart sheet does NOT render it, which is the point", () => {
    // The sheet is a dialog: it unmounts when closed, so a region inside it
    // does not exist at the moment most cart mutations happen. If this ever
    // fails, the region moved back into the thing that disappears.
    expect(code("cart-sheet.tsx")).not.toMatch(/<CartAnnouncer\s*\/>/)
  })

  it("the detector can say no", () => {
    // The other half: a shell with the line removed must not read as mounted.
    const without = shell.replace(/<CartAnnouncer\s*\/>/, "")
    expect(without).not.toMatch(/<CartAnnouncer\s*\/>/)
  })
})
