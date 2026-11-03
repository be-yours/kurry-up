// @vitest-environment jsdom

/**
 * Choosing an option on a configurable dish.
 *
 * Two defects, one structure. The choice row was a `<div onClick>` and the
 * radio was a `<div>` drawn to look like one: no `input`, no `role`, no
 * `tabIndex`, no key handler. A keyboard or screen-reader user could not select
 * a REQUIRED option, so `handleAddToCart` refused them every time — the dish
 * was not merely awkward to configure, it was impossible to buy.
 *
 * The multi-select row was worse than unusable, it was silently wrong. The
 * native `<Checkbox>`'s `onCheckedChange` AND the parent row's `onClick` both
 * fired on one click, toggling twice, and a single click on a clean checkbox
 * produced `[]`.
 *
 * The fix is one control per choice, wrapped in a `<label>`: the row is
 * clickable because the label is, not because a second handler says so. These
 * tests read the selection through the cart, which is the only place it becomes
 * observable — and the only place that matters.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const added: Array<{ options: Array<{ name: string; choice: string }> }> = []
const errors: string[] = []

vi.mock("@be-yours/restaurant", () => ({
  /* The collector's emitter moved into this package with the collector; a
     component that adds to the cart now imports it from here, so a partial
     mock has to carry it or the import throws. It is a no-op in a test: the
     real one is inert until a mounted collector registers an emitter. */
  recordSignal: () => {},
  useCartStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      addItem: (item: { options: Array<{ name: string; choice: string }> }) =>
        added.push(item),
      storeId: "store_1",
    }),
  formatPrice: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  calculateProductPrice: (base: number) => base,
  isProductAvailable: () => true,
  useLocalizedDocument: <T,>(doc: T) => doc,
}))

vi.mock("@/lib/hooks/use-favorites", () => ({
  useFavorites: () => ({ isFavorite: () => false, toggleFavorite: () => {} }),
}))

vi.mock("@/lib/hooks/use-store-status", () => ({
  useStoreStatus: () => ({ isOpen: true }),
}))

vi.mock("sonner", () => ({
  toast: {
    success: () => {},
    error: (message: string) => errors.push(message),
  },
}))

const PRODUCT = {
  _id: "prod_1",
  name: "Pizza Regina",
  price: 1200,
  taxRate: 10,
  categoryId: "cat_1",
  images: [],
  options: [
    {
      id: "opt_size",
      name: "Taille",
      required: true,
      maxSelections: 1,
      choices: [
        { id: "small", name: "Petite", priceModifier: 0 },
        { id: "large", name: "Grande", priceModifier: 300 },
      ],
    },
    {
      id: "opt_extra",
      name: "Suppléments",
      required: false,
      maxSelections: 2,
      choices: [
        { id: "olives", name: "Olives", priceModifier: 100 },
        { id: "basil", name: "Basilic", priceModifier: 50 },
        { id: "ham", name: "Jambon", priceModifier: 200 },
      ],
    },
  ],
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  added.length = 0
  errors.length = 0
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mount() {
  const { ProductDetailClient } = await import(
    "@/components/storefront/product-detail-client"
  )
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<ProductDetailClient product={PRODUCT as never} storeId="store_1" />)
  })
  return container
}

function controls(container: HTMLElement, type: "radio" | "checkbox") {
  return [...container.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)]
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

/** The options the cart received, after a successful add. */
async function addToCart(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ajouter")
  )!
  await click(button)
  return added[0]?.options.map((o) => `${o.name}:${o.choice}`) ?? null
}

