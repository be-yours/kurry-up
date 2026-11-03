'use client'

import { useSyncExternalStore } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useTranslation } from '@be-yours/restaurant'
import { isThemeChoice, nextThemeChoice, type ThemeChoice } from '@/lib/site-theme'
import { useSiteTheme } from '@/lib/site-theme-provider'

/**
 * What each choice looks like and is called. The label names the choice the
 * visitor is on and says what the button does, because an icon gives a screen
 * reader neither.
 */
const CHOICES = {
  light: { Icon: Sun, labelKey: 'accessibility.themeLight' },
  dark: { Icon: Moon, labelKey: 'accessibility.themeDark' },
  system: { Icon: Monitor, labelKey: 'accessibility.themeSystem' },
} as const satisfies Record<ThemeChoice, { Icon: unknown; labelKey: string }>

/**
 * The visitor's light, dark or system choice: one button that steps through the
 * three.
 *
 * WHY IT EXISTS. `app/providers.tsx` mounts next-themes on `enableSystem`, so a
 * diner whose device was dark got the dark storefront with nothing on the page
 * to leave it, and a site that ships two deliberate looks could not let anyone
 * pick between them. next-themes already stores the choice in `localStorage`
 * and applies it before the first paint; this is only the control.
 *
 * ONE BUTTON, NOT A MENU. The header already carries a language picker, a store
 * picker, the basket and the account, and a fourth popover is a lot of chrome
 * for three values. The icon shows the choice the visitor is on, and the
 * accessible name says the same in words: nothing else on the page tells a
 * screen reader which scheme is active.
 *
 * HYDRATION. The stored choice does not exist on the server, and on the client
 * next-themes reads it during the very first render, so drawing it straight
 * away mismatches the server HTML for every visitor who ever chose. Until
 * mounted this draws the site's default, which is what the server drew, and
 * swaps to the stored choice once hydration is over.
 *
 * THREE GROUNDS. `transparent` and `solid` are the two states of the header bar
 * and carry the classes of their neighbours there. `overlay` is the full-screen
 * mobile menu, which is painted `--primary`: it takes the classes of that menu's
 * own close button, because `text-white` is not guaranteed to read on a primary
 * a site chose, and draws its focus ring in ink for the same reason: the global
 * `outline-ring/50` is `--primary` there, the colour the menu is painted, so a
 * keyboard user would see no indicator at all (what `UserMenu`'s `overlay`
 * found, #725). The classes are written inline, in the `className`, for the
 * contrast sweep: it reads that attribute and does not follow a lookup table, so
 * a table of them would be a control it never measured.
 *
 * `storefront-theme-toggle` is a hook for a site's own CSS, like the
 * `storefront-nav*` classes beside it, not styling. A site that does not want
 * the control sets `toggle: false` in the `theme` entry of `site.config.ts`.
 */
export function ThemeToggle({
  variant = 'solid',
}: {
  variant?: 'transparent' | 'solid' | 'overlay'
}) {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const site = useSiteTheme()
  const hasMounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  if (!site.toggle) return null

  const current: ThemeChoice = hasMounted && isThemeChoice(theme) ? theme : site.default
  const { Icon, labelKey } = CHOICES[current]
  const label = t(labelKey)

  return (
    <button
      type="button"
      onClick={() => setTheme(nextThemeChoice(current))}
      className={`storefront-theme-toggle flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
        variant === 'transparent'
          ? 'bg-white/10 border-white/20 text-white hover:bg-white/20'
          : variant === 'overlay'
            ? 'bg-primary-hover border-white/20 text-primary-foreground focus-visible:outline-primary-foreground'
            : 'bg-card border-border shadow-sm text-accent-foreground hover:bg-muted'
      }`}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
