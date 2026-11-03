/**
 * The `theme` entry of `site.config.ts`, and the order the header's toggle steps in.
 *
 * WHY THE READER IS THIS FORGIVING. `site.config.ts` is the client zone: an
 * update never overwrites it, so most of the sites already delivered have no
 * `theme` key at all, and `siteConfig.theme` would not compile for them. The
 * layout therefore passes the whole configuration to `readSiteTheme`, and the
 * first thing held here is that "no entry" is today's behaviour exactly: follow
 * the visitor's device, toggle on. The second is that a value it does not
 * recognise falls back instead of throwing, because a typo in a build-time file
 * must not take the storefront down.
 */

import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SITE_THEME,
  THEME_CHOICES,
  isThemeChoice,
  nextThemeChoice,
  readSiteTheme,
} from '@/lib/site-theme'

describe('readSiteTheme', () => {
  test("is today's behaviour for a site that has no theme entry", () => {
    expect(DEFAULT_SITE_THEME).toEqual({ default: 'system', toggle: true })
    expect(readSiteTheme({ name: 'Chez Luigi', defaultLocale: 'fr' })).toEqual(DEFAULT_SITE_THEME)
  })

  test.each([undefined, null, 'dark', 42, [], { theme: null }, { theme: 'dark' }])(
    "is today's behaviour for a configuration it cannot read (%j)",
    (config) => {
      expect(readSiteTheme(config)).toEqual(DEFAULT_SITE_THEME)
    },
  )

  test('reads both fields', () => {
    expect(readSiteTheme({ theme: { default: 'light', toggle: false } })).toEqual({
      default: 'light',
      toggle: false,
    })
    expect(readSiteTheme({ theme: { default: 'dark', toggle: true } })).toEqual({
      default: 'dark',
      toggle: true,
    })
  })

  test('fills in the field a site left out, and only that one', () => {
    expect(readSiteTheme({ theme: { default: 'light' } })).toEqual({
      default: 'light',
      toggle: true,
    })
    expect(readSiteTheme({ theme: { toggle: false } })).toEqual({
      default: 'system',
      toggle: false,
    })
  })

  test('falls back field by field on a value it does not know', () => {
    // `"ligth"` is a typo, `"no"` is the wrong type: neither may throw, and
    // neither may drag the other field back to its default.
    expect(readSiteTheme({ theme: { default: 'ligth', toggle: false } })).toEqual({
      default: 'system',
      toggle: false,
    })
    expect(readSiteTheme({ theme: { default: 'dark', toggle: 'no' } })).toEqual({
      default: 'dark',
      toggle: true,
    })
  })

  test('hands back a copy, so a caller cannot change the defaults for everyone', () => {
    const first = readSiteTheme(undefined)
    first.default = 'dark'
    first.toggle = false

    expect(DEFAULT_SITE_THEME).toEqual({ default: 'system', toggle: true })
    expect(readSiteTheme(undefined)).toEqual({ default: 'system', toggle: true })
  })
})

describe('isThemeChoice', () => {
  test('accepts the three choices and nothing else', () => {
    for (const choice of THEME_CHOICES) expect(isThemeChoice(choice)).toBe(true)

    for (const other of ['Light', 'auto', '', undefined, null, 1, {}]) {
      expect(isThemeChoice(other)).toBe(false)
    }
  })

  test('offers light, dark and system', () => {
    // The labels in the catalogues and the icons in the toggle are keyed on
    // exactly these; a fourth choice has to arrive in all three places.
    expect([...THEME_CHOICES]).toEqual(['light', 'dark', 'system'])
  })
})

describe('nextThemeChoice', () => {
  test('steps light, dark, system, and round again', () => {
    expect(nextThemeChoice('light')).toBe('dark')
    expect(nextThemeChoice('dark')).toBe('system')
    expect(nextThemeChoice('system')).toBe('light')
  })

  test('is back where it started after one visit to each choice', () => {
    for (const start of THEME_CHOICES) {
      let current = start
      for (let step = 0; step < THEME_CHOICES.length; step++) current = nextThemeChoice(current)
      expect(current).toBe(start)
    }
  })

  test('starts from the first choice for anything that is not one', () => {
    // next-themes reports `undefined` until it has read the browser.
    for (const unknown of [undefined, null, '', 'sepia']) {
      expect(nextThemeChoice(unknown)).toBe('light')
    }
  })
})
