/**
 * The layout families a template picks from (#507).
 *
 * WHERE THIS COMES FROM. `demos/assets/site.css` declares the contract in its
 * own header, and `demos/assets/themes.js` assigns one value per family to each
 * of the fifty demo identities. Those identities are what
 * `scripts/gen-templates.mjs` already generates the catalogue from — it reads
 * `hero` and `menu` to write an English sentence into `template.json`'s
 * `description`, and throws the machine-readable value away. The other five
 * families it never reads at all.
 *
 * So a design sold "by restaurant type" arrived at a client as a palette, a
 * radius and a font pair, and the layout half of its identity stayed in the
 * sales demo. This table is the layout half, in a form the engine can act on.
 *
 * ATTRIBUTE OR COMPONENT VARIANT — THE ANSWER IS BOTH, AND THIS FILE USED TO
 * SAY OTHERWISE. It claimed that "every family there is pure CSS keyed on a
 * `data-*` attribute, over markup that does not change between variants". That
 * is true of `nav`, `btn`, `tex`, `foot` and `up`, and **false of `hero` and
 * `menu`** — the two that had not been implemented when it was written.
 *
 * `demos/assets/site.js` sets all seven attributes on `<html>` at `:121`, and
 * then decides those two by emitting different markup: `switch (T.hero)` at
 * `:323` returns a different `<section>` per value, and `renderMenu(dishes,
 * style, full)` at `:276` branches the same way. The CSS confirms it —
 * `.hero-editorial .stamp`, `.hero-poster .marq`, `.hero-magazine .rule` select
 * elements that exist in one variant only.
 *
 * That is why `HONOURED` below is per VALUE. Three of `hero`'s ten are
 * arrangements of what the engine's hero already holds, and those three are
 * ordinary CSS here; the other seven want a photograph, a second image, a
 * locations board, a marquee, or a rating stamp this product refuses to invent —
 * a different tree, not a different rule. A family is not atomic, and pretending
 * it was would have meant shipping none of the three or claiming all ten.
 *
 * WHERE THE ATTRIBUTE SITS, AND WHERE THE RULES MAY REACH. The attribute goes
 * on `<html>`, as it does in the demos. Every rule that reads it MUST be
 * confined to `.storefront-theme` — the shell's own div — because `<html>` is
 * the administration's ancestor too. That is the same lesson #410 and #41 cost:
 * name the element the storefront actually is, or you repaint the dashboard.
 * `app/globals.css` holds the rules, and a test refuses one that escapes.
 */

/** Every family, with its allowed values. The first value of each is the engine's own. */
export const LAYOUT_FAMILIES = {
  nav: ["left", "center", "bar", "minimal"],
  hero: [
    "split",
    "editorial",
    "fullbleed",
    "poster",
    "board",
    "magazine",
    "zen",
    "banner",
    "collage",
    "duo",
  ],
  menu: ["cards", "dotted", "tickets", "zen", "mosaic", "ledger", "tabs", "bento"],
  btn: ["soft", "pill", "square", "brutal", "underline"],
  tex: ["none", "dots", "lines", "grain", "checker"],
  foot: ["columns", "center", "heavy"],
  up: ["0", "1"],
} as const satisfies Record<string, readonly string[]>

export type LayoutFamily = keyof typeof LAYOUT_FAMILIES

/** The layout half of a template's identity: one value per family. */
export type SiteLayout = {
  [F in LayoutFamily]: (typeof LAYOUT_FAMILIES)[F][number]
}

/**
 * What the storefront actually renders differently today — per VALUE.
 *
 * Per value and not per family, because a family is not atomic. `hero` has ten,
 * and three of them are expressible on the content an establishment already has;
 * the other seven want a photograph the engine's hero does not carry, a second
 * image, a locations board, or — for `editorial` — a rating stamp, which this
 * product refuses to invent at all (CLAUDE.md § social proof, held by
 * `tests/storefront/no-fabricated-social-proof.test.ts`). Treating the family as
 * one switch would have meant shipping none of the three or lying about seven.
 *
 * The grain has earned itself twice since. `menu` went three of eight to five
 * when #566 restructured the card body for `tickets` and `dotted`, and `btn`
 * went three of five to all five when the filled control turned out to have a
 * name already. Neither would have been shippable at family grain.
 *
 * `layout-families.test.ts` compares this against what exists, in both
 * directions and by mechanism: the CSS families against the rules in
 * `app/globals.css`, and `hero` against the variants its component implements.
 * So a value listed here with nothing behind it fails, and a variant built
 * without being listed fails too.
 *
 * `templates/README.md` says the same thing in prose, and a test holds that to
 * this as well.
 */
