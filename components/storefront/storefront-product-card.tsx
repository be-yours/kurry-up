"use client"

import Image from "next/image"
import { Heart, Plus, ShoppingBag } from "lucide-react"
import {
  formatPrice,
  isProductAvailable,
  useLocalizedDocument,
  useTranslation,
} from "@be-yours/restaurant"
import type { ProductDoc } from "@be-yours/restaurant"
import { Badge } from "@be-yours/ui"

interface StorefrontProductCardProps {
  product: ProductDoc
  storeId: string
  isStoreOpen: boolean
  /** `globalSettings.timezone` — the clock a serving window is read on. */
  timeZone?: string
  isFavorite: boolean
  onToggleFavorite: () => void
  onClick?: () => void
  onAddToCart?: () => void
  otherStore?: boolean
}

/**
 * Product images go through `next/image`, not a raw `<img>`.
 *
 * A menu page renders twelve of these, and each one used to fetch the
 * full-size original an owner uploaded — a 3 MB photograph from a phone,
 * scaled down by the browser, on every card, with no lazy loading and no
 * modern format. `next/image` resizes to the slot, serves AVIF or WebP where
 * the browser accepts it, and defers everything below the fold.
 *
 * Deliberately no `priority`: every grid this card appears in sits under a
 * full-height hero, so no card is above the fold and marking one would only
 * delay the hero that is.
 */
