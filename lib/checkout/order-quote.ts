/**
 * Which Uber Direct quote an order should travel with.
 *
 * Pulled out of the checkout page because each branch decides what the customer
 * is charged, and a branch inside a submit handler is only reachable through a
 * browser. The page executes the decision; this file makes it.
 *
 * The server counterpart is `assertQuoteApplies` in the convex-functions
 * package: it re-checks existence, tenant, expiry, single use and the bond to
 * the address the quote priced. Nothing here is a security boundary — a browser
 * can send any id it likes. This decides which id an honest browser sends, and
 * therefore whether the fee charged is the fee displayed.
 */

import { effectiveDeliveryFeeMode } from "@be-yours/convex-functions/deliveryQuote"

export interface OrderQuote {
  estimateId: string
  fee: number
}

export interface DeliveryAddress {
  street: string
  city: string
  postalCode: string
  country: string
  latitude?: number
  longitude?: number
}

export type OrderQuoteDecision =
  /** Nothing to send: this order does not price a courier. */
  | { kind: "none" }
  /** Send the quote the displayed fee was computed from. */
  | { kind: "reuse"; quote: OrderQuote }
  /** Nothing displayed yet — ask Uber for this address. */
  | { kind: "fetch"; latitude: number; longitude: number; dropoffAddress: string }
  /** The address carries no usable coordinates; the customer has to re-enter it. */
  | { kind: "address-incomplete" }

export function decideOrderQuote(input: {
  orderType: string
  feeMode: string | undefined
  uberDirectEnabled: boolean | undefined
  /** The quote held in state, which the fee on screen was computed from. */
  displayedQuote: OrderQuote | null | undefined
  deliveryAddress: DeliveryAddress | undefined
}): OrderQuoteDecision {
  // A quote already on screen wins, whatever the mode. The server charges from
  // the quote the id points at, so re-quoting here could bill a price the
  // customer never saw. In fixed mode the server ignores the id entirely.
  if (input.displayedQuote) {
    return { kind: "reuse", quote: input.displayedQuote }
  }

  // Percentage mode with the integration off prices nothing: the server falls
  // back to the fixed fee rather than refusing the order, and asking Uber for a
  // quote here would bill a fee the shop cannot honour.
  const needsQuote =
    input.orderType === "delivery" &&
    effectiveDeliveryFeeMode({
      feeMode: input.feeMode,
      uberDirectEnabled: input.uberDirectEnabled,
    }) === "percentage"

  if (!needsQuote) return { kind: "none" }

  const address = input.deliveryAddress
  // Addresses saved before quoting existed carry no coordinates. Asking again
  // beats geocoding blind and sending a courier to the wrong street.
  if (
    typeof address?.latitude !== "number" ||
    typeof address?.longitude !== "number"
  ) {
    return { kind: "address-incomplete" }
  }

  return {
    kind: "fetch",
    latitude: address.latitude,
    longitude: address.longitude,
    dropoffAddress: `${address.street}, ${address.postalCode} ${address.city}`,
  }
}