export const HONOURED: { readonly [F in LayoutFamily]: readonly SiteLayout[F][] } = {
  nav: ["left", "center", "bar", "minimal"],
  tex: ["none", "dots", "lines", "grain", "checker"],
  foot: ["columns", "center", "heavy"],
  up: ["0", "1"],
  hero: ["split", "zen", "banner"],
  menu: ["cards", "zen", "ledger", "tickets", "dotted"],
  btn: ["soft", "pill", "square", "brutal", "underline"],
}

/** The families with at least one value the storefront honours. */
export const HONOURED_FAMILIES = (Object.keys(HONOURED) as LayoutFamily[]).filter(
  (family) => HONOURED[family].length > 0
)

/** Does the storefront render this value differently, or fall back to the default? */
export function isHonoured(family: LayoutFamily, value: string): boolean {
  return (HONOURED[family] as readonly string[]).includes(value)
}

/** The engine's own layout — what a site renders with no template applied. */
export const ENGINE_LAYOUT: SiteLayout = {
  nav: "left",
  hero: "split",
  menu: "cards",
  btn: "soft",
  tex: "none",
  foot: "columns",
  up: "0",
}

/** Is `value` one this family admits? */
export function isLayoutValue(family: LayoutFamily, value: unknown): boolean {
  return (LAYOUT_FAMILIES[family] as readonly string[]).includes(String(value))
}

/**
 * The `data-*` attributes for a layout, ready to spread onto `<html>`.
 *
 * TWO REASONS TO FALL BACK, AND THEY ARE THE SAME REASON (#529).
 *
 * A value outside its family falls back to the engine's rather than reaching
 * the DOM: an attribute no rule matches is invisible, and an invisible wrong
 * value is how a template silently renders as something else. The applier
 * refuses a template with no `layout.ts` at all, which is the loud half of the
 * same rule.
 *
 * A value INSIDE its family that nothing paints is the identical situation, and
 * the line used to be drawn at family membership instead. `hero: "poster"` is a
 * legal value with zero rules in `globals.css`, so the shop rendered `split`
 * while `<html>` said `poster`. Measured at `a92a0e51`: 31 of the 51 templates
 * named a hero the storefront does not paint, 26 a menu, and 51 a button style —
 * the whole `btn` family, which then had no painted value at all.
 *
 * `btn` is now FIVE OF FIVE and that last figure is 0. `brutal` and `underline`
 * were the two this file called unbuildable, on an objection that was correct
 * about the danger and wrong about the remedy: both restyle a control's fill,
 * and the selector the radius values lean on also catches the dish name, which
 * is a `<button>` with no ground. The remedy was said to be naming every filled
 * control by hand. It was not needed — `Button.tsx` writes `data-variant`
 * beside `data-slot`, from the same call that decides the ground, so
 * `[data-variant="default"]` already names exactly the filled control and none
 * of the 56 raw buttons. `globals.css` carries the measurement.
 *
 * THE DECLARATION IS NOT LOST. It moves to `data-<family>-requested`, so the
 * markup says both what it renders and what the template asked for. Painting a
 * value is then one entry in `HONOURED` away from making the note disappear on
 * its own, and somebody asking "why is my poster hero not showing" finds the
 * answer in the DOM rather than in a stylesheet they have to search.
 *
 * `templates/README.md` carries the measured reason each value is still
 * unpainted: the heroes and menus want a photograph, a second image, a board or
 * a category bar the engine's components do not carry, and `editorial` wants a
 * rating stamp this product refuses to invent at all.
 */
export function layoutAttributes(
  layout: Partial<SiteLayout> | undefined
): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const family of Object.keys(LAYOUT_FAMILIES) as LayoutFamily[]) {
    const chosen = layout?.[family]
    const legal = isLayoutValue(family, chosen)
    const value = legal ? String(chosen) : ENGINE_LAYOUT[family]

    if (isHonoured(family, value)) {
      attributes[`data-${family}`] = value
      continue
    }

    // Unpainted. The engine's value is what renders, so it is what the DOM
    // says — and the request is recorded beside it, unless it IS the engine's
    // value, where there is nothing to report.
    attributes[`data-${family}`] = ENGINE_LAYOUT[family]
    if (legal && value !== ENGINE_LAYOUT[family]) {
      attributes[`data-${family}-requested`] = value
    }
  }
  return attributes
}
