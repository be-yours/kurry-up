// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * A saved address has to keep the point it was geocoded to.
 *
 * `AddressManager` built its payload field by field and simply never listed
 * `latitude`/`longitude`, so the autocomplete's coordinates were read into
 * state, shown, and then dropped on save. Everything downstream was ready for
 * them: the schema stores them, the hook forwards them, and the checkout quotes
 * Uber Direct from `dropoffLatitude`/`dropoffLongitude` and from nothing else.
 *
 * The consequence was money, not tidiness. The same address produced a
 * different delivery fee depending on where the customer had entered it —
 * typed at checkout it quoted; picked from the address book it could not quote
 * at all, because the effect that requests the quote returns early when either
 * coordinate is undefined.
 *
 * The read-back below goes through the real Convex mutation, so it asserts what
 * is in the database rather than what was passed to a spy.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { convexTest, type TestConvex } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IDENTITY = {
  subject: "user_alpha",
  issuer: "https://test",
  tokenIdentifier: "test|user_alpha",
}

/** What the autocomplete returns for 12 rue de la Paix, Paris. */
const PICKED = {
  street: "12 rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  country: "France",
  latitude: 48.8692,
  longitude: 2.3312,
}

/** The concrete schema, so `t.run` callbacks see the real tables. */
type Harness = TestConvex<typeof schema>

let harness: Harness | null = null
const inFlight: Array<Promise<unknown>> = []

/** The callback the autocomplete would invoke when a suggestion is picked. */
let onSelect: ((parsed: typeof PICKED) => void) | null = null

vi.mock("@/hooks/useGooglePlacesAutocomplete", () => ({
  useGooglePlacesAutocomplete: (opts: { onSelect: (p: typeof PICKED) => void }) => {
    onSelect = opts.onSelect
    return { inputRef: { current: null } }
  },
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user_alpha" } } }) },
}))

/**
 * `useAddresses`' authenticated branch, pointed at a real database.
 *
 * Mirrors the real hook's mapping exactly, so the test exercises the whole
 * payload path from the form to the row — the defect lived in what the form
 * handed the hook, and nothing downstream could recover a field never sent.
 */
vi.mock("@/lib/hooks/use-addresses", () => ({
  useAddresses: () => ({
    addresses: [],
    defaultAddress: undefined,
    isLoading: false,
    addAddress: (address: Record<string, unknown>) => {
      const pending = harness!.withIdentity(IDENTITY).mutation(
        api.customerAddresses.addAddress,
        {
          label: address.label,
          street: address.street,
          city: address.city,
          postalCode: address.postalCode,
          country: address.country,
          latitude: address.latitude,
          longitude: address.longitude,
        } as never
      )
      inFlight.push(pending)
      return pending
    },
    updateAddress: () => {},
    removeAddress: () => {},
    setDefault: () => {},
  }),
}))

vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }))

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  inFlight.length = 0
  harness = convexTest(schema, modules)
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  harness = null
})

async function mountManager() {
  const { AddressManager } = await import("@/components/storefront/address-manager")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<AddressManager />)
  })
  return container
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label)
  )!
}

async function fillFromAutocomplete(container: HTMLElement) {
  await act(async () => {
    button(container, "Ajouter une adresse").click()
  })
  await act(async () => {
    onSelect!(PICKED)
  })
}

async function save(container: HTMLElement) {
  await act(async () => {
    button(container, "Ajouter l’adresse").click()
  })
  await act(async () => {
    await Promise.allSettled(inFlight)
  })
}

function savedAddresses() {
  return harness!.run((ctx) => ctx.db.query("customerAddresses").collect())
}

describe("an address picked from the autocomplete", () => {
  test("is stored with the coordinates it was geocoded to", async () => {
    const container = await mountManager()

    await fillFromAutocomplete(container)
    await save(container)

    const rows = await savedAddresses()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.street).toBe(PICKED.street)
    expect(rows[0]!.latitude).toBe(PICKED.latitude)
    expect(rows[0]!.longitude).toBe(PICKED.longitude)
  })

  test("quotes identically from the address book and from checkout", async () => {
    const container = await mountManager()

    await fillFromAutocomplete(container)
    await save(container)
    const saved = (await savedAddresses())[0]!

    // The exact payload `app/(storefront)/checkout/page.tsx` hands
    // `getDeliveryQuote`. Uber Direct is quoted from these two numbers alone,
    // so equal payloads are equal fees.
    const fromAddressBook = {
      dropoffLatitude: saved.latitude,
      dropoffLongitude: saved.longitude,
    }
    const fromCheckout = {
      dropoffLatitude: PICKED.latitude,
      dropoffLongitude: PICKED.longitude,
    }

    expect(fromAddressBook).toEqual(fromCheckout)
    expect(fromAddressBook.dropoffLatitude).toBeTypeOf("number")
  })
})

describe("an address the customer retypes", () => {
  test("drops coordinates that no longer describe it", async () => {
    const container = await mountManager()

    await fillFromAutocomplete(container)

    // Retyping the street makes the geocoded point describe somewhere else. A
    // stale point is worse than none: the checkout would quote a courier to the
    // old address without ever showing that it had.
    const street = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (i) => i.value === PICKED.street
    )!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!
      setValue.call(street, "8 avenue de l'Opéra")
      street.dispatchEvent(new Event("input", { bubbles: true }))
    })

    await save(container)

    const rows = await savedAddresses()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.street).toBe("8 avenue de l'Opéra")
    expect(rows[0]!.latitude).toBeUndefined()
    expect(rows[0]!.longitude).toBeUndefined()
  })
})
