"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import {
  ShoppingBag,
  CheckCircle2,
  Tag,
  X,
  Loader2,
} from "lucide-react"
import { Input, Separator } from "@be-yours/ui"
import { useCartStore, formatPrice } from "@be-yours/restaurant"
import { computeOrderTotals } from "@be-yours/convex-functions/orderTotals"

interface AppliedPromo {
  id: string
  code: string
  name: string
  discountAmount: number
}

interface OrderSummaryProps {
  appliedPromo?: AppliedPromo | null
  /**
   * An offer the restaurant applies on its own, with no code to type. The
   * server applies the best one when no coupon was entered; showing it here is
   * what keeps the screen and the charge in agreement.
   */
  automaticOffer?: AppliedPromo | null
  promoError?: string
  promoLoading?: boolean
  onApplyPromo?: (code: string) => void
  onRemovePromo?: () => void
  deliveryFee?: number | null // number = calculated, null = can't calculate yet, undefined = not delivery
  /**
   * True when the fee cannot be worked out at all — an address carrying no
   * coordinates, or a quote that failed.
   *
   * Without it `deliveryFee: null` has two meanings and this row printed the
   * optimistic one for both: "Calculée à la validation", beside an error
   * saying the address has to be re-entered, on an order that validation was
   * going to refuse.
   */
  deliveryFeeUnavailable?: boolean
  hasDeliveryAddress?: boolean
  /**
   * Applicable tax rate as a percentage, resolved the same way the server does.
   * The summary used to omit tax entirely while labelling the total "Taxes
   * incluses" — a 20 € basket at 10 % displayed 20 € and was charged 22 €.
   */
  taxRatePercent?: number
  /**
   * What the kitchen says this basket takes, from the dishes' own preparation
   * times (`estimatedPrepMinutes`). Absent when there is no honest figure — the
   * row is then not drawn. It used to be a sentence typed into this component,
   * « Délai estimé : 25-35 mins », printed for every restaurant and every basket.
   */
  estimatedMinutes?: number
}

