/**
 * The design a client site actually runs, checked where a client can break it.
 *
 * A site created from scratch (`beyours create --blank`) has its design
 * composed after the fact — by a person or by a coding agent working from
 * `site/DESIGN_BRIEF.md`. `pnpm design:check` is what tells either of them
 * whether the result holds. The palette half is already measured:
 * `a11y/template-contrast.test.ts` has two assertions on `site/theme.css`, in
 * the real cascade, and `design:check` runs exactly those two. What nothing
 * measured is the other two files of the client zone.
 *
 * WHY THESE TWO CHECKS AND NOT MORE. They run in every client's CI too, for as
 * long as the site exists, so each one has to be false only for a site that is
 * actually broken. A layout value the storefront does not paint is NOT broken:
 * most of the catalogue names a hero or a menu it does not paint yet
 * (`templates/README.md`, "The layout half"), and a site that applied one would
 * go red here for a choice the catalogue sold it. That one is recorded in the
 * markup as `data-<family>-requested` and left alone.
 *
 * An out-of-family value is another matter. It does not fail anywhere at
 * runtime — `layoutAttributes` falls back to the engine's own — so the site
 * renders something other than what was written, and `tsc` is the only thing
 * that would have said so. `design:check` does not run `tsc`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LAYOUT_FAMILIES, isLayoutValue, type LayoutFamily } from '@/lib/layout-families'
import { siteLayout } from '@/site/layout'

const FAMILIES = Object.keys(LAYOUT_FAMILIES) as LayoutFamily[]

describe('site/layout.ts', () => {
  it('sets every layout family', () => {
    expect(Object.keys(siteLayout).sort()).toEqual([...FAMILIES].sort())
  })

  it('only uses values its family admits', () => {
    const refused = FAMILIES.filter((family) => !isLayoutValue(family, siteLayout[family])).map(
      (family) =>
        `${family}: "${siteLayout[family]}" is not one of ${LAYOUT_FAMILIES[family].join(', ')}`,
    )
    expect(refused).toEqual([])
  })
})

describe('site/fonts.ts', () => {
  const source = readFileSync(join(process.cwd(), 'site', 'fonts.ts'), 'utf8')

  it('exports fontVariables, which app/layout.tsx puts on <html>', () => {
    expect(source).toMatch(/export const fontVariables\b/)
  })

  it('keeps the two variable names the engine theme reads', () => {
    // Whatever typeface they carry. `app/globals.css` resolves the heading and
    // body families through these two names, so a pair declared under others
    // renders in the browser's fallback with no error anywhere.
    expect(source).toContain('"--font-inter"')
    expect(source).toContain('"--font-poppins"')
  })
})

describe('pnpm design:check', () => {
  it('still selects the contrast assertions it exists to run', () => {
    // `-t` with a pattern that matches nothing runs nothing and reports a pass.
    // The pattern names the file path in the test titles, so renaming those
    // titles would turn the command into a green no-op without anything going
    // red; this is what goes red instead.
    const script: string = JSON.parse(readFileSync('package.json', 'utf8')).scripts['design:check']
    const pattern = /-t\s+"([^"]+)"/.exec(script)?.[1]
    expect(pattern, 'design:check names no -t filter').toBeDefined()
    const titles = [
      ...readFileSync('tests/a11y/template-contrast.test.ts', 'utf8').matchAll(
        /\bit\(\s*"([^"]+)"/g,
      ),
    ].map((match) => match[1])
    const selected = titles.filter((title) => new RegExp(pattern as string).test(title))
    expect(selected).toHaveLength(2)
    expect(selected.every((title) => title.includes('site/theme.css'))).toBe(true)
  })
})
