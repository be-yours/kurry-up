import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * A template must repaint the shop, not only the dashboard (#41).
 *
 * WHAT GOES WRONG. `app/globals.css` declares the storefront's palette on
 * `.storefront-theme` — a `<div>` in `components/storefront/storefront-shell.tsx`,
 * not on `<html>`. A custom property declared ON an element beats the one it
 * would have INHERITED, whatever the layer and whatever the specificity. So a
 * theme that writes `--primary` on `:root` alone recolours the admin and the
 * sign-in pages and leaves the shop the engine's green — which is the whole of
 * what #41 asked for ("after which the templates genuinely recolour the
 * storefront"), and the same defect #410 found one layer down in `StoreTheme`.
 *
 * `scripts/gen-templates.mjs` emits the pair, so the 50 generated templates are
 * right. `templates/default/theme.css` is written by hand — it is the file a
 * client edits after `pnpm template:apply`, and it is what `site/theme.css`
 * starts as — and it taught `:root` alone in its worked example for as long as
 * it existed. Nothing measured either way.
 *
 * So this reads the token list out of `globals.css` rather than restating it:
 * the rule is "a token `.storefront-theme` itself declares must not be set on
 * `:root` alone", and a token added to that block is covered on the same commit.
 */

const APP_ROOT = path.resolve(__dirname, "..")
const GLOBALS = path.join(APP_ROOT, "app/globals.css")
const TEMPLATES_DIR = path.join(APP_ROOT, "templates")
const APPLIED_THEME = path.join(APP_ROOT, "site/theme.css")

/** The storefront shell's own class, as `globals.css` spells it. */
const SHELL_SELECTOR = ".storefront-theme"

/**
 * CSS with every comment removed.
 *
 * Load-bearing, not tidiness: `templates/default/theme.css` is ENTIRELY a
 * comment, and its worked example is a `:root { … }` block. Parsed with comments
 * left in, the documentation reads as a declaration and the file fails its own
 * rule — or, worse, a real declaration hides inside a comment and passes.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

/** Every `selector { body }` rule at the top level of a stylesheet. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const [, selector = "", body = ""] = match
    found.push({ selector: selector.trim(), body })
  }
  return found
}

/** The custom properties a rule body sets. */
function declaredTokens(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/gi)]
    .map((m) => m[1])
    .filter((token): token is string => token !== undefined)
}

/**
 * The tokens the storefront shell declares for itself — the ones a `:root`-only
 * override cannot reach.
 */
function storefrontTokens(): Set<string> {
  const css = withoutComments(fs.readFileSync(GLOBALS, "utf8"))
  const tokens = new Set<string>()
  for (const rule of rules(css)) {
    // `.storefront-theme` and `.dark .storefront-theme`, and nothing that merely
    // mentions the class inside a longer descendant chain of something else.
    const selectors = rule.selector.split(",").map((s) => s.trim())
    if (!selectors.some((s) => s === SHELL_SELECTOR || s === `.dark ${SHELL_SELECTOR}`)) {
      continue
    }
    for (const token of declaredTokens(rule.body)) tokens.add(token)
  }
  return tokens
}

/** Does this selector list reach the storefront shell? */
function reachesShell(selector: string): boolean {
  return selector
    .split(",")
    .some((part) => part.trim().split(/\s+/).includes(SHELL_SELECTOR))
}

interface Offence {
  file: string
  selector: string
  tokens: string[]
}

/** Every rule in `file` that paints a shop token somewhere the shop cannot see. */
function offences(file: string, shopTokens: Set<string>): Offence[] {
  const css = withoutComments(fs.readFileSync(file, "utf8"))
  const relative = path.relative(APP_ROOT, file)
  const found: Offence[] = []
  for (const rule of rules(css)) {
    if (reachesShell(rule.selector)) continue
    const missed = declaredTokens(rule.body).filter((token) => shopTokens.has(token))
    if (missed.length > 0) {
      found.push({ file: relative, selector: rule.selector, tokens: missed })
    }
  }
  return found
}

const themeFiles = [
  ...fs
    .readdirSync(TEMPLATES_DIR)
    .map((slug) => path.join(TEMPLATES_DIR, slug, "theme.css"))
    .filter((file) => fs.existsSync(file)),
  APPLIED_THEME,
]

describe("a template repaints the shop, not only the dashboard", () => {
  test("the rule has tokens to enforce, read from globals.css", () => {
    const tokens = storefrontTokens()

    // Anti-vacuity. An empty set would make every assertion below pass on a
    // stylesheet that paints nothing correctly.
    expect(tokens.size).toBeGreaterThan(8)
    expect(tokens).toContain("--primary")
    expect(tokens).toContain("--background")
    expect(tokens).toContain("--ring")
  })

  test("there is a catalogue to check, and an applied theme beside it", () => {
    expect(themeFiles.length).toBeGreaterThanOrEqual(50)
    expect(themeFiles).toContain(APPLIED_THEME)
  })

  test("the scan finds real declarations — it is not matching an empty file set", () => {
    const shopTokens = storefrontTokens()
    const scoped = themeFiles.filter((file) => {
      const css = withoutComments(fs.readFileSync(file, "utf8"))
      return rules(css).some(
        (rule) =>
          reachesShell(rule.selector) &&
          declaredTokens(rule.body).some((token) => shopTokens.has(token))
      )
    })

    // The generated catalogue: 50 templates that do declare shop tokens under
    // the shell selector. If this drops, the parser stopped reading CSS and
    // every other test in this file went quiet rather than green.
    expect(scoped.length).toBeGreaterThanOrEqual(50)
  })

  test("no theme paints a shop token where the shop cannot see it", () => {
    const shopTokens = storefrontTokens()
    const broken = themeFiles.flatMap((file) => offences(file, shopTokens))

    expect(
      broken.map((o) => `${o.file} — ${o.selector} sets ${o.tokens.join(", ")}`)
    ).toEqual([])
  })

  test("the hand-written default teaches the pair rather than :root alone", () => {
    // The generated templates cannot regress — `gen-templates.mjs` writes the
    // selector. This one is prose a human edits, and it is what `site/theme.css`
    // starts life as, so its EXAMPLE is what a client copies.
    const source = fs.readFileSync(path.join(TEMPLATES_DIR, "default/theme.css"), "utf8")

    expect(source).toContain(":root,\n *   .storefront-theme {")
    expect(source).toContain(".dark,\n *   .dark .storefront-theme {")
  })
})
