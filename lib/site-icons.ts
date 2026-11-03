import type { Metadata } from 'next'

/**
 * The browser-tab icons a site names for itself.
 *
 * `app/favicon.ico` shipped with the shell, and Next.js gives a file-based icon
 * priority over everything else it reads — the `metadata` object, and a file the
 * site drops in `public/`. So a delivered site could not put its own icon on its
 * own tab: `public/favicon.ico` lost to the shell's, and `metadata.icons` lost to
 * it too. The file is gone (it was the create-next-app placeholder, not an engine
 * asset), and the site zone now says what it wants in `site.config.ts`:
 *
 *   icons: { icon: "/brand/favicon.png", apple: "/brand/apple-touch-icon.png" }
 *
 * Paths in the site's `public/`, or `https:` URLs. Without `icons` the shell
 * declares none, and a browser asks `/favicon.ico` as it always does — served
 * from `public/favicon.ico` when the site has one. The CMS favicon (« Identité
 * visuelle ») still replaces whichever is declared, in the browser, once the
 * page has loaded: `DynamicFavicon` rewrites the first icon link.
 */
export interface SiteIcons {
  icon?: string
  shortcut?: string
  apple?: string
}

const KEYS = ['icon', 'shortcut', 'apple'] as const

/** A path in `public/` or an `https:` URL; `//host` and `javascript:` are neither. */
const ICON_SOURCE = /^(?:\/(?![/\\])[^\s\\]*|https:\/\/[^\s]+)$/

/**
 * Next's `metadata.icons` for a site config, or `undefined` when it names none.
 *
 * Takes the config as `unknown` on purpose. `site.config.ts` is a client-zone
 * file that no engine update overwrites, so a site created before `icons`
 * existed does not have the key — and one that has it may have typed anything.
 * Reading it defensively is what keeps an engine update from breaking the
 * build of a site that has never heard of this.
 */
export function siteIconsMetadata(config: unknown): Metadata['icons'] | undefined {
  const declared = (config as { icons?: unknown } | null | undefined)?.icons
  if (!declared || typeof declared !== 'object') return undefined

  const icons: SiteIcons = {}
  for (const key of KEYS) {
    const value = (declared as Record<string, unknown>)[key]
    if (typeof value === 'string' && ICON_SOURCE.test(value.trim())) {
      icons[key] = value.trim()
    }
  }
  return Object.keys(icons).length > 0 ? icons : undefined
}
