/**
 * Synthetic answers of `cms.getPageBlocks`, for the first-paint suites.
 *
 * The shape is the query's own — `{ pageMeta, blocks: [{ blockKey, values,
 * translationsByField, resolvedMedia }] }` — written out by hand rather than
 * produced by the handler, so a suite fails on what the page does with a given
 * answer and not on how the answer was made. Every value is invented.
 */

export interface CmsFieldFixture {
  type: 'text' | 'image'
  textValue?: string
  mediaId?: string
  altText?: string
  isCleared?: boolean
}

interface ResolvedMediaFixture {
  url: string
  filename: string
  mimeType: string
  width: number
  height: number
}

/** One field as an author writes it: the stored value, and its media if any. */
export interface FieldSpec {
  value: CmsFieldFixture
  media?: ResolvedMediaFixture
}

/** Block key → field key → what the author wrote. */
export type BlocksSpec = Record<string, Record<string, FieldSpec>>

/** Block key → field key → language code → translated text. */
export type TranslationsSpec = Record<string, Record<string, Record<string, string>>>

export const STORE = {
  _id: 'store_luigi',
  name: 'Chez Luigi',
  slug: 'chez-luigi',
  status: 'open',
} as const

export const OTHER_STORE = {
  _id: 'store_lyon',
  name: 'Chez Luigi Lyon',
  slug: 'chez-luigi-lyon',
  status: 'open',
} as const

export const text = (textValue: string): FieldSpec => ({
  value: { type: 'text', textValue },
})

/** A field the owner reset: the stored text is still there, and must not show. */
export const cleared = (textValue: string): FieldSpec => ({
  value: { type: 'text', textValue, isCleared: true },
})

export const image = (url: string, altText?: string): FieldSpec => ({
  value: {
    type: 'image',
    mediaId: `media_${url}`,
    ...(altText === undefined ? {} : { altText }),
  },
  media: {
    url,
    filename: url.split('/').pop() ?? url,
    mimeType: 'image/webp',
    width: 1200,
    height: 1200,
  },
})

/** Reads as what it is at the call site; the identity function otherwise. */
export const withTranslations = (translations: TranslationsSpec): TranslationsSpec => translations

/** A published page, as `cms.getPageBlocks` answers it. */
export function cmsPage(blocks: BlocksSpec, translations: TranslationsSpec = {}) {
  return {
    pageMeta: { hasPublished: true, publishedAt: 1_760_000_000_000 },
    blocks: Object.entries(blocks).map(([blockKey, fields]) => {
      const values: Record<string, CmsFieldFixture> = {}
      const resolvedMedia: Record<string, ResolvedMediaFixture> = {}
      for (const [fieldKey, spec] of Object.entries(fields)) {
        values[fieldKey] = spec.value
        if (spec.media) resolvedMedia[fieldKey] = spec.media
      }

      const translationsByField: Record<
        string,
        Record<string, { value: string; isAutoTranslated: boolean }>
      > = {}
      for (const [fieldKey, byLocale] of Object.entries(translations[blockKey] ?? {})) {
        translationsByField[fieldKey] = Object.fromEntries(
          Object.entries(byLocale).map(([locale, value]) => [
            locale,
            { value, isAutoTranslated: false },
          ]),
        )
      }

      return { blockKey, values, translationsByField, resolvedMedia }
    }),
  }
}

/** What the query answers for a page nobody has written yet. */
export const emptyCmsPage = () => ({ pageMeta: null, blocks: [] })