export function OrderSummary({
  appliedPromo,
  automaticOffer,
  promoError,
  promoLoading,
  onApplyPromo,
  onRemovePromo,
  deliveryFee,
  deliveryFeeUnavailable,
  hasDeliveryAddress,
  taxRatePercent = 0,
  estimatedMinutes,
}: OrderSummaryProps) {
  const items = useCartStore((s) => s.items)
  const orderType = useCartStore((s) => s.orderType)
  const getSubtotal = useCartStore((s) => s.getSubtotal)
  const getItemCount = useCartStore((s) => s.getItemCount)

  const [promoInput, setPromoInput] = useState("")

  const subtotal = getSubtotal()
  const itemCount = getItemCount()

  // Same function the server bills with, so the two cannot drift apart again —
  // including which rate applies to which line.
  const totals = computeOrderTotals({
    subtotal,
    taxRatePercent,
    lines: items.map((item) => ({
      subtotal:
        (item.price + item.options.reduce((s, o) => s + o.priceModifier, 0)) *
        item.quantity,
      taxRatePercent: item.taxRate ?? taxRatePercent,
    })),
    deliveryFee: deliveryFee ?? 0,
    // One promotion per order, the coupon first — the same rule the server
    // applies.
    discount: appliedPromo?.discountAmount ?? automaticOffer?.discountAmount ?? 0,
  })
  const discount = totals.discount
  const displayTotal = totals.total

  const handleApplyPromo = () => {
    const code = promoInput.trim()
    if (!code || !onApplyPromo) return
    onApplyPromo(code)
  }

  return (
    <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
      {/* Header */}
      <div className="p-8 pb-0">
        <h2 className="text-2xl font-black uppercase italic tracking-tighter text-foreground">
          Votre Box
        </h2>
        <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <span>Articles ({itemCount})</span>
          <Link href="/cart" className="text-accent-foreground hover:underline">
            Modifier
          </Link>
        </div>
      </div>

      {/* Items */}
      <div className="max-h-[300px] overflow-y-auto p-8">
        <div className="space-y-6">
          {items.map((item, idx) => {
            const optionsTotal = item.options.reduce(
              (s, o) => s + o.priceModifier,
              0
            )
            const lineTotal = (item.price + optionsTotal) * item.quantity

            return (
              <div
                key={`${item.productId}-${item.options.map((o) => o.choice).join("-")}-${idx}`}
                className="flex gap-4"
              >
                {/* Image */}
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border bg-muted">
                  {item.imageUrl ? (
                    <Image
                      src={item.imageUrl}
                      alt={item.name}
                      fill
                      sizes="64px"
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ShoppingBag className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  {/* Quantity badge */}
                  <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-lg bg-primary text-[10px] font-black text-primary-foreground">
                    {item.quantity}
                  </div>
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-black uppercase tracking-tight text-foreground">
                    {item.name}
                  </h3>
                  {item.options.length > 0 && (
                    <p className="mt-0.5 truncate text-[10px] font-black uppercase text-accent-foreground">
                      +{" "}
                      {item.options.map((o) => o.choice).join(", ")}
                    </p>
                  )}
                  <p className="mt-1 text-xs font-bold text-muted-foreground">
                    {formatPrice(lineTotal)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Promo Code */}
      {onApplyPromo && (
        <div className="px-8 pb-2">
          <Separator className="mb-6 bg-muted" />

          {!appliedPromo && automaticOffer && (
            <div className="mb-4 flex items-center gap-3 rounded-2xl border-2 border-primary/20 bg-accent/50 p-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
                <Tag className="h-4 w-4 text-accent-foreground" />
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-accent-foreground">
                  Offre automatique
                </p>
                <p className="text-[10px] font-medium text-accent-foreground">
                  {automaticOffer.name} — -{formatPrice(automaticOffer.discountAmount)}
                </p>
              </div>
            </div>
          )}

          {appliedPromo ? (
            <div className="flex items-center justify-between rounded-2xl border-2 border-primary/20 bg-accent/50 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
                  <Tag className="h-4 w-4 text-accent-foreground" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-accent-foreground">
                    {appliedPromo.code}
                  </p>
                  <p className="text-[10px] font-medium text-accent-foreground">
                    {appliedPromo.name} — -{formatPrice(appliedPromo.discountAmount)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Retirer le code promo"
                onClick={onRemovePromo}
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div>
              <label
                className="mb-2 block text-[10px] font-black uppercase tracking-widest text-muted-foreground"
                htmlFor="promo-code"
              >
                Code promo
              </label>
              <div className="flex gap-2">
                <Input
                  id="promo-code"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleApplyPromo()}
                  placeholder="Entrez votre code"
                  className="h-12 flex-1 rounded-xl border-border bg-muted px-4 text-sm font-bold uppercase tracking-widest transition-all focus:bg-card focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleApplyPromo}
                  disabled={!promoInput.trim() || promoLoading}
                  className="flex h-12 items-center justify-center rounded-xl bg-primary px-5 text-[10px] font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {promoLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Appliquer"
                  )}
                </button>
              </div>
              {promoError && (
                <p className="mt-2 text-xs font-medium text-destructive">
                  {promoError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Totals */}
      <div className="p-8 pt-0">
        <Separator className="my-8 bg-muted" />

        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
            <span>Sous-total</span>
            <span className="text-foreground">{formatPrice(subtotal)}</span>
          </div>

          {discount > 0 && (
            <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-accent-foreground">
              <span className="flex items-center gap-1.5">
                <Tag className="h-3 w-3" />
                Réduction
              </span>
              <span>-{formatPrice(discount)}</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
            <span>Livraison</span>
            {orderType !== "delivery" ? (
              <span className="font-black text-accent-foreground">
                GRATUIT (Retrait)
              </span>
            ) : !hasDeliveryAddress ? (
              <span className="text-muted-foreground">Renseignez votre adresse</span>
            ) : deliveryFeeUnavailable && typeof deliveryFee !== "number" ? (
              <span className="text-destructive">À préciser</span>
            ) : typeof deliveryFee === "number" && deliveryFee === 0 ? (
              <span className="font-black text-accent-foreground">OFFERTE</span>
            ) : typeof deliveryFee === "number" && deliveryFee > 0 ? (
              <span className="text-foreground">{formatPrice(deliveryFee)}</span>
            ) : (
              <span className="text-muted-foreground">Calculée à la validation</span>
            )}
          </div>

          {totals.taxAmount > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-bold uppercase tracking-widest text-muted-foreground">
                {/* "dont" — the tax is inside the prices above, not added to
                    them. One rate is named; a basket mixing rates is not. */}
                dont TVA
                {totals.taxBreakdown.length === 1
                  ? ` (${totals.taxBreakdown[0]!.ratePercent} %)`
                  : ""}
              </span>
              <span className="text-foreground">
                {formatPrice(totals.taxAmount)}
              </span>
            </div>
          )}

          <Separator className="bg-muted" />

          <div className="flex items-center justify-between pt-2">
            <span className="text-xl font-black uppercase tracking-tighter text-foreground">
              Total
            </span>
            <div className="text-right">
              <p className="text-3xl font-black leading-none tracking-tighter text-accent-foreground">
                {formatPrice(displayTotal)}
              </p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {totals.taxAmount > 0 ? "TVA incluse" : "Non soumis à la TVA"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer — only with a figure the kitchen stands behind. */}
      {estimatedMinutes !== undefined && (
        <div className="border-t border-border bg-primary/[0.02] p-8">
          <div className="flex items-center gap-3 text-accent-foreground">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-[10px] font-black uppercase tracking-widest">
              Préparation estimée : {estimatedMinutes} min
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
