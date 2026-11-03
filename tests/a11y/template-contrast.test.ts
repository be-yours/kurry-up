/**
 * Every palette a client is actually sold, measured.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `contrast.test.ts`. That sweep reads
 * `app/globals.css` and nothing else, so it measures the engine's default
 * palette — the one NO delivered site runs. `app/layout.tsx` imports
 * `./globals.css` and then `@/site/theme.css`, and `pnpm template:apply <slug>`
 * overwrites that second file from `templates/<slug>/theme.css`: 45 to 53 token
 * overrides, chosen at clone time, one of the 51 verticals under `templates/`.
 * Every one of those overrides is invisible to a sweep of `globals.css`.
 *
 * WHAT IT FOUND ON THE DAY IT WAS WRITTEN. 50 of the 51 templates carried at
 * least one pair below the WCAG 2.1 AA floor. The dominant defect was one
 * mistake copied 50 times: every template set `--input` to the same value as
 * `--border`, which is exactly the defect `app/globals.css:126-135` had already
 * found and fixed for the engine, in a comment that says why — "the product
 * was, to a low-vision user, a rectangle that was not there". `--input` is the
 * boundary of every form field (`Input.tsx:12`), so every delivered site had
 * form fields whose edge was not there: 1.09:1 on `food-truck-tacoloco`,
 * 1.21:1 on `asiatique-bambou`, against the 3:1 WCAG 1.4.11 asks of a control.
 * Under it sat a quieter band of marginal misses — `--muted-foreground` at
 * 3.37:1 and a cluster of semantic inks at 4.32–4.49 — all of them on `--muted`.
 *
 * `templates/README.md` claimed "AA contrast verified: every palette passes
 * WCAG AA". Nothing measured it. This is what makes that sentence true, and it
 * is why the sentence now points here.
 *
 * WHAT IT DID NOT DO, AND NOW DOES. This file used to be the token matrix
 * ONLY, and said so: running `scanContrast` 51 times "would re-parse every
 * `.tsx` in the app once per template, which is minutes of CI", so the markup
 * was swept once under the default palette and "a pair that fails only for a
 * class combination unique to one template would fall between the two".
 *
 * That gap was the whole product. Measured with the argument wired through:
 * 49 of the 51 templates rendered at least one pair below AA, 272 pairs in
 * all, and the two guards were green for every one of them —
 * `pnpm template:apply asiatique-dragon` produced a site with 12 failing
 * pairs and a passing suite. The token matrix could not see them because a
 * failing pair is a COMBINATION (`text-primary` on `bg-muted`) that only the
 * markup names; the markup sweep could not see them because it read
 * `globals.css` and no template.
 *
 * The cost was also wrong. Measured: 28 seconds for all 51, not minutes — the
 * TypeScript parse dominates and it is the same parse each time.
 *
 * The two halves are still both here and both needed: the matrix catches a
 * token pair nothing happens to render TODAY, the sweep catches a combination
 * no matrix enumerates.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AA_LARGE, AA_TEXT, contrast, type Rgb } from "@be-yours/ui/contrast"
import { formatFailures, loadTokens, scanContrast } from "@be-yours/ui/contrast-scan"

/** The four token scopes a delivered site renders under. */
const SCOPES = [
  { label: "admin, light", mode: "light", scope: "" },
  { label: "admin, dark", mode: "dark", scope: "" },
  { label: "storefront, light", mode: "light", scope: ".storefront-theme" },
  { label: "storefront, dark", mode: "dark", scope: ".storefront-theme" },
] as const

/**
 * The same matrix `contrast.test.ts` holds the engine palette to.
 *
 * Kept as its own copy deliberately: this file has to keep measuring what a
 * client receives even if the engine's own list is narrowed, and a shared
 * constant that one of the two callers quietly shrinks is how a guard stops
 * guarding without anything going red.
 */
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
]
const INK_ON_SURFACE = ["primary-ink", "destructive", "success", "warning", "info", "accent-solid"]
const SURFACES = ["background", "card", "muted"]
/** WCAG 1.4.11: a control that has to be seen needs 3:1, text or not. */
const NON_TEXT = ["primary", "ring", "input", "accent-solid", "destructive"]

const SELECTORS = [":root", ".dark", ".storefront-theme", ".dark .storefront-theme"]

const TEMPLATES = readdirSync("templates")
  .filter((slug) => existsSync(join("templates", slug, "theme.css")))
  .sort()

/**
 * Every AA failure one palette produces, as readable rows.
 *
 * `dir` is relative to `templates/`, so a slug names a catalogue entry and
 * `../site` names the client zone the app actually imports.
 */
