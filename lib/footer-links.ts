/**
 * The footer's two link columns: the engine's links, or the owner's own.
 *
 * The footer carried two constant arrays — « Box », « Mes commandes »,
 * « Mes favoris » and « Mon compte », « Mes adresses », « Nos restaurants » —
 * with « Nos restaurants » pointing at `/store-selector` even on a deployment
 * that has one establishment and so nothing to select. A site could neither
 * drop one of them nor add a page of its own (`/evenements`), and a client with
 * both needs ended up hiding the column in CSS.
 *
 * A column is now read from « Layout du storefront » (`footerNav` and
 * `footerUseful`): the owner's links when they gave it at least one, the
 * engine's otherwise, nothing when they hid it. The value is rendered as an
 * `href`, so what is accepted is a closed list — a path on this site, an
 * `https:` address, `mailto:` or `tel:` — and `javascript:` and its cousins
 * never reach the page (see `safeSocialUrl` for the same rule on the icons).
 */

import { isNativeReservationHref } from '@be-yours/convex-schema'
import { FOOTER_LINK_SLOTS } from '@/cms/pages/storefront-layout'

/**
 * - `internal` — a page of this site, routed client-side.
 * - `web` — another site, opened in a new tab.
 * - `contact` — `mailto:` or `tel:`, handed to the visitor's own app.
 */
export type FooterLinkKind = 'internal' | 'web' | 'contact'

export interface FooterLink {
  href: string
  label: string
  kind: FooterLinkKind
}

/** A path on this site. `//host` and `/\host` are other hosts in a browser's eyes. */
const SITE_PATH = /^\/(?![/\\])[^\s\\]*$/

const MAX_HREF_LENGTH = 300

/** Where a typed address leads, or null when it is not one this footer will print. */
export function classifyFooterHref(
  value: string | null | undefined,
): { href: string; kind: FooterLinkKind } | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > MAX_HREF_LENGTH) return null

  if (SITE_PATH.test(trimmed)) return { href: trimmed, kind: 'internal' }

  try {
    const { protocol } = new URL(trimmed)
    if (protocol === 'https:') return { href: trimmed, kind: 'web' }
    if (protocol === 'mailto:' || protocol === 'tel:') return { href: trimmed, kind: 'contact' }
  } catch {
    // Not an absolute URL, and not a path on this site either.
  }
  return null
}

/**
 * The links an owner typed into a column's numbered slots.
 *
 * A slot needs both halves. A label with no address, or an address the footer
 * would not print, is skipped rather than drawn as a dead link — the editor
 * shows no error for it, so the safe reading is that it is not there.
 */
export function customFooterLinks(
  read: (field: string) => string | null | undefined,
): FooterLink[] {
  const links: FooterLink[] = []
  for (let slot = 1; slot <= FOOTER_LINK_SLOTS; slot++) {
    const label = read(`link${slot}Label`)?.trim()
    const target = classifyFooterHref(read(`link${slot}Url`))
    if (label && target) links.push({ label, ...target })
  }
  return links
}

/**
 * What a column draws: its owner's links, else its defaults, else nothing.
 *
 * `hidden` wins over everything, so an owner who hides a column while keeping
 * links in its slots gets the footer they asked for and loses nothing they typed.
 */
export function resolveFooterColumn(args: {
  hidden: boolean
  custom: readonly FooterLink[]
  defaults: readonly FooterLink[]
  /**
   * The establishment's own booking page is switched off. A link the owner
   * typed to `/reservation` goes with it — the footer would otherwise keep a
   * door to a page that now answers 404. Their other links stay; if that was
   * all they had typed, the column falls back to the engine's defaults.
   */
  dropNativeReservation?: boolean
}): readonly FooterLink[] | null {
  if (args.hidden) return null
  const custom = args.dropNativeReservation
    ? args.custom.filter((link) => !isNativeReservationHref(link.href))
    : args.custom
  if (custom.length > 0) return custom
  return args.defaults.length > 0 ? args.defaults : null
}
