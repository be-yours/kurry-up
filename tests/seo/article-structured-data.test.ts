/**
 * An article says what it is, and answers what it asks.
 *
 * `/blog/<slug>` shipped a `Restaurant` and a `BreadcrumbList` and nothing
 * else. The page, its metadata, its canonical and its body were all rendered on
 * the server, so a crawler could read every word of an article and still had no
 * `Article` to take the headline, the dates and the publisher from, and no
 * `FAQPage` for the "Questions fréquentes" section that the articles of the
 * first client project end with.
 *
 * The questions are read out of the sanitised HTML the page prints, then written
 * into a `<script>`. Two properties therefore carry the weight here, and the
 * markup cannot be trusted to guarantee either on its own: what is emitted must
 * parse, and nothing an establishment typed may end the tag it is emitted in.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import DOMPurify from 'isomorphic-dompurify'
import { ARTICLE_SANITIZE_PROFILE } from '@/lib/blog/sanitize-profile'

vi.mock('server-only', () => ({}))

const {
  JsonLd,
  buildArticleSchema,
  buildFaqSchema,
  buildRestaurantSchema,
  extractFaqItems,
  serializeJsonLd,
} = await import('@/lib/json-ld')

const BASE = 'https://chez-luigi.fr'
const STORE = { name: 'Chez Luigi' }

const PUBLISHED = Date.UTC(2026, 8, 14, 9, 30)
const UPDATED = Date.UTC(2026, 8, 21, 16, 5)

const ARTICLE = {
  title: 'Pizza napolitaine : pourquoi la pâte repose 48 heures',
  description: 'Une pâte qui repose deux jours digère mieux et croustille plus.',
  imageUrl: '/api/files/blog/pizza.webp',
  publishedAt: PUBLISHED,
  updatedAt: UPDATED,
  path: '/blog/pate-napolitaine',
}

/** Round-trips a document the way the page does, and refuses `undefined` and `null`. */
function serialised(document: unknown): string {
  const json = JSON.stringify(document)
  expect(json).not.toContain('undefined')
  expect(json).not.toContain('null')
  return json
}

/** The sanitised markup the page hands to the browser, and to the FAQ reader. */
const sanitised = (html: string) => DOMPurify.sanitize(html, ARTICLE_SANITIZE_PROFILE)

/** The JSON text a browser would find inside the `<script>` that `JsonLd` renders. */
function scriptBody(document: Parameters<typeof JsonLd>[0]['data']): string {
  const element = JsonLd({ data: document })
  expect(element).not.toBeNull()
  expect(element?.props.type).toBe('application/ld+json')
  return element?.props.dangerouslySetInnerHTML.__html as string
}

/** Answer-first, closed by the section every article of the first client ends with. */
const ARTICLE_HTML = [
  '<p>Oui, on peut commander sa pizza en ligne et la retirer en vingt minutes.</p>',
  '<h2>Comment commander ?</h2>',
  '<p>Depuis la carte, en trois clics.</p>',
  "<h3>Une question posée dans le corps de l'article ?</h3>",
  "<p>Elle n'appartient pas à la FAQ.</p>",
  '<h2>Questions fréquentes</h2>',
  '<h3>Peut-on commander sans compte ?</h3>',
  '<p>Oui, le paiement se fait en invité.</p>',
  '<h3>Livrez-vous le dimanche ?</h3>',
  '<p>Oui, de 18 h à 22 h.</p>',
  '<p>Les commandes passées après 21 h 30 se retirent sur place.</p>',
  '<h2>Pour aller plus loin</h2>',
  '<h3>Une autre question, hors de la FAQ ?</h3>',
  "<p>Elle n'est pas dans la section non plus.</p>",
].join('')

