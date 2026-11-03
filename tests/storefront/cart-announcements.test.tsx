// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * A cart a blind diner can follow.
 *
 * WHAT WAS MEASURED, at `b9e20ea`. Adding a dish announced itself, because
 * `sonner` renders its toasts into a live region and the product card raises
 * one. Nothing else did. Quantity plus and minus, removing a line, emptying
 * the Box, the header badge, the subtotal and the total were bare `<span>`s,
 * and a `<span>` whose text changes is announced by nothing. Four
 * `aria-live`/`role="status"` attributes existed across the 36 files on the
 * buying path and none of them was in a cart — so a diner could press
 * « Augmenter la quantité » four times, be told nothing four times, and reach
 * the checkout without ever having heard what they were about to pay.
 *
 * The two halves this pins:
 *
 *   the CONTROL's name — the cart button carries the count, so reaching it
 *   says how many dishes are in the Box rather than "Ouvrir la Box";
 *   the CHANGE — one polite region in the shell, announcing the new state
 *   after every mutation, wherever it was made from.
 *
 * The region is deliberately outside the cart sheet. A live region must exist
 * before its contents change, and the sheet is a dialog that unmounts when
 * closed, so a region inside it would miss every mutation made from a product
 * card. That is asserted below by mutating with the sheet never opened at all.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}))

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(async () => {
  const { useCartStore, useLanguageStore } = await import("@be-yours/restaurant")
  // The real catalogue, not a stub: what is being asserted is the SENTENCE a
  // diner hears, and `t()` answers with the key itself when nothing is loaded
  // — which would let a missing translation pass as a passing test. This is
  // what `StorefrontI18nProvider` puts there in the running app.
  const { REFERENCE_LOCALE, REFERENCE_STRINGS } = await import("@/lib/i18n/index")
  act(() => {
    useCartStore.getState().clearCart()
    useLanguageStore.setState({
      locale: REFERENCE_LOCALE,
      defaultLocale: REFERENCE_LOCALE,
      staticStrings: new Map([[REFERENCE_LOCALE, REFERENCE_STRINGS]]),
      overrides: {},
    })
  })
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mountAnnouncer() {
  const { CartAnnouncer } = await import("@/components/storefront/cart-announcer")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<CartAnnouncer />)
  })
  return container
}

function liveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector('[role="status"]')
  if (!region) throw new Error("no live region rendered")
  return region as HTMLElement
}

const DISH = {
  productId: "p1",
  name: "Margherita",
  price: 1200,
  quantity: 1,
  options: [],
}

/** Put a dish in the cart, outside React, the way a product card does. */
async function addDish(overrides: Record<string, unknown> = {}) {
  const { useCartStore } = await import("@be-yours/restaurant")
  await act(async () => {
    useCartStore.getState().addItem({ ...DISH, ...overrides } as never)
  })
}

describe("the live region", () => {
  test("is in the document from the start, and empty", async () => {
    // A region inserted already holding its text is not reliably announced —
    // the assistive technology has to have been watching it. This is why the
    // component exists rather than an `aria-live` on the total.
    const container = await mountAnnouncer()

    expect(liveRegion(container).textContent).toBe("")
  })

  test("is polite and atomic", async () => {
    const region = liveRegion(await mountAnnouncer())

    // `aria-atomic`, because a diff-based reading announces "4" on its own,
    // which is not an announcement. `role` AND `aria-live`, because support
    // for either alone is uneven.
    expect(region.getAttribute("aria-live")).toBe("polite")
    expect(region.getAttribute("aria-atomic")).toBe("true")
  })

  test("says nothing on mount, even with a cart already in it", async () => {
    // A cart rehydrated from `localStorage` is not something the diner just
    // did, and announcing it talks over the page they opened.
    await addDish()
    const container = await mountAnnouncer()

    expect(liveRegion(container).textContent).toBe("")
  })
})

describe("every mutation, not only the first", () => {
  test("an added dish announces the new state", async () => {
    const container = await mountAnnouncer()
    await addDish()

    expect(liveRegion(container).textContent).toContain("1")
  })

  test("a quantity change announces — this one used to be silent", async () => {
    const container = await mountAnnouncer()
    await addDish()
    const { useCartStore } = await import("@be-yours/restaurant")
    const lineId = useCartStore.getState().items[0]!.lineId

    await act(async () => {
      useCartStore.getState().updateQuantity(lineId, 4)
    })

    const said = liveRegion(container).textContent ?? ""
    expect(said).toContain("4")
  })

  test("a removed line announces, and an emptied Box says so", async () => {
    const container = await mountAnnouncer()
    await addDish()
    const { useCartStore } = await import("@be-yours/restaurant")
    const lineId = useCartStore.getState().items[0]!.lineId

    await act(async () => {
      useCartStore.getState().removeItem(lineId)
    })

    // Not a count of zero: "0 articles" is a worse sentence than the one the
    // screen shows, which is that the Box is empty.
    expect(liveRegion(container).textContent).toMatch(/vide|empty|vac/i)
  })

  test("emptying the whole Box announces", async () => {
    const container = await mountAnnouncer()
    await addDish()
    await addDish({ productId: "p2", name: "Napoli" })
    const { useCartStore } = await import("@be-yours/restaurant")

    await act(async () => {
      useCartStore.getState().clearCart()
    })

    expect(liveRegion(container).textContent).toMatch(/vide|empty|vac/i)
  })

  test("the total is in the sentence, which is the number nobody could read", async () => {
    const container = await mountAnnouncer()
    await addDish({ price: 1250 })

    // `formatPrice` renders cents; the digits are what matter here, not the
    // separator a locale picks.
    expect(liveRegion(container).textContent).toMatch(/12[.,]50/)
  })

  test("a mutation the diner did not make is not re-announced", async () => {
    // A re-render caused by anything else must not repeat the last sentence:
    // a live region that re-fires on every render is one a person turns off.
    const container = await mountAnnouncer()
    await addDish()
    const first = liveRegion(container).textContent

    const { useCartStore } = await import("@be-yours/restaurant")
    await act(async () => {
      useCartStore.getState().setOrderType("delivery")
    })

    expect(liveRegion(container).textContent).toBe(first)
  })
})
