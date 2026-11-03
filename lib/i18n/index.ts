/**
 * Static i18n strings and I18nKey type
 * @packageDocumentation
 */

import frJson from './locales/fr.json'

/**
 * Type-safe i18n key derived from the French reference file.
 * All locale files must contain exactly these keys.
 */
export type I18nKey = keyof typeof frJson

/** All available static locale files */
const LOCALE_IMPORTS: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  fr: () => import('./locales/fr.json'),
  en: () => import('./locales/en.json'),
  es: () => import('./locales/es.json'),
}

/** In-memory cache of loaded locale strings */
const localeCache = new Map<string, Record<string, string>>()

/**
 * Load all static strings for the given locales.
 * Prefetches everything at boot so t() lookups are synchronous O(1).
 *
 * @param localeCodes - Locale codes to load (e.g. ["fr", "en", "es"])
 * @returns Map of locale code → key/value pairs
 */
export async function loadAllStaticStrings(
  localeCodes: string[]
): Promise<Map<string, Record<string, string>>> {
  const toLoad = localeCodes.filter(
    (code) => !localeCache.has(code) && code in LOCALE_IMPORTS
  )

  if (toLoad.length > 0) {
    const results = await Promise.all(
      toLoad.map(async (code) => {
        const mod = await LOCALE_IMPORTS[code]!()
        // Handle default export (Next.js dynamic import wraps JSON in { default: ... })
        const data = (mod as { default: Record<string, string> }).default ?? mod
        return [code, data as Record<string, string>] as const
      })
    )

    for (const [code, data] of results) {
      localeCache.set(code, data)
    }
  }

  // Return all requested locales from cache
  const result = new Map<string, Record<string, string>>()
  for (const code of localeCodes) {
    const cached = localeCache.get(code)
    if (cached) {
      result.set(code, cached)
    }
  }
  return result
}

/**
 * Get cached static strings for a locale (synchronous).
 * Returns undefined if not yet loaded via loadAllStaticStrings().
 */
export function getStaticStrings(locale: string): Record<string, string> | undefined {
  return localeCache.get(locale)
}

/** Reference keys from French locale (for CI validation) */
export const REFERENCE_KEYS = Object.keys(frJson) as I18nKey[]

/**
 * The reference catalogue itself, available synchronously.
 *
 * `loadAllStaticStrings` is async, and until it resolves `t()` has nothing to
 * resolve against and returns the key — so the header would paint `nav.home
 * nav.menu nav.about` for a frame on every cold load. This is what the store
 * is seeded with before the first render.
 */
export const REFERENCE_STRINGS = frJson as Record<string, string>

/** The language `REFERENCE_STRINGS` is written in. */
export const REFERENCE_LOCALE = "fr"
