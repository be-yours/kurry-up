'use client'

/**
 * Site effects — CLIENT ZONE.
 *
 * The one place a site runs its own code in the browser: inertial smooth
 * scrolling, a custom pointer, anything that has to outlive a page and touch
 * `window`. `app/layout.tsx` mounts this component once, for the whole site,
 * through the engine's `SiteEffectsSlot`.
 *
 * It ships EMPTY. A site that changes nothing here changes nothing: no markup,
 * no listener, no effect. The file is yours. A template or engine update never
 * overwrites it, and the template does not edit it again after the first time
 * it arrives (`docs/UPDATES.md`). Should a merge ever report a conflict on it,
 * keep your own version:
 *
 *   git checkout --ours site/components/SiteEffects.tsx
 *
 * WHAT THE SLOT GUARANTEES
 *
 *   - This component renders after hydration and never on the server, so
 *     reading `window`, `document` or `matchMedia` while it renders is safe.
 *   - It is not rendered in the administration (`app/(admin)`): the dashboard
 *     never runs your effects. Everywhere else it is (storefront, sign-in,
 *     QR game, wall display); narrow it with `usePathname()` when you must.
 *   - It sits after the page, at the end of `<body>`, outside the engine's
 *     providers: no Convex hook, no `useTheme()`, no toast in here.
 *
 * WHAT IT ASKS OF YOU
 *
 *   - Put nothing in the flow of the page. Return `null`, or an overlay that is
 *     `position: fixed` (or `absolute`) with `pointer-events: none`: neither
 *     shifts the layout.
 *   - Undo everything in the effect cleanup. This component unmounts when the
 *     visitor opens the dashboard and mounts again when they leave it.
 *   - Honour `prefers-reduced-motion`. The stylesheet and framer-motion cannot
 *     reach motion you drive from JavaScript; `useReducedMotion()` from
 *     `framer-motion`, already installed, answers it.
 *   - Keep `'use client'` on the first line: the layout is a server component.
 *
 * Recipes (smooth scrolling, page transitions) are in `docs/CUSTOMIZATION.md`.
 */
import { usePathname } from 'next/navigation'

import { ChromeEffects } from './chrome/ChromeEffects'
import { HeroFilm } from './home/HeroFilm'

/** The wall display, the QR game and the CMS preview never get the site's effects. */
const OUT_OF_SITE = /^\/(display|game|games|preview)(\/|$)/

/**
 * Kurry Up, « La Fresque ». Kept minimal on purpose: every motion of the site is CSS (shared.css § 12), already
 * in its final state without script and under `prefers-reduced-motion`. No smooth-scroll library, no custom
 * pointer. What runs here is the chrome's (site/components/chrome/): the « Commander » of the bar and of the
 * phone menu, the footer's painted promise, and the phone menu's dialog behaviour. Nothing here moves.
 */
export function SiteEffects() {
  const pathname = usePathname() ?? ''
  if (OUT_OF_SITE.test(pathname)) return null
  return (
    <>
      <ChromeEffects />
      <HeroFilm />
    </>
  )
}
