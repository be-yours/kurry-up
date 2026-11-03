import { describe, it, expect } from "vitest"
import { decideOrderQuote } from "./order-quote"

const QUOTE = { estimateId: "est_abc", fee: 590 }

const LOCATED = {
  street: "12 rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  country: "FR",
  latitude: 48.8698,
  longitude: 2.3312,
}

/** A percentage-mode delivery with Uber Direct on — the only shape that quotes. */
function quoting(over: Record<string, unknown> = {}) {
  return {
    orderType: "delivery",
    feeMode: "percentage",
    uberDirectEnabled: true,
    displayedQuote: null,
    deliveryAddress: LOCATED,
    ...over,
  } as Parameters<typeof decideOrderQuote>[0]
}

describe("the quote the customer already saw", () => {
  it("travels with the order rather than a fresh one", () => {
    const d = decideOrderQuote(quoting({ displayedQuote: QUOTE }))
    expect(d).toEqual({ kind: "reuse", quote: QUOTE })
  })

  it("wins even in fixed mode, where the server ignores it anyway", () => {
    const d = decideOrderQuote(quoting({ feeMode: "fixed", displayedQuote: QUOTE }))
    expect(d).toEqual({ kind: "reuse", quote: QUOTE })
  })

  it("is preferred over re-quoting, which is the whole point", () => {
    // Two quotes for one address can come back at different prices. Charging
    // from the second while the first was on screen bills a fee never shown.
    const d = decideOrderQuote(quoting({ displayedQuote: QUOTE }))
    expect(d.kind).not.toBe("fetch")
  })
})

describe("no quote on screen", () => {
  it("asks Uber, carrying the address as written", () => {
    expect(decideOrderQuote(quoting())).toEqual({
      kind: "fetch",
      latitude: 48.8698,
      longitude: 2.3312,
      dropoffAddress: "12 rue de la Paix, 75002 Paris",
    })
  })

  it("refuses to guess when the address has no coordinates", () => {
    const { latitude: _lat, longitude: _lng, ...noCoords } = LOCATED
    const d = decideOrderQuote(quoting({ deliveryAddress: noCoords }))
    expect(d).toEqual({ kind: "address-incomplete" })
  })

  it("treats a half-located address as unusable", () => {
    const d = decideOrderQuote(
      quoting({ deliveryAddress: { ...LOCATED, longitude: undefined } })
    )
    expect(d).toEqual({ kind: "address-incomplete" })
  })

  it("does not accept a latitude of the wrong type", () => {
    const d = decideOrderQuote(
      quoting({ deliveryAddress: { ...LOCATED, latitude: "48.87" } })
    )
    expect(d).toEqual({ kind: "address-incomplete" })
  })

  it("accepts coordinates at the origin instead of reading 0 as absent", () => {
    const d = decideOrderQuote(
      quoting({ deliveryAddress: { ...LOCATED, latitude: 0, longitude: 0 } })
    )
    expect(d.kind).toBe("fetch")
  })

  it("refuses when there is no address at all", () => {
    const d = decideOrderQuote(quoting({ deliveryAddress: undefined }))
    expect(d).toEqual({ kind: "address-incomplete" })
  })
})

describe("orders that price no courier", () => {
  it("leaves a pickup order alone", () => {
    expect(decideOrderQuote(quoting({ orderType: "pickup" }))).toEqual({ kind: "none" })
  })

  it("leaves a fixed-fee delivery alone", () => {
    expect(decideOrderQuote(quoting({ feeMode: "fixed" }))).toEqual({ kind: "none" })
  })

  it("leaves a delivery alone when Uber Direct is off", () => {
    expect(decideOrderQuote(quoting({ uberDirectEnabled: false }))).toEqual({ kind: "none" })
  })

  it("treats an unset Uber Direct as off rather than on", () => {
    expect(decideOrderQuote(quoting({ uberDirectEnabled: undefined }))).toEqual({ kind: "none" })
  })

  it("treats an unset fee mode as not percentage", () => {
    expect(decideOrderQuote(quoting({ feeMode: undefined }))).toEqual({ kind: "none" })
  })
})
