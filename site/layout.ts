/**
 * Site layout — CLIENT ZONE. Kurry Up, « La Fresque » (contract: site/ART_DIRECTION.md).
 *
 * The layout half of the identity, beside the colour half in `theme.css` and the type half in `fonts.ts`.
 * The families and what each admits are declared in `lib/layout-families.ts`; a value nothing paints
 * falls back to the engine's and is kept in the DOM as `data-<family>-requested`.
 *
 * Why these values, for this direction:
 *
 *   nav   "left"     the engine's own bar, so no engine grid fights site/pages/chrome.css, which composes the
 *                    one-row header: the logo placeholder on the axis, the rooms split on each side.
 *   hero  "banner"   a straight band with no bottom curve: the wall is flat, the passes are laid on it.
 *   menu  "cards"    photo cards as cream slabs on the wall; site/pages/menu.css dresses them.
 *   btn   "soft"     the engine's own radius on controls. `square` and `pill` reach EVERY button, the round
 *                    icon buttons of the header and the cart included; the brushed « Commander » is painted
 *                    by `.ky-btn` and by shared.css on the filled engine buttons instead.
 *   tex   "none"     the lime-wash grain is the site's own (shared.css, `--ky-grain`), at 3 % on the ground
 *                    only, never under a photo or a field of colour.
 *   foot  "columns"  the engine's columns, repainted as the green field by chrome.css.
 *   up    "1"        headings in capitals: Bungee is a capital face.
 */

import type { SiteLayout } from "@/lib/layout-families"

export const siteLayout: SiteLayout = {
  nav: "left",
  hero: "banner",
  menu: "cards",
  btn: "soft",
  tex: "none",
  foot: "columns",
  up: "1",
}
