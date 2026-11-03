'use client'

import { createContext, useContext } from 'react'
import { DEFAULT_SITE_THEME, type SiteTheme } from './site-theme'

/**
 * The site's colour-scheme settings, for the components that sit far from
 * `app/providers.tsx` and cannot be handed a prop: the storefront header's
 * toggle asks whether it should exist at all.
 *
 * The default is the real default, not a placeholder, so a component rendered
 * without a provider (a test, a harness) behaves like the bench does.
 *
 * Kept apart from `site-theme.ts` on purpose. `app/layout.tsx` is a Server
 * Component and imports `readSiteTheme` from there; a file that calls
 * `createContext` cannot be imported by one.
 */
const SiteThemeContext = createContext<SiteTheme>(DEFAULT_SITE_THEME)

export const SiteThemeProvider = SiteThemeContext.Provider

export function useSiteTheme(): SiteTheme {
  return useContext(SiteThemeContext)
}
