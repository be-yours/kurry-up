// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The checkout never lands a diner on a payment tile the deployment cannot
 * serve (#374).
 *
 * The form used to hardcode card as the `useState` default with a second
 * inline fallback that also resolved to card. On a fresh deployment — cash
 * enabled, no card provider keyed — every card submit failed, so the natural
 * first journey was a failed card attempt retried as cash, which is the
 * method-switch deadlock. The rule now comes from `resolvePaymentMethod`
 * fed by the server's `paymentAvailability.get`; this test pins the WIRING —
 * that the rendered form actually consults the availability answer — the
 * rule itself is pinned in `@be-yours/restaurant`'s own suite.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Answers the two queries the form makes; set per test. */
const state = vi.hoisted(() => ({
  settings: undefined as unknown,
  availability: undefined as unknown,
}))

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server")
  return {
    useQuery: (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name === "paymentAvailability:get") return state.availability
      if (name === "globalSettings:get") return state.settings
      return undefined
    },
  }
})

vi.mock("@/hooks/useGooglePlacesAutocomplete", () => ({
  useGooglePlacesAutocomplete: () => ({ inputRef: { current: null } }),
}))

const ALL_SERVICES = {
  dineIn: true,
  takeaway: true,
  delivery: true,
  clickAndCollect: true,
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  state.settings = undefined
  state.availability = undefined
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mountCheckoutForm(options: {
  isAuthenticated: boolean
  /** What the page hands the form for a guest who needs an account. */
  signInAction?: React.ReactNode
  onSubmit?: (data: unknown) => void
}) {
  const { CheckoutForm } = await import("@/components/storefront/checkout-form")
  const { useCartStore } = await import("@be-yours/restaurant")
  act(() => {
    useCartStore.getState().setOrderType("pickup")
  })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(
      <CheckoutForm
        onSubmit={options.onSubmit ?? (() => {})}
        isSubmitting={false}
        addresses={[]}
        isAuthenticated={options.isAuthenticated}
        services={ALL_SERVICES}
        signInAction={options.signInAction}
      />
    )
  })
  return container
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  for (const button of Array.from(container.querySelectorAll("button"))) {
    if (button.textContent?.includes(text)) return button
  }
  return null
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[type="submit"]')
  if (!button) throw new Error("no submit button rendered")
  return button as HTMLButtonElement
}

describe("payment tile pre-selection", () => {
  test("a deployment that can take a card keeps the card-first default", async () => {
    state.settings = {
      payments: { cardProvider: "stripe", paypal: false, cash: true },
    }
    state.availability = { card: true }

    const container = await mountCheckoutForm({ isAuthenticated: true })

    expect(submitButton(container).textContent).toContain("Payer par carte")
    expect(buttonByText(container, "Carte bancaire")?.disabled).toBe(false)
  })

  test("a fresh deployment — cash on, no card provider — lands the diner on Espèces", async () => {
    state.settings = {
      payments: { cardProvider: "stripe", paypal: false, cash: true },
    }
    state.availability = { card: false }

    const container = await mountCheckoutForm({ isAuthenticated: true })

    // Card is visible but not servable: disabled, and says why.
    const card = buttonByText(container, "Carte bancaire")
    expect(card?.disabled).toBe(true)
    expect(card?.textContent).toContain("Indisponible pour le moment")

    // The effective method is the tile that works: submit reads as cash.
    expect(submitButton(container).textContent).toContain("Confirmer la commande")
  })

  /**
   * REWRITTEN. This case asserted a disabled button reading « Choisissez un
   * moyen de paiement » and stopped there — it pinned the dead end in place.
   * Refusing a doomed submit is right and is still asserted; telling a guest
   * to choose from a grid with nothing choosable in it is not. On a cash-only
   * establishment this is not an edge case, it is every guest checkout (#376).
   */
  test("no servable method refuses the submit AND tells the diner what to do", async () => {
    // Card dead, cash present but the diner is not signed in — submitting
    // card anyway is exactly the #374 journey.
    state.settings = {
      payments: { cardProvider: "stripe", paypal: false, cash: true },
    }
    state.availability = { card: false }

    const signIn = <button type="button">Se connecter</button>
    const container = await mountCheckoutForm({
      isAuthenticated: false,
      signInAction: signIn,
    })

    const submit = submitButton(container)
    expect(submit.disabled).toBe(true)
    // The button no longer asks for a choice that does not exist.
    expect(submit.textContent).not.toContain("Choisissez un moyen de paiement")
    expect(submit.textContent).toContain("Connectez-vous pour continuer")

    // And the way out is on the screen, where the diner is blocked.
    const notice = container.querySelector('[role="alert"]')
    expect(notice?.textContent).toContain("espèces")
    expect(buttonByText(container, "Se connecter")).not.toBeNull()
  })
})

/**
 * A cash-only establishment — the food truck, one of the five verticals this
 * engine is sold for.
 *
 * `payments.cardProvider` was a `stripe | sumup` union with no way to say
 * "we do not take cards", and the checkout rendered the card tile
 * unconditionally. So the tile could only ever be greyed out under
 * « Indisponible pour le moment » — which reads as a fault that might clear —
 * and never removed (#376).
 */
describe("an establishment that does not take cards", () => {
  test("renders no card tile at all", async () => {
    state.settings = {
      payments: { cardProvider: "none", paypal: false, cash: true },
    }
    state.availability = { card: false, cardOffered: false }

    const container = await mountCheckoutForm({ isAuthenticated: true })

    expect(buttonByText(container, "Carte bancaire")).toBeNull()
    // Not "unavailable for the moment": there is nothing to come back for.
    expect(container.textContent).not.toContain("Indisponible pour le moment")
    // And the diner lands on the tile that works.
    expect(submitButton(container).textContent).toContain(
      "Confirmer la commande"
    )
  })

  test("gives a guest a way through rather than a dead end", async () => {
    state.settings = {
      payments: { cardProvider: "none", paypal: false, cash: true },
    }
    state.availability = { card: false, cardOffered: false }

    const container = await mountCheckoutForm({
      isAuthenticated: false,
      signInAction: <button type="button">Se connecter</button>,
    })

    expect(buttonByText(container, "Carte bancaire")).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Connectez-vous"
    )
    expect(buttonByText(container, "Se connecter")).not.toBeNull()
  })

  test("says so plainly when nothing at all is on offer", async () => {
    // Cards off, cash off, PayPal off. Nothing a diner can do about it — but
    // they are owed the reason instead of a disabled button.
    state.settings = {
      payments: { cardProvider: "none", paypal: false, cash: false },
    }
    state.availability = { card: false, cardOffered: false }

    const container = await mountCheckoutForm({ isAuthenticated: true })

    const submit = submitButton(container)
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toContain("Aucun paiement disponible")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Contactez le restaurant"
    )
  })

  test("a deployment that only lost its keys still greys the tile", async () => {
    // The distinction that makes the tile's absence meaningful: this owner
    // does mean to take cards, and the tile stays, greyed and explained.
    state.settings = {
      payments: { cardProvider: "stripe", paypal: false, cash: true },
    }
    state.availability = { card: false, cardOffered: true }

    const container = await mountCheckoutForm({ isAuthenticated: true })

    const card = buttonByText(container, "Carte bancaire")
    expect(card).not.toBeNull()
    expect(card?.disabled).toBe(true)
    expect(card?.textContent).toContain("Indisponible pour le moment")
  })
})
