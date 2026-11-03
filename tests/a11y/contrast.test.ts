/**
 * Every colour a diner or an owner is asked to read, measured.
 *
 * WHAT THIS HOLDS SHUT. #410, raised by the owner from real use — "parfois les
 * couleurs ne sont pas très visibles" — and then measured rather than argued
 * about. Measured at `e8a396e`: 794 foreground/background pairs below the WCAG
 * 2.1 AA floor across the storefront, the sign-in screens, the admin and the
 * two UI packages — 484 of them with a surface this sweep can resolve, and 226
 * of those in LIGHT mode, which is to say live for everyone with no dark phone
 * required. Some were not marginal:
 *
 *   1.07:1  the storefront footer's copyright, `text-accent-foreground/40` on
 *           `bg-primary-hover` — dark green on dark green
 *   1.10:1  every card on the storefront, in dark mode: `.storefront-theme`
 *           had no dark counterpart, so near-black storefront ink landed on
 *           the engine's near-black `--card`
 *   2.85:1  the engine's own `--primary`: a white label on `#f97015`, and any
 *           word written in `text-primary`
 *   4.42:1  `text-muted-foreground` on `bg-muted`, in 952 places
 *
 * WHY A SOURCE SWEEP AND NOT A BROWSER. A browser measures the pages a test
 * mounts. This measures every page, including the ones no test mounts — which
 * is where the failures were. The arithmetic underneath is not trusted on its
 * own: it is checked against Chromium, with every colour read back off a canvas
 * so oklch, `color-mix` and alpha compositing are resolved by the engine rather
 * than re-implemented here. 194 of the first 199 pairs agreed to within 0.06;
 * re-run over the whole resolved set after the fixes, 389 of 398.
 *
 * WHY IT LIVES IN THE APP AND THE ENGINE BOTH. The scanner and the WCAG maths
 * are in `@be-yours/ui` — the package that owns the colours, next to
 * `readableForeground` and the branding sweep that guards the DERIVED palette.
 * The regions are here because only the app knows which of its trees render
 * under which token scope, and because a client site cloned from this template
 * runs this same file over its own source.
 *
 * WHEN THIS GOES RED, the fix is a token, not a hex. A literal that fails is a
 * literal that escaped the design system: route it back through the token
 * layer and an establishment's own branding governs it, with
 * `readableForeground` guaranteeing the result. And never reach for `opacity`
 * or a `/60` modifier to soften text — it multiplies the ratio down silently,
 * which is how the footer got to 1.07:1.
 */

import { readFileSync, readdirSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AA_LARGE, AA_TEXT, contrast } from "@be-yours/ui/contrast"
import { formatFailures, loadTokens, scanContrast } from "@be-yours/ui/contrast-scan"

/**
 * The token scope each tree renders under.
 *
 * `.storefront-theme` is carried by two elements — the `<div>` in
 * `components/storefront/storefront-shell.tsx` and the one in
 * `app/(auth)/layout.tsx` — and a custom property declared on an element beats
 * the one it would inherit, so everything inside either of them reads the
 * storefront palette and everything outside reads the engine's. The `(auth)`
 * pages are inside it deliberately: a diner signing in to order is the same
 * person the storefront serves, and the greens those pages used to spell as
 * literal hex were this scope's own values. The admin, the kitchen display and
 * the engine packages are outside.
 */
/**
 * The two surfaces a shell paints, taken from the shell rather than typed out.
 *
 * A hex copied into a test is a hex that goes stale silently, in the direction
 * of passing: repaint the game arena and this file would keep measuring
 * against the old colour and keep saying everything is fine. So each is read
 * from the source that declares it, and the read failing is the test failing.
 */
function declaredSurface(file: string, pattern: RegExp): string {
  const source = readFileSync(join(process.cwd(), file), "utf8")
  const match = pattern.exec(source)
  if (!match?.[1]) {
    throw new Error(`no surface colour found in ${file} — the shell was repainted or moved`)
  }
  return match[1]
}