describe("option groups are real controls", () => {
  test("each choice is an input a keyboard can reach", async () => {
    const container = await mount()

    expect(controls(container, "radio")).toHaveLength(2)
    expect(controls(container, "checkbox")).toHaveLength(3)

    // `sr-only` hides them visually; it must not take them out of the tab
    // order, which is the whole point of using a real input.
    for (const input of controls(container, "radio")) {
      expect(input.tabIndex).toBe(0)
    }
  })

  test("the group carries its name, its hint and its requirement", async () => {
    const container = await mount()

    const radiogroup = container.querySelector('[role="radiogroup"]')!
    const name = document.getElementById(radiogroup.getAttribute("aria-labelledby")!)
    const hint = document.getElementById(radiogroup.getAttribute("aria-describedby")!)

    expect(name?.textContent).toContain("Taille")
    expect(hint?.textContent).toBe("Choisir 1")
    expect(radiogroup.getAttribute("aria-required")).toBe("true")

    // Multi-select is a group, not a radiogroup, and is not required here.
    const group = container.querySelector('[role="group"]')!
    expect(
      document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent
    ).toContain("Suppléments")
    expect(group.getAttribute("aria-required")).toBeNull()
  })

  test("the radios of one option share a name, so arrow keys move within it", async () => {
    const container = await mount()

    const names = new Set(controls(container, "radio").map((r) => r.name))
    expect(names.size).toBe(1)
    // Checkboxes are independent and must NOT be grouped by name.
    expect(controls(container, "checkbox").every((c) => c.name === "")).toBe(true)
  })

  test("every choice control is labelled by its own row", async () => {
    const container = await mount()

    for (const input of [
      ...controls(container, "radio"),
      ...controls(container, "checkbox"),
    ]) {
      expect(input.closest("label")).not.toBeNull()
    }
  })
})

describe("selecting", () => {
  test("one click on a checkbox selects that option — it does not cancel itself", async () => {
    const container = await mount()

    // Measured before the fix: a single click on the clean checkbox yielded [].
    await click(controls(container, "checkbox")[0]!)
    await click(controls(container, "radio")[0]!)

    expect(await addToCart(container)).toEqual([
      "Taille:Petite",
      "Suppléments:Olives",
    ])
  })

  test("a second click on the same checkbox clears it", async () => {
    const container = await mount()

    await click(controls(container, "checkbox")[0]!)
    await click(controls(container, "checkbox")[0]!)
    await click(controls(container, "radio")[0]!)

    expect(await addToCart(container)).toEqual(["Taille:Petite"])
  })

  test("clicking the row selects the option exactly once", async () => {
    const container = await mount()

    // The label is the row, so this is what a click anywhere on the row does.
    await click(controls(container, "checkbox")[0]!.closest("label")!)
    await click(controls(container, "radio")[1]!)

    expect(await addToCart(container)).toEqual([
      "Taille:Grande",
      "Suppléments:Olives",
    ])
  })

  test("a radio replaces the previous choice instead of adding to it", async () => {
    const container = await mount()

    await click(controls(container, "radio")[0]!)
    await click(controls(container, "radio")[1]!)

    expect(await addToCart(container)).toEqual(["Taille:Grande"])
  })

  test("the multi-select stops at maxSelections", async () => {
    const container = await mount()

    await click(controls(container, "radio")[0]!)
    await click(controls(container, "checkbox")[0]!)
    await click(controls(container, "checkbox")[1]!)

    // Two is the limit, so the third is disabled rather than silently ignored.
    expect(controls(container, "checkbox")[2]!.disabled).toBe(true)

    expect(await addToCart(container)).toEqual([
      "Taille:Petite",
      "Suppléments:Olives",
      "Suppléments:Basilic",
    ])
  })
})

describe("a required option that was not chosen", () => {
  test("blocks the add and sends the customer to the choice", async () => {
    const container = await mount()

    expect(await addToCart(container)).toBeNull()
    expect(errors).toEqual(["Veuillez sélectionner : Taille"])
    // A toast is enough for a mouse. A keyboard user is left at the bottom of
    // the page with no idea where "Taille" is unless focus goes there.
    expect(document.activeElement).toBe(controls(container, "radio")[0])
  })
})
