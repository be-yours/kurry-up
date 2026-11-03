// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The two status badges mounted on the storefront speak the diner's language.
 *
 * WHAT WENT WRONG (#376, item 4): `OrderStatusBadge` and `StoreStatusBadge` in
 * `@be-yours/ui` carried eleven hardcoded English labels between them and
 * took no label from outside. Both are mounted on French screens — the store
 * selector and the diner's own order page — so a customer picking a location
 * read « Temporarily Unavailable » under a French heading, and the translation
 * layer #148 shipped could not reach either word.
 *
 * The vocabulary and the fallback are pinned in `@be-yours/core`; the
 * badge's own behaviour in `@be-yours/ui`. This pins the WIRING, which is
 * the half that was missing: that the mounted screen actually resolves the
 * labels through `t()` and hands them to the badge. Delete the `labels` prop
 * at either call site and this file goes red.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The store list the selector renders; set per test. */
const state = vi.hoisted(() => ({ stores: undefined as unknown }))

vi.mock("convex/react", () => ({
  useQuery: () => state.stores,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const STORES = [
  {
    _id: "store_open",
    name: "Pizzeria Napoli",
    status: "open",
    address: {
      street: "12 rue de la Paix",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  },
  {
    _id: "store_paused",
    name: "Pizzeria Lyon",
    status: "temporarily_unavailable",
    address: {
      street: "3 rue Mercière",
      city: "Lyon",
      postalCode: "69002",
      country: "France",
    },
  },
]

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  state.stores = STORES
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

/** Put the language store back to the state a fresh storefront starts in. */
async function resetLanguage() {
  const { useLanguageStore } = await import("@be-yours/restaurant")
  act(() => {
    useLanguageStore.setState({
      locale: "fr",
      defaultLocale: "fr",
      availableLanguages: [],
      overrides: {},
      staticStrings: new Map(),
      isReady: false,
    })
  })
}

async function mountStoreSelector(): Promise<HTMLElement> {
  const { default: StoreSelectorContent } = await import(
    "@/app/(storefront)/store-selector/_components/StoreSelectorContent"
  )
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<StoreSelectorContent />)
  })
  return container
}

/**
 * The same status, on the panel in the header — mounted on EVERY storefront
 * page, unlike the selector page above.
 *
 * Radix keeps the popover's contents out of the tree until it is opened, so
 * the trigger has to be clicked before there is anything to read.
 */
async function openHeaderStorePanel(): Promise<void> {
  const { StoreSelectorDropdown } = await import(
    "@/components/storefront/store-selector-dropdown"
  )
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<StoreSelectorDropdown />)
  })
  await act(async () => {
    container
      .querySelector("button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("the store selector's status badge", () => {
  test("reads French on a French storefront, not English", async () => {
    await resetLanguage()

    const container = await mountStoreSelector()

    expect(container.textContent).toContain("Ouvert")
    expect(container.textContent).toContain("Temporairement indisponible")
    // The exact words a diner used to read between French sentences.
    expect(container.textContent).not.toContain("Open")
    expect(container.textContent).not.toContain("Temporarily Unavailable")
  })

  test("follows the language the diner chose", async () => {
    await resetLanguage()
    const { useLanguageStore } = await import("@be-yours/restaurant")

    act(() => {
      useLanguageStore.setState({
        locale: "es",
        defaultLocale: "fr",
        availableLanguages: [
          {
            code: "es",
            name: "Espagnol",
            nativeName: "Español",
            isDefault: false,
            isActive: true,
          },
        ],
        staticStrings: new Map([
          [
            "es",
            {
              "store.openNow": "Abierto",
              "storefront.storeTempUnavailable": "Temporalmente no disponible",
            },
          ],
        ]),
        isReady: true,
      })
    })

    const container = await mountStoreSelector()

    expect(container.textContent).toContain("Abierto")
    expect(container.textContent).toContain("Temporalmente no disponible")
    expect(container.textContent).not.toContain("Ouvert")
  })

  test("a restaurateur's own wording beats the catalogue", async () => {
    await resetLanguage()
    const { useLanguageStore } = await import("@be-yours/restaurant")

    act(() => {
      useLanguageStore.setState({
        locale: "fr",
        defaultLocale: "fr",
        availableLanguages: [
          {
            code: "fr",
            name: "Français",
            nativeName: "Français",
            isDefault: true,
            isActive: true,
          },
        ],
        staticStrings: new Map([[
          "fr",
          { "store.openNow": "Ouvert" },
        ]]),
        // The manual override is the owner correcting the machine, and it must
        // reach the badge like any other string.
        overrides: { fr: { "store.openNow": "Service en cours" } },
        isReady: true,
      })
    })

    const container = await mountStoreSelector()

    expect(container.textContent).toContain("Service en cours")
  })
})

/**
 * The header's store panel, and WCAG 1.4.1.
 *
 * WHAT WENT WRONG: this panel is mounted in the storefront header on every
 * page, and the ONLY thing distinguishing a location that is taking orders
 * from one that is not was the fill of a 6px dot — `bg-primary` against
 * `bg-muted-foreground`. No word, no shape, no accessible name: a diner who
 * cannot separate those two colours picked a restaurant with no way of knowing
 * it was shut. Its sibling, the full store-selector page above, has printed
 * the word all along; the two surfaces answer the same question and only one
 * of them answered it.
 *
 * The dot kept its colour and gained the word beside it, from the same
 * vocabulary and the same `t()` the page uses.
 */
describe("the header store panel's status", () => {
  test("prints the status as a word, not only as a coloured dot", async () => {
    await resetLanguage()

    await openHeaderStorePanel()

    expect(document.body.textContent).toContain("Pizzeria Napoli")
    expect(document.body.textContent).toContain("Ouvert")
    expect(document.body.textContent).toContain("Temporairement indisponible")
  })

  test("follows the language the diner chose, like the page does", async () => {
    await resetLanguage()
    const { useLanguageStore } = await import("@be-yours/restaurant")

    act(() => {
      useLanguageStore.setState({
        locale: "es",
        defaultLocale: "fr",
        availableLanguages: [
          {
            code: "es",
            name: "Espagnol",
            nativeName: "Español",
            isDefault: false,
            isActive: true,
          },
        ],
        staticStrings: new Map([
          [
            "es",
            {
              "store.openNow": "Abierto",
              "storefront.storeTempUnavailable": "Temporalmente no disponible",
            },
          ],
        ]),
        isReady: true,
      })
    })

    await openHeaderStorePanel()

    expect(document.body.textContent).toContain("Abierto")
    expect(document.body.textContent).toContain("Temporalmente no disponible")
  })
})
