/**
 * Engine nodes the chrome dresses — CLIENT ZONE. Owner: agent « chrome » (site/ART_DIRECTION.md § 10).
 *
 * Selectors of the engine's markup (components/storefront/storefront-header.tsx, storefront-footer.tsx), read
 * only. A node is handed out once React has hydrated it (it carries its `__reactFiber$` key): writing an
 * attribute into, or portalling into, a node still being hydrated is a hydration error.
 */

export const SEL = {
  /** The bar's flex row: the « Commander » button is portalled at its end (after the account, in tab order). */
  nav: '.storefront-theme > header .storefront-nav',
  /** The phone menu, mounted by AnimatePresence while open (framer keeps it 300 ms after the close). */
  overlay: '.storefront-theme > div.fixed.inset-0.bg-primary',
  /** The phone menu's top row (logo, cross): it repeats the bar, so the « Commander » plaque is portalled there. */
  overlayTop: '.storefront-theme > div.fixed.inset-0.bg-primary > div:first-child',
  /** The burger of the compact bar (the engine names it « Ouvrir le menu » / « Fermer le menu »). */
  burger: '.storefront-theme > header .storefront-nav > div.lg\\:hidden > button:last-child',
  /** The footer's centred column: the painted promise is portalled into it (placed first by chrome.css). */
  footerInner: '.storefront-theme footer.storefront-footer > div.max-w-7xl',
} as const

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Has React hydrated this node? (read only: the key React sets on every host node it owns) */
export function hydrated(el: Element | null): el is HTMLElement {
  if (!el) return false
  return Object.keys(el).some((k) => k.startsWith('__reactFiber$'))
}

export function find(selector: string): HTMLElement | null {
  const el = document.querySelector(selector)
  return hydrated(el) ? el : null
}

/** The close cross of the phone menu (first row of the overlay). */
export function closeButton(overlay: HTMLElement): HTMLButtonElement | null {
  return overlay.querySelector<HTMLButtonElement>(':scope > div:first-child > button')
}
