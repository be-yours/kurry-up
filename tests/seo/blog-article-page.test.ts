/**
 * What `/blog/<slug>` prints for a crawler.
 *
 * `article-structured-data.test.ts` holds the builders to their shapes. This
 * renders the route itself, because a builder nobody calls, or one fed the
 * stored HTML instead of the markup the visitor is shown, passes every test on
 * the builder and leaves the page exactly as it was: a `Restaurant` and a
 * `BreadcrumbList`, and nothing a search result or an answer engine could quote.
 */

import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchQuery } = vi.hoisted(() => ({ fetchQuery: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) =>
    createElement('a', { href }, children),
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('convex/nextjs', () => ({ fetchQuery }))
vi.mock('@/lib/convex-server', () => ({
  resolveStorefrontStore: async () => ({ _id: 'store_1' }),
}))
vi.mock('@/lib/seo', () => ({
  absoluteUrl: (path: string) => path,
  buildSeoMetadata: vi.fn(),
}))
vi.mock('@/lib/structured-data', () => ({
  getStorefrontSeoContext: async () => ({
    baseUrl: 'https://chez-luigi.fr',
    store: { name: 'Chez Luigi' },
    brandName: 'Chez Luigi',
  }),
}))
vi.mock('@be-yours/ui', () => ({
  Badge: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}))

const { default: BlogArticlePage } = await import('@/app/(storefront)/blog/[slug]/page')

const TITLE = 'Pizza napolitaine : pourquoi la pâte repose 48 heures'

/** One article as `getArticleBySlug` returns it: the published copy, media resolved. */
function published(html: string, title = TITLE) {
  return {
    _id: 'article_1',
    slug: 'pate-napolitaine',
    status: 'published',
    publishedAt: Date.UTC(2026, 8, 14, 9, 30),
    content: {
      title,
      excerpt: 'Une pâte qui repose deux jours.',
      metaDescription: 'Une pâte qui repose deux jours digère mieux.',
      content: html,
      updatedAt: Date.UTC(2026, 8, 21, 16, 5),
    },
    readingMinutes: 3,
    coverImage: { url: '/api/files/blog/pizza.webp', alt: 'Une pizza' },
    ogImage: null,
    category: null,
    tags: [],
  }
}

/** The fields of a printed JSON-LD document that these tests read. */
interface PrintedDocument {
  '@type': string
  headline?: string
  mainEntity?: { name: string; acceptedAnswer: { text: string } }[]
}

/** The page as a browser would receive it, and every JSON-LD document in it. */
async function render(slug = 'pate-napolitaine') {
  const html = renderToStaticMarkup(await BlogArticlePage({ params: Promise.resolve({ slug }) }))
  const documents = [
    ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs),
  ].map(([, json]) => JSON.parse(json!) as PrintedDocument)
  return { html, documents, types: documents.map((document) => document['@type']) }
}

const FAQ = [
  '<p>Oui, on peut commander sa pizza en ligne.</p>',
  '<h2>Questions fréquentes</h2>',
  '<h3>Peut-on commander sans compte ?</h3>',
  '<p>Oui, le paiement se fait en invité.</p>',
  '<h3>Livrez-vous le dimanche ?</h3>',
  '<p>Oui, de 18 h à 22 h.</p>',
].join('')

beforeEach(() => {
  fetchQuery.mockReset()
})

describe('the article route', () => {
  it('prints an Article and a FAQPage beside the breadcrumbs', async () => {
    fetchQuery.mockResolvedValue(published(FAQ))

    const { types, documents } = await render()

    expect(types).toEqual(['BreadcrumbList', 'Article', 'FAQPage'])
    expect(documents[1]).toMatchObject({
      '@context': 'https://schema.org',
      headline: TITLE,
      description: 'Une pâte qui repose deux jours digère mieux.',
      image: 'https://chez-luigi.fr/api/files/blog/pizza.webp',
      datePublished: '2026-09-14T09:30:00.000Z',
      dateModified: '2026-09-21T16:05:00.000Z',
      author: { '@id': 'https://chez-luigi.fr/#restaurant', name: 'Chez Luigi' },
      publisher: { '@id': 'https://chez-luigi.fr/#restaurant', name: 'Chez Luigi' },
      mainEntityOfPage: { '@id': 'https://chez-luigi.fr/blog/pate-napolitaine' },
    })
    expect(documents[2]?.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'Peut-on commander sans compte ?',
        acceptedAnswer: { '@type': 'Answer', text: 'Oui, le paiement se fait en invité.' },
      },
      {
        '@type': 'Question',
        name: 'Livrez-vous le dimanche ?',
        acceptedAnswer: { '@type': 'Answer', text: 'Oui, de 18 h à 22 h.' },
      },
    ])
  })

  it('claims no answer the page does not print', async () => {
    fetchQuery.mockResolvedValue(published(FAQ))

    const { html, documents } = await render()
    const printed = html.replace(/<script[\s\S]*?<\/script>/g, '')
    const questions = documents[2]?.mainEntity ?? []

    // Counted first, so that an empty list cannot pass the loop below unread.
    expect(questions).toHaveLength(2)
    for (const { name, acceptedAnswer } of questions) {
      expect(printed).toContain(name)
      expect(printed).toContain(acceptedAnswer.text)
    }
  })

  it('prints no FAQPage for an article that asks no question', async () => {
    fetchQuery.mockResolvedValue(
      published('<p>Oui.</p><h2>Pourquoi la pâte repose</h2><p>Quarante-huit heures.</p>'),
    )

    const { html, types } = await render()

    expect(types).toEqual(['BreadcrumbList', 'Article'])
    expect(html).not.toContain('FAQPage')
  })

  it('prints no FAQPage for a section that holds a single question', async () => {
    fetchQuery.mockResolvedValue(
      published('<h2>Questions fréquentes</h2><h3>Une seule ?</h3><p>Oui.</p>'),
    )

    const { types } = await render()

    expect(types).toEqual(['BreadcrumbList', 'Article'])
  })

  it('reads the questions from the markup the visitor is shown, not from the stored HTML', async () => {
    // The render pass drops a <template> with everything in it. The stored
    // copy still holds a whole FAQ there, which no visitor can read: a reader
    // fed that copy would publish answers the page does not print.
    fetchQuery.mockResolvedValue(
      published(`<p>Oui.</p><template>${FAQ}</template><h2>Pour finir</h2><p>Merci.</p>`),
    )

    const { html, types } = await render()

    expect(html).not.toContain('Peut-on commander sans compte')
    expect(types).toEqual(['BreadcrumbList', 'Article'])
  })

  it('keeps what an establishment typed from ending the script it is printed in', async () => {
    const hostile = '</script><script>alert(1)</script>'
    const escaped = hostile.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    fetchQuery.mockResolvedValue(
      published(
        `<h2>FAQ</h2><h3>Et ${escaped} ?</h3><p>Réponse ${escaped}</p><h3>Deux ?</h3><p>Oui.</p>`,
        `Titre ${hostile}`,
      ),
    )

    const { html, documents } = await render()

    // Three documents, three opening tags: no `<script` came from the data.
    expect(html.match(/<script/g)).toHaveLength(3)
    expect(documents.map((document) => document['@type'])).toEqual([
      'BreadcrumbList',
      'Article',
      'FAQPage',
    ])
    expect(documents[1]?.headline).toBe(`Titre ${hostile}`)
    expect(documents[2]?.mainEntity?.[0]?.name).toBe(`Et ${hostile} ?`)
  })

  it('is a 404 when there is no such article', async () => {
    fetchQuery.mockResolvedValue(null)

    await expect(render('introuvable')).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
