'use client'

import { useSelectedLayoutSegment } from 'next/navigation'
import { useSyncExternalStore, type ReactNode } from 'react'

/**
 * The route group that holds the administration: the folder `app/(admin)`.
 *
 * Named once, here, so the exclusion below reads the same string the folder is
 * called. `tests/site-effects-slot.test.tsx` fails when the folder is renamed:
 * a slot that went on comparing against a name nothing carries any more would
 * mount a site's own code on every dashboard screen, and say nothing.
 */
export const ADMIN_ROUTE_GROUP = '(admin)'

/**
 * Where a site's own browser-side code is mounted: once, for the whole site.
 *
 * Smooth scrolling, a custom pointer and the like need a client component that
 * outlives every page, and the shell has nowhere to put one. `app/layout.tsx`
 * is the only engine file allowed to read the client zone, so it is the one
 * place that can hand the slot the site's `SiteEffects` component
 * (`site/components/SiteEffects.tsx`). The engine's own layout hands it
 * nothing, and the slot then renders nothing at all.
 *
 * WHAT THE SLOT ADDS, and why each line is here:
 *
 *   NOTHING BEFORE HYDRATION. The server HTML and the hydration pass hold none
 *   of the site's code, because the first render answers `false` (the
 *   `hasMounted` idiom the storefront header and the user menu already use). A
 *   component that reads `window`, `matchMedia` or storage while it renders
 *   therefore cannot cause a hydration mismatch, and nothing it draws can show
 *   up uninitialised before its effects have run.
 *
 *   NOTHING IN THE ADMINISTRATION. The dashboard is the owner's tool, not the
 *   diner's site: inertial scrolling on a data table or a custom pointer over a
 *   form is a defect there, not a feature. Which routes those are is read from
 *   the route tree (from the root layout, the selected segment of a dashboard
 *   page is the group's folder name) rather than from a list of URLs, because a
 *   list has to be remembered every time the administration gains a route and
 *   the folder cannot be left behind. The children unmount on a client
 *   navigation into the group, so their effect cleanups run, and mount again
 *   on the way out.
 *
 *   NO MARKUP OF ITS OWN. A fragment, so the slot itself cannot move anything.
 *   Whatever the site draws sits after `Providers` at the end of `<body>`,
 *   which is why a fixed or absolutely positioned overlay does not shift the
 *   page and an in-flow block would only lengthen it below the content.
 */
export function SiteEffectsSlot({ children }: { children?: ReactNode }) {
  const segment = useSelectedLayoutSegment()
  const hasMounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  if (!hasMounted || segment === ADMIN_ROUTE_GROUP) return null
  return <>{children}</>
}
