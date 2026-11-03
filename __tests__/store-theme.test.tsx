// @vitest-environment jsdom

/**
 * An establishment's colours, on the page a diner reads.
 *
 * THE DEFECT. `/dashboard/design` wrote `stores.branding.primaryColor` and
 * nothing read it back. `--primary` had exactly one definition per app — the
 * literal `24 95% 53%` in `app/globals.css` — so every establishment the
 * engine has ever delivered shipped the same orange, and the theme picker on a
 * product sold as "a theme by restaurant type" changed nothing at all.
 *
 * These tests hold the reading half shut. `packages/ui/src/__tests__/
 * branding.test.ts` holds the derivation; this file is about the component
 * that puts it on the page, and about the two states that had to be right for
 * it to be worth having: the server-rendered starting point, and the switch to
 * whichever establishment the visitor is actually browsing.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** What `useStoreId` will answer. Set per test. */
let resolvedStore: { _id: string; branding?: unknown } | null = null

vi.mock("@/lib/hooks/use-store-id", () => ({
  useStoreId: () => ({
    storeId: resolvedStore?._id ?? null,
    store: resolvedStore,
    isLoading: false,
  }),
}))

const { StoreTheme } = await import("@/components/storefront/store-theme")

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  resolvedStore = null
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  return container
}

const styleOf = (container: HTMLElement): string | null =>
  container.querySelector("style[data-store-theme]")?.textContent ?? null

describe("StoreTheme", () => {
  test("paints the establishment's primary onto the storefront", async () => {
    resolvedStore = { _id: "store_1", branding: { primaryColor: "#d32f2f" } }

    const css = styleOf(await render(<StoreTheme />))

    // `.storefront-theme` beside `:root`, because that is the element the
    // storefront palette is declared on and a custom property declared on an
    // element beats the one it would inherit. Without it these tokens stopped
    // at `<html>` and the diner's page stayed engine green: measured in
    // Chromium, `#d32f2f` gave `rgb(211, 49, 49)` in the admin and
    // `rgb(13, 94, 64)` on the storefront. #410.
    expect(css).toContain(":root,.storefront-theme{")
    expect(css).toContain(".dark,.dark .storefront-theme{")
    expect(css).toContain("--primary:0 65% 51%;")
    // The whole point, stated as the assertion it deserves: what the page
    // paints with is no longer the engine's orange.
    expect(css).not.toContain("24 95% 53%")
  })

  test("renders nothing at all for an establishment that set no colours", async () => {
    resolvedStore = { _id: "store_1", branding: {} }

    // Not an empty <style>: no element. An establishment that never opened the
    // Design screen must be byte-for-byte the site it was before this existed.
    expect(styleOf(await render(<StoreTheme />))).toBeNull()
    expect(styleOf(await render(<StoreTheme />))).toBeNull()
  })

  test("keeps a legacy branding blob from breaking the page", async () => {
    // `stores.branding` is `v.any()` and a deployment may hold anything. A
    // shape this code has never seen must produce no stylesheet, not a throw
    // inside the storefront layout.
    for (const branding of [null, "orange", 42, ["#fff"], { logoUrl: "/l.png" }]) {
      resolvedStore = { _id: "store_1", branding }
      expect(styleOf(await render(<StoreTheme />)), JSON.stringify(branding)).toBeNull()
    }
  })

  test("shows the server's answer until the client query resolves", async () => {
    // `useQuery` has nothing during the server render and nothing before the
    // first round trip. Without this the visitor watches the engine orange
    // repaint into the establishment's red a moment after the page appears.
    resolvedStore = null
    const initialCss = ":root{--primary:0 65% 51%;}"

    expect(styleOf(await render(<StoreTheme initialCss={initialCss} />))).toBe(initialCss)
  })

  test("follows the visitor to the establishment they picked", async () => {
    // The storefront is multi-store and the choice lives in the browser, so
    // the server's starting point is the wrong palette for a visitor who has
    // switched. It has to lose to the resolved store.
    resolvedStore = { _id: "store_lyon", branding: { primaryColor: "#1a237e" } }

    const css = styleOf(await render(<StoreTheme initialCss=":root{--primary:0 65% 51%;}" />))

    expect(css).toContain("--primary:235 66% 30%;")
    expect(css).not.toContain("0 65% 51%")
  })

  test("drops the server's answer when the resolved store has no branding", async () => {
    // The mirror of the case above, and the one a naive `??` gets wrong: an
    // unbranded Lyon must not inherit Paris's palette from the server render.
    resolvedStore = { _id: "store_lyon", branding: {} }

    expect(styleOf(await render(<StoreTheme initialCss=":root{--primary:0 65% 51%;}" />))).toBeNull()
  })

  test("carries a hostile stored value into no CSS at all", async () => {
    // `stores.updateBranding` validates a string and a length, not grammar, so
    // this is a value the mutation accepts and stores. It reaches a <style>
    // through `dangerouslySetInnerHTML`, which is only safe because nothing
    // interpolates it.
    resolvedStore = {
      _id: "store_1",
      branding: {
        primaryColor: "#fff;}body{display:none}",
        fontBody: 'Inter"; } html { display: none } x { font: "y',
      },
    }

    expect(styleOf(await render(<StoreTheme />))).toBeNull()
  })

  test("sets the typography variables the stylesheet reads", async () => {
    // `globals.css` resolves its font utilities through
    // `var(--brand-font-body, var(--font-inter))`. Emitting any other name
    // would be a typography tab that saves and shows nothing.
    resolvedStore = { _id: "store_1", branding: { fontHeading: "Playfair Display" } }

    expect(styleOf(await render(<StoreTheme />))).toContain(
      '--brand-font-heading:"Playfair Display";'
    )
  })
})
