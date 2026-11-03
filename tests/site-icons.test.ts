/**
 * A site can put its own icon on its own tab.
 *
 * The shell shipped `app/favicon.ico`, and Next.js gives a file-based icon
 * priority over everything else it reads — the `metadata` object and a file in
 * `public/` alike. A delivered site therefore had no way to override it: the
 * first client project found `public/favicon.ico` could not win, and the only
 * icon it could change was the one the CMS swaps in after the page has loaded.
 *
 * The fix is two halves, and both are pinned. The shell ships NO icon file (the
 * one it shipped was the create-next-app placeholder, not an asset), and the
 * site zone says what it wants in `site.config.ts` → `icons`, which the
 * template's layout turns into `metadata.icons`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siteIconsMetadata } from '@/lib/site-icons'

const ROOT = process.cwd()

describe('siteIconsMetadata', () => {
  it('names no icon for a config that declares none', () => {
    expect(siteIconsMetadata(undefined)).toBeUndefined()
    expect(siteIconsMetadata(null)).toBeUndefined()
    expect(siteIconsMetadata({})).toBeUndefined()
    expect(siteIconsMetadata({ icons: {} })).toBeUndefined()
    expect(siteIconsMetadata({ icons: '/favicon.png' })).toBeUndefined()
  })

  it('is not broken by a site.config.ts older than the key', () => {
    // `site.config.ts` is a client-zone file: an engine update never rewrites it,
    // so a site created before `icons` existed keeps a config without it.
    const old = { name: 'Mon Restaurant', url: 'https://example.test', defaultLocale: 'fr' }
    expect(siteIconsMetadata(old)).toBeUndefined()
  })

  it('hands over the paths a site declares', () => {
    expect(
      siteIconsMetadata({
        icons: { icon: '/brand/favicon.png', apple: '/brand/apple-touch-icon.png' },
      }),
    ).toEqual({ icon: '/brand/favicon.png', apple: '/brand/apple-touch-icon.png' })
  })

  it('accepts an https address and trims what was typed', () => {
    expect(
      siteIconsMetadata({
        icons: { icon: '  https://cdn.example.test/favicon.svg  ', shortcut: '/favicon.ico' },
      }),
    ).toEqual({ icon: 'https://cdn.example.test/favicon.svg', shortcut: '/favicon.ico' })
  })

  it.each([
    ['javascript:alert(1)'],
    ['data:image/svg+xml;base64,PHN2Zz4='],
    ['http://insecure.example/favicon.png'],
    ['//evil.example/favicon.png'],
    ['/\\evil.example/favicon.png'],
    ['favicon.png'],
    ['/with space.png'],
    [''],
  ])('refuses %j and keeps the valid ones beside it', (bad) => {
    expect(siteIconsMetadata({ icons: { icon: bad, apple: '/apple.png' } })).toEqual({
      apple: '/apple.png',
    })
    expect(siteIconsMetadata({ icons: { icon: bad } })).toBeUndefined()
  })

  it('ignores a key it does not know and a value that is not a string', () => {
    expect(
      siteIconsMetadata({
        icons: { other: '/x.png', icon: 42, apple: ['/apple.png'], shortcut: '/s.ico' },
      }),
    ).toEqual({ shortcut: '/s.ico' })
  })
})

describe('the shell ships no icon file', () => {
  // Every name Next.js treats as a file-based icon. Any one of them, present in
  // `app/`, outranks `metadata.icons` — which is the defect.
  const FILE_BASED = /^(favicon\.ico|(icon|apple-icon)\d*\.(ico|jpe?g|png|svg|[jt]sx?))$/

  it('has nothing in app/ that Next.js would read as an icon', () => {
    const found = readdirSync(join(ROOT, 'app')).filter((name) => FILE_BASED.test(name))
    expect(found).toEqual([])
  })

  it('recognises the file that used to be there', () => {
    // Anti-vacuity: the pattern has to match what it exists to forbid.
    expect(FILE_BASED.test('favicon.ico')).toBe(true)
    expect(FILE_BASED.test('icon.png')).toBe(true)
    expect(FILE_BASED.test('apple-icon1.jpg')).toBe(true)
    expect(FILE_BASED.test('layout.tsx')).toBe(false)
  })
})

// `site.config.ts` and the patched layout exist in the template only; the bench
// has no site zone. The engine half above is checked in both.
describe.runIf(existsSync(join(ROOT, 'site.config.ts')))("the template's site zone", () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  it("feeds the site's icons into the layout's metadata", () => {
    const layout = read('app/layout.tsx')
    expect(layout).toContain('from "@/lib/site-icons"')
    expect(layout).toMatch(/icons:\s*siteIconsMetadata\(siteConfig\)/)
  })

  it('declares the key where a site can find it, empty by default', () => {
    const config = read('site.config.ts')
    expect(config).toMatch(/\bicons:\s*\{/)
    // No default icon: the engine ships none, and a placeholder path here would
    // be a 404 on every page of a fresh site.
    expect(config).not.toMatch(/^\s*icon:/m)
  })

  it('imports nothing, because next.config.ts reads this file before `@/` exists', () => {
    expect(read('site.config.ts')).not.toMatch(/^\s*import\s/m)
  })
})