/** `bg-[#120d1a]` on the wrapper every QR-game screen renders inside. */
const GAME_ARENA = declaredSurface(
  "node_modules/@be-yours/admin/src/game/game-shell.tsx",
  /className="[^"]*\bbg-\[(#[0-9a-fA-F]{3,8})\]/
)

/** `background: #0f172a` on `.display-root`, the kitchen screen's own sheet. */
const KITCHEN_DISPLAY = declaredSurface(
  "app/display/[storeId]/display.css",
  /\.display-root\s*\{[^}]*background:\s*(#[0-9a-fA-F]{3,8})/
)

const REGIONS = [
  // The trees a scope wraps come first: a file is measured once, under the
  // scope of whichever region claims it. `(auth)` is in this list because its
  // layout carries `.storefront-theme` — a diner signing in to order is the
  // same person the storefront serves, and the greens those pages had been
  // painting themselves with by hand were that scope's values digit for digit.
  { dir: "app/(storefront)", scope: ".storefront-theme" },
  { dir: "components/storefront", scope: ".storefront-theme" },
  { dir: "components/website", scope: ".storefront-theme" },
  { dir: "app/(auth)", scope: ".storefront-theme" },
  // The two trees whose background is painted by a shell in another file, and
  // which were therefore measured by NOTHING: every pair in them came back
  // `surfaceKnown: false` and was dropped. Naming the surface is a claim about
  // what the shell paints, and each is checked against its source below.
  //
  //   the QR game — `bg-[#120d1a]` on the wrapper in
  //   `@be-yours/admin/src/game/game-shell.tsx`, opaque, covering all
  //   eleven screens under `game/`;
  //   the kitchen display — `background: #0f172a` on `.display-root`, in
  //   `app/display/[storeId]/display.css`, which no `.tsx` mentions at all.
  //
  // They come before the general `app`/`components` entries for the same
  // reason the scoped trees do: first region to claim a file wins it.
  { dir: "node_modules/@be-yours/admin/src/game", scope: "", surface: GAME_ARENA },
  { dir: "app/display", scope: "", surface: KITCHEN_DISPLAY },
  // One FILE, not a directory: `block-preview.tsx` draws an EMAIL, and an
  // email lands on its own white ground whatever the admin's colour scheme is
  // — so it paints `bg-white` itself and every colour inside it is chosen for
  // that. The sweep cannot see the connection, because the blocks come back
  // from a closure rather than nested under the element that paints them; its
  // neighbours in the same directory are ordinary admin chrome on
  // `--background`, so the declaration has to be this narrow.
  {
    dir: "node_modules/@be-yours/admin/src/pages/email/templates/block-preview.tsx",
    scope: "",
    surface: "#ffffff",
  },
  // Then everything else this app renders — the admin, the CMS preview, the
  // error boundaries.
  //
  // `surface: "background"` is the same kind of claim as the two literals
  // above, made about a token rather than a hex because the admin has two
  // colour schemes: `SidebarInset` in `@be-yours/ui/src/components/
  // Sidebar.tsx` paints `bg-background`, `app/(admin)/layout.tsx` renders every
  // page inside it, and nothing between them paints anything else. Without it
  // these trees produced a `<page>` surface flagged `surfaceKnown: false` and
  // dropped — 95 pairs, which is most of what this sweep finds, thrown away for
  // want of the sentence above.
  //
  // A component sitting on a `--card` rather than the page is measured against
  // the page here, which is the conservative direction on the pairs that
  // matter: an ink that fails on `--background` fails on `--card` and `--muted`
  // too, both being within a few points of it in each scheme.
  { dir: "app", scope: "", surface: "background" },
  { dir: "components", scope: "", surface: "background" },
  { dir: "lib", scope: "", surface: "background" },
  // And the two engine packages, which render inside the admin.
  { dir: "node_modules/@be-yours/ui/src", scope: "", surface: "background" },
  { dir: "node_modules/@be-yours/admin/src", scope: "", surface: "background" },
]

/**
 * Files whose surface genuinely cannot be read from any source.
 *
 * Not a suppression list — an inventory, asserted to be exactly this. The
 * storefront header is `bg-white/10` over the HERO IMAGE in its transparent
 * state, and no static reading can say what colour a photograph is; its two
 * dropdowns, the theme toggle and the user menu render inside that same bar and
 * inherit the problem, and the favourite button sits on a product photo.
 *
 * Everything NOT on this list must resolve. That is the half that was missing:
 * the sweep used to drop every unresolved pair with `filter(surfaceKnown)`, so
 * a new component whose surface it could not read joined 150 others in silence
 * — the guarded count was 0 of 150. Now an unreadable surface in a new file
 * fails, and the fix is either to paint the surface in the same tree or to add
 * the file here with the reason.
 */
const SURFACE_PAINTED_ELSEWHERE = [
  "components/storefront/storefront-header.tsx",
  "components/storefront/user-menu.tsx",
  "components/storefront/language-selector-dropdown.tsx",
  "components/storefront/store-selector-dropdown.tsx",
  "components/storefront/theme-toggle.tsx",
  "components/website/favorite-button.tsx",
]

/**
 * Parsing and walking every `.tsx` in the app and two engine packages, twice.
 * Stated because `vitest.config.ts` would otherwise give a whole-tree sweep the
 * same budget as a unit test — the mistake this suite's sibling in
 * `packages/ui` was red for.
 */
const SWEEP_BUDGET_MS = 120_000

describe("WCAG 2.1 AA contrast", () => {
  const failures = scanContrast({
    appDir: process.cwd(),
    scopes: [".storefront-theme"],
    regions: REGIONS,
  })

  /**
   * Pairs whose surface no source can establish.
   *
   * This used to be `failures.filter(surfaceKnown)` and nothing else, which
   * made the exclusion unbounded: measured at `b9e20ea`, 150 failures were
   * reported and 150 were dropped — the guarded count was ZERO. Fifty-one of
   * them were the game screens on an opaque `#120d1a` and four the kitchen
   * display on `#0f172a`, both painted by a shell in another file and both now
   * declared in `REGIONS`; the rest were real, and among them
   * `inventory-page.tsx:303` at 1.109:1 and `status-badges.tsx:37` at 1.945:1.
   *
   * What is left is text over a photograph, which is not knowable and is not
   * pretended to be. It is pinned to a list of files instead of a boolean, so
   * a NEW unresolved surface fails rather than joining a silent pile.
   */
  const unresolved = failures.filter((failure) => !failure.surfaceKnown)
  const measured = failures.filter((failure) => failure.surfaceKnown)

  it("has no rendered pair below the floor, in either colour scheme", () => {
    expect(formatFailures(measured)).toBe("No pair below the WCAG 2.1 AA floor.")
  }, SWEEP_BUDGET_MS)

  it("resolves the surface of nearly every pair it measures", () => {
    /* The number that made the sweep look green while it was guarding
       nothing. At `b9e20ea` the failure list was 150 long and every single
       entry was dropped for an unresolved surface — the guarded count was 0.

       Counted over every pair the sweep RESOLVES rather than over the
       failures, because the failures are meant to be zero and a proportion of
       zero says nothing. `minimumRatio: 21` reports them all: nothing clears
       21:1 but black on white. */
    const everything = scanContrast({
      appDir: process.cwd(),
      scopes: [".storefront-theme"],
      regions: REGIONS,
      minimumRatio: 21,
    })
    const unknown = everything.filter((pair) => !pair.surfaceKnown)

    expect(everything.length).toBeGreaterThan(500)
    // 5.8% when this was written, all of it the storefront header and what
    // renders inside it. The bound is loose enough not to go red on one new
    // dropdown in that bar and tight enough that a return to dropping
    // everything cannot pass.
    expect(unknown.length / everything.length).toBeLessThan(0.08)
  }, SWEEP_BUDGET_MS)

  it("cannot read the surface of exactly the files that have none", () => {
    /* The whole point of the change. An unresolvable surface is a real
       category — `bg-white/10` over a hero PHOTOGRAPH has no colour a parser
       can name — but it has to be a NAMED category. A file that lands here
       without being on the list is either composed onto something the sweep
       should have been told about (add it to `REGIONS`) or painting itself
       from a shell that could paint it in the same tree. */
    const seen = [...new Set(unresolved.map((failure) => failure.file))].sort()

    expect(seen).toEqual([...SURFACE_PAINTED_ELSEWHERE].sort())
  }, SWEEP_BUDGET_MS)

  it("is actually looking at something", () => {
    // A scanner that resolves nothing reports no failures, which is the same
    // green as a product with no failures. The regions above cover several
    // hundred files and thousands of colour utilities; if this number
    // collapses, the sweep has stopped working rather than the product having
    // become perfect.
    const seen = scanContrast({
      appDir: process.cwd(),
      scopes: [".storefront-theme"],
      regions: REGIONS,
      // Nothing clears 21:1 except black on white, so this counts the pairs
      // the scanner actually resolved.
      minimumRatio: 21,
    })
    expect(seen.length).toBeGreaterThan(500)
  }, SWEEP_BUDGET_MS)

  it("resolves inline style pairs, not only className strings", () => {
    /**
     * THE INSTRUMENT GAP THIS GUARDS. `scanContrast` once read `className` and
     * nothing else, so an element that set its ink or its surface inline was
     * invisible to it. Demonstrated rather than argued: painting the onboarding
     * tour's badge `--primary` on `--primary` produced a pair measuring EXACTLY
     * 1.000:1 with every guard green.
     *
     * #446 closed it in the scanner — `style={{ … }}` is now read and merged
     * into the class reading, and a finding is named `style:color:…` rather
     * than after a class that does not exist. This counts what that resolves
     * out of the real tree, because a reader that silently stops reporting no
     * failures, which is the same green as a sound product.
     *
     * STILL NOT READ, and stated so nobody assumes otherwise: a `styles={{ … }}`
     * MAP handed to a third-party component — the shape the tour itself uses.
     * That needs the scanner to report several independent surfaces for one
     * element, which its current model does not express.
     */
    const resolved = scanContrast({
      appDir: process.cwd(),
      scopes: [".storefront-theme"],
      regions: REGIONS,
      // Nothing clears 21:1 but black on white, so this reports every pair the
      // scanner actually resolved rather than only the failing ones.
      minimumRatio: 21,
    }).filter(
      (failure) =>
        failure.foreground.startsWith("style:") || failure.background.startsWith("style:")
    )

    expect(resolved.length).toBeGreaterThan(0)
  }, SWEEP_BUDGET_MS)
})

/**
 * The scopes and schemes a token can be resolved under.
 *
 * `.storefront-theme` is consulted before `.dark` for the same reason the
 * markup sweep does it: the scope sits on a descendant element, so what it
 * declares beats what it would inherit.
 */
const SCOPES = [
  { label: "admin, light", mode: "light", scope: "" },
  { label: "admin, dark", mode: "dark", scope: "" },
  { label: "storefront, light", mode: "light", scope: ".storefront-theme" },
  { label: "storefront, dark", mode: "dark", scope: ".storefront-theme" },
] as const

/** Every label that has to be read on its own fill. */
const LABEL_ON_FILL: Array<[string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  ["accent-solid-foreground", "accent-solid"],
  ["foreground", "card"],
  ["foreground", "muted"],
  // The sidebar carries its own set, spelled as whole `hsl()` values rather
  // than triples, and it is the chrome an owner looks at all day.
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
]

/** Every token a word is written in, and the surfaces it is written on. */
const INK_ON_SURFACE = ["primary-ink", "destructive", "success", "warning", "info", "accent-solid"]
const SURFACES = ["background", "card", "muted"]

describe("the token matrix itself", () => {
  const tokens = loadTokens(process.cwd(), [
    ":root",
    ".dark",
    ".storefront-theme",
    ".dark .storefront-theme",
  ])

  const resolve = (mode: "light" | "dark", scope: string, name: string) => {
    const chain = scope
      ? mode === "dark"
        ? [`.dark ${scope}`, scope, ".dark"]
        : [scope, ":root"]
      : [mode === "dark" ? ".dark" : ":root"]
    for (const selector of chain) {
      const value = tokens.get(selector)?.get(name)
      if (value) return value
    }
    throw new Error(`no --${name} in ${mode}/${scope || ":root"}`)
  }

  it("clears AA before any markup is involved", () => {
    // Ten of these failed when #410 was raised, and none of them needed a
    // literal to do it: `--primary-foreground` on `--primary` was 2.85:1,
    // `--muted-foreground` on `--muted` was 4.42:1, and `--warning` was
    // 1.95:1 on `--muted` — below even the 3:1 an ICON needs.
    const below: string[] = []
    for (const { label, mode, scope } of SCOPES) {
      const check = (ink: string, surface: string) => {
        const ratio = contrast(resolve(mode, scope, ink), resolve(mode, scope, surface))
        if (ratio < AA_TEXT) below.push(`${label}: ${ratio.toFixed(2)}:1  --${ink} on --${surface}`)
      }
      for (const [ink, surface] of LABEL_ON_FILL) check(ink, surface)
      for (const ink of INK_ON_SURFACE) for (const surface of SURFACES) check(ink, surface)
    }
    expect(below).toEqual([])
  })

  it("separates every control from the page it sits on", () => {
    // WCAG 1.4.11: a non-text element that has to be seen needs 3:1. A focus
    // ring, a button fill and the boundary of an input are all of them.
    // `--border` is deliberately not here: it is a decorative separator, which
    // is why `--input` is a separate and lighter value in the dark storefront.
    const below: string[] = []
    for (const { label, mode, scope } of SCOPES) {
      for (const token of ["primary", "ring", "input", "accent-solid", "destructive"]) {
        const ratio = contrast(resolve(mode, scope, token), resolve(mode, scope, "background"))
        if (ratio < AA_LARGE) below.push(`${label}: ${ratio.toFixed(2)}:1  --${token} vs --background`)
      }
    }
    expect(below).toEqual([])
  })

  /**
   * The ring is measured above at FULL opacity. This is what makes that the
   * right thing to measure.
   *
   * `--ring` cleared 1.4.11 in all four scopes and the focus indicator still
   * did not, because every primitive rendered it as `focus-visible:ring-ring/50`
   * — shadcn's stylistic default, carried in unexamined. Half the token is not
   * half as visible: alpha composites toward the page, so 5.03:1 became 2.13:1
   * in the light admin, 7.83:1 became 2.61:1 in the dark one, and 7.63:1 became
   * 2.42:1 on the light storefront. Only the dark storefront cleared, at 3.09:1.
   * A keyboard user could not see where they were, on any screen, in any
   * template — `pizzeria` measured 2.10:1.
   *
   * The fix was to render the token the test already trusted, so this asserts
   * the two have not drifted apart again. Reach for a `/NN` on a focus ring and
   * the arithmetic above stops describing the product.
   *
   * SCOPE, AND WHY IT IS NOW THE WHOLE PRODUCT. This used to hold the DESIGN
   * SYSTEM only, and said so: the bespoke `<input className="…
   * focus:ring-primary/20">` written by hand in the checkout, the auth pages
   * and the affiliate portal were called "a separate population and a separate
   * job". They were 88 of them, and they measured 1.10–1.70:1 — worse than the
   * primitives this test was written to fix, on every field a diner types a
   * card into:
   *
   *   1.318:1  admin, light      ring-primary/20 on bg-muted
   *   1.149:1  admin, light      ring-primary/10 on bg-background
   *   1.505:1  storefront, dark  ring-primary/20 on bg-card
   *   1.696:1  apps/site, light  ring-primary/40 on --background
   *
   * And the guard could not see any of them, because its regex named ONE token
   * literal — `ring-ring/(\d+)`. Swapping `focus-visible:ring-ring` for
   * `focus-visible:ring-primary/20` on `Button.tsx` took the indicator to
   * 1.318:1 and this file stayed green. The pattern below now matches a faded
   * ring in ANY token, which is the property that was actually being asserted.
   *
   * `ring-destructive/NN` is the one exclusion, and it is the same one the
   * original carried: `aria-invalid:ring-destructive/20` is emphasis layered
   * over a full-opacity `border-destructive`, not the thing that says where the
   * keyboard is.
   */
  it("renders the focus ring at the opacity measured above", () => {
    const roots = [
      "node_modules/@be-yours/ui/src/components",
      "node_modules/@be-yours/admin/src",
      // The app's own trees. The primitives were never where the worst of it
      // was — these hand-written fields were.
      "app",
      "components",
    ]
    const faded: string[] = []
    const walk = (dir: string): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
        } else if (entry.name.endsWith(".tsx")) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, index) => {
              // The focus states only, and ANY token rather than one literal.
              // `aria-invalid:ring-destructive/20` is emphasis layered over a
              // full-opacity `border-destructive`, not the thing that says
              // where the keyboard is, so it stays out.
              const match = line.match(
                /(?:focus-visible|focus)\]?:ring-(?!destructive\/)([a-z-]+)\/(\d+)/
              )
              if (match) faded.push(`${path}:${index + 1} — ring-${match[1]}/${match[2]}`)
            })
        }
      }
    }
    for (const root of roots) walk(root)
    expect(faded).toEqual([])
  })
})
