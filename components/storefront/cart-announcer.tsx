"use client"

import { useState } from "react"
import { formatPrice, useCartStore, useTranslation } from "@be-yours/restaurant"

/**
 * What the cart just did, said out loud.
 *
 * WHAT WAS MEASURED, at `b9e20ea`. Adding a dish reached a screen reader —
 * `sonner` renders its toasts into a live region and the product card raises
 * one. Every mutation after that was silent: the quantity buttons, removing a
 * line, emptying the Box, the count on the header badge, the subtotal and the
 * total are all bare `<span>`s, and a `<span>` whose text changes announces
 * nothing at all. Across the 36 files on the buying path there were four
 * `aria-live`/`role="status"` attributes and none of them was in a cart. So a
 * blind diner could press « Augmenter la quantité » four times and be told
 * nothing four times, with no way to know what they were about to pay.
 *
 * WHY ONE REGION, IN THE SHELL, AND NOT ONE PER CONTROL. A live region has to
 * be in the document BEFORE its contents change — a region that is inserted
 * already holding text is not reliably announced. The cart sheet is a dialog
 * that unmounts when closed, so a region inside it would miss every mutation
 * made from a product card, which is most of them. `StorefrontShell` is
 * mounted for the whole storefront, which makes this the one place that hears
 * all of them.
 *
 * WHAT IT SAYS is the state, not the verb: "Box : 3 articles, 24,50 €". The
 * toast already names the action for an addition, and repeating it here would
 * queue two announcements for one event. The state is also the thing the other
 * mutations have no way of saying — the diner who pressed « - » wants the new
 * count and the new total, and both of them are the numbers on the screen they
 * cannot see.
 *
 * NOT ON MOUNT. Rehydrating a persisted cart is not an event the diner caused,
 * and announcing it would talk over the page they just opened.
 */
export function CartAnnouncer() {
  const { t } = useTranslation()
  const items = useCartStore((s) => s.items)
  const getItemCount = useCartStore((s) => s.getItemCount)
  const getSubtotal = useCartStore((s) => s.getSubtotal)

  const itemCount = getItemCount()
  const subtotal = getSubtotal()

  /* What the cart looked like the last time this rendered.
     The lines rather than the two totals: emptying a five-euro line and adding
     another leaves the count and the total unchanged while the cart plainly
     moved, and the diner is owed the sentence either way. */
  const signature = JSON.stringify(
    items.map((item) => [item.lineId, item.quantity, item.price])
  )

  const [seen, setSeen] = useState(signature)
  const [message, setMessage] = useState("")

  /*
    Adjusted DURING render, not in an effect — React's own pattern for state
    derived from something that changed, and the reason is not style. An effect
    that calls `setState` runs after the browser has painted, so the region
    would be filled a frame late and, more to the point, `react-hooks` refuses
    it: a synchronous `setState` in an effect body cascades renders. Here React
    re-renders immediately, before committing anything, and the region goes from
    empty to holding the sentence — which is the transition a live region
    announces.

    The first render initialises `seen` to whatever the cart already holds, so a
    cart rehydrated from `localStorage` is silent: that is not something the
    diner just did, and announcing it talks over the page they opened.
  */
  if (seen !== signature) {
    setSeen(signature)
    setMessage(
      itemCount === 0
        ? t("accessibility.cartEmptied")
        : t("accessibility.cartStatus", {
            count: itemCount,
            total: formatPrice(subtotal),
          })
    )
  }

  return (
    /*
      `aria-atomic` so the whole sentence is read rather than the words that
      differ from last time — "4" on its own is not an announcement. `role` and
      `aria-live` together because the two are supported unevenly and the pair
      is what actually gets read everywhere.

      Rendered empty and filled afterwards, never mounted with its text: that
      is the ordering a live region requires, and it is why this component
      exists rather than an attribute on the number in the header.
    */
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}
