"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useMutation, useQuery, useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { recordSignal } from "@be-yours/restaurant"
import type { Id } from "@/convex/_generated/dataModel"
import {
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@be-yours/ui"
import { useCartStore, formatPrice,
  cartSignature,
  resolveCheckoutAttempt,
  loadCheckoutAttempt,
  saveCheckoutAttempt,
  clearCheckoutAttempt,
  useCartHydrated,
  cardUnavailableMessage,
  type CartItem,
} from "@be-yours/restaurant"
import {
  computeOrderTotals,
  resolveTaxRatePercent,
} from "@be-yours/convex-functions/orderTotals"
import { effectiveDeliveryFeeMode } from "@be-yours/convex-functions/deliveryQuote"
import { cardMinimumFor } from "@be-yours/convex-functions/cardChargeFloor"
import {
  resolvePromotionDiscount,
  PromotionRejectedError,
} from "@be-yours/convex-functions/promotionDiscount"
import { authClient } from "@/lib/auth-client"
import {
  decideOrderQuote,
  type OrderQuote,
} from "@/lib/checkout/order-quote"
import { convexErrorMessage } from "@/lib/convex-error"
import { estimatedPrepMinutes } from "@/lib/checkout/estimated-prep"
import { useBestEffortQuery } from "@/lib/hooks/use-best-effort-query"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { useStoreStatus } from "@/lib/hooks/use-store-status"
import { useAddresses } from "@/lib/hooks/use-addresses"
import { CheckoutForm } from "@/components/storefront/checkout-form"
import { OrderSummary } from "@/components/storefront/order-summary"
import { SignInDialog } from "@/components/storefront/sign-in-dialog"
import { toast } from "sonner"

/**
 * What the customer is asked to do about an address we cannot price.
 *
 * Declared once because it is said in two places — beside the delivery line as
 * soon as we know, and again in the toast if they submit anyway — and two
 * wordings for one problem read as two problems.
 */
const ADDRESS_NEEDS_REENTRY =
  "Merci de resaisir votre adresse dans le champ de recherche : nous en avons besoin pour calculer les frais de livraison."

interface AppliedPromo {
  id: string
  code: string
  name: string
  discountAmount: number
}

/**
 * The cart lines a promotion may be resolved against.
 *
 * FORMULE LINES ARE NOT AMONG THEM (#352), and this is the client half of a
 * decision the server makes in `orders.create`: a formule's dishes never enter
 * `discountableLines`. The bundle price is the owner's own discount — they set
 * it below the à-la-carte total deliberately — so letting « -20 % sur les
 * desserts » also reach the dessert inside a formule discounts the same dish
 * twice without anybody having asked.
 *
 * Order-level promotions still see the formule: those apply to the subtotal,
 * which includes it.
 *
 * One function rather than a filter written at each of the two call sites: the
 * summary the diner reads and the order the server writes must agree, and the
 * way they stop agreeing is one site being updated and the other not.
 */
function discountableCartLines(items: CartItem[]) {
  return items
    .filter((item) => !item.menu && item.productId !== undefined)
    .map((item) => ({
      productId: item.productId,
      categoryId: item.categoryId,
      subtotal:
        (item.price + item.options.reduce((s, o) => s + o.priceModifier, 0)) *
        item.quantity,
    }))
}

export default function CheckoutPage() {
  const router = useRouter()

  /*
   * The funnel step between a filled basket and a paid order. `orders` already
   * counts the far end of it exactly; this is the only one of the four that
   * nothing else could know, because a diner who opens the checkout and leaves
   * writes no row anywhere.
   *
   * Once per mount, which is once per attempt: a diner who abandons and comes
   * back has started the checkout twice, and that is what the number means.
   */
  useEffect(() => {
    recordSignal("checkout_start")
  }, [])

  const { storeId, isLoading: isResolvingStore } = useStoreId()
  const cartHydrated = useCartHydrated()
  const { isOpen, services } = useStoreStatus(storeId)
  const { data: session } = authClient.useSession()

  const items = useCartStore((s) => s.items)
  const orderType = useCartStore((s) => s.orderType)
  const clearCart = useCartStore((s) => s.clearCart)
  const getSubtotal = useCartStore((s) => s.getSubtotal)
  const { addresses } = useAddresses(!!session?.user)

  const createOrder = useMutation(api.orders.create)
  const createStripeSession = useAction(api.stripe.createCheckoutSession)
  const createSumUpCheckout = useAction(api.sumup.createCheckout)
  const createPayPalOrder = useAction(api.paypal.createPayPalOrder)
  const getDeliveryQuote = useAction(api.uberDirect.getDeliveryQuote)
  const store = useQuery(
    api.stores.getById,
    storeId ? { id: storeId as Id<"stores"> } : "skip"
  )

  const [isSubmitting, setIsSubmitting] = useState(false)
  /**
   * One key per checkout attempt, kept in session storage rather than in a ref.
   *
   * The button re-enables in `finally` while the redirect to the payment
   * provider is in flight, and the cart survives a Back navigation: without a
   * key, a second click bought a second dinner. A ref covered the click and not
   * the return — this page remounts on every arrival, including the one that
   * matters. Tied to the basket, so an edited cart starts a new attempt instead
   * of handing back an order for the old contents.
   */
  const [isSuccess, setIsSuccess] = useState(false)
  const [lastOrderId, setLastOrderId] = useState<string | null>(null)
  /*
   * The number the restaurant sees — « ORD-2026-00001 » — read back from the
   * order, not derived from its id. The confirmation used to print the last six
   * characters of the internal id, a reference that appears nowhere the owner
   * looks: not in the orders list, not on the ticket, not on the invoice. A diner
   * who telephoned to ask about « #8FWXRV » was asking about an order nobody
   * could find. `getPaymentState` is the public read the card success page
   * already uses for this: the status and the number, no customer, no amount.
   * Best effort — this line must never cost the diner the confirmation.
   */
  const confirmedOrder = useBestEffortQuery(
    api.orders.getPaymentState,
    lastOrderId ? { orderId: lastOrderId as Id<"orders"> } : "skip"
  )
  const [formEmail, setFormEmail] = useState("")

  /*
   * What the kitchen says this basket takes, for the summary's last line. The
   * dishes' own `preparationTime`s, the same figure `orders.create` records on
   * the order, and nothing when it would be partial — see `estimatedPrepMinutes`.
   * It was a sentence typed into the summary, « Délai estimé : 25-35 mins ».
   *
   * Best effort, and it has to be: the ids come out of the browser's own
   * storage, and one this deployment never issued — a basket saved before the
   * site moved to a new backend — is refused by the query's validator. A plain
   * `useQuery` threw that into the error boundary, over the payment form.
   */
  const cartProductIds = items.flatMap((item) =>
    !item.menu && item.productId ? [item.productId as Id<"products">] : []
  )
  const cartProducts = useBestEffortQuery(
    api.products.getManyByIds,
    cartProductIds.length > 0 ? { ids: cartProductIds } : "skip"
  )
  const estimatedMinutes = cartProducts
    ? estimatedPrepMinutes(items, cartProducts)
    : undefined

  // Delivery fee state
  const [deliveryCoords, setDeliveryCoords] = useState<{
    latitude?: number
    longitude?: number
  } | null>(null)
  const hasDeliveryAddress = deliveryCoords !== null
  // Percentage fee mode bills a share of the Uber Direct quote. The server
  // reads that quote from its own records, so the checkout has to request one
  // and pass back its id — it can no longer just send a number.
  const [uberQuote, setUberQuote] = useState<{
    estimateId: string
    fee: number
  } | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const globalSettings = useQuery(api.globalSettings.get)

  // Promo state
  const [promoCode, setPromoCode] = useState("")
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null)
  const [promoError, setPromoError] = useState("")
  const [promoLoading, setPromoLoading] = useState(false)

  // Automatic offers the restaurant is running right now. The list existed and
  // had no caller at all: an owner who configured an "offre automatique" got a
  // promotion that never applied. The server applies the best one when no
  // coupon is typed; this is how the customer sees it coming.
  const autoPromotions = useQuery(
    api.promotions.listActiveAuto,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )

  // Reactive query for promo lookup
  const promoResult = useQuery(
    api.promotions.getByCouponCode,
    storeId && promoCode
      ? { storeId: storeId as Id<"stores">, couponCode: promoCode }
      : "skip"
  )

  // Process promo result when it arrives
  useEffect(() => {
    if (!promoLoading || !promoCode) return
    // Still loading from Convex
    if (promoResult === undefined) return

    setPromoLoading(false)

    if (!promoResult) {
      setPromoError("Code promo invalide ou introuvable.")
      setPromoCode("")
      return
    }

    const now = Date.now()
    const promo = promoResult

    // The server's own resolver, run on the client for display. It used to be
    // a second, looser copy: `free_delivery` was hard-coded to 0 here while the
    // server discounted the whole fee (26,90 € on screen, 22,00 € charged), and
    // a fixed amount was uncapped here and clamped there (−50 € shown on a 22 €
    // order). Same function, same numbers.
    let discountAmount = 0
    try {
      const resolved = resolvePromotionDiscount({
        promotion: promo,
        storeId: storeId as string,
        subtotal: getSubtotal(),
        deliveryFee: estimatedDeliveryFee ?? 0,
        now,
        // Formule lines are left out, exactly as the server leaves them out of
        // `discountableLines`: the bundle price IS the owner's discount, and a
        // category promotion reaching the dessert inside a formule would
        // discount the same dish twice. Filtering here keeps the summary the
        // diner reads equal to the order the server writes (#352).
        items: discountableCartLines(items),
        timezone: globalSettings?.timezone,
        // The email is not known until the form is submitted, so a per-customer
        // cap cannot be checked here. The server checks it and may still refuse.
      })
      discountAmount = resolved.discount
    } catch (error) {
      setPromoError(
        error instanceof PromotionRejectedError
          ? error.message
          : "Ce code promo ne s'applique pas à votre commande."
      )
      setPromoCode("")
      return
    }

    setPromoError("")
    setAppliedPromo({
      id: promo._id,
      code: promo.couponCode ?? promoCode.toUpperCase(),
      name: promo.name,
      discountAmount,
    })
  }, [promoResult, promoLoading, promoCode, getSubtotal])

  // Calculate estimated delivery fee
  const estimatedDeliveryFee = (() => {
    if (orderType !== "delivery") return undefined // not delivery
    if (!hasDeliveryAddress) return null // needs address
    if (globalSettings === undefined) return null // still loading
    const deliveryConfig = globalSettings?.delivery
    if (!deliveryConfig) return null // no config → calculated server-side

    const subtotal = getSubtotal()
    const freeAbove = deliveryConfig.freeAbove
    if (freeAbove && subtotal >= freeAbove) return 0

    const feeMode = effectiveDeliveryFeeMode({
      feeMode: deliveryConfig.feeMode,
      uberDirectEnabled: globalSettings?.integrations?.uberDirect?.enabled,
    })
    if (feeMode === "fixed") {
      const fee = deliveryConfig.fee
      if (fee === undefined || fee === null) return null // no fee configured
      return fee
    }

    // percentage mode: a share of the quote the server issued and stored
    if (!uberQuote) return null
    const percentage = deliveryConfig.percentage ?? 100
    const fee = Math.round((uberQuote.fee * percentage) / 100)
    return deliveryConfig.maxFee !== undefined && fee > deliveryConfig.maxFee
      ? deliveryConfig.maxFee
      : fee
  })()

  // The automatic offer the server would apply: the best one that resolves,
  // evaluated with the resolver the server uses. Only when no coupon was typed
  // — one promotion per order, and a typed coupon is the customer's own choice.
  const automaticOffer = (() => {
    if (appliedPromo || !storeId || !autoPromotions?.length) return null

    const lines = discountableCartLines(items)

    let best: AppliedPromo | null = null
    for (const promotion of autoPromotions) {
      try {
        const resolved = resolvePromotionDiscount({
          promotion,
          storeId: storeId as string,
          subtotal: getSubtotal(),
          deliveryFee: estimatedDeliveryFee ?? 0,
          now: Date.now(),
          items: lines,
          timezone: globalSettings?.timezone,
        })
        if (resolved.discount > (best?.discountAmount ?? 0)) {
          best = {
            id: promotion._id,
            code: "",
            name: promotion.name,
            discountAmount: resolved.discount,
          }
        }
      } catch {
        // Not applicable to this basket, at this hour. Nobody asked for it by
        // name, so there is nobody to explain a refusal to.
      }
    }
    return best
  })()

  // Request an Uber Direct quote when the fee depends on one. Skipped in every
  // other mode so a fixed-fee store never touches the Uber API.
  // The mode the shop can honour, not the one it stored: percentage without
  // Uber Direct prices nothing, and the server charges the fixed fee. Asking
  // for a quote here would show a fee the order is never charged.
  const feeMode = effectiveDeliveryFeeMode({
    feeMode: globalSettings?.delivery?.feeMode,
    uberDirectEnabled: globalSettings?.integrations?.uberDirect?.enabled,
  })
  const needsQuote =
    orderType === "delivery" && feeMode === "percentage" && !!storeId

  useEffect(() => {
    if (!needsQuote || uberQuote) return
    const lat = deliveryCoords?.latitude
    const lng = deliveryCoords?.longitude
    if (lat === undefined || lng === undefined) {
      // An address with no coordinates — saved before quoting existed, or
      // typed over the autocomplete instead of chosen from it. This used to
      // return silently: no quote arrived, so the summary fell through to its
      // last branch and read "Calculée à la validation", and at validation the
      // order was refused with "merci de resaisir votre adresse". The customer
      // was told to carry on and then stopped, having filled in the whole form.
      //
      // Only once an address has actually been entered: before that the
      // summary already says "Renseignez votre adresse", and an error over an
      // empty field is noise.
      if (deliveryCoords !== null) setQuoteError(ADDRESS_NEEDS_REENTRY)
      return
    }

    let cancelled = false
    getDeliveryQuote({
      storeId: storeId as Id<"stores">,
      dropoffLatitude: lat,
      dropoffLongitude: lng,
    })
      .then((quote) => {
        if (!cancelled) setUberQuote({ estimateId: quote.estimateId, fee: quote.fee })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setQuoteError(
          error instanceof Error && error.message.includes("UNDELIVERABLE_ZONE")
            ? "Cette adresse n'est pas desservie."
            : "Les frais de livraison n'ont pas pu être calculés."
        )
      })

    return () => {
      cancelled = true
    }
  }, [needsQuote, uberQuote, deliveryCoords, storeId, getDeliveryQuote])

  const handleAddressChange = useCallback(
    (address: { latitude?: number; longitude?: number } | null) => {
      setDeliveryCoords(address)
      setUberQuote(null)
      setQuoteError(null)
    },
    []
  )

  const handleApplyPromo = useCallback((code: string) => {
    setPromoError("")
    setPromoCode(code.toUpperCase())
    setPromoLoading(true)
  }, [])

  const handleRemovePromo = useCallback(() => {
    setAppliedPromo(null)
    setPromoCode("")
    setPromoError("")
  }, [])

  // Guards.
  //
  // Both wait for the persisted cart to be read back and for the establishment
  // list to arrive. Before that the cart looks empty and no store is resolved,
  // so a customer arriving at /checkout with a full basket — the one coming
  // back from the payment provider, above all — was bounced to /cart or to the
  // restaurant picker.
  useEffect(() => {
    if (!cartHydrated) return
    if (items.length === 0 && !isSuccess) {
      router.replace("/cart")
    }
  }, [cartHydrated, items.length, router, isSuccess])

  useEffect(() => {
    if (!cartHydrated || isResolvingStore) return
    if (storeId === null && items.length > 0) {
      router.replace("/store-selector")
    }
  }, [cartHydrated, isResolvingStore, storeId, items.length, router])

  // Success screen
  if (isSuccess) {
    return (
      <div className="min-h-screen bg-muted px-4 pb-20 pt-32">
        <div className="mx-auto max-w-xl text-center">
          <div className="mx-auto mb-8 flex h-24 w-24 items-center justify-center rounded-full bg-success text-success-foreground">
            <CheckCircle2 className="h-12 w-12" />
          </div>
          <h1 className="mb-4 text-4xl font-black uppercase italic tracking-tighter text-foreground">
            Commande {" "}
            <span className="not-italic text-accent-foreground">Confirmée</span>
          </h1>

          {/* Nothing until the number is read: a placeholder derived from the
              id would be shown for a moment and then contradicted. */}
          {confirmedOrder?.orderNumber && (
            <div className="mb-6">
              <span className="rounded-full bg-muted px-4 py-2 text-xs font-black uppercase tracking-widest leading-none text-muted-foreground">
                Commande #{confirmedOrder.orderNumber}
              </span>
            </div>
          )}

          <p className="mb-8 text-lg leading-relaxed text-muted-foreground">
            Votre commande a bien été prise en compte. Vous recevrez une
            confirmation
            {formEmail && (
              <>
                {" "}
                à{" "}
                <span className="font-bold text-foreground">{formEmail}</span>
              </>
            )}
            .
          </p>

          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Link href="/menu">
              <Button className="h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover">
                Retour au menu
              </Button>
            </Link>
            <Link href="/">
              <Button
                variant="outline"
                className="h-14 rounded-2xl border-border px-8 font-black uppercase tracking-widest transition-all"
              >
                Page d&apos;accueil
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!cartHydrated || isResolvingStore) return null
  if (items.length === 0 || !storeId) return null

  const cardProvider = globalSettings?.payments?.cardProvider ?? "stripe"

  /**
   * What this basket owes right now, in cents — or `undefined` while it cannot
   * be known.
   *
   * The payment tiles need it: a card provider has a floor (0,50 € at Stripe,
   * in EUR) and a 100 % coupon takes an order below it, to zero. Offering a
   * card for either produced an order no retry could ever settle.
   *
   * Computed with the same pure function the summary and the SERVER bill with,
   * from the same inputs, so the figure the tiles reason about is the figure
   * the diner is reading beside them. `null` from `estimatedDeliveryFee` means
   * the quote has not landed, and a total without it is not the total.
   */
  const amountDue = (() => {
    if (estimatedDeliveryFee === null) return undefined
    return computeOrderTotals({
      subtotal: getSubtotal(),
      taxRatePercent: resolveTaxRatePercent({
        globalTaxRate: globalSettings?.taxRate,
      }),
      lines: items.map((item) => ({
        subtotal:
          (item.price + item.options.reduce((sum, o) => sum + o.priceModifier, 0)) *
          item.quantity,
        taxRatePercent: item.taxRate ?? resolveTaxRatePercent({
          globalTaxRate: globalSettings?.taxRate,
        }),
      })),
      deliveryFee: estimatedDeliveryFee ?? 0,
      discount:
        appliedPromo?.discountAmount ?? automaticOffer?.discountAmount ?? 0,
    }).total
  })()

  const handleSubmit = async (data: {
    name: string
    email?: string
    phone?: string
    paymentMethod: "card" | "paypal" | "cash"
    notes?: string
    tableNumber?: string
    deliveryAddress?: {
      street: string
      city: string
      postalCode: string
      country: string
      latitude?: number
      longitude?: number
    }
  }) => {
    if (!isOpen) {
      toast.error("Le restaurant est actuellement fermé.")
      return
    }

    setIsSubmitting(true)
    const attempt = resolveCheckoutAttempt(
      loadCheckoutAttempt(),
      cartSignature({
        storeId,
        orderType,
        promotionId: appliedPromo?.id ?? automaticOffer?.id,
        items,
      }),
      () => crypto.randomUUID()
    )
    saveCheckoutAttempt(attempt)
    setFormEmail(data.email ?? "")

    try {
      // 1. Settle the courier quote before creating the order. The decision
      // itself lives in lib/checkout/order-quote.ts, where it is tested.
      const decision = decideOrderQuote({
        orderType,
        feeMode: globalSettings?.delivery?.feeMode,
        uberDirectEnabled: globalSettings?.integrations?.uberDirect?.enabled,
        displayedQuote: uberQuote,
        deliveryAddress: data.deliveryAddress,
      })

      if (decision.kind === "address-incomplete") {
        toast.error(ADDRESS_NEEDS_REENTRY)
        setQuoteError(ADDRESS_NEEDS_REENTRY)
        setIsSubmitting(false)
        return
      }

      let orderQuote: OrderQuote | undefined =
        decision.kind === "reuse" ? decision.quote : undefined

      if (decision.kind === "fetch") {
        try {
          const quote = await getDeliveryQuote({
            storeId: storeId as Id<"stores">,
            dropoffLatitude: decision.latitude,
            dropoffLongitude: decision.longitude,
            dropoffAddress: decision.dropoffAddress,
          })
          orderQuote = { estimateId: quote.estimateId, fee: quote.fee }
        } catch (err) {
          const message = err instanceof Error ? err.message : ""
          toast.error(
            message.includes("UNDELIVERABLE_ZONE")
              ? "Cette adresse est hors de notre zone de livraison. Essayez le retrait sur place."
              : "Impossible de calculer les frais de livraison pour le moment. Réessayez dans un instant."
          )
          setIsSubmitting(false)
          return
        }
      }

      // 2. Create order with paymentStatus "pending"
      const orderId = await createOrder({
        storeId: storeId as Id<"stores">,
        customerId: session?.user?.id,
        customerInfo: {
          name: data.name,
          email: data.email,
          phone: data.phone,
        },
        items: items.map((item) =>
          item.menu
            ? {
                /*
                 * A *formule* (#352). No `productId`, and every price here is
                 * ignored by the server: the bundle price comes from the `menus`
                 * row and the per-dish shares are computed there, so a client
                 * that sent them would be a second implementation of a VAT rule.
                 * `productName`, `unitPrice` and `subtotal` are sent because the
                 * validator requires them, and are overwritten.
                 */
                productName: item.name,
                quantity: item.quantity,
                unitPrice: item.price,
                selectedOptions: [],
                subtotal: item.price * item.quantity,
                menu: {
                  menuId: item.menu.menuId as Id<"menus">,
                  // The cart's own line id, so the grouping the diner saw is the
                  // grouping the kitchen prints.
                  lineId: item.lineId,
                  choices: item.menu.choices.map((choice) => ({
                    sectionId: choice.sectionId,
                    productId: choice.productId as Id<"products">,
                    quantity: choice.quantity,
                    selectedOptions: (choice.options ?? []).map((opt) => ({
                      optionName: opt.name,
                      choiceName: opt.choice,
                      priceModifier: opt.priceModifier,
                    })),
                  })),
                },
              }
            : {
                productId: item.productId as Id<"products">,
                productName: item.name,
                quantity: item.quantity,
                unitPrice: item.price,
                selectedOptions: item.options.map((opt) => ({
                  optionName: opt.name,
                  choiceName: opt.choice,
                  priceModifier: opt.priceModifier,
                })),
                subtotal:
                  (item.price +
                    item.options.reduce((s, o) => s + o.priceModifier, 0)) *
                  item.quantity,
              }
        ),
        type: orderType,
        paymentMethod: data.paymentMethod,
        // The diner's note to the kitchen — an allergy, most of the time. It
        // rides the order through `releaseToKitchen` onto the ticket, which
        // has had a line for it all along and never had anything to print.
        notes: data.notes,
        // The server recomputes the discount from this promotion. The
        // `appliedPromo.discountAmount` computed above is for display only and
        // is deliberately not sent — it used to be, and was trusted verbatim.
        promotionId: appliedPromo
          ? (appliedPromo.id as Id<"promotions">)
          : undefined,
        deliveryAddress:
          orderType === "delivery" ? data.deliveryAddress : undefined,
        // Gated the same way, and for the same reason: the server rejects a
        // table number on an order that is not `dine_in`, so a type switched
        // after the table was typed cannot smuggle a stale one through.
        tableNumber: orderType === "dine_in" ? data.tableNumber : undefined,
        // Only the id: the server reads the fee from the quote it stored.
        uberDirectEstimateId: orderQuote?.estimateId,
        idempotencyKey: attempt.key,
      })

      const origin = window.location.origin

      // 3. Route based on payment method
      if (data.paymentMethod === "cash") {
        // Cash: immediate confirmation
        setLastOrderId(orderId)
        clearCart()
        // The order went through: the basket is gone and so is its attempt.
        clearCheckoutAttempt()
        setIsSuccess(true)
        toast.success("Commande confirmée !")

      } else if (data.paymentMethod === "card") {
        if (cardProvider === "sumup") {
          // SumUp: create checkout → redirect to local widget page
          const result = await createSumUpCheckout({
            orderId: orderId as Id<"orders">,
            // The checkout id cannot go in here — it does not exist until this
            // call returns. `/checkout/pay` carries it forward to the success
            // page instead, which is where the payment gets verified.
            redirectUrl: `${origin}/checkout/success?orderId=${orderId}`,
          })
          window.location.href = `/checkout/pay?orderId=${orderId}&checkoutId=${result.checkoutId}`
        } else {
          // Stripe: create checkout session → redirect to Stripe hosted page
          const result = await createStripeSession({
            orderId: orderId as Id<"orders">,
            successUrl: `${origin}/checkout/success?orderId=${orderId}`,
            cancelUrl: `${origin}/checkout/cancel?orderId=${orderId}`,
          })
          if (!result.sessionUrl) {
            // The order exists and is `pending`; the customer can pay it from
            // the tracking link. Said here rather than thrown, so the sentence
            // survives — the catch below can only trust a ConvexError.
            toast.error("Impossible de créer la session de paiement.")
            return
          }
          window.location.href = result.sessionUrl
        }

      } else if (data.paymentMethod === "paypal") {
        // PayPal: create order → redirect to PayPal approval
        const result = await createPayPalOrder({
          orderId: orderId as Id<"orders">,
          returnUrl: `${origin}/checkout/success?orderId=${orderId}`,
          cancelUrl: `${origin}/checkout/cancel?orderId=${orderId}`,
        })
        if (!result.approvalUrl) {
          toast.error("Impossible de créer la commande PayPal.")
          return
        }
        window.location.href = result.approvalUrl
      }

    } catch (error) {
      // `error.message` was read here, and in production it always said "Server
      // Error": Convex redacts a thrown `Error` and only a `ConvexError` keeps
      // its payload. Every refusal `orders.create` can give — sold out, a
      // required option missing, below the minimum, outside the delivery zone,
      // a service the restaurant does not offer — arrived at the moment of
      // payment as those two words, and the diner had nothing to act on.
      //
      // No code map: the server's own French sentence is the copy, and this
      // screen has nothing better to say than the one that names the dish.
      //
      // Logged as well as shown: a client-side fault inside this handler — a
      // stale cart id failing argument validation, a provider action throwing —
      // reaches the same generic toast, and without this there is nothing left
      // of it to diagnose from.
      console.error("Checkout failed", error)
      toast.error(
        convexErrorMessage(
          error,
          {
            /*
             * The one refusal whose right wording depends on the SCREEN, not on
             * the deployment (#531).
             *
             * The server's own sentence ends « Choisissez un autre moyen de
             * paiement. », and `convex/stripe.ts` cannot know what tiles this
             * page rendered. On a delivery order at an establishment with no
             * cash and no PayPal, card is the only tile there is — so that
             * sentence asks the diner to do something the page does not offer,
             * and they read it as their own oversight.
             *
             * Decided here, against the same context the tiles were rendered
             * from, so the advice cannot contradict what is on screen. Every
             * other code keeps the server's French verbatim: it is the copy.
             */
            card_payment_unavailable: cardUnavailableMessage({
              cardAvailable: false,
              paypalEnabled: globalSettings?.payments?.paypal === true,
              cashEnabled: globalSettings?.payments?.cash === true,
              isDelivery: orderType === "delivery",
              isAuthenticated: !!session?.user,
              amountDue,
              cardMinimum: cardMinimumFor(globalSettings?.currency),
            }),
          },
          "Erreur lors de la commande. Veuillez réessayer."
        )
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-muted px-4 pb-20 pt-32">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <header className="mb-12">
          <Link
            href="/cart"
            className="group mb-4 inline-flex items-center text-sm font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-accent-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4 transition-transform group-hover:-translate-x-1" />
            Retour à la Box
          </Link>

          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <h1 className="text-5xl font-black uppercase italic tracking-tighter text-foreground">
              Finaliser{" "}
              <span className="not-italic text-accent-foreground">Commande</span>
            </h1>

            {!session && (
              <SignInDialog />
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-12">
          {/* Left Column: Form */}
          <div className="lg:col-span-7">
            <CheckoutForm
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
              addresses={addresses}
              isAuthenticated={!!session?.user}
              amountDue={amountDue}
              user={session?.user ? {
                name: session.user.name ?? undefined,
                email: session.user.email ?? undefined,
              } : undefined}
              onAddressChange={handleAddressChange}
              services={services}
              // Only for a guest: a signed-in diner has no use for it, and the
              // form only renders it when cash is the sole path and an account
              // is what is missing.
              signInAction={!session ? <SignInDialog /> : undefined}
            />
          </div>

          {/* Right Column: Order Summary */}
          <div className="relative lg:col-span-5">
            <div className="sticky top-32 space-y-6">
              <OrderSummary
                appliedPromo={appliedPromo}
                automaticOffer={automaticOffer}
                promoError={promoError}
                promoLoading={promoLoading}
                onApplyPromo={handleApplyPromo}
                onRemovePromo={handleRemovePromo}
                deliveryFee={estimatedDeliveryFee}
                deliveryFeeUnavailable={quoteError !== null}
                hasDeliveryAddress={hasDeliveryAddress}
                estimatedMinutes={estimatedMinutes}
                taxRatePercent={resolveTaxRatePercent({
                  globalTaxRate: globalSettings?.taxRate,
                })}
              />
              {quoteError && (
                <p className="px-4 text-center text-sm text-destructive">
                  {quoteError}
                </p>
              )}

              {/* Security badge */}
              <div className="flex items-center gap-4 rounded-[2rem] border border-success/20 bg-card p-8">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-success/10 text-success">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-bold text-foreground">
                    Paiement 100% Sécurisé
                  </p>
                  <p className="text-xs leading-tight text-muted-foreground">
                    Vos informations de paiement sont cryptées et ne sont jamais
                    stockées sur nos serveurs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
