// @vitest-environment jsdom

/**
 * The basket page must not tell a customer their basket is empty before it has
 * read it back.
 *
 * The cart is persisted, and persistence is not instant: zustand reads
 * localStorage after mount, and React serves the *server* snapshot — an empty
 * basket — for the whole hydration render. `CartContent` read `items.length` in
 * that render and, finding nothing, rendered the full-screen "Votre Box est
 * vide" hero. A customer who reloaded `/cart` or arrived from a bookmark got a
 * dead-end screen over a basket that was about to appear.
 *
 * `useCartHydrated` exists for exactly this and documents the failure mode. It
 * had been applied to `/checkout`, twice, and to neither read here.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Flipped per test to stand in for "localStorage has been read back". */
let hydrated = false
/** The basket localStorage holds. Present from the first render, as it is. */
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
let items: typeof ITEMS = []

vi.mock("@be-yours/restaurant", () => ({
  /* The collector's emitter moved into this package with the collector; a
     component that adds to the cart now imports it from here, so a partial
     mock has to carry it or the import throws. It is a no-op in a test: the
     real one is inert until a mounted collector registers an emitter. */
  recordSignal: () => {},
  useCartHydrated: () => hydrated,
  useCartStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items,
      orderType: "pickup",
      updateQuantity: () => {},
      removeItem: () => {},
      clearCart: () => {},
      setOrderType: () => {},
      getSubtotal: () => items.reduce((sum, i) => sum + i.price * i.quantity, 0),
      getItemCount: () => items.reduce((sum, i) => sum + i.quantity, 0),
    }),
  formatPrice: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/hooks/use-store-id", () => ({
  useStoreId: () => ({ storeId: "stores:1", isLoading: false }),
}))

vi.mock("@/lib/hooks/use-store-status", () => ({
  useStoreStatus: () => ({
    isOpen: true,
    services: {
      dineIn: true,
      takeaway: true,
      delivery: true,
      clickAndCollect: true,
    },
  }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
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

beforeEach(() => {
  hydrated = false
  items = []
})

async function render() {
  const { default: CartContent } = await import(
    "../app/(storefront)/cart/_components/CartContent"
  )
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<CartContent />)
  })
  return container
}

describe("the basket page before the persisted cart arrives", () => {
  test("says nothing at all", async () => {
    // Not "your basket is empty" — nothing. The screen it would otherwise show
    // is a dead end with a "Parcourir le menu" button on it.
    const container = await render()

    expect(container.textContent).toBe("")
  })

  test("shows the empty state once hydration says the basket really is empty", async () => {
    hydrated = true
    items = []

    const container = await render()

    expect(container.textContent).toContain("Votre Box est vide")
  })

  test("shows the basket once hydration brings it back", async () => {
    hydrated = true
    items = ITEMS

    const container = await render()

    expect(container.textContent).toContain("Pizza Regina")
    expect(container.textContent).not.toContain("Votre Box est vide")
  })
})
