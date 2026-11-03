/**
 * Which establishment, and which language, this server render is for.
 *
 * Two readers need the same answer and used to hold it twice: the page's
 * `<head>` (`generateCmsMetadata`) and the page's body (`getCmsInitialData`). A
 * `<title>` written for one establishment over a body written for another is
 * the kind of disagreement nobody reviews for, so the decision lives once and
 * both ask it.
 *
 * It also decides the key `getStorePageData` memoises on, so as long as both
 * ask here, the metadata and the body share one fetch per render.
 */

import 'server-only'
import { cookies } from 'next/headers'
import { LOCALE_COOKIE_NAME, normalizeStoredLocale } from '@be-yours/core'
import { resolveDefaultStoreSlug } from '@/lib/resolve-default-store'

export interface CmsRequest {
  /** `null` when this deployment has no published establishment at all. */
  storeSlug: string | null
  /** The visitor's language from `beid_locale`; `null` is the source language. */
  locale: string | null
}

export async function resolveCmsRequest(): Promise<CmsRequest> {
  const cookieStore = await cookies()

  // The cookie still wins when it is there — an owner previewing one of
  // several establishments has one, and the storefront writes it once the
  // visitor has settled on one (`useStoreId`) — but its absence is the normal
  // case, not a reason to give up.
  const storeSlug = cookieStore.get('storeSlug')?.value ?? (await resolveDefaultStoreSlug())

  const locale = normalizeStoredLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value)

  return { storeSlug, locale }
}