export function StorefrontProductCard({
  product: sourceProduct,
  storeId,
  isStoreOpen,
  timeZone,
  isFavorite: favorited,
  onToggleFavorite,
  onClick,
  onAddToCart,
  otherStore,
}: StorefrontProductCardProps) {
  // The card is what the menu, the homepage and the favourites grid all render
  // through, so localising here is what puts a translated catalogue in front
  // of a customer everywhere at once.
  const product = useLocalizedDocument(sourceProduct)
  const { t } = useTranslation()
  const available = isProductAvailable(product, timeZone)
  const canAdd = available && isStoreOpen && !otherStore

  return (
    <div
      onClick={onClick}
      className={`storefront-menu-item bg-card rounded-[2.5rem] overflow-hidden shadow-2xl shadow-black/[0.04] border border-white/10 hover:border-primary/20 transition-all group flex flex-col h-full duration-300 ${
        onClick ? "cursor-pointer hover:-translate-y-2.5" : ""
      }`}
    >
      {/* Image */}
      <div className="storefront-menu-photo relative aspect-[4/3] overflow-hidden bg-muted">
        {product.images?.[0] ? (
          <Image
            src={product.images[0]}
            alt={product.name}
            fill
            // The card sits in a four-column grid at desktop, two at tablet,
            // one on a phone. Without this the optimiser is asked for a
            // full-viewport image for a quarter-viewport slot, twelve times a
            // menu page.
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
            className={`object-cover group-hover:scale-110 transition-all duration-700 ${
              otherStore ? "opacity-60" : ""
            }`}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ShoppingBag className="h-12 w-12" />
          </div>
        )}

        {/* Badge top-left */}
        <div className="absolute top-4 left-4 flex gap-2">
          {otherStore ? (
            <Badge variant="secondary" className="bg-card/90 backdrop-blur-md border-none py-1.5 px-3 rounded-lg font-bold uppercase text-[9px] shadow-sm">
              {t("product.otherRestaurant")}
            </Badge>
          ) : product.isFeatured ? (
            <span className="bg-card/90 backdrop-blur-md text-foreground border-none py-1.5 px-3 rounded-lg font-bold uppercase text-[9px] shadow-sm">
              {t("product.popular")}
            </span>
          ) : !available ? (
            <span className="bg-card/90 backdrop-blur-md text-foreground border-none py-1.5 px-3 rounded-lg font-bold uppercase text-[9px] shadow-sm">
              {t("product.unavailable")}
            </span>
          ) : null}
        </div>

        {/* Favorite top-right */}
        {/*
          Named, and its state announced. An icon-only control with no text and
          no `aria-label` reaches a screen reader as "button" and nothing else —
          there were two of these per dish, so a five-dish menu had ten unnamed
          buttons and a fifty-dish carte a hundred. `aria-pressed` is what says
          whether this heart is already filled, which the colour alone says only
          to someone who can see it.
        */}
        <button
          type="button"
          aria-label={
            favorited
              ? t("product.removeFromFavorites", { name: product.name })
              : t("product.addToFavorites", { name: product.name })
          }
          aria-pressed={favorited}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className="storefront-menu-fav absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-card/90 shadow-sm backdrop-blur-sm transition-all hover:bg-card hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Heart
            aria-hidden="true"
            className={`h-4 w-4 transition-colors ${
              favorited
                ? "fill-destructive text-destructive"
                : "text-muted-foreground"
            }`}
          />
        </button>

        {/* Unavailable overlay */}
        {!available && (
          <div className="absolute inset-0 bg-white/40" />
        )}
      </div>

      {/* Content */}
      {/* `storefront-menu-*` below are hooks for the `menu` layout family
          (#507), not styling. `tickets` turns this card into a row and `dotted`
          into a priced line, and neither can be written against Tailwind's
          generated class names — those are not a contract. The default is
          `cards`, which is what this markup already renders, so an unstyled
          card is correct. */}
      <div className="storefront-menu-body p-8 flex flex-col flex-1">
        {/*
          THE DISH'S NAME IS THE CONTROL, and that is what makes the card
          reachable from a keyboard at all.

          The card is a `<div onClick>`. Measured live on the bench it reported
          `tabIndex: -1` and `role: null`, so a keyboard user could not open a
          dish — which on this storefront means they could not choose a required
          option, and therefore could not order half the menu.

          The obvious repair — `role="button" tabIndex={0}` on the card — is
          invalid here: this card already contains two buttons (favourite, add
          to basket), and a button inside a button is not a thing a browser or a
          screen reader can represent. Promoting the TITLE instead gives a
          keyboard user three ordinary stops in reading order and leaves the
          card's own click handler for pointer users, where it was never a
          problem.
        */}
        <h3 className="storefront-menu-name mb-3 leading-tight">
          {onClick ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClick()
              }}
              className="text-left text-lg font-black uppercase tracking-tighter text-foreground line-clamp-1 transition-colors group-hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {product.name}
            </button>
          ) : (
            <span className="line-clamp-1 text-lg font-black uppercase tracking-tighter text-foreground transition-colors group-hover:text-accent-foreground">
              {product.name}
            </span>
          )}
        </h3>

        {product.description && (
          <p className="storefront-menu-desc text-xs text-muted-foreground line-clamp-2 mb-4 leading-relaxed">
            {product.description}
          </p>
        )}

        <div className="storefront-menu-foot mt-auto flex items-center justify-between gap-4">
          <div className="storefront-menu-price flex flex-col">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none mb-1">
              {t("product.price")}
            </span>
            <span className="text-xl font-black text-accent-foreground leading-none">
              {formatPrice(product.price)}
            </span>
            {/* « Prix barré TTC » had zero storefront readers (#626). The admin
                collected it, the field is on every product, and a diner never
                saw one — so an owner ran a markdown that showed nowhere. Drawn
                only when it is genuinely above the price, which is what
                `compareAtPrice` means and the only case where a strikethrough
                is honest. */}
            {typeof product.compareAtPrice === "number" &&
            product.compareAtPrice > product.price ? (
              <span className="mt-1 text-sm font-medium text-muted-foreground line-through leading-none">
                {formatPrice(product.compareAtPrice)}
              </span>
            ) : null}
          </div>

          {canAdd && onAddToCart ? (
            <button
              type="button"
              aria-label={t("product.addNamedToCart", { name: product.name })}
              onClick={(e) => {
                e.stopPropagation()
                onAddToCart()
              }}
              className="storefront-menu-add flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/10 transition-all hover:scale-110 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <Plus className="h-6 w-6" aria-hidden="true" />
            </button>
          ) : (
            // Decoration, not a control: it cannot be pressed and the badge
            // above already says why. Announcing a greyed plus as "button"
            // offers a screen-reader user something that does not exist.
            <div
              aria-hidden="true"
              className="storefront-menu-add flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
            >
              <Plus className="h-6 w-6" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
