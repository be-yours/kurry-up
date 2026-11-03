/**
 * The colour scheme a site declares, checked where a client can break it.
 *
 * `site.config.ts` is edited by hand and no update ever overwrites it, and
 * `readSiteTheme` falls back to the default on anything it does not recognise.
 * That keeps a typo from taking the storefront down, and it also keeps the typo
 * from being noticed: `default: "ligth"` builds, renders, and quietly opens in
 * the visitor's device scheme. This is what says so, in the CI of the site that
 * wrote it.
 *
 * WHAT IT DOES NOT REQUIRE: the entry itself. A site delivered before the entry
 * existed has no `theme` key and is not broken, because the defaults are
 * exactly what it did before. This file runs in every client's CI for as long as
 * the site exists, so it may only be false for a site that is actually wrong,
 * and "has not added an optional entry" is not that.
 *
 * THE ENGINE'S HALF is the layout. `app/layout.tsx` is the one place the entry
 * is read, and it is a patched file, so an engine sync that restored the bench's
 * version would drop the wiring without a single other test noticing.
 *
 * WHY THIS FILE HAS NO TWIN IN `apps/reference`. The bench has no
 * `site.config.ts` and no patched layout; there is nothing there to read.
 * `scripts/check-app-divergence.mjs` lists it as one-sided on purpose.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siteConfig } from '@/site.config'
import { readSiteTheme } from '@/lib/site-theme'

const FIELDS = ['default', 'toggle']

describe('site.config.ts', () => {
  const config: Record<string, unknown> = { ...siteConfig }
  const declared = (config.theme ?? {}) as Record<string, unknown>
  const read = readSiteTheme(siteConfig) as Record<string, unknown>

  it('is read exactly as it is written', () => {
    // A value the reader did not recognise comes back as the default, which is
    // not what was written, and that difference is the typo.
    const misread = Object.entries(declared)
      .filter(([key]) => FIELDS.includes(key))
      .filter(([key, value]) => read[key] !== value)
      .map(([key, value]) => `theme.${key}: ${JSON.stringify(value)}`)

    expect(misread).toEqual([])
  })

  it('declares no field the engine does not read', () => {
    const unknown = Object.keys(declared).filter((key) => !FIELDS.includes(key))

    expect(unknown).toEqual([])
  })
})

describe('app/layout.tsx', () => {
  const layout = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  it('hands the site’s colour scheme to Providers', () => {
    expect(layout).toMatch(/<Providers\s+theme=\{readSiteTheme\(siteConfig\)\}>/)
  })

  it('reads it through readSiteTheme, never as siteConfig.theme', () => {
    // A site older than the entry has no `theme` key, and the property access
    // would not compile for it.
    expect(layout).not.toMatch(/siteConfig\.theme\b/)
  })
})
