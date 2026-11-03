// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * A diner can tell the kitchen about an allergy.
 *
 * WHAT WENT WRONG (#376, item 1): every part of this pipeline existed except
 * the input. `orders.create` takes `notes`; the order carries it;
 * `releaseToKitchen` copies it onto the ticket as `deliveryNotes`; the printed
 * slip has a line for it. `grep -c notes checkout-form.tsx` answered 0 — in
 * BOTH apps, byte-identically — so the line was always blank and a diner with
 * a nut allergy had no way to say so. Food safety, not convenience.
 *
 * This pins the field and what it hands the page: the value the page submits
 * is the value that goes to `orders.create`, which is the value the kitchen
 * ticket prints. The server half — the cap, and the note surviving onto the
 * ticket — is pinned in `@be-yours/convex-functions`; the printed and
 * on-screen tickets in `@be-yours/admin`.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FIELD_LIMITS } from "@be-yours/convex-functions/rateLimit"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  state.settings = {
    payments: { cardProvider: "stripe", paypal: false, cash: false },
  }
  state.availability = { card: true, cardOffered: true }
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

interface SubmittedOrder {
  name: string
  notes?: string
}

async function mountCheckoutForm(): Promise<{
  container: HTMLElement
  submitted: SubmittedOrder[]
}> {
  const { CheckoutForm } = await import("@/components/storefront/checkout-form")
  const { useCartStore } = await import("@be-yours/restaurant")
  act(() => {
    useCartStore.getState().setOrderType("pickup")
  })

  const submitted: SubmittedOrder[] = []
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(
      <CheckoutForm
        onSubmit={(data) => submitted.push(data as SubmittedOrder)}
        isSubmitting={false}
        addresses={[]}
        isAuthenticated
        services={ALL_SERVICES}
      />
    )
  })
  return { container, submitted }
}

/** Type into a controlled input the way React's own listener sees it. */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

function field<T extends HTMLElement>(container: HTMLElement, id: string): T {
  const element = container.querySelector(`#${id}`)
  if (!element) throw new Error(`no #${id} rendered`)
  return element as T
}

async function submitForm(container: HTMLElement) {
  const form = container.querySelector("form")
  if (!form) throw new Error("no form rendered")
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

describe("the note to the kitchen", () => {
  test("exists, and says what it is for", async () => {
    const { container } = await mountCheckoutForm()

    const notes = field<HTMLTextAreaElement>(container, "notes")
    expect(notes.tagName).toBe("TEXTAREA")
    // The word that matters: a diner scanning the page for where to declare an
    // allergy has to find it.
    expect(container.textContent).toContain("Allergies")
    expect(notes.getAttribute("placeholder")).toContain("allergie")
  })

  test("reaches the page, which is what reaches orders.create", async () => {
    const { container, submitted } = await mountCheckoutForm()

    setValue(field<HTMLInputElement>(container, "name"), "Jean Dupont")
    setValue(
      field<HTMLTextAreaElement>(container, "notes"),
      "Allergie aux arachides"
    )
    await submitForm(container)

    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.notes).toBe("Allergie aux arachides")
  })

  test("is optional — an empty note is absent, not an empty line", async () => {
    const { container, submitted } = await mountCheckoutForm()

    setValue(field<HTMLInputElement>(container, "name"), "Jean Dupont")
    setValue(field<HTMLTextAreaElement>(container, "notes"), "   ")
    await submitForm(container)

    expect(submitted).toHaveLength(1)
    // A `Note:` heading over three spaces is noise on a kitchen slip.
    expect(submitted[0]?.notes).toBeUndefined()
  })

  test("cannot outgrow what the server stores", async () => {
    // The cap comes from `FIELD_LIMITS`, so the input and `orders.create`
    // cannot disagree — a longer note would be refused at the moment of
    // payment, which is the worst possible place to discover it.
    const { container } = await mountCheckoutForm()

    const notes = field<HTMLTextAreaElement>(container, "notes")
    expect(notes.getAttribute("maxlength")).toBe(String(FIELD_LIMITS.orderNote))
  })
})
