// @vitest-environment jsdom

/**
 * The cart drawer as a dialog.
 *
 * It was a bare `<div>`: no `role`, no `aria-modal`, no focus trap, no Escape,
 * and — the part that reached every visitor — permanently rendered, merely
 * pushed off-screen with `translate-x-full`. Its seven buttons therefore sat in
 * the tab order of EVERY page. A keyboard user tabbing through the homepage
 * walked into an invisible cart, tabbed through "Tout vider" and "Commander",
 * and had no way to know where they were.
 *
 * It now renders through `components/ui/sheet.tsx`, the repository's own Radix
 * wrapper, which was sitting unused. The first test is the one that matters
 * most: closed, the drawer contributes nothing to the page behind it.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS = [
  {
    lineId: "line_1",
    productId: "prod_1",
    name: "Pizza Regina",
    price: 1200,
    quantity: 2,
    options: [],
    imageUrl: undefined,
  },
]

vi.mock("@be-yours/restaurant", () => ({
  /* The collector's emitter moved into this package with the collector; a
     component that adds to the cart now imports it from here, so a partial
     mock has to carry it or the import throws. It is a no-op in a test: the
     real one is inert until a mounted collector registers an emitter. */
  recordSignal: () => {},
  useCartStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: ITEMS,
      updateQuantity: () => {},
      removeItem: () => {},
      clearCart: () => {},
      getSubtotal: () => 2400,
      getItemCount: () => 2,
    }),
  formatPrice: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mount(open: boolean, onOpenChange: (next: boolean) => void = () => {}) {
  const { CartSheet } = await import("@/components/storefront/cart-sheet")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<CartSheet open={open} onOpenChange={onOpenChange} />)
  })
  return { container, root }
}

/** Everything a Tab press could land on, anywhere in the document. */
function tabbable(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((el) => !el.hasAttribute("disabled"))
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

describe("closed", () => {
  test("contributes nothing to the tab order of the page behind it", async () => {
    await mount(false)

    expect(tabbable()).toHaveLength(0)
  })

  test("is absent from the accessibility tree entirely", async () => {
    await mount(false)

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Tout vider")
  })
})

describe("open", () => {
  test("is a modal dialog with a name and a description", async () => {
    await mount(true)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel.getAttribute("aria-modal")).toBe("true")

    const name = document.getElementById(panel.getAttribute("aria-labelledby")!)
    const description = document.getElementById(
      panel.getAttribute("aria-describedby")!
    )
    expect(name?.textContent).toBe("cart.boxTitleFull")
    expect(description?.textContent).toContain("cart.itemsSelected")
  })

  test("moves focus onto the close button rather than the first tooltip trigger", async () => {
    await mount(true)

    // Focusing "Tout vider" would open its tooltip, and the tooltip — being the
    // topmost dismissable layer — would swallow the first Escape.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fermer la Box")
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  test("closes on the first Escape", async () => {
    let closed = false
    await mount(true, (next) => {
      if (!next) closed = true
    })

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    })

    expect(closed).toBe(true)
  })

  test("hides the rest of the document from assistive technology", async () => {
    const outside = document.createElement("main")
    outside.textContent = "Le menu"
    document.body.appendChild(outside)

    await mount(true)

    expect(outside.getAttribute("aria-hidden")).toBe("true")
    outside.remove()
  })

  test("keeps the slide animation the drawer was designed with", async () => {
    await mount(true)

    const panel = dialog()
    // Radix drives the animation off `data-state`; without it the classes below
    // never trigger and the drawer would appear and vanish instantly.
    expect(panel.getAttribute("data-state")).toBe("open")
    expect(panel.className).toContain("data-[state=open]:slide-in-from-right")
    expect(panel.className).toContain("data-[state=closed]:slide-out-to-right")
  })

  test("keeps the drawer's own shape rather than the primitive's default", async () => {
    await mount(true)

    const panel = dialog()
    expect(panel.className).toContain("rounded-l-[3rem]")
    expect(panel.className).toContain("sm:max-w-md")
  })
})
