"use client"

import { useState, useEffect, useRef, type ReactNode } from "react"
import Link from "next/link"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import {
  ArrowRight,
  CreditCard,
  Mail,
  MapPin,
  Phone,
  Truck,
  ShoppingBag,
  MapPinOff,
  CheckCircle2,
  Banknote,
  Utensils,
  AlertTriangle,
} from "lucide-react"
import {
  Button,
  Input,
  Label,
  Separator,
  Textarea,
} from "@be-yours/ui"
import {
  formatPrice,
  isPaymentMethodSelectable,
  nothingIsDue,
  resolvePaymentMethod,
  useCartStore,
  type OrderType,
  type PaymentMethodContext,
} from "@be-yours/restaurant"
import { isOrderTypeOffered, type StoreServices } from "@be-yours/convex-schema"
import {
  MAX_TABLE_NUMBER_LENGTH,
  normalizeTableNumber,
} from "@be-yours/core/dining"
// The server's own cap on the note, read from the server. A textarea that
// accepts more than `orders.create` stores turns a diner's allergy warning
// into a refused order at the moment of payment.
import { FIELD_LIMITS } from "@be-yours/convex-functions/rateLimit"
// The floor the three card money paths enforce, read from the same module
// they enforce it with, so the tile and the refusal cannot drift apart.
import { cardMinimumFor } from "@be-yours/convex-functions/cardChargeFloor"
import { useGooglePlacesAutocomplete } from "@/hooks/useGooglePlacesAutocomplete"
import type { AddressValue } from "@/lib/address"
import type { SavedAddress } from "@/lib/stores/addresses-store"
import { toast } from "sonner"

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""

const checkoutSchema = z.object({
  name: z.string().min(2, "Le nom est requis"),
  email: z.string().email("Email invalide").or(z.literal("")).optional(),
  phone: z.string().optional(),
  /**
   * What the diner needs the kitchen to know — an allergy, above all.
   *
   * The whole pipeline behind this field already existed: `orders.create`
   * takes `notes`, the order carries it, `releaseToKitchen` copies it onto the
   * ticket and the printed slip has a line for it. There was simply no input
   * anywhere on the storefront, so the line was always blank and a diner with
   * a nut allergy had no way to say so (#376). Optional, and capped at what
   * the server stores.
   */
  notes: z
    .string()
    .max(
      FIELD_LIMITS.orderNote,
      `Note trop longue (${FIELD_LIMITS.orderNote} caractères maximum)`
    )
    .optional(),
})

type CheckoutFormData = z.infer<typeof checkoutSchema>

export type PaymentMethod = "card" | "paypal" | "cash"

interface UserInfo {
  name?: string
  email?: string
  phone?: string
}

interface CheckoutFormProps {
  onSubmit: (data: {
    name: string
    email?: string
    phone?: string
    paymentMethod: PaymentMethod
    /** The diner's note to the kitchen — allergies included. */
    notes?: string
    /** Set only for `dine_in`; the server rejects it on the other types. */
    tableNumber?: string
    deliveryAddress?: {
      street: string
      city: string
      postalCode: string
      country: string
      latitude?: number
      longitude?: number
    }
  }) => void
  isSubmitting: boolean
  addresses: SavedAddress[]
  isAuthenticated: boolean
  /**
   * What the basket currently owes, in cents, as the summary prices it.
   *
   * Needed because a payment tile is not only a question of configuration: a
   * card provider has a floor (0,50 € at Stripe, in EUR) and a 100 % coupon
   * takes an order below it, to zero. `undefined` while the basket is still
   * being priced.
   */
  amountDue?: number
  user?: UserInfo
  /**
   * Reports the delivery address as it changes. Coordinates are included when
   * known — the checkout needs them to request an Uber Direct quote before the
   * order is submitted, since the server now reads the delivery fee from that
   * quote instead of trusting a client-supplied number.
   */
  onAddressChange?: (
    address: { latitude?: number; longitude?: number } | null
  ) => void
  /**
   * The services the store actually offers, or `null` while they load.
   *
   * This form used to carry its own two-option fulfilment toggle that knew
   * nothing about them, so a cart set to `dine_in` showed "À emporter"
   * selected and one click rewrote the type to `pickup` — the customer sat at
   * a table and the kitchen was told to bag the order. The toggle is now the
   * same three types the cart offers, filtered by the same predicate the
   * server validates against.
   */
  services?: StoreServices | null
  /**
   * A way to sign in, rendered where the diner discovers they need one.
   *
   * Cash requires an account — a recorded decision, so the till knows who to
   * call — and a cash-only establishment therefore leaves a guest with no
   * selectable tile at all. The form used to answer that with a disabled
   * button reading « Choisissez un moyen de paiement », in front of nothing to
   * choose (#376). The dialog itself belongs to the app, not to this
   * component, so it arrives as a node.
   */
  signInAction?: ReactNode
}

