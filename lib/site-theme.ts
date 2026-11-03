/**
 * The colour scheme a site opens in, and whether its visitors may change it.
 *
 * WHERE IT COMES FROM. The `theme` entry of `site.config.ts`, a file only a
 * client site has. `app/layout.tsx` is the one engine file allowed to read it,
 * so it calls `readSiteTheme` and hands the result to `<Providers theme={…}>`.
 * The bench's layout passes nothing and gets `DEFAULT_SITE_THEME`. That is what
 * keeps `app/providers.tsx`, this file and `components/` byte-identical in both
 * apps.
 *
 * WHAT `default` IS. The first impression: the scheme a visitor sees before
 * they have chosen one. It is not a lock. A choice already stored in the
 * browser (next-themes keeps it under `localStorage.theme`) wins over it, and
 * so does the admin's own toggle on the same browser, which writes the same key.
 *
 * WHAT `toggle` IS. Whether the storefront header offers the choice. `false`
 * removes that control and nothing else; the admin keeps its own.
 */

/** In the order the toggle steps through them. */
export const THEME_CHOICES = ['light', 'dark', 'system'] as const

/** What a visitor can be on: a fixed look, or whatever their device is set to. */
export type ThemeChoice = (typeof THEME_CHOICES)[number]

/** The `theme` entry of `site.config.ts`. Both fields are optional. */
export interface SiteThemeConfig {
  /** The scheme a visitor sees before they have chosen one. */
  default?: ThemeChoice
  /** Whether the storefront header offers the choice. */
  toggle?: boolean
}

/** The entry with its defaults applied. */
export type SiteTheme = Required<SiteThemeConfig>

/** Today's behaviour: follow the visitor's device, and let them override it. */
export const DEFAULT_SITE_THEME: SiteTheme = { default: 'system', toggle: true }

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.some((choice) => choice === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The `theme` entry of a site configuration, with its defaults applied.
 *
 * It takes the whole configuration and accepts anything. A site's
 * `site.config.ts` is never overwritten by an update, so one written before the
 * entry existed has no `theme` key, and `siteConfig.theme` would not compile
 * there. A value this does not recognise falls back to the default rather than
 * throwing: a typo in a build-time file must not take the storefront down. The
 * template's `tests/site-theme-config.test.ts` is what catches it in CI.
 */
export function readSiteTheme(config: unknown): SiteTheme {
  const entry = isRecord(config) ? config.theme : undefined
  if (!isRecord(entry)) return { ...DEFAULT_SITE_THEME }

  return {
    default: isThemeChoice(entry.default) ? entry.default : DEFAULT_SITE_THEME.default,
    toggle: typeof entry.toggle === 'boolean' ? entry.toggle : DEFAULT_SITE_THEME.toggle,
  }
}

/**
 * The choice after `current`, in the order of `THEME_CHOICES`.
 *
 * Anything that is not a choice, such as the `undefined` next-themes reports
 * before it has read the browser, steps to the first one.
 */
export function nextThemeChoice(current: unknown): ThemeChoice {
  const index = THEME_CHOICES.findIndex((choice) => choice === current)
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length] ?? THEME_CHOICES[0]
}
