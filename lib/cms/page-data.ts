/**
 * What a CMS page is made of, and how a field is read out of it.
 *
 * No directive and no `server-only`: this is imported by the client hook
 * (`useCmsPage`), by the server reader (`fetchCmsPage`) and by the content
 * components that receive a server render as props. It exists because the first
 * two each carried their own copy of `block()` / `field()`, and a server render
 * that resolves a translation differently from the browser that hydrates it is
 * a hydration mismatch rather than a style difference. One resolver, two callers.
 */

import type { CmsFieldValue, CmsBlockValues } from '@be-yours/cms'

// ---------------------------------------------------------------------------
// What the pages read
// ---------------------------------------------------------------------------

export interface CmsMediaInfo {
  url: string
  thumbnailUrl?: string
  filename: string
  mimeType: string
  width?: number
  height?: number
}

export interface CmsFieldAccessor {
  text: string | null
  mediaUrl: string | null
  media: CmsMediaInfo | null
  embedUrl: string | null
  altText: string | null
  raw: CmsFieldValue | undefined
}

export interface CmsBlockAccessor {
  field: (fieldKey: string) => CmsFieldAccessor
  values: CmsBlockValues
}

// ---------------------------------------------------------------------------
// What the backend answers
// ---------------------------------------------------------------------------

/** One block of a page, as `cms.getPageBlocks` returns it. */
export interface CmsPageBlock {
  blockKey: string
  values: CmsBlockValues
  translationsByField?: Record<string, Record<string, { value?: string | null }>>
  resolvedMedia?: Record<string, CmsMediaInfo>
}

/**
 * The whole answer of `cms.getPageBlocks`: plain JSON, which is what lets a
 * server render hand it to a client component as a prop.
 *
 * The query's own return type is looser than this (its handlers take `ctx:
 * any`), so callers cast to it once, here, instead of each re-describing it.
 */
export interface CmsPageData {
  pageMeta: {
    hasPublished: boolean
    publishedAt?: number
  } | null
  blocks: CmsPageBlock[]
}

// ---------------------------------------------------------------------------
// The server's copy of a page
// ---------------------------------------------------------------------------

/**
 * A page as the server read it, to render from until the browser has its own.
 *
 * The browser's copy comes from a live Convex subscription that cannot exist
 * before hydration, so without this a CMS-driven page prints the code's sample
 * copy in the first HTML, and a crawler that runs no JavaScript never sees the
 * owner's words. See `getCmsInitialData`, which builds it.
 */
export interface CmsInitialData {
  /** The establishment the page was read for. */
  storeId: string
  /**
   * The language the translations in `data` were resolved against, as the
   * server picked it from the `beid_locale` cookie. `null` is the source
   * language. Hydration has to resolve the same way the server did, and the
   * browser's language store cannot say so yet (see `localeFor`).
   */
  locale: string | null
  data: CmsPageData
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const EMPTY_FIELD: CmsFieldAccessor = {
  text: null,
  mediaUrl: null,
  media: null,
  embedUrl: null,
  altText: null,
  raw: undefined,
}

const EMPTY_BLOCK: CmsBlockAccessor = {
  field: () => EMPTY_FIELD,
  values: {},
}

/**
 * One block of a page, with its fields ready to read.
 *
 * Anything the CMS does not hold comes back as an empty accessor — `text`,
 * `mediaUrl`, `altText` all `null` — which is the signal each page already
 * reads as "use the sample copy written in the code". That covers a page with
 * no data, a block the owner never saved, a field they never filled in and a
 * field they reset (`isCleared`).
 *
 * `locale` picks a translation when the block has one for that field; with none
 * (or `null`) the field reads in the source language.
 */
export function resolveCmsBlock(
  data: CmsPageData | null | undefined,
  blockKey: string,
  locale: string | null | undefined,
): CmsBlockAccessor {
  const blockData = data?.blocks.find((b) => b.blockKey === blockKey)
  if (!blockData) return EMPTY_BLOCK

  return {
    values: blockData.values,
    field: (fieldKey: string): CmsFieldAccessor => {
      const value = blockData.values[fieldKey] as CmsFieldValue | undefined

      // Cleared, or never written: the code's default applies.
      if (!value || value.isCleared) return EMPTY_FIELD

      let text = value.textValue ?? null
      if (text && locale) {
        text = blockData.translationsByField?.[fieldKey]?.[locale]?.value ?? text
      }

      const media = blockData.resolvedMedia?.[fieldKey] ?? null

      return {
        text,
        mediaUrl: media?.url ?? null,
        media,
        embedUrl: value.embedUrl ?? null,
        altText: value.altText ?? null,
        raw: value,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Deciding whether the server's copy still applies
// ---------------------------------------------------------------------------

/**
 * The server's copy, if it is a copy of the page being asked about.
 *
 * The server read one establishment. Until the browser has settled on one
 * (`storeId` is `undefined` while the list of establishments loads, which is
 * the whole of hydration) the server's copy is the only copy there is. Once the
 * browser has settled on a different one, that copy belongs to somebody else's
 * restaurant and is dropped, never shown in place of the right one.
 */
export function initialDataFor(
  initial: CmsInitialData | null | undefined,
  storeId: string | null | undefined,
): CmsInitialData | null {
  if (!initial) return null
  if (storeId && storeId !== initial.storeId) return null
  return initial
}

/**
 * Which language to resolve translations in.
 *
 * The browser's language store starts at a literal `"fr"` and learns the
 * visitor's language in an effect, after the establishment's languages have
 * come back — so for the whole of hydration it holds the default, not what the
 * visitor chose. The server read the choice from the cookie. Resolving with the
 * store at that point would print French where the server printed English: a
 * hydration mismatch, and then a second flash once the store caught up. So
 * while the store is not ready, the server's language stands.
 *
 * Without a server copy there is nothing to agree with, and the store is
 * always right.
 */
export function localeFor(
  initial: CmsInitialData | null,
  storeLocale: string,
  languageReady: boolean,
): string | null {
  return initial && !languageReady ? initial.locale : storeLocale
}