function failuresFor(dir: string): string[] {
  const slug = dir === join("..", "site") ? "site/theme.css" : dir
  // The real cascade: globals first, then the overlay, exactly as
  // `app/layout.tsx` imports them.
  const tokens = loadTokens(process.cwd(), SELECTORS, [join("templates", dir, "theme.css")])

  // A scope selector sits on a DESCENDANT element, so what it declares beats
  // what it would inherit — the same chain the engine sweep resolves through.
  const resolve = (mode: string, scope: string, name: string): Rgb | null => {
    const chain = scope
      ? mode === "dark"
        ? [`.dark ${scope}`, scope, ".dark"]
        : [scope, ":root"]
      : [mode === "dark" ? ".dark" : ":root"]
    for (const selector of chain) {
      const value = tokens.get(selector)?.get(name)
      if (value) return value
    }
    return null
  }

  const rows: string[] = []
  for (const { label, mode, scope } of SCOPES) {
    const check = (ink: string, surface: string, floor: number) => {
      const a = resolve(mode, scope, ink)
      const b = resolve(mode, scope, surface)
      // A token neither the template nor globals declares in this scope is not
      // a failure; `contrast.test.ts` is what holds the engine's own set whole.
      if (!a || !b) return
      const ratio = contrast(a, b)
      if (ratio >= floor) return
      rows.push(
        `${slug} — ${label}: ${ratio.toFixed(2)}:1 (needs ${floor})  --${ink} on --${surface}`
      )
    }
    for (const [ink, surface] of LABEL_ON_FILL) check(ink, surface, AA_TEXT)
    for (const ink of INK_ON_SURFACE) for (const surface of SURFACES) check(ink, surface, AA_TEXT)
    for (const token of NON_TEXT) check(token, "background", AA_LARGE)
  }
  return rows
}

describe("every shipped template palette", () => {
  it("clears WCAG 2.1 AA in all four scopes", () => {
    const below = TEMPLATES.flatMap(failuresFor)
    expect(below).toEqual([])
  })

  /**
   * And the file the app actually imports.
   *
   * `templates/<slug>/theme.css` is the SOURCE; `site/theme.css` is the copy
   * `pnpm template:apply` writes and `app/layout.tsx` imports, and it is the
   * CLIENT ZONE — the one stylesheet a client is invited to hand-edit, which a
   * template update deliberately never overwrites. So it can drift from every
   * template in the catalogue and be the only palette anybody renders. In a
   * cloned client repository this assertion is the whole of this file that
   * matters: it measures that client's own colours.
   */
  it("clears it for site/theme.css, which is what layout.tsx imports", () => {
    expect(existsSync("site/theme.css")).toBe(true)
    expect(failuresFor(join("..", "site"))).toEqual([])
  })

  it("is actually looking at all 51 of them", () => {
    // A sweep that has stopped resolving templates reports no failures, which
    // reads as the same green as 51 sound palettes. Both halves are asserted:
    // that the directory is still being enumerated, and that a token actually
    // came back for each one.
    expect(TEMPLATES.length).toBe(51)
    for (const slug of TEMPLATES) {
      const tokens = loadTokens(process.cwd(), SELECTORS, [join("templates", slug, "theme.css")])
      expect(tokens.get(":root")?.size ?? 0).toBeGreaterThan(20)
    }
  })

  it("reads the template's value and not the engine's", () => {
    // The overlay is the whole point of this file: if `loadTokens` ever stops
    // applying it, every assertion above silently re-measures `globals.css` 51
    // times and passes. `asiatique-bambou` sets a green `--primary` where the
    // engine ships orange, so the two cannot be confused.
    const withTemplate = loadTokens(process.cwd(), SELECTORS, [
      join("templates", "asiatique-bambou", "theme.css"),
    ])
    const engineOnly = loadTokens(process.cwd(), SELECTORS)
    expect(withTemplate.get(":root")?.get("primary")).not.toEqual(
      engineOnly.get(":root")?.get("primary")
    )
  })
})

/**
 * A surface a shell paints, read from the shell rather than typed out.
 *
 * Same function and same reasoning as `contrast.test.ts`: a hex copied into a
 * test goes stale silently, in the direction of passing.
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

/**
 * The token scope each tree renders under — the same list `contrast.test.ts`
 * uses, because it is the same application. Kept as its own copy for the same
 * reason `LABEL_ON_FILL` is: a shared constant that one caller quietly narrows
 * is how a guard stops guarding without anything going red.
 *
 * IT HAD DRIFTED, AND THE DRIFT WAS THE WHOLE DEFECT. Not one entry here
 * declared a `surface`, while the sibling declared seven — so every file whose
 * background is painted by a shell in another file came back
 * `surfaceKnown: false` and `filter(f => f.surfaceKnown)` threw it away.
 * Measured on `asiatique-dragon`: this list resolved 1251 of 2116 pairs and
 * guarded 0 of 72 failures; the sibling's resolved 1994 of 2116 and guarded 3
 * of 15. A sweep of all 51 palettes that discards 40.9% of what it measures is
 * not a sweep.
 *
 * The three entries with a specific surface have to come BEFORE the general
 * `app`/`components` ones, and that ordering is not cosmetic either: first
 * region to claim a file wins it, so without them the eleven QR-game screens
 * and the kitchen display — both designed for a near-black ground — are
 * measured against a near-white page. Copying only the five
 * `surface: "background"` lines produced 2946 failures, almost all of them that
 * mistake.
 */
