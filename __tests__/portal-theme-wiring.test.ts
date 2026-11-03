/**
 * The shop names its surface, and names the one the stylesheet paints.
 *
 * `packages/ui` holds the mechanism — a portalled overlay carries the class its
 * provider names, and carries none without one. Nothing held the two ends of it
 * in this app: remove `<PortalThemeProvider>` from the shell and every one of
 * those tests still passes, while the cart sheet goes back to inheriting
 * `:root` — the administration's palette — on the last screen before paying.
 *
 * Measured in Chromium against this app's own stylesheet before the fix, on a
 * `.storefront-theme` div and on a body-level sibling of it: 9 of the 11 tokens
 * `.storefront-theme` declares resolved to the dashboard's values, `--primary`
 * 24 95% 37% where the shop had 158 75% 21%. That figure is left here as the
 * measurement rather than asserted, because it moves whenever either palette is
 * tuned and the guard below is about the wiring, not about the colours.
 *
 * Read from source on purpose. Rendering the shell would need `useStoreId`,
 * `useStoreStatus`, the i18n provider and the favicon effect mocked, and would
 * then prove the provider is mounted in a tree nobody ships. What matters is
 * cheaper and more durable: the shell says `storefront-theme`, and
 * `globals.css` declares the palette on exactly that selector.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(__dirname, "..")
const SHELL = join(ROOT, "components/storefront/storefront-shell.tsx")
const GLOBALS = join(ROOT, "app/globals.css")

const SURFACE = "storefront-theme"

/** Declarations of the first block for `selector`, as a name → value map. */
function tokensOf(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const open = new RegExp(`^[ \\t]*${escaped}[ \\t]*\\{`, "m").exec(css)
  if (!open) return {}
  let i = open.index + open[0].length
  let depth = 1
  let body = ""
  while (i < css.length && depth > 0) {
    const c = css[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (!depth) break
    }
    body += c
    i++
  }
  const out: Record<string, string> = {}
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[d[1] as string] = (d[2] as string).trim()
  }
  return out
}

describe("the storefront names the surface its overlays belong to", () => {
  const shell = readFileSync(SHELL, "utf8")
  const css = readFileSync(GLOBALS, "utf8")

  it("wraps the shell in a provider", () => {
    expect(shell).toMatch(/<PortalThemeProvider\b/)
    expect(shell).toMatch(/<\/PortalThemeProvider>/)
  })

  it("names the class the stylesheet paints, not some other string", () => {
    const named = /<PortalThemeProvider[^>]*className="([^"]+)"/.exec(shell)
    expect(named, "the provider is mounted without a className").not.toBeNull()
    expect(named?.[1]).toBe(SURFACE)

    // The div the shell renders carries it too — the provider names a surface
    // that exists rather than one it invented.
    expect(shell).toMatch(new RegExp(`className="${SURFACE}\\s`))
  })

  it("imports it from the one specifier the design system is reached through", () => {
    // `design-system-singularity` refuses `@be-yours/ui/components` and the
    // other subpaths; this catches the same thing at the point of use.
    expect(shell).toMatch(
      /import \{[^}]*\bPortalThemeProvider\b[^}]*\} from "@be-yours\/ui"/
    )
  })

  it("is a surface the stylesheet actually declares a palette on", () => {
    const surface = tokensOf(css, `.${SURFACE}`)
    const root = tokensOf(css, ":root")

    // Anti-vacuity: a guard that passes over a stylesheet declaring nothing
    // would be worth nothing, and the regex above is the kind that can quietly
    // stop matching.
    expect(Object.keys(surface).length).toBeGreaterThanOrEqual(9)
    expect(Object.keys(root).length).toBeGreaterThanOrEqual(9)
    expect(surface["--primary"]).toBeDefined()

    // And it is a DIFFERENT palette from the one a portalled element would
    // inherit without the class. If these ever converge the fix stops mattering
    // — which is a thing to discover here rather than in a shop.
    const differing = Object.keys(surface).filter(
      (t) => root[t] !== undefined && root[t] !== surface[t]
    )
    expect(differing.length).toBeGreaterThan(0)
    expect(differing).toContain("--primary")
  })
})
