/**
 * A delivered site may not promise, or speak English, on the template's behalf.
 *
 * The first client project hid five things in CSS because they were typed into
 * the engine's markup and nothing in the product could change them:
 *
 *   - a contact card, « Réponse rapide · Nous répondons sous 24h en moyenne »,
 *     and a form description promising an answer « sous 24h » — a delay no
 *     establishment had committed to;
 *   - three English words on a French storefront: « Price », « Read More »,
 *     « Items »;
 *   - a category band whose cards raised an English toast and went nowhere;
 *   - a footer sentence, « … faites-vous livrer directement chez vous »,
 *     printed whether or not the establishment delivers, and a link labelled
 *     « Box ».
 *
 * `no-fabricated-social-proof.test.ts` is the sibling for reviews and ratings.
 * Like it, this reads the shipped source off disk rather than rendering it: the
 * defect was the presence of the text, and a guard that only fires at runtime
 * would pass on a page nobody mounted in a test. The behaviour is pinned beside
 * it — `contact-response-time`, `footer-configurable`, `home-labels`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/**
 * The same file, with comments removed.
 *
 * Every fix above is explained, in its own words, in a comment beside it —
 * « sous 24h », « Read More » — and prose about a defect is the opposite of the
 * defect. Only whole-line and block comments are stripped, never a trailing
 * `//`, so a `https://` inside a string cannot swallow the rest of a line.
 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

/** Every source file a client site actually ships to a diner. */
function storefrontSources(): string[] {
  const roots = ['app/(storefront)', 'components/website', 'components/storefront']
  const out: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, entry)
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel)
      } else if (['.ts', '.tsx'].includes(extname(entry))) {
        out.push(rel)
      }
    }
  }

  for (const root of roots) walk(root)
  return out
}

describe('the sweep can see what it claims to see', () => {
  it('reads the storefront, including the files the fixes touched', () => {
    // Anti-vacuity: a broken walk would report every file clean.
    const sources = storefrontSources()
    expect(sources.length).toBeGreaterThan(40)
    for (const touched of [
      'app/(storefront)/contact/_components/ContactContent.tsx',
      'components/storefront/storefront-footer.tsx',
      'components/website/category-card.tsx',
      'components/website/meal-card.tsx',
      'components/website/blog-card.tsx',
    ]) {
      expect(sources, touched).toContain(touched)
    }
  })

  it('strips a comment but not the code beside it', () => {
    const code = readCode('components/website/category-card.tsx')
    expect(code).toContain('useTranslation')
    // The file explains the old toast in a comment; the code carries none of it.
    expect(read('components/website/category-card.tsx')).toContain('Exploring')
    expect(code).not.toContain('Exploring')
  })
})

describe('no storefront source promises a response time', () => {
  it('never says an answer comes « sous 24h »', () => {
    const offenders = storefrontSources().filter((path) => /sous\s+24\s?h/i.test(readCode(path)))
    expect(offenders).toEqual([])
  })

  it('never prints the « Réponse rapide » card', () => {
    const offenders = storefrontSources().filter((path) =>
      /Réponse rapide|Nous répondons/.test(readCode(path)),
    )
    expect(offenders).toEqual([])
  })

  it("does not seed the promise into a fresh site's CMS either", () => {
    // The seed writes the contact form's description; « sous 24h » there would
    // publish the delay on every site that ran it, whatever the component says.
    expect(readCode('convex/cmsSeed.ts')).not.toMatch(/sous\s+24\s?h/i)
  })

  it('keeps the card behind the CMS, not behind a code fallback', () => {
    const contact = readCode('app/(storefront)/contact/_components/ContactContent.tsx')
    expect(contact).toMatch(/block\("responseTime"\)/)
    expect(contact).toMatch(/\(responseTitle \|\| responseText\) &&/)
  })
})

describe('no storefront source speaks English where the catalogue should', () => {
  const websiteSources = () =>
    storefrontSources().filter((path) => path.startsWith('components/website/'))

  it('labels no price « Price »', () => {
    const offenders = websiteSources().filter((path) => />\s*Price\s*</.test(readCode(path)))
    expect(offenders).toEqual([])
  })

  it('invites no one to « Read More »', () => {
    const offenders = websiteSources().filter((path) => /Read More/.test(readCode(path)))
    expect(offenders).toEqual([])
  })

  it('counts nothing in « Items »', () => {
    const offenders = websiteSources().filter((path) =>
      /["'`]0? ?Items["'`]|\bcountText\b/.test(readCode(path)),
    )
    expect(offenders).toEqual([])
  })

  it('raises no English toast from a category card', () => {
    const card = readCode('components/website/category-card.tsx')
    expect(card).not.toMatch(/from ["']sonner["']/)
    expect(card).not.toMatch(/\btoast\b/)
  })

  it('asks the catalogue for each of those words instead', () => {
    expect(readCode('components/website/meal-card.tsx')).toContain('t("product.price")')
    expect(readCode('components/website/blog-card.tsx')).toContain('t("blog.readMore")')
    const card = readCode('components/website/category-card.tsx')
    expect(card).toContain('storefront.categoryProductsOne')
    expect(card).toContain('storefront.categoryProductsOther')
  })

  it('makes the category card a link, not a click handler', () => {
    const card = readCode('components/website/category-card.tsx')
    expect(card).toMatch(/<Link\b/)
    expect(card).not.toMatch(/onClick/)
  })
})

describe('the footer says nothing the establishment did not', () => {
  const footer = () => readCode('components/storefront/storefront-footer.tsx')

  it('promises no delivery', () => {
    expect(footer()).not.toMatch(/livr/i)
  })

  it('labels no link « Box »', () => {
    expect(footer()).not.toMatch(/label:\s*["']Box["']|>\s*Box\s*</)
  })

  it('builds its links from the catalogue and the CMS, not from literals', () => {
    const code = footer()
    expect(code).not.toMatch(
      /label:\s*["'](Menu|Mes commandes|Mes favoris|Mon compte|Mes adresses|Nos restaurants)["']/,
    )
    expect(code).toContain('customFooterLinks')
  })

  it('sends nobody to the selector unless there is one to choose from', () => {
    expect(footer()).toMatch(/multiStoreOnly:\s*true/)
  })
})
