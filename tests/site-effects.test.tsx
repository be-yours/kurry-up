// @vitest-environment jsdom

/**
 * `site/components/SiteEffects.tsx`: what the template promises about it.
 *
 * The file is the client's. The template ships it once, empty, and never edits
 * it again, so this suite has two halves that must not be confused.
 *
 *   THE CONTRACT, true on every site whatever its owner put in the file. The
 *   layout imports a function called `SiteEffects` from it, and that layout is a
 *   server component, so the module has to open with the client directive: a
 *   missing one fails the build far from the line that caused it. And the
 *   layout has to go on handing it to the slot, which is what a bad conflict
 *   resolution on `app/layout.tsx` during `pnpm update:template` would undo
 *   without any type error.
 *
 *   THE DEFAULT, true only where the file is still the one the template wrote.
 *   "A site that does nothing changes nothing" is a statement about that file,
 *   not about a site that has since added a smooth scroll or a pointer: on a
 *   delivered site the second half would go red for a reason that is no fault.
 *   It runs where the shipped default is the only possible content, which is
 *   this monorepo (`IN_MONOREPO`), and is skipped in a client's clone — the same
 *   shape `__tests__/client-stylesheet.test.ts` gives the half of its checks that
 *   reads something only the monorepo has.
 *
 * The slot around it — hydration, the administration, the markup — is
 * `tests/site-effects-slot.test.tsx`, which both apps carry.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { SiteEffects } from '@/site/components/SiteEffects'
import { APP_ROOT, IN_MONOREPO } from './lib/repo-layout'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source = readFileSync(join(APP_ROOT, 'site', 'components', 'SiteEffects.tsx'), 'utf8')

describe('the contract every site keeps', () => {
  test('exports the component app/layout.tsx mounts', () => {
    expect(typeof SiteEffects).toBe('function')
  })

  test('opens with the client directive, which the server layout that imports it needs', () => {
    // Comments may come first; the directive must be the first statement.
    const firstStatement = source.replace(/^(\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*/, '')
    expect(firstStatement).toMatch(/^(['"])use client\1/)
  })

  test('is handed to the slot by app/layout.tsx', () => {
    const layout = readFileSync(join(APP_ROOT, 'app', 'layout.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    expect(layout).toMatch(
      /import\s*\{\s*SiteEffects\s*\}\s*from\s*['"]@\/site\/components\/SiteEffects['"]/,
    )
    expect(layout).toMatch(/<SiteEffectsSlot>\s*<SiteEffects\s*\/>\s*<\/SiteEffectsSlot>/)
  })
})

describe.skipIf(!IN_MONOREPO)('the default the template ships', () => {
  test('renders nothing on the server', () => {
    expect(renderToStaticMarkup(<SiteEffects />)).toBe('')
  })

  test('renders nothing in the browser', async () => {
    const into = document.createElement('div')
    document.body.append(into)
    const root = createRoot(into)

    await act(async () => {
      root.render(<SiteEffects />)
    })
    expect(into.innerHTML).toBe('')

    await act(async () => {
      root.unmount()
    })
    into.remove()
  })

  test('is a plain function returning null, so a site that edits nothing changes nothing', () => {
    expect(SiteEffects()).toBeNull()
  })
})
