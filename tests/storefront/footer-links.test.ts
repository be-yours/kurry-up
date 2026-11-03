/**
 * What the footer's link columns are willing to print.
 *
 * The footer used to carry two constant arrays. A column now takes links the
 * owner typed into the CMS, and a typed address ends up in an `href` — so the
 * property that matters most here is what is REFUSED: `javascript:`, a
 * protocol-relative `//host`, and a label with no address behind it.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyFooterHref,
  customFooterLinks,
  resolveFooterColumn,
  type FooterLink,
} from '@/lib/footer-links'
import { FOOTER_LINK_SLOTS } from '@/cms/pages/storefront-layout'

describe('classifyFooterHref', () => {
  it('accepts a page of the site, with its query and anchor', () => {
    expect(classifyFooterHref('/evenements')).toEqual({ href: '/evenements', kind: 'internal' })
    expect(classifyFooterHref('  /menu?category=pizzas#top  ')).toEqual({
      href: '/menu?category=pizzas#top',
      kind: 'internal',
    })
    expect(classifyFooterHref('/')).toEqual({ href: '/', kind: 'internal' })
  })

  it('accepts an https address, which opens elsewhere', () => {
    expect(classifyFooterHref('https://www.thefork.fr/restaurant/x')).toEqual({
      href: 'https://www.thefork.fr/restaurant/x',
      kind: 'web',
    })
  })

  it("accepts mailto: and tel:, which hand over to the visitor's own app", () => {
    expect(classifyFooterHref('mailto:bonjour@resto.fr')?.kind).toBe('contact')
    expect(classifyFooterHref('tel:+33100000000')?.kind).toBe('contact')
  })

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['http://insecure.example'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['ftp://files.example'],
    ['menu'],
    ['/two words'],
    ['   '],
    [''],
  ])('refuses %j', (value) => {
    expect(classifyFooterHref(value)).toBeNull()
  })

  it('refuses nothing it was not given, and an address past the CMS length', () => {
    expect(classifyFooterHref(undefined)).toBeNull()
    expect(classifyFooterHref(null)).toBeNull()
    expect(classifyFooterHref(`/${'a'.repeat(300)}`)).toBeNull()
  })
})

describe('customFooterLinks', () => {
  const reading = (values: Record<string, string>) => (field: string) => values[field]

  it('reads the numbered slots in order, skipping the empty ones', () => {
    const links = customFooterLinks(
      reading({
        link1Label: 'Événements',
        link1Url: '/evenements',
        link3Label: 'Réserver',
        link3Url: 'https://www.thefork.fr/x',
      }),
    )
    expect(links).toEqual([
      { label: 'Événements', href: '/evenements', kind: 'internal' },
      { label: 'Réserver', href: 'https://www.thefork.fr/x', kind: 'web' },
    ])
  })

  it('needs both halves of a slot', () => {
    expect(
      customFooterLinks(reading({ link1Label: 'Sans adresse', link2Url: '/sans-texte' })),
    ).toEqual([])
  })

  it('drops a slot whose address the footer would not print', () => {
    expect(
      customFooterLinks(
        reading({
          link1Label: 'Piège',
          link1Url: 'javascript:alert(1)',
          link2Label: 'Ok',
          link2Url: '/ok',
        }),
      ),
    ).toEqual([{ label: 'Ok', href: '/ok', kind: 'internal' }])
  })

  it('trims the label and ignores a slot past the last one the CMS declares', () => {
    const beyond = FOOTER_LINK_SLOTS + 1
    expect(
      customFooterLinks(
        reading({
          link1Label: '  Carte  ',
          link1Url: '/menu',
          [`link${beyond}Label`]: 'Invisible',
          [`link${beyond}Url`]: '/invisible',
        }),
      ),
    ).toEqual([{ label: 'Carte', href: '/menu', kind: 'internal' }])
  })

  it('reads every slot the CMS declares, the last one included', () => {
    const values: Record<string, string> = {}
    for (let slot = 1; slot <= FOOTER_LINK_SLOTS; slot++) {
      values[`link${slot}Label`] = `Lien ${slot}`
      values[`link${slot}Url`] = `/page-${slot}`
    }
    expect(customFooterLinks(reading(values))).toHaveLength(FOOTER_LINK_SLOTS)
  })
})

describe('resolveFooterColumn', () => {
  const link = (label: string): FooterLink => ({ label, href: `/${label}`, kind: 'internal' })
  const defaults = [link('menu'), link('panier')]
  const custom = [link('evenements')]

  it("shows the engine's links until the owner gives the column one of their own", () => {
    expect(resolveFooterColumn({ hidden: false, custom: [], defaults })).toEqual(defaults)
  })

  it("replaces the defaults with the owner's links — it does not append to them", () => {
    expect(resolveFooterColumn({ hidden: false, custom, defaults })).toEqual(custom)
  })

  it('draws nothing for a hidden column, whatever it holds', () => {
    expect(resolveFooterColumn({ hidden: true, custom, defaults })).toBeNull()
    expect(resolveFooterColumn({ hidden: true, custom: [], defaults })).toBeNull()
  })

  it('draws nothing for a column with no links at all', () => {
    // « Nos restaurants » is the only link of its column on some deployments'
    // short list; with it gone, a title over an empty nav is worse than no column.
    expect(resolveFooterColumn({ hidden: false, custom: [], defaults: [] })).toBeNull()
  })
})