describe('Article', () => {
  const document = buildArticleSchema(ARTICLE, { baseUrl: BASE, store: STORE })

  it("is an Article at the page's own address", () => {
    expect(document['@context']).toBe('https://schema.org')
    expect(document['@type']).toBe('Article')
    expect(document.mainEntityOfPage).toEqual({
      '@type': 'WebPage',
      '@id': `${BASE}/blog/pate-napolitaine`,
    })
  })

  it('carries the fields a search result and an answer engine quote', () => {
    expect(document.headline).toBe('Pizza napolitaine : pourquoi la pâte repose 48 heures')
    expect(document.description).toBe(
      'Une pâte qui repose deux jours digère mieux et croustille plus.',
    )
    expect(document.image).toBe(`${BASE}/api/files/blog/pizza.webp`)
    expect(document.datePublished).toBe('2026-09-14T09:30:00.000Z')
    expect(document.dateModified).toBe('2026-09-21T16:05:00.000Z')
  })

  it("names the establishment as author and publisher through the Restaurant's own @id", () => {
    const restaurant = buildRestaurantSchema(STORE, { baseUrl: BASE })

    expect(restaurant['@id']).toBe(`${BASE}/#restaurant`)
    expect(document.author).toEqual({
      '@type': 'Restaurant',
      '@id': restaurant['@id'],
      name: 'Chez Luigi',
    })
    expect(document.publisher).toEqual(document.author)
  })

  it('keeps an absolute image as it is', () => {
    const absolute = buildArticleSchema(
      { ...ARTICLE, imageUrl: 'https://cdn.chez-luigi.fr/pizza.webp' },
      { baseUrl: BASE },
    )

    expect(absolute.image).toBe('https://cdn.chez-luigi.fr/pizza.webp')
  })

  it('dates the modification from the publication when nothing was modified later', () => {
    const unedited = buildArticleSchema({ ...ARTICLE, updatedAt: undefined }, { baseUrl: BASE })

    expect(unedited.dateModified).toBe('2026-09-14T09:30:00.000Z')
  })

  it('omits what is missing, rather than emitting null', () => {
    const bare = buildArticleSchema({ title: 'Bonjour', path: '/blog/bonjour' }, { baseUrl: BASE })

    expect(serialised(bare)).toBeTruthy()
    expect(bare).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Bonjour',
      author: { '@type': 'Restaurant', '@id': `${BASE}/#restaurant` },
      publisher: { '@type': 'Restaurant', '@id': `${BASE}/#restaurant` },
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${BASE}/blog/bonjour` },
    })
  })

  it('survives a timestamp that is not a date, which would otherwise throw the page', () => {
    // `new Date(NaN).toISOString()` throws a RangeError, and so does a value
    // past the 8.64e15 ms the language can hold.
    const broken = buildArticleSchema(
      { ...ARTICLE, publishedAt: Number.NaN, updatedAt: 8.64e15 + 1 },
      { baseUrl: BASE },
    )

    expect(broken.datePublished).toBeUndefined()
    expect(broken.dateModified).toBeUndefined()
    expect(broken.headline).toBe(ARTICLE.title)
  })
})

describe('extractFaqItems', () => {
  it('reads the question and answer pairs that close an answer-first article', () => {
    expect(extractFaqItems(ARTICLE_HTML)).toEqual([
      {
        question: 'Peut-on commander sans compte ?',
        answer: 'Oui, le paiement se fait en invité.',
      },
      {
        question: 'Livrez-vous le dimanche ?',
        answer: 'Oui, de 18 h à 22 h. Les commandes passées après 21 h 30 se retirent sur place.',
      },
    ])
  })

  it.each([
    'Questions fréquentes',
    'QUESTIONS FRÉQUENTES',
    'questions frequentes',
    'Questions fréquentes sur la livraison',
    'FAQ',
    'Faq : la carte',
    'La FAQ du Chez Luigi',
  ])('opens a section on the heading %j', (heading) => {
    expect(extractFaqItems(`<h2>${heading}</h2><h3>Une ?</h3><p>Oui.</p>`)).toHaveLength(1)
  })

  it.each([
    'Conclusion',
    'Comment commander ?',
    'Nos réponses à vos questions',
    'Questions',
    "Les questions que l'on nous pose",
    'Faquirs',
  ])('does not open a section on the heading %j', (heading) => {
    expect(extractFaqItems(`<h2>${heading}</h2><h3>Une ?</h3><p>Oui.</p>`)).toEqual([])
  })

  it('closes the section at the next h2', () => {
    const html =
      '<h2>FAQ</h2><h3>Dedans ?</h3><p>Oui.</p><h2>Ailleurs</h2><h3>Dehors ?</h3><p>Non.</p>'

    expect(extractFaqItems(html).map((item) => item.question)).toEqual(['Dedans ?'])
  })

  it('reads a second FAQ section as more of the same list', () => {
    const html =
      '<h2>FAQ</h2><h3>Un ?</h3><p>a.</p><h2>Entre deux</h2><p>x</p>' +
      '<h2>Questions fréquentes</h2><h3>Deux ?</h3><p>b.</p>'

    expect(extractFaqItems(html).map((item) => item.question)).toEqual(['Un ?', 'Deux ?'])
  })

  it('stops an answer at the next heading, whatever its level', () => {
    const html =
      '<h2>FAQ</h2><h3>Un ?</h3><p>a.</p><h4>Détail</h4><p>Pas dans la réponse.</p>' +
      '<h3>Deux ?</h3><p>b.</p>'

    expect(extractFaqItems(html)).toEqual([
      { question: 'Un ?', answer: 'a.' },
      { question: 'Deux ?', answer: 'b.' },
    ])
  })

  it('skips a subheading that is not a question, and the text under it', () => {
    const html =
      '<h2>FAQ</h2><h3>Un ?</h3><p>a.</p><h3>À savoir</h3><p>Pas une réponse.</p>' +
      '<h3>Deux ?</h3><p>b.</p>'

    expect(extractFaqItems(html)).toEqual([
      { question: 'Un ?', answer: 'a.' },
      { question: 'Deux ?', answer: 'b.' },
    ])
  })

  it('drops a question with nothing under it, since schema.org requires the answer', () => {
    const html = '<h2>FAQ</h2><h3>Sans réponse ?</h3><h3>Avec réponse ?</h3><p>Oui.</p>'

    expect(extractFaqItems(html)).toEqual([{ question: 'Avec réponse ?', answer: 'Oui.' }])
  })

  it('strips the tags and decodes what the sanitiser encoded', () => {
    const html =
      '<h2>FAQ</h2><h3>Un ?</h3>' +
      '<p>Oui, <strong>sans compte</strong> &amp; en <a href="/menu?a=1&amp;b=2" target="_blank">2 clics</a> &lt;3&nbsp;!</p>'

    expect(extractFaqItems(html)[0]?.answer).toBe('Oui, sans compte & en 2 clics <3 !')
  })

  it('decodes a character reference once, never twice', () => {
    const html = '<h2>FAQ</h2><h3>Un ?</h3><p>l&#39;été &#x27;ok&#x27; &amp;lt;b&amp;gt;</p>'

    expect(extractFaqItems(html)[0]?.answer).toBe("l'été 'ok' &lt;b&gt;")
  })

  it('leaves a reference it cannot read exactly as written', () => {
    const html = '<h2>FAQ</h2><h3>Un ?</h3><p>&constructor; &#0; &#xD800; &#99999999;</p>'

    expect(extractFaqItems(html)[0]?.answer).toBe('&constructor; &#0; &#xD800; &#99999999;')
  })

  it('does not end a tag at a > inside a quoted attribute', () => {
    const html = '<h2>FAQ</h2><h3>Un ?</h3><p><a href="/x?a>b" title=\'c>d\'>le lien</a> suit.</p>'

    expect(extractFaqItems(html)[0]?.answer).toBe('le lien suit.')
  })

  it('keeps the words of two blocks apart, and the letters of one inline run together', () => {
    const html =
      '<h2>FAQ</h2><h3>Un ?</h3><p>Oui.</p><p>Voici.<br>Et voilà.</p><p>Pi<strong>zza</strong></p>'

    expect(extractFaqItems(html)[0]?.answer).toBe('Oui. Voici. Et voilà. Pizza')
  })

  it('keeps a list that is part of an answer', () => {
    const html =
      '<h2>FAQ</h2><h3>Quels moyens de paiement ?</h3>' +
      '<p>Nous acceptons :</p><ul><li><p>la carte</p></li><li>les espèces</li></ul>'

    expect(extractFaqItems(html)[0]?.answer).toBe('Nous acceptons : la carte les espèces')
  })

  it('reads the markup and the non-breaking space inside a question', () => {
    const html = '<h2>FAQ</h2><h3><strong>Livrez-vous le dimanche</strong>&nbsp;?</h3><p>Oui.</p>'

    expect(extractFaqItems(html)[0]?.question).toBe('Livrez-vous le dimanche ?')
  })

  it('ignores a comment', () => {
    const html = '<h2>FAQ</h2><!-- <h3>Faux ?</h3><p>x</p> --><h3>Vrai ?</h3><p>Oui.</p>'

    expect(extractFaqItems(html)).toEqual([{ question: 'Vrai ?', answer: 'Oui.' }])
  })

  it('ends an unclosed heading at the next one, so it cannot swallow the article', () => {
    const html = '<h2>FAQ</h2><h3>Perdu ?<p>a.</p><h3>Retrouvé ?</h3><p>b.</p>'

    expect(extractFaqItems(html)).toEqual([{ question: 'Retrouvé ?', answer: 'b.' }])
  })

  it('finds nothing where there is nothing to find', () => {
    expect(extractFaqItems('')).toEqual([])
    expect(extractFaqItems('<p>Texte sans question.</p>')).toEqual([])
    expect(extractFaqItems('a < b and c > d')).toEqual([])
  })
})

describe('extractFaqItems on what the sanitiser returns', () => {
  it('reads the markup the page prints, not the markup that was stored', () => {
    // A row written before the write pass sanitised: a wrapper `<div>`, a
    // heading level the profile does not allow, and a script. The render pass
    // keeps the text of the first, drops the second's tag and the third whole.
    const stored =
      '<div><h1>Titre</h1><h2>Questions fréquentes</h2>' +
      '<h3>Livrez-vous ?</h3><p>Oui &amp; non, <em>selon</em> l’heure.</p>' +
      '<script>alert(1)</script>' +
      '<h3>Ouvert le lundi ?</h3><p>Non.</p></div>'

    expect(extractFaqItems(sanitised(stored))).toEqual([
      { question: 'Livrez-vous ?', answer: 'Oui & non, selon l’heure.' },
      { question: 'Ouvert le lundi ?', answer: 'Non.' },
    ])
  })

  it('reads a question whose space before the mark is a non-breaking one', () => {
    const html = sanitised('<h2>FAQ</h2><h3>Que faire\xa0?</h3><p>Rien.</p>')

    expect(extractFaqItems(html)).toEqual([{ question: 'Que faire ?', answer: 'Rien.' }])
  })

  it('reads the articles as the sanitiser leaves them', () => {
    expect(extractFaqItems(sanitised(ARTICLE_HTML))).toEqual(extractFaqItems(ARTICLE_HTML))
  })
})

describe('FAQPage', () => {
  const document = buildFaqSchema(extractFaqItems(ARTICLE_HTML))

  it('lists each question with its accepted answer', () => {
    expect(document).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Peut-on commander sans compte ?',
          acceptedAnswer: { '@type': 'Answer', text: 'Oui, le paiement se fait en invité.' },
        },
        {
          '@type': 'Question',
          name: 'Livrez-vous le dimanche ?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Oui, de 18 h à 22 h. Les commandes passées après 21 h 30 se retirent sur place.',
          },
        },
      ],
    })
    expect(serialised(document)).toContain('FAQPage')
  })

  it('is nothing at all for an article that asks no question', () => {
    const articles = {
      'no FAQ section': '<h2>Pourquoi la pâte repose</h2><p>Quarante-huit heures.</p>',
      'a FAQ section with no question in it':
        '<h2>Questions fréquentes</h2><h3>À savoir</h3><p>Rien.</p><h3>Allergènes</h3><p>Voir la carte.</p>',
      'questions outside the FAQ section':
        '<h2>Pourquoi ?</h2><h3>Et alors ?</h3><p>Voilà.</p><h3>Et ensuite ?</h3><p>Rien.</p>',
      'only one question': '<h2>FAQ</h2><h3>Une seule ?</h3><p>Oui.</p>',
      'one answered question and one without an answer':
        '<h2>FAQ</h2><h3>Répondue ?</h3><p>Oui.</p><h3>Muette ?</h3>',
      'no markup at all': '',
    }

    for (const [name, html] of Object.entries(articles)) {
      expect(buildFaqSchema(extractFaqItems(html)), name).toBeUndefined()
    }
  })

  it('needs two items that can be told, not two that were counted', () => {
    expect(buildFaqSchema([])).toBeUndefined()
    expect(buildFaqSchema([{ question: 'Une ?', answer: 'Oui.' }])).toBeUndefined()
    expect(
      buildFaqSchema([
        { question: 'Une ?', answer: 'Oui.' },
        { question: 'Deux ?', answer: '   ' },
        { question: '  ', answer: 'Non.' },
      ]),
    ).toBeUndefined()
    expect(
      buildFaqSchema([
        { question: 'Une ?', answer: 'Oui.' },
        { question: 'Deux ?', answer: 'Non.' },
      ]),
    ).toBeDefined()
  })
})

describe('what is written into the page', () => {
  /** Every character that could end a script element, in text an establishment typed. */
  const HOSTILE = '</script ><script>alert(1)</script> <!-- <img src=x onerror=alert(1)> & co'

  const article = buildArticleSchema(
    { ...ARTICLE, title: `Pâtes ${HOSTILE}`, description: `Résumé ${HOSTILE}` },
    { baseUrl: BASE, store: { name: `Chez ${HOSTILE}` } },
  )

  // The HTML escapes what the sanitiser escapes: the visitor sees the text, and
  // the FAQ reader decodes it — which is exactly what hands `<` back to the JSON.
  const escaped = HOSTILE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const faq = buildFaqSchema(
    extractFaqItems(
      sanitised(
        `<h2>Questions fréquentes</h2><h3>Et si on écrit ${escaped} ?</h3><p>Réponse ${escaped}</p>` +
          '<h3>Deuxième ?</h3><p>Oui &amp; non.</p>',
      ),
    ),
  )

  it('decodes the text of a question back to what was typed', () => {
    // Guard against the escaping tests below passing on a document that never
    // held a `<` in the first place.
    expect(faq?.mainEntity).toMatchObject([
      { name: `Et si on écrit ${HOSTILE} ?`, acceptedAnswer: { text: `Réponse ${HOSTILE}` } },
      { name: 'Deuxième ?' },
    ])
  })

  it.each([
    ['the Article', article],
    ['the FAQPage', faq],
  ])('writes %s as JSON that parses back to the same document', (_name, document) => {
    expect(document).toBeDefined()
    expect(JSON.parse(serializeJsonLd(document))).toEqual(document)
  })

  it.each([
    ['the Article', article],
    ['the FAQPage', faq],
  ])('cannot be ended by what %s holds', (_name, document) => {
    const out = scriptBody(document)

    expect(out).not.toMatch(/[<>&]/)
    expect(out).toContain('\\u003c')
    expect(JSON.parse(out)).toEqual(document)
  })

  it('renders nothing for a document that is not there', () => {
    expect(JsonLd({ data: buildFaqSchema([]) })).toBeNull()
  })
})

describe('the markup actually reaches the article page', () => {
  const page = readFileSync(join(process.cwd(), 'app/(storefront)/blog/[slug]/page.tsx'), 'utf8')

  it('renders the Article and the FAQPage beside the breadcrumbs', () => {
    expect(page).toMatch(/<JsonLd\s+data=\{breadcrumbs\}/)
    expect(page).toMatch(/<JsonLd\s+data=\{articleSchema\}/)
    expect(page).toMatch(/<JsonLd\s+data=\{faqSchema\}/)
  })

  it('reads the questions from the sanitised markup, never from the stored HTML', () => {
    expect(page).toMatch(/const content = DOMPurify\.sanitize\(/)
    expect(page).toMatch(/extractFaqItems\(\s*content\s*\)/)
    expect(page).not.toMatch(/extractFaqItems\(\s*article\b/)
  })
})
