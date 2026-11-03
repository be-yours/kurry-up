/**
 * The CMS blocks the footer and the contact page read, against the code that reads them.
 *
 * A client on Instagram, TikTok and Snapchat found the engine could show
 * Facebook, Instagram and X, and a footer whose links nobody could change. The
 * lists that decide what can be shown live in three places — the platform list
 * in `lib/social-links.ts`, the CMS block that stores each address, and the
 * glyph map that draws each icon — and a network added to one of them and not
 * the others is an icon that never appears, or a field nothing reads. This
 * fails when the three stop agreeing.
 */

import { describe, expect, it } from 'vitest'
import { contactPage } from '@/cms/pages/contact'
import { FOOTER_LINK_SLOTS, storefrontLayoutPage } from '@/cms/pages/storefront-layout'
import { SOCIAL_PLATFORMS, socialLinks } from '@/lib/social-links'
import { SOCIAL_ICONS } from '@/components/storefront/social-icons'

function block(page: { blocks: Array<{ key: string }> }, key: string) {
  const found = page.blocks.find((b) => b.key === key) as
    | { key: string; fields: Record<string, Record<string, unknown>> }
    | undefined
  if (!found) throw new Error(`block ${key} is not declared`)
  return found
}

describe('the social networks', () => {
  it('declares one CMS field per network, in the order the footer draws them', () => {
    const fields = Object.keys(block(storefrontLayoutPage, 'social').fields)
    expect(fields).toEqual([...SOCIAL_PLATFORMS])
  })

  it('keeps every address untranslated and without a code fallback', () => {
    // An icon with a sample address would be a button to somebody else's page.
    for (const [key, field] of Object.entries(block(storefrontLayoutPage, 'social').fields)) {
      expect(field.translatable, key).toBe(false)
      expect(field.hasCodeFallback, key).toBe(false)
    }
  })

  it('draws a glyph for every network, and only for those', () => {
    expect(Object.keys(SOCIAL_ICONS).sort()).toEqual([...SOCIAL_PLATFORMS].sort())
    for (const platform of SOCIAL_PLATFORMS) {
      expect(SOCIAL_ICONS[platform], platform).toBeTruthy()
    }
  })

  it('includes the networks a client asked for', () => {
    expect(SOCIAL_PLATFORMS).toEqual(expect.arrayContaining(['instagram', 'tiktok', 'snapchat']))
  })

  it('prints each configured network once, https only, in the fixed order', () => {
    const links = socialLinks({
      snapchat: 'https://www.snapchat.com/add/maisonbinato',
      tiktok: 'https://www.tiktok.com/@maisonbinato',
      instagram: 'https://www.instagram.com/maisonbinato',
      youtube: 'http://insecure.example/chaine',
      linkedin: 'javascript:alert(1)',
      facebook: '',
    })
    expect(links.map((l) => [l.platform, l.label])).toEqual([
      ['instagram', 'Instagram'],
      ['tiktok', 'TikTok'],
      ['snapchat', 'Snapchat'],
    ])
    expect(links.every((l) => l.href.startsWith('https://'))).toBe(true)
  })
})

describe("the footer's link columns", () => {
  for (const key of ['footerNav', 'footerUseful']) {
    describe(key, () => {
      const fields = () => block(storefrontLayoutPage, key).fields

      it('declares a label and an address for each of the slots the footer reads', () => {
        for (let slot = 1; slot <= FOOTER_LINK_SLOTS; slot++) {
          expect(fields()[`link${slot}Label`], `link${slot}Label`).toBeDefined()
          expect(fields()[`link${slot}Url`], `link${slot}Url`).toBeDefined()
        }
        // Nothing past the last slot: a field the footer never reads is an
        // editor control that looks like it works.
        expect(fields()[`link${FOOTER_LINK_SLOTS + 1}Label`]).toBeUndefined()
      })

      it('lets an owner hide the column, and leaves it shown until they do', () => {
        const display = fields().display as {
          type: string
          options: Array<{ value: string }>
          hasCodeFallback: boolean
        }
        expect(display.type).toBe('select')
        expect(display.options.map((o) => o.value)).toEqual(['show', 'hide'])
        expect(display.hasCodeFallback).toBe(true)
      })

      it('has no sample link: an empty slot is an absent link', () => {
        for (let slot = 1; slot <= FOOTER_LINK_SLOTS; slot++) {
          expect(fields()[`link${slot}Label`]!.hasCodeFallback).toBe(false)
          expect(fields()[`link${slot}Url`]!.hasCodeFallback).toBe(false)
          // An address is not prose: « Traduire tout » must not spend a model on it.
          expect(fields()[`link${slot}Url`]!.translatable).toBe(false)
        }
      })

      it('groups each label with its address, so the editor shows one card per link', () => {
        for (let slot = 1; slot <= FOOTER_LINK_SLOTS; slot++) {
          expect(fields()[`link${slot}Label`]!.group).toBe(`Lien ${slot}`)
          expect(fields()[`link${slot}Url`]!.group).toBe(`Lien ${slot}`)
        }
      })
    })
  }
})

describe('what a template may not say for an establishment', () => {
  it("gives the footer's sentence about the establishment no code fallback", () => {
    // It used to read « … faites-vous livrer directement chez vous » on every
    // site, delivering or not. A default here would bring it back.
    const tagline = block(storefrontLayoutPage, 'footer').fields.tagline
    expect(tagline).toBeDefined()
    expect(tagline!.hasCodeFallback).toBe(false)
  })

  it("gives the contact page's response-time card no code fallback", () => {
    // « Réponse rapide · Nous répondons sous 24h en moyenne » used to be typed
    // into the page. The card exists only for an owner who fills these in.
    const fields = block(contactPage, 'responseTime').fields
    expect(Object.keys(fields).sort()).toEqual(['text', 'title'])
    expect(fields.title!.hasCodeFallback).toBe(false)
    expect(fields.text!.hasCodeFallback).toBe(false)
  })
})
