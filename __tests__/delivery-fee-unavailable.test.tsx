// @vitest-environment jsdom

/**
 * An address we cannot price says so, instead of promising a price later.
 *
 * WHAT WAS BROKEN. `deliveryFee: null` carried two meanings — "the quote has
 * not come back yet" and "there is no way to work this out" — and the summary
 * printed the optimistic one for both: « Calculée à la validation ». The
 * second case is an address with no coordinates (saved before quoting existed,
 * or typed over the autocomplete instead of chosen from it), and at validation
 * the order is refused with « merci de resaisir votre adresse ». So the
 * customer was told to carry on, filled in the rest of the form, and was
 * stopped at the last click by a problem the page had already detected.
 *
 * The checkout page now sets `quoteError` the moment it finds an address it
 * cannot price, and passes `deliveryFeeUnavailable` here so this line stops
 * contradicting the error printed underneath it.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS = [
  {
    productId: "prod_1",
    name: "Pizza Regina",
    price: 1200,
    quantity: 1,
    options: [] as Array<{ choice: string; priceModifier: number }>,
    imageUrl: undefined,
    taxRate: undefined,
  },
]

// The basket and the order type come off the Zustand store, not from props —
// only the delivery fee is passed in, which is the whole subject here.
vi.mock("@be-yours/restaurant", () => ({
  /* The collector's emitter moved into this package with the collector; a
     component that adds to the cart now imports it from here, so a partial
     mock has to carry it or the import throws. It is a no-op in a test: the
     real one is inert until a mounted collector registers an emitter. */
  recordSignal: () => {},
  useCartStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: ITEMS,
      orderType: "delivery",
      getSubtotal: () => 1200,
      getItemCount: () => 1,
    }),
  formatPrice: (cents: number) =>
    `${(cents / 100).toFixed(2).replace(".", ",")} €`,
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { OrderSummary } from "@/components/storefront/order-summary"

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function render(props: Record<string, unknown>): string {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root!.render(<OrderSummary {...(props as any)} />)
  })
  return host.textContent ?? ""
}

describe("the delivery line of the order summary", () => {
  test("asks for an address before one has been entered", () => {
    const text = render({ hasDeliveryAddress: false, deliveryFee: null })
    expect(text).toContain("Renseignez votre adresse")
  })

  test("promises a later calculation only while one is still possible", () => {
    // An address is in, the quote simply has not landed. This is the case the
    // optimistic wording was written for, and it keeps it.
    const text = render({ hasDeliveryAddress: true, deliveryFee: null })
    expect(text).toContain("Calculée à la validation")
  })

  test("says the address needs work when the fee cannot be worked out", () => {
    const text = render({
      hasDeliveryAddress: true,
      deliveryFee: null,
      deliveryFeeUnavailable: true,
    })
    expect(text).not.toContain("Calculée à la validation")
    expect(text).toContain("À préciser")
  })

  test("shows the fee once there is one, whatever else went wrong earlier", () => {
    const text = render({
      hasDeliveryAddress: true,
      deliveryFee: 350,
      deliveryFeeUnavailable: true,
    })
    expect(text).toContain("3,50 €")
    expect(text).not.toContain("À préciser")
  })
})