const REGIONS = [
  // The trees a scope wraps come first: a file is measured once, under the
  // scope of whichever region claims it.
  { dir: "app/(storefront)", scope: ".storefront-theme" },
  { dir: "components/storefront", scope: ".storefront-theme" },
  { dir: "components/website", scope: ".storefront-theme" },
  { dir: "app/(auth)", scope: ".storefront-theme" },
  // The two trees whose background is painted by a shell in another file.
  { dir: "node_modules/@be-yours/admin/src/game", scope: "", surface: GAME_ARENA },
  { dir: "app/display", scope: "", surface: KITCHEN_DISPLAY },
  // One FILE: `block-preview.tsx` draws an EMAIL, which lands on its own white
  // ground whatever the admin's colour scheme is.
  {
    dir: "node_modules/@be-yours/admin/src/pages/email/templates/block-preview.tsx",
    scope: "",
    surface: "#ffffff",
  },
  // Then everything else this app renders, on the admin page background.
  { dir: "app", scope: "", surface: "background" },
  { dir: "components", scope: "", surface: "background" },
  { dir: "lib", scope: "", surface: "background" },
  { dir: "node_modules/@be-yours/ui/src", scope: "", surface: "background" },
  { dir: "node_modules/@be-yours/admin/src", scope: "", surface: "background" },
]

/** 28 seconds measured for all 51; the ceiling is a stall detector. */
const CATALOGUE_BUDGET_MS = 300_000

const sweep = (overlays: string[]) =>
  scanContrast({
    appDir: process.cwd(),
    scopes: [".storefront-theme"],
    regions: REGIONS,
    overlays,
  })

/**
 * Hand the event loop back between templates.
 *
 * WHY A SWEEP HAS TO YIELD. 51 `scanContrast` calls in one test body is 29
 * seconds of uninterrupted synchronous work on a warm laptop and upwards of
 * three minutes on a CI runner. Vitest's worker talks to the main process over
 * an RPC to report progress, and a body that never yields never lets that call
 * be serviced — so the run ends
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * with EVERY test passing and the job red. Measured: 1711 passed, 1 unhandled
 * error, exit 1, on a runner where the same suite takes 6.8x its local time.
 *
 * A macrotask between templates costs nothing measurable and is the whole fix:
 * the worker gets to answer, and the sweep still runs to completion. Do not
 * collapse this back into a synchronous `flatMap` — it reads tidier and it is
 * how the job goes red without a single failing assertion.
 */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("every shipped template, as the app actually renders it", () => {
  it("has no rendered pair below the floor, under any of the 51 palettes", async () => {
    const below: string[] = []
    for (const slug of TEMPLATES) {
      // `surfaceKnown: false` is excluded here for the same reason it is in
      // `contrast.test.ts`: no static reading can say what colour an image is.
      below.push(
        ...sweep([join("templates", slug, "theme.css")])
          .filter((failure) => failure.surfaceKnown)
          .map((failure) => `${slug} — ${failure.file}:${failure.line} ` +
            `${failure.ratio.toFixed(3)}:1 (needs ${failure.floor}) ` +
            `${failure.foreground} on ${failure.background} [${failure.scope || "admin"}/${failure.mode}]`)
      )
      await yieldToLoop()
    }
    expect(below).toEqual([])
  }, CATALOGUE_BUDGET_MS)

  it("and under site/theme.css, which is the file layout.tsx imports", () => {
    // In THIS repository `site/theme.css` is comment-only, so this measures the
    // engine default — which is exactly the palette no client runs, and is why
    // the assertion above exists. In a cloned client repository it is the only
    // one of the two that matters: it measures that client's own colours.
    expect(existsSync("site/theme.css")).toBe(true)
    expect(formatFailures(sweep(["site/theme.css"]).filter((f) => f.surfaceKnown)))
      .toBe("No pair below the WCAG 2.1 AA floor.")
  }, CATALOGUE_BUDGET_MS)

  it("is actually resolving a template's tokens, not re-reading the default", () => {
    // The overlay is the whole point. If `scanContrast` ever stops applying it,
    // every assertion above silently measures `globals.css` 51 times and
    // passes — which is precisely the state this file was in before.
    // `asiatique-bambou` ships a green `--primary` where the engine ships
    // orange, so a sweep that resolved the template cannot report the same
    // pairs as one that did not.
    const seen = (overlays: string[]) =>
      new Set(
        scanContrast({
          appDir: process.cwd(),
          scopes: [".storefront-theme"],
          regions: REGIONS,
          overlays,
          // Nothing clears 21:1 but black on white, so this reports every pair
          // the scanner resolved, with the colour it resolved it to.
          minimumRatio: 21,
        }).map((f) => `${f.file}:${f.line}|${f.foregroundHex}|${f.backgroundHex}`)
      )
    const withTemplate = seen([join("templates", "asiatique-bambou", "theme.css")])
    const engineOnly = seen([])
    expect(engineOnly.size).toBeGreaterThan(500)
    expect(withTemplate).not.toEqual(engineOnly)
  }, CATALOGUE_BUDGET_MS)
})