const fulfillmentOptions: {
  type: OrderType
  label: string
  icon: typeof Truck
}[] = [
  { type: "delivery", label: "Livraison", icon: Truck },
  { type: "pickup", label: "À emporter", icon: ShoppingBag },
  { type: "dine_in", label: "Sur place", icon: Utensils },
]

export function CheckoutForm({
  onSubmit,
  isSubmitting,
  addresses,
  isAuthenticated,
  amountDue,
  user,
  onAddressChange,
  services,
  signInAction,
}: CheckoutFormProps) {
  const orderType = useCartStore((s) => s.orderType)
  const setOrderType = useCartStore((s) => s.setOrderType)
  const isDelivery = orderType === "delivery"
  const isDineIn = orderType === "dine_in"

  // Nothing is offered until the services are known. `null` here means "still
  // loading", not "everything" — guessing is what put Livraison in front of a
  // restaurant that does not deliver.
  const availableFulfillment = services
    ? fulfillmentOptions.filter((opt) => isOrderTypeOffered(opt.type, services))
    : []

  const [tableNumber, setTableNumber] = useState("")
  const [tableNumberError, setTableNumberError] = useState<string | null>(null)

  // Which of the three required address fields are empty, and where to put the
  // cursor when they are. The submit handler used to `return` bare on this
  // condition: no toast, no error text, no focus move, and no error element on
  // any of the fields — the diner pressed « Payer par carte » and NOTHING
  // happened, with no way to find out why. WCAG 3.3.1 is Level A, and this is
  // the money path.
  const [addressErrors, setAddressErrors] = useState<{
    street?: string
    city?: string
    postalCode?: string
  }>({})
  // Three separate refs rather than one object holding them. The object form
  // reads fine and `react-hooks/refs` refuses it: reaching into it for a `ref=`
  // prop is an access during render as far as the rule can tell, and it cannot
  // distinguish that from a real one. Named individually, each `ref=` is a
  // plain identifier.
  const streetRef = useRef<HTMLInputElement>(null)
  const cityRef = useRef<HTMLInputElement>(null)
  const postalCodeRef = useRef<HTMLInputElement>(null)

  /**
   * Which field to put the cursor in, and which attempt asked for it.
   *
   * The submit handler used to focus the field itself. That reads a ref inside
   * a function handed to `handleSubmit` during render, which `react-hooks/refs`
   * refuses — it cannot see that the function is only ever CALLED on submit.
   * Naming the target as state and moving the focus into an effect is the
   * honest fix rather than a suppression: a ref is read where React says refs
   * are read, after the render that produced the error message.
   *
   * `attempt` is what makes a SECOND submission with the same empty field move
   * the cursor again — without it the state would be unchanged and the effect
   * would not re-run.
   */
  const [focusRequest, setFocusRequest] = useState<{
    field: "street" | "city" | "postalCode"
    attempt: number
  } | null>(null)

  useEffect(() => {
    if (!focusRequest) return
    const target =
      focusRequest.field === "street"
        ? streetRef
        : focusRequest.field === "city"
          ? cityRef
          : postalCodeRef
    target.current?.focus()
  }, [focusRequest])

  const globalSettings = useQuery(api.globalSettings.get)
  const payments = globalSettings?.payments
  // Server-measured: can this deployment take a card at all? `cardProvider`
  // only declares WHICH provider; on a fresh deployment nothing is keyed and
  // every card attempt fails, so the tile must not be the default (#374).
  const cardAvailability = useQuery(api.paymentAvailability.get)
  // Two different answers, and the checkout owes the diner a different screen
  // for each. `card === false` with `cardOffered === true` is a deployment
  // that means to take cards and cannot right now — a greyed tile saying so.
  // `cardOffered === false` is an owner who does not take cards at all: the
  // tile has no business being on the page. `undefined` while the query is in
  // flight keeps today's behaviour, which is to show it.
  const cardOffered = cardAvailability?.cardOffered !== false

  const [selectedAddressId, setSelectedAddressId] = useState<
    string | "manual"
  >(addresses.find((a) => a.isDefault)?.id ?? "manual")
  // `null` is "the diner has not chosen": the tile they land on is decided by
  // `resolvePaymentMethod` below, from what the deployment can actually serve.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null)
  const [manualAddress, setManualAddress] = useState<AddressValue>({
    street: "", city: "", postalCode: "", country: "France",
  })
  // "search" = only search bar visible, "selected" = address picked from Google, "manual" = user types manually
  const [addressMode, setAddressMode] = useState<"search" | "selected" | "manual">("search")

  const { inputRef: addressInputRef } = useGooglePlacesAutocomplete({
    apiKey: GOOGLE_MAPS_API_KEY,
    onSelect: (parsed) => {
      setManualAddress((prev) => ({
        street: parsed.street ?? prev.street,
        city: parsed.city ?? prev.city,
        postalCode: parsed.postalCode ?? prev.postalCode,
        country: parsed.country ?? prev.country,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      }))
      setAddressMode("selected")
    },
  })

  const showAddressFields = addressMode === "selected" || addressMode === "manual"

  // The diner's choice while it is servable, else the first servable tile in
  // display order — and `null` when the deployment can serve none, which
  // disables submit instead of sending a doomed attempt. One rule for the
  // default and every fallback; the old inline "reset to card" resolved to a
  // tile no card provider could honour (#374).
  const cardMinimum = cardMinimumFor(globalSettings?.currency)
  const paymentContext: PaymentMethodContext = {
    cardAvailable: cardAvailability?.card,
    cardOffered,
    paypalEnabled: payments?.paypal === true,
    cashEnabled: payments?.cash === true,
    isDelivery,
    isAuthenticated,
    amountDue,
    cardMinimum,
  }
  // Nothing to pay at all — a 100 % coupon. Not a payment method question:
  // there is no charge to route anywhere, so the tiles say so rather than
  // offering a card the provider would refuse and PayPal an order of zero.
  const nothingDue = nothingIsDue(paymentContext)
  // Something IS owed and no card provider will take that little.
  const belowCardFloor =
    !nothingDue && amountDue !== undefined && amountDue < cardMinimum
  const effectivePaymentMethod: PaymentMethod | null = resolvePaymentMethod(
    paymentMethod,
    paymentContext
  )
  // Three reasons a rendered card tile cannot be chosen, and the diner is owed
  // a different sentence for each: the deployment cannot charge one, the order
  // is under the provider's floor, or there is nothing to charge.
  const cardUnavailable = !isPaymentMethodSelectable("card", paymentContext)
  const cardUnavailableReason = nothingDue
    ? "Rien à payer sur cette commande"
    : belowCardFloor
      ? `Minimum ${formatPrice(cardMinimum, globalSettings?.currency)} par carte`
      : "Indisponible pour le moment"
  // The one blocked state that has a way out the diner can take right now:
  // cash is offered on this order type and only an account is missing.
  const cashNeedsAccount =
    payments?.cash === true && !isDelivery && !isAuthenticated
  // Nothing selectable, and the answers are in — `undefined` is still loading,
  // and a notice shown then would flash on every cold checkout.
  const noPaymentMethod =
    !effectivePaymentMethod && cardAvailability !== undefined

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { errors },
  } = useForm<CheckoutFormData>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      name: user?.name ?? "",
      email: user?.email ?? "",
      phone: user?.phone ?? "",
      notes: "",
    },
  })

  // Update form when user session changes (e.g. after sign-in dialog)
  useEffect(() => {
    if (user?.name || user?.email) {
      reset({
        name: user.name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        // Kept: signing in mid-checkout must not silently drop an allergy the
        // diner has already typed.
        notes: getValues("notes") ?? "",
      })
    }
  }, [user?.name, user?.email, user?.phone, reset, getValues])

  // Notify parent when the delivery address changes
  useEffect(() => {
    if (!onAddressChange || !isDelivery) {
      onAddressChange?.(null)
      return
    }
    if (selectedAddressId !== "manual") {
      const saved = addresses.find((a) => a.id === selectedAddressId)
      // Saved addresses carry no coordinates today, so a percentage-mode quote
      // cannot be requested for them — the summary says so rather than failing
      // at submit time.
      onAddressChange(saved ? {} : null)
    } else {
      const hasManual = !!(manualAddress.street.trim() && manualAddress.city.trim() && manualAddress.postalCode.trim())
      onAddressChange(
        hasManual
          ? {
              latitude: manualAddress.latitude,
              longitude: manualAddress.longitude,
            }
          : null
      )
    }
  }, [isDelivery, selectedAddressId, manualAddress, addresses, onAddressChange])

  const handleFormSubmit = (data: CheckoutFormData) => {
    let deliveryAddress:
      | {
          street: string
          city: string
          postalCode: string
          country: string
          latitude?: number
          longitude?: number
        }
      | undefined

    if (isDelivery) {
      if (selectedAddressId !== "manual") {
        const saved = addresses.find((a) => a.id === selectedAddressId)
        if (saved) {
          deliveryAddress = {
            street: saved.street,
            city: saved.city,
            postalCode: saved.postalCode,
            country: saved.country,
            latitude: saved.latitude,
            longitude: saved.longitude,
          }
        }
      } else {
        // Name every empty field, not just the first: a diner who fixes one
        // and presses again should not discover the next one at the same cost.
        const missing: typeof addressErrors = {}
        if (!manualAddress.street.trim()) missing.street = "Indiquez votre adresse"
        if (!manualAddress.city.trim()) missing.city = "Indiquez votre ville"
        if (!manualAddress.postalCode.trim()) {
          missing.postalCode = "Indiquez votre code postal"
        }

        if (missing.street || missing.city || missing.postalCode) {
          setAddressErrors(missing)
          toast.error("Complétez votre adresse de livraison")
          // The first empty one, in reading order. `aria-invalid` and the
          // `role="alert"` paragraph carry the reason; the focus move is what
          // stops a screen-reader user hunting the form for it.
          const first = (["street", "city", "postalCode"] as const).find(
            (field) => missing[field]
          )
          if (first) {
            setFocusRequest((previous) => ({
              field: first,
              attempt: (previous?.attempt ?? 0) + 1,
            }))
          }
          return
        }
        setAddressErrors({})

        deliveryAddress = {
          street: manualAddress.street,
          city: manualAddress.city,
          postalCode: manualAddress.postalCode,
          country: manualAddress.country || "France",
          latitude: manualAddress.latitude,
          longitude: manualAddress.longitude,
        }
      }
    }

    // The table is required here and optional on the server. The server has to
    // accept a `dine_in` order without one — Uber Eats and Deliveroo forward
    // those and they carry no table — but a diner checking out on the
    // storefront is demonstrably sitting at one, and a slip with no table is
    // the defect this field exists to close.
    let table: string | undefined
    if (isDineIn) {
      table = normalizeTableNumber(tableNumber)
      if (!table) {
        setTableNumberError("Indiquez votre numéro de table")
        return
      }
      if (table.length > MAX_TABLE_NUMBER_LENGTH) {
        setTableNumberError(
          `Numéro de table trop long (${MAX_TABLE_NUMBER_LENGTH} caractères maximum)`
        )
        return
      }
      setTableNumberError(null)
    }

    // No servable method: the button is disabled, but a submit can still race
    // the availability answer — refuse it rather than send a doomed attempt.
    if (!effectivePaymentMethod) return

    onSubmit({
      name: data.name,
      email: data.email || undefined,
      phone: data.phone || undefined,
      // Trimmed, and dropped when it is only whitespace: an empty `Note:` line
      // on a kitchen slip is noise a cook has to read past.
      notes: data.notes?.trim() || undefined,
      paymentMethod: effectivePaymentMethod,
      // Sent only for dine-in. Switching the type away from `sur place` must
      // not leave a stale table on the order — the server rejects one on a
      // delivery or pickup order precisely to catch that.
      tableNumber: table,
      deliveryAddress,
    })
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-8">
      {/* Fulfillment Method Selection */}
      <div
        className={`grid gap-4 ${
          availableFulfillment.length === 3
            ? "grid-cols-3"
            : availableFulfillment.length === 2
              ? "grid-cols-2"
              : "grid-cols-1"
        }`}
      >
        {availableFulfillment.map((opt) => {
          const Icon = opt.icon
          // Exact, not a `!== "delivery"` catch-all: that catch-all is what
          // showed "À emporter" lit up for a dine-in cart and then wrote
          // `pickup` over it on the next click.
          const isSelected = orderType === opt.type

          return (
            <button
              key={opt.type}
              type="button"
              onClick={() => setOrderType(opt.type)}
              className={`group flex h-24 flex-col items-center justify-center gap-2 rounded-[2rem] border-2 transition-all ${
                isSelected
                  ? "border-primary bg-primary text-primary-foreground shadow-xl shadow-primary/10"
                  : "border-border bg-card text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              <Icon className="h-6 w-6 transition-colors" />
              <span className="text-[10px] font-black uppercase tracking-widest">
                {opt.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* Table number — dine-in only */}
      {isDineIn && (
        <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
          <div className="p-8 space-y-2">
            <Label htmlFor="tableNumber" className="flex items-center gap-2">
              <Utensils className="h-4 w-4" />
              Numéro de table
            </Label>
            <Input
              id="tableNumber"
              value={tableNumber}
              onChange={(e) => {
                setTableNumber(e.target.value)
                if (tableNumberError) setTableNumberError(null)
              }}
              maxLength={MAX_TABLE_NUMBER_LENGTH}
              placeholder="12, A3, Terrasse 4…"
              aria-invalid={tableNumberError ? true : undefined}
              aria-describedby={
                tableNumberError ? "tableNumber-error" : "tableNumber-hint"
              }
            />
            {tableNumberError ? (
              <p id="tableNumber-error" role="alert" className="text-sm text-destructive">
                {tableNumberError}
              </p>
            ) : (
              <p id="tableNumber-hint" className="text-sm text-muted-foreground">
                Le numéro figure sur votre table. Il est imprimé sur le ticket
                de cuisine pour que votre commande vous soit apportée.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Contact Information */}
      <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
        <div className="p-8">
          <div className="mb-2 flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Mail className="h-5 w-5" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
              Contact
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Renseignez vos coordonnées pour la confirmation de commande.
          </p>
        </div>

        <div className="space-y-4 px-8 pb-8">
          <div className="space-y-2">
            <Label
              htmlFor="name"
              className="ml-1 text-[10px] font-black uppercase tracking-widest"
            >
              Nom complet *
            </Label>
            <Input
              id="name"
              {...register("name")}
              placeholder="Jean Dupont"
              className="h-14 rounded-2xl border-input bg-muted px-6 text-sm font-medium transition-all focus:bg-card focus-visible:ring-ring"
            />
            {errors.name && (
              <p className="ml-1 text-xs font-medium text-destructive">
                {errors.name.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label
                htmlFor="email"
                className="ml-1 text-[10px] font-black uppercase tracking-widest"
              >
                Email
              </Label>
              <Input
                id="email"
                type="email"
                {...register("email")}
                placeholder="jean.dupont@exemple.fr"
                className="h-14 rounded-2xl border-input bg-muted px-6 text-sm font-medium transition-all focus:bg-card focus-visible:ring-ring"
              />
              {errors.email && (
                <p className="ml-1 text-xs font-medium text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="phone"
                className="ml-1 text-[10px] font-black uppercase tracking-widest"
              >
                Téléphone
              </Label>
              <Input
                id="phone"
                type="tel"
                {...register("phone")}
                placeholder="+33 6 00 00 00 00"
                className="h-14 rounded-2xl border-input bg-muted px-6 text-sm font-medium transition-all focus:bg-card focus-visible:ring-ring"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Delivery Address - Conditional */}
      {isDelivery && (
        <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
          <div className="p-8">
            <div className="mb-2 flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <MapPin className="h-5 w-5" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
                Livraison
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Où souhaitez-vous recevoir votre commande ?
            </p>
          </div>

          <div className="space-y-4 px-8 pb-8">
            {/* Saved addresses */}
            {addresses.length > 0 && (
              <div className="space-y-2">
                {addresses.map((addr) => (
                  <button
                    key={addr.id}
                    type="button"
                    onClick={() => setSelectedAddressId(addr.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl border-2 px-5 py-4 text-left text-sm transition-all ${
                      selectedAddressId === addr.id
                        ? "border-primary bg-accent/30"
                        : "border-border hover:border-border"
                    }`}
                  >
                    <div
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                        selectedAddressId === addr.id
                          ? "border-primary bg-primary"
                          : "border-border"
                      }`}
                    >
                      {selectedAddressId === addr.id && (
                        <div className="h-2 w-2 rounded-full bg-card" />
                      )}
                    </div>
                    <div>
                      {addr.label && (
                        <span className="font-bold">{addr.label} — </span>
                      )}
                      <span className="font-medium text-muted-foreground">
                        {addr.street}, {addr.postalCode} {addr.city}
                      </span>
                    </div>
                    {selectedAddressId === addr.id && (
                      <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-success" />
                    )}
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => setSelectedAddressId("manual")}
                  className={`flex w-full items-center gap-3 rounded-2xl border-2 px-5 py-4 text-left text-sm transition-all ${
                    selectedAddressId === "manual"
                      ? "border-primary bg-accent/30"
                      : "border-border hover:border-border"
                  }`}
                >
                  <div
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                      selectedAddressId === "manual"
                        ? "border-primary bg-primary"
                        : "border-border"
                    }`}
                  >
                    {selectedAddressId === "manual" && (
                      <div className="h-2 w-2 rounded-full bg-card" />
                    )}
                  </div>
                  <span className="font-bold text-muted-foreground">
                    Nouvelle adresse
                  </span>
                </button>
              </div>
            )}

            {/* Address autocomplete */}
            {selectedAddressId === "manual" && (
              <div className="space-y-4">
                {addresses.length > 0 && <Separator />}

                {/* Search with Google Places */}
                <div className="space-y-2">
                  <Label
                    htmlFor="address-search"
                    className="ml-1 text-[10px] font-black uppercase tracking-widest"
                  >
                    Rechercher une adresse
                  </Label>
                  <div className="relative">
                    <MapPin className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-accent-foreground" />
                    <input
                      id="address-search"
                      ref={addressInputRef}
                      type="text"
                      placeholder="Ex : 12 rue de la Paix, Paris..."
                      className="storefront-pac-input h-14 w-full rounded-2xl border-2 border-input bg-muted pl-12 pr-6 text-sm font-medium transition-all placeholder:text-muted-foreground focus:border-primary focus:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </div>

                {/* "Can't find my address" fallback */}
                {addressMode === "search" && (
                  <button
                    type="button"
                    onClick={() => setAddressMode("manual")}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-3 text-xs font-bold uppercase tracking-widest text-muted-foreground transition-all hover:border-border hover:text-muted-foreground"
                  >
                    <MapPinOff className="h-3.5 w-3.5" />
                    Je ne trouve pas mon adresse
                  </button>
                )}

                {/* Detail fields — shown after Google select or manual mode */}
                {showAddressFields && (
                  <div className="space-y-4 rounded-2xl border-2 border-primary/20 bg-accent/30 p-5">
                    {addressMode === "selected" && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-success" />
                          <span className="text-[10px] font-black uppercase tracking-widest text-accent-foreground">
                            Adresse sélectionnée
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAddressMode("search")
                            setManualAddress({ street: "", city: "", postalCode: "", country: "France" })
                          }}
                          className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-muted-foreground"
                        >
                          Modifier
                        </button>
                      </div>
                    )}
                    {addressMode === "manual" && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                          Saisie manuelle
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAddressMode("search")
                            setManualAddress({ street: "", city: "", postalCode: "", country: "France" })
                          }}
                          className="text-[10px] font-bold uppercase tracking-widest text-accent-foreground transition-colors hover:text-accent-foreground"
                        >
                          Revenir à la recherche
                        </button>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label
                        htmlFor="delivery-street"
                        className="ml-1 text-[10px] font-black uppercase tracking-widest"
                      >
                        Adresse *
                      </Label>
                      <Input
                        id="delivery-street"
                        ref={streetRef}
                        value={manualAddress.street}
                        onChange={(e) => {
                          setManualAddress((p) => ({ ...p, street: e.target.value }))
                          if (addressErrors.street) {
                            setAddressErrors((p) => ({ ...p, street: undefined }))
                          }
                        }}
                        placeholder="123 rue de la Paix"
                        readOnly={addressMode === "selected"}
                        aria-invalid={addressErrors.street ? true : undefined}
                        aria-describedby={
                          addressErrors.street ? "delivery-street-error" : undefined
                        }
                        className="h-14 rounded-2xl bg-card px-6 text-sm font-medium transition-all"
                      />
                      {addressErrors.street && (
                        <p
                          id="delivery-street-error"
                          role="alert"
                          className="ml-1 text-xs font-medium text-destructive"
                        >
                          {addressErrors.street}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label
                          htmlFor="delivery-city"
                          className="ml-1 text-[10px] font-black uppercase tracking-widest"
                        >
                          Ville *
                        </Label>
                        <Input
                          id="delivery-city"
                          ref={cityRef}
                          value={manualAddress.city}
                          onChange={(e) => {
                            setManualAddress((p) => ({ ...p, city: e.target.value }))
                            if (addressErrors.city) {
                              setAddressErrors((p) => ({ ...p, city: undefined }))
                            }
                          }}
                          placeholder="Paris"
                          readOnly={addressMode === "selected"}
                          aria-invalid={addressErrors.city ? true : undefined}
                          aria-describedby={
                            addressErrors.city ? "delivery-city-error" : undefined
                          }
                          className="h-14 rounded-2xl bg-card px-6 text-sm font-medium transition-all"
                        />
                        {addressErrors.city && (
                          <p
                            id="delivery-city-error"
                            role="alert"
                            className="ml-1 text-xs font-medium text-destructive"
                          >
                            {addressErrors.city}
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label
                          htmlFor="delivery-postal-code"
                          className="ml-1 text-[10px] font-black uppercase tracking-widest"
                        >
                          Code postal *
                        </Label>
                        <Input
                          id="delivery-postal-code"
                          ref={postalCodeRef}
                          value={manualAddress.postalCode}
                          onChange={(e) => {
                            setManualAddress((p) => ({ ...p, postalCode: e.target.value }))
                            if (addressErrors.postalCode) {
                              setAddressErrors((p) => ({ ...p, postalCode: undefined }))
                            }
                          }}
                          placeholder="75001"
                          readOnly={addressMode === "selected"}
                          aria-invalid={addressErrors.postalCode ? true : undefined}
                          aria-describedby={
                            addressErrors.postalCode
                              ? "delivery-postal-code-error"
                              : undefined
                          }
                          className="h-14 rounded-2xl bg-card px-6 text-sm font-medium transition-all"
                        />
                        {addressErrors.postalCode && (
                          <p
                            id="delivery-postal-code-error"
                            role="alert"
                            className="ml-1 text-xs font-medium text-destructive"
                          >
                            {addressErrors.postalCode}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label
                        htmlFor="delivery-country"
                        className="ml-1 text-[10px] font-black uppercase tracking-widest"
                      >
                        Pays
                      </Label>
                      <Input
                        id="delivery-country"
                        value={manualAddress.country}
                        onChange={(e) => setManualAddress((p) => ({ ...p, country: e.target.value }))}
                        readOnly={addressMode === "selected"}
                        className="h-14 rounded-2xl bg-card px-6 text-sm font-medium transition-all"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Allergies and instructions for the kitchen */}
      <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
        <div className="p-8">
          <div className="mb-2 flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/5 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
              Allergies &amp; instructions
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Une allergie, une intolérance, une préférence&nbsp;? Dites-le à la
            cuisine.
          </p>
        </div>

        <div className="space-y-2 px-8 pb-8">
          <Label
            htmlFor="notes"
            className="ml-1 text-[10px] font-black uppercase tracking-widest"
          >
            Note pour la cuisine
          </Label>
          <Textarea
            id="notes"
            rows={3}
            maxLength={FIELD_LIMITS.orderNote}
            {...register("notes")}
            placeholder="Ex : allergie aux arachides, sauce à part, sans oignon…"
            aria-describedby={errors.notes ? "notes-error" : "notes-hint"}
            aria-invalid={errors.notes ? true : undefined}
            className="min-h-[96px] rounded-2xl border-input bg-muted px-6 py-4 text-sm font-medium transition-all focus:bg-card focus-visible:ring-ring"
          />
          {errors.notes ? (
            <p
              id="notes-error"
              role="alert"
              className="ml-1 text-xs font-medium text-destructive"
            >
              {errors.notes.message}
            </p>
          ) : (
            <p id="notes-hint" className="ml-1 text-xs text-muted-foreground">
              Cette note est imprimée sur le ticket de cuisine. Elle ne remplace
              pas un échange avec le restaurant en cas d&apos;allergie grave.
            </p>
          )}
        </div>
      </div>

      {/* Payment section + Submit */}
      <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
        <div className="p-8">
          <div className="mb-2 flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <CreditCard className="h-5 w-5" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
              Paiement
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Choisissez votre moyen de paiement préféré.
          </p>
        </div>

        <div className="px-8 pb-4">
          <div className="grid grid-cols-1 gap-3">
            {/* Card — rendered when the establishment takes cards at all,
                selectable only when it can actually charge one. Pre-selecting
                a dead card tile is what sent every fresh deployment's first
                order into #374; rendering one an owner has switched off is
                what left a cash-only food truck with a payment method it could
                never honour (#376). Two different states, two different
                answers: greyed for the first, absent for the second. */}
            {cardOffered && (
              <button
                type="button"
                onClick={() => !cardUnavailable && setPaymentMethod("card")}
                disabled={cardUnavailable}
                className={`flex items-center gap-4 rounded-2xl border-2 p-4 text-left transition-all ${
                  cardUnavailable
                    ? "border-border bg-muted disabled:opacity-60 cursor-not-allowed"
                    : effectivePaymentMethod === "card"
                      ? "border-primary bg-accent/30"
                      : "border-border hover:border-border"
                }`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  {/* The unavailable tile already carries `disabled:opacity-60`, so the
                      icon needs no second dimming of its own — the ternary that
                      used to be here chose between two greys that #41 maps to
                      the same token. */}
                  <CreditCard className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className={`font-bold ${cardUnavailable ? "text-muted-foreground" : "text-foreground"}`}>Carte bancaire</p>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {cardUnavailable
                      ? cardUnavailableReason
                      : payments?.cardProvider === "sumup" ? "SumUp" : "Visa, Master, Amex"}
                  </p>
                </div>
                {effectivePaymentMethod === "card" && !cardUnavailable && (
                  <CheckCircle2 className="ml-auto h-5 w-5 text-success" />
                )}
              </button>
            )}

            {/* PayPal — if enabled, and only for an amount it can take. Under a
                provider floor, and at zero, there is no PayPal order to open. */}
            {payments?.paypal && isPaymentMethodSelectable("paypal", paymentContext) && (
              <button
                type="button"
                onClick={() => setPaymentMethod("paypal")}
                className={`flex items-center gap-4 rounded-2xl border-2 p-4 text-left transition-all ${
                  effectivePaymentMethod === "paypal"
                    ? "border-primary bg-accent/30"
                    : "border-border hover:border-border"
                }`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                  <span className="text-lg font-black text-blue-600">P</span>
                </div>
                <div>
                  <p className="font-bold text-foreground">PayPal</p>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Paiement sécurisé
                  </p>
                </div>
                {effectivePaymentMethod === "paypal" && (
                  <CheckCircle2 className="ml-auto h-5 w-5 text-success" />
                )}
              </button>
            )}

            {/* Cash — if enabled AND order is not delivery.
                An order that owes nothing is the fourth state, and it is not a
                payment: the cash branch is simply the one that places the
                order without calling a provider, so it is offered whatever the
                cash settings say. Its own gates are about who may hand over
                money and where, and nobody is handing over any. */}
            {(nothingDue || (payments?.cash && !isDelivery)) && (
              <button
                type="button"
                onClick={() =>
                  (isAuthenticated || nothingDue) && setPaymentMethod("cash")
                }
                disabled={!isAuthenticated && !nothingDue}
                className={`flex items-center gap-4 rounded-2xl border-2 p-4 text-left transition-all ${
                  !isAuthenticated && !nothingDue
                    ? "border-border bg-muted disabled:opacity-60 cursor-not-allowed"
                    : effectivePaymentMethod === "cash"
                      ? "border-primary bg-accent/30"
                      : "border-border hover:border-border"
                }`}
              >
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${isAuthenticated || nothingDue ? "bg-accent" : "bg-muted"}`}>
                  <Banknote className={`h-6 w-6 ${isAuthenticated || nothingDue ? "text-accent-foreground" : "text-muted-foreground"}`} />
                </div>
                <div>
                  <p className={`font-bold ${isAuthenticated || nothingDue ? "text-foreground" : "text-muted-foreground"}`}>
                    {nothingDue ? "Rien à payer" : "Espèces"}
                  </p>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {nothingDue
                      ? "Cette commande est offerte"
                      : isAuthenticated
                        ? "Paiement au retrait"
                        : "Connectez-vous pour payer en espèces"}
                  </p>
                </div>
                {effectivePaymentMethod === "cash" && (isAuthenticated || nothingDue) && (
                  <CheckCircle2 className="ml-auto h-5 w-5 text-success" />
                )}
              </button>
            )}
          </div>
          {/*
            No tile is selectable. Say which of the two situations this is and
            what to do about it — a disabled button in front of an empty grid
            tells a diner nothing, and it is the last screen before they give
            up. A cash-only establishment reaches this on every guest checkout.

            The amber stays literal through #41's tokenisation: it means
            "warning", not "brand", so a template must not recolour it — the
            same reasoning that kept the order-status pill and the cancelled
            red out of the sweep.
          */}
          {noPaymentMethod && (
            <div
              role="alert"
              className="mt-3 space-y-3 rounded-2xl border-2 border-amber-200 bg-amber-50 p-5"
            >
              <p className="text-sm font-medium text-amber-900">
                {cashNeedsAccount
                  ? "Le paiement en espèces sur place est le seul moyen disponible ici. Connectez-vous pour confirmer votre commande : nous avons besoin d'un nom et d'un contact pour la préparer."
                  : "Aucun moyen de paiement n'est disponible en ligne pour le moment. Contactez le restaurant pour commander."}
              </p>
              {cashNeedsAccount && signInAction}
            </div>
          )}

          <p className="mt-3 text-[10px] font-medium italic text-muted-foreground">
            Le paiement sera traité de manière sécurisée au moment de la validation.
          </p>
        </div>

        <div className="px-8 pb-8 pt-4">
          {/*
            Acceptance of the CGV, stated where the contract is concluded. The
            pages are the engine's own (`/cgv`, `/confidentialite`), linked from
            every footer too; this line is what makes them part of the order
            rather than a page a diner might never open. A statement beside the
            button, not a checkbox: whether counsel wants a box ticked is a
            decision recorded on the pull request that added this line.
          */}
          <p
            data-testid="checkout-terms-acceptance"
            className="mb-4 text-xs leading-relaxed text-muted-foreground"
          >
            En validant votre commande, vous acceptez nos{" "}
            <Link href="/cgv" className="font-semibold text-foreground underline underline-offset-2">
              conditions générales de vente
            </Link>
            . Vos données sont utilisées pour préparer et vous remettre votre
            commande, comme décrit dans notre{" "}
            <Link
              href="/confidentialite"
              className="font-semibold text-foreground underline underline-offset-2"
            >
              politique de confidentialité
            </Link>
            .
          </p>
          <Button
            type="submit"
            disabled={isSubmitting || !effectivePaymentMethod}
            className="group h-16 w-full rounded-2xl bg-primary text-lg font-black uppercase tracking-widest text-primary-foreground shadow-xl shadow-primary/10 transition-all hover:bg-primary-hover"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Traitement en cours...
              </span>
            ) : (
              <>
                {effectivePaymentMethod === "card"
                  ? "Payer par carte"
                  : effectivePaymentMethod === "paypal"
                    ? "Payer avec PayPal"
                    : effectivePaymentMethod === "cash"
                      ? "Confirmer la commande"
                      : /* Not "choose a payment method": on a cash-only
                           establishment there is nothing on this screen to
                           choose, and the button said so to every guest. */
                        cashNeedsAccount
                        ? "Connectez-vous pour continuer"
                        : "Aucun paiement disponible"}
                <ArrowRight className="ml-2 h-6 w-6 transition-transform group-hover:translate-x-1" />
              </>
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
