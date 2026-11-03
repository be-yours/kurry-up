"use client"

import { useCallback, useId, useRef, useState } from "react"
import { Check, Heart, Minus, Plus, ShoppingBag, Clock } from "lucide-react"
import Link from "next/link"
import { Badge, Separator, Label, AllergenBadge, SpiceLevelIndicator } from "@be-yours/ui"
import { resolveAllergens } from "@be-yours/core/allergens"
import {
  useCartStore,
  formatPrice,
  calculateProductPrice,
  isProductAvailable,
  useLocalizedDocument,
} from "@be-yours/restaurant"
import type { ProductDoc, CartSelectedOption } from "@be-yours/restaurant"
import { useFavorites } from "@/lib/hooks/use-favorites"
import { useStoreStatus } from "@/lib/hooks/use-store-status"
import { toast } from "sonner"
import { recordSignal } from "@be-yours/restaurant"

interface ProductDetailClientProps {
  product: ProductDoc
  storeId: string
}

export function ProductDetailClient({
  product: sourceProduct,
  storeId,
}: ProductDetailClientProps) {
  // Localised here rather than at each call site: the name this component
  // renders is also the name it writes into the cart, and the two must agree.
  const product = useLocalizedDocument(sourceProduct)
  const addItem = useCartStore((s: { addItem: (item: import("@be-yours/restaurant").NewCartItem) => void }) => s.addItem)
  const cartStoreId = useCartStore((s: { storeId: string | null }) => s.storeId)
  const { isFavorite, toggleFavorite } = useFavorites()
  const { isOpen, timeZone } = useStoreStatus(storeId)

  const [quantity, setQuantity] = useState(1)
  /* THE OTHER FIVE PHOTOGRAPHS (#626). `product-images-field.tsx` offers six
     reorderable slots and every storefront reader took `images[0]`, so an owner
     uploaded six photographs and a diner saw one. That is what moved PM9 Image
     Gallery from absent to PARTIAL in the feature ledger: the uploader landed
     without a reader.
     Empty entries are dropped rather than rendered as gaps — the slots are
     reorderable, so a cleared middle slot is an ordinary state. */
  const images = (product.images ?? []).filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  )
  const [activeImage, setActiveImage] = useState(0)
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string[]>
  >({})

  const optionsId = useId()

  /**
   * The first control of each option group, so a refused add-to-cart can send
   * the customer to the choice it is waiting for.
   *
   * A toast naming the missing option is fine for a mouse; a keyboard user is
   * left at the bottom of the page with no idea where "Taille" is.
   */
  const firstChoiceInput = useRef<Map<string, HTMLInputElement>>(new Map())

  const registerChoiceInput = useCallback(
    (optionId: string, choiceId: string, el: HTMLInputElement | null) => {
      const key = `${optionId}:${choiceId}`
      const map = firstChoiceInput.current
      if (el) map.set(key, el)
      else map.delete(key)
    },
    []
  )

  const focusFirstChoice = useCallback((optionId: string) => {
    for (const [key, el] of firstChoiceInput.current) {
      if (key.startsWith(`${optionId}:`)) {
        el.focus()
        return
      }
    }
  }, [])

  const available = isProductAvailable(product, timeZone)
  const canAdd = available && isOpen

  // Build cart options from selected state
  const cartOptions: CartSelectedOption[] = []
  for (const option of product.options ?? []) {
    const selectedChoiceIds = selectedOptions[option.id] ?? []
    for (const choiceId of selectedChoiceIds) {
      const choice = option.choices.find((c) => c.id === choiceId)
      if (choice) {
        cartOptions.push({
          name: option.name,
          choice: choice.name,
          priceModifier: choice.priceModifier,
        })
      }
    }
  }

  const totalPrice = calculateProductPrice(product.price, cartOptions)

  const handleOptionToggle = (optionId: string, choiceId: string, maxSelections?: number) => {
    setSelectedOptions((prev) => {
      const current = prev[optionId] ?? []

      if (maxSelections === 1) {
        return { ...prev, [optionId]: [choiceId] }
      }

      if (current.includes(choiceId)) {
        return {
          ...prev,
          [optionId]: current.filter((id) => id !== choiceId),
        }
      }

      if (maxSelections && current.length >= maxSelections) {
        return prev
      }

      return { ...prev, [optionId]: [...current, choiceId] }
    })
  }

  const handleAddToCart = () => {
    if (!canAdd) return

    if (cartStoreId && cartStoreId !== storeId) {
      toast.error("Vous avez des articles d'un autre restaurant dans votre Box. Videz-la d'abord.")
      return
    }

    for (const option of product.options ?? []) {
      if (option.required && !(selectedOptions[option.id]?.length)) {
        toast.error(`Veuillez sélectionner : ${option.name}`)
        focusFirstChoice(option.id)
        return
      }
    }

    /* Counted here and at the two other doors into the cart — a dish page, a
       formule and the favourites grid. The cart store itself is in
       `@be-yours/restaurant`, which cannot reach the storefront's collector,
       so the emit lives at each call site and `audience-signal-sites.test.ts`
       is what stops a fourth door being added without one. */
    recordSignal("add_to_cart")
    addItem({
      productId: product._id,
      name: product.name,
      price: product.price,
      taxRate: product.taxRate,
      categoryId: product.categoryId,
      quantity,
      options: cartOptions,
      imageUrl: images[0],
    })

    toast.success(`${product.name} ajouté à la Box`)
  }

  return (
    <>
      {/* Image */}
      <div className="relative aspect-video w-full bg-muted">
        {images[0] ? (
          <img
            src={images[activeImage] ?? images[0]}
            alt={
              images.length > 1
                ? `${product.name} — photo ${activeImage + 1} sur ${images.length}`
                : product.name
            }
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ShoppingBag className="h-16 w-16" />
          </div>
        )}

        {/* Badges */}
        <div className="absolute top-6 left-6 flex gap-2">
          {product.isFeatured && (
            <span className="bg-card/90 backdrop-blur-md text-foreground border-none py-2 px-4 rounded-xl font-bold uppercase text-[10px] shadow-sm">
              Populaire
            </span>
          )}
          {!available && (
            <span className="bg-destructive/90 backdrop-blur-md text-destructive-foreground border-none py-2 px-4 rounded-xl font-bold uppercase text-[10px] shadow-sm">
              Indisponible
            </span>
          )}
        </div>

        {/* Favorite */}
        <div className="absolute top-6 right-6 z-10">
          <button
            type="button"
            aria-label={
              isFavorite(product._id, storeId)
                ? `Retirer ${product.name} des favoris`
                : `Ajouter ${product.name} aux favoris`
            }
            aria-pressed={isFavorite(product._id, storeId)}
            onClick={() => toggleFavorite(product._id, storeId)}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-card/90 shadow-md backdrop-blur-sm transition-all hover:bg-card hover:scale-110"
          >
            <Heart
              className={`h-5 w-5 ${
                isFavorite(product._id, storeId)
                  ? "fill-destructive text-destructive"
                  : "text-muted-foreground"
              }`}
            />
          </button>
        </div>
      </div>

      {/* The other photographs, reachable (#626). A row of thumbnails rather
          than a swipe-only carousel: this is also the keyboard and screen-reader
          path, and a diner choosing a dish is comparing pictures rather than
          browsing them. Hidden entirely for a product with one photograph, so
          nothing new appears on the common case. */}
      {images.length > 1 ? (
        <div
          className="flex gap-3 overflow-x-auto px-10 pt-6"
          role="group"
          aria-label={`Photos de ${product.name}`}
        >
          {images.map((url, index) => (
            <button
              key={url}
              type="button"
              onClick={() => setActiveImage(index)}
              aria-label={`Voir la photo ${index + 1} sur ${images.length}`}
              aria-current={index === activeImage}
              className={`relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 transition-all ${
                index === activeImage
                  ? "border-accent-foreground"
                  : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}

      {/* Content */}
      <div className="p-10 space-y-6">
        {/* Header */}
        <div className="space-y-4 text-left">
          {/* Allergens & Tags */}
          <div className="flex items-center gap-4 flex-wrap">
            {/*
              Resolved, not mapped raw. Rendering `product.allergens` directly
              showed two "Lait" badges for a dish tagged both `lactose` and
              `lait`, where the kitchen slip — which resolves — showed one, and
              it handed React a duplicate key. The dish page and the slip have
              to agree about what a diner was told.
            */}
            {resolveAllergens(product.allergens).map((entry) => (
              <AllergenBadge key={entry.raw} allergen={entry.raw} />
            ))}
            {product.spiceLevel !== undefined && product.spiceLevel > 0 && (
              <SpiceLevelIndicator level={product.spiceLevel} />
            )}
          </div>

          <h2 className="text-4xl font-black tracking-tighter text-foreground uppercase italic leading-none">
            {product.name}
          </h2>

          {product.description && (
            <p className="text-muted-foreground font-medium leading-relaxed text-lg">
              {product.description}
            </p>
          )}
        </div>

        {/* Tags */}
        {product.tags && product.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {product.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted border border-border px-3 py-1 text-[10px] font-black uppercase tracking-widest text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Options */}
        {(product.options?.length ?? 0) > 0 && (
          <div className="space-y-10">
            {product.options?.map((option) => {
              const isRadio = option.maxSelections === 1
              const labelId = `${optionsId}-${option.id}-label`
              const hintId = `${optionsId}-${option.id}-hint`

              return (
                <div key={option.id} className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      {/* `id`, not `htmlFor`: this names the group below, and a
                          group of controls has no single control to point at. */}
                      <Label
                        id={labelId}
                        className="text-sm font-black uppercase tracking-tighter text-foreground flex items-center gap-2"
                      >
                        {option.name}
                        {option.required && (
                          <span className="bg-primary/10 text-accent-foreground border-none py-0.5 px-2 rounded-md text-[8px] font-black uppercase">
                            Requis
                          </span>
                        )}
                      </Label>
                      <p
                        id={hintId}
                        className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest"
                      >
                        {isRadio
                          ? "Choisir 1"
                          : option.maxSelections
                            ? `Jusqu'à ${option.maxSelections}`
                            : "Sélectionner"}
                      </p>
                    </div>
                  </div>

                  {/*
                    A real group, holding real controls.

                    This was a `<div onClick>` containing a `<div>` drawn to look
                    like a radio: nothing focusable, no role, no key handler. A
                    keyboard or screen-reader user could not select a REQUIRED
                    option, so `handleAddToCart` refused them and the dish could
                    not be bought at all. The native inputs below bring arrow-key
                    navigation, roving focus, Space/Enter and the checked state
                    with them, and the `<label>` wrapper is what makes the whole
                    row clickable — one toggle path instead of two.
                  */}
                  <div
                    role={isRadio ? "radiogroup" : "group"}
                    aria-labelledby={labelId}
                    aria-describedby={hintId}
                    aria-required={isRadio && option.required ? true : undefined}
                    className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                  >
                    {option.choices.map((choice) => {
                      const isSelected = (selectedOptions[option.id] ?? []).includes(choice.id)
                      const atLimit =
                        !isRadio &&
                        !isSelected &&
                        option.maxSelections !== undefined &&
                        (selectedOptions[option.id] ?? []).length >= option.maxSelections

                      return (
                        <label
                          key={choice.id}
                          className={`flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer group has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:border-primary ${
                            isSelected
                              ? "bg-accent border-primary/20"
                              : "bg-muted border-border hover:border-primary/20"
                          } ${atLimit ? "pointer-events-none opacity-50" : ""}`}
                        >
                          <div className="flex items-center gap-4">
                            {/* Visually replaced by the marker beside it, never
                                visually hidden from focus: `sr-only` keeps it
                                in the tab order and in the accessibility tree,
                                and the ring above is drawn on the row. */}
                            <input
                              type={isRadio ? "radio" : "checkbox"}
                              className="sr-only"
                              name={isRadio ? `${optionsId}-${option.id}` : undefined}
                              value={choice.id}
                              checked={isSelected}
                              disabled={atLimit}
                              required={isRadio && option.required}
                              ref={(el) => {
                                registerChoiceInput(option.id, choice.id, el)
                              }}
                              onChange={() =>
                                handleOptionToggle(option.id, choice.id, option.maxSelections)
                              }
                            />
                            {isRadio ? (
                              <span
                                aria-hidden="true"
                                className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                                  isSelected
                                    ? "border-primary bg-primary"
                                    : "border-border"
                                }`}
                              >
                                {isSelected && <span className="h-2 w-2 rounded-full bg-card" />}
                              </span>
                            ) : (
                              <span
                                aria-hidden="true"
                                className={`h-5 w-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                                  isSelected
                                    ? "border-primary bg-primary"
                                    : "border-border"
                                }`}
                              >
                                {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                              </span>
                            )}
                            <span className="font-bold text-sm text-foreground">
                              {choice.name}
                            </span>
                          </div>
                          <span className="font-black text-[10px] text-accent-foreground">
                            {choice.priceModifier > 0
                              ? `+ ${formatPrice(choice.priceModifier)}`
                              : "Inclus"}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <Separator className="bg-muted" />

        {/* Footer: Price + Quantity + Add */}
        <div className="flex items-center justify-between pt-6">
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none mb-1">
              Prix total
            </span>
            <span className="text-4xl font-black text-accent-foreground tracking-tighter leading-none">
              {formatPrice(totalPrice * quantity)}
            </span>
            {/* The strikethrough price, on the detail page too (#626).
                Scaled by the quantity so the two figures are comparable, and
                only while no option has changed the price — a markdown on the
                base dish says nothing about a dish with three supplements. */}
            {typeof product.compareAtPrice === "number" &&
            product.compareAtPrice > product.price &&
            totalPrice === product.price ? (
              <span className="mt-1 text-lg font-medium text-muted-foreground line-through leading-none">
                {formatPrice(product.compareAtPrice * quantity)}
              </span>
            ) : null}
          </div>

          <div className="flex gap-4 items-center">
            {/* Quantity */}
            <div className="flex items-center bg-muted rounded-2xl p-2 border border-border h-16">
              <button
                type="button"
                aria-label="Diminuer la quantité"
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                disabled={quantity <= 1}
                className="h-12 w-12 rounded-xl text-muted-foreground hover:text-accent-foreground hover:bg-card transition-all flex items-center justify-center disabled:opacity-30"
              >
                <Minus className="h-5 w-5" />
              </button>
              <div className="w-12 text-center font-black text-lg text-foreground">
                {quantity}
              </div>
              <button
                type="button"
                aria-label="Augmenter la quantité"
                onClick={() => setQuantity(quantity + 1)}
                className="h-12 w-12 rounded-xl text-muted-foreground hover:text-accent-foreground hover:bg-card transition-all flex items-center justify-center"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>

            {/* Add to cart */}
            <button
              onClick={handleAddToCart}
              disabled={!canAdd}
              className={`h-16 px-10 rounded-2xl font-black uppercase tracking-widest text-sm shadow-xl transition-all flex items-center gap-3 ${
                canAdd
                  ? "bg-primary hover:bg-primary-hover text-primary-foreground shadow-primary/20"
                  : "bg-muted-foreground text-background cursor-not-allowed shadow-none"
              }`}
            >
              <ShoppingBag className="h-5 w-5" />
              {!available
                ? "Indisponible"
                : !isOpen
                  ? "Fermé"
                  : "Ajouter"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
