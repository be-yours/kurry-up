/**
 * How long the kitchen needs for this basket, from what the kitchen knows.
 *
 * WHY THIS REPLACES A SENTENCE. The order summary used to end on « Délai estimé :
 * 25-35 mins », a literal typed into the component. It was printed for every
 * restaurant, for every basket, whether the dish took four minutes or forty and
 * whether the restaurant took away or delivered — a promise nobody had made, in
 * a screen the diner reads right before paying. A figure about an establishment
 * is the establishment's to state (see `no-fabricated-social-proof.test.ts`).
 *
 * The establishment does state one: each dish has a `preparationTime`, and
 * `orders.create` records the longest of them on the order as
 * `estimatedPrepTime`, which is what the kitchen ticket's « Est. 12 min » shows.
 * This is the same rule applied before the order exists — dishes are cooked side
 * by side, so the longest one decides, not the sum.
 *
 * `undefined` rather than a guess whenever the figure would be partial: a
 * formule (its time lives on the menu row the server reads, not on the cart
 * line), a dish nobody timed, or one that is no longer on sale. An understated
 * estimate is worse than none, and the row simply does not appear.
 */

interface CartLine {
  productId?: string
  menu?: unknown
}

interface TimedProduct {
  _id: string
  preparationTime?: number | null
}

export function estimatedPrepMinutes(
  lines: ReadonlyArray<CartLine>,
  products: ReadonlyArray<TimedProduct>,
): number | undefined {
  if (lines.length === 0) return undefined

  let longest = 0
  for (const line of lines) {
    if (line.menu || !line.productId) return undefined

    const product = products.find((p) => p._id === line.productId)
    const minutes = product?.preparationTime
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      return undefined
    }
    longest = Math.max(longest, minutes)
  }

  return Math.round(longest)
}
