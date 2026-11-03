"use client"

import { Search, ShoppingBag } from "lucide-react"
import {
  Skeleton,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@be-yours/ui"
import { isProductAvailable, useTranslation } from "@be-yours/restaurant"
import type { ProductDoc } from "@be-yours/restaurant"
import { useFavorites } from "@/lib/hooks/use-favorites"
import { StorefrontProductCard } from "./storefront-product-card"

interface ProductGridProps {
  products: ProductDoc[] | undefined
  storeId: string | null
  isStoreOpen: boolean
  /** `globalSettings.timezone` — the clock a serving window is read on. */
  timeZone?: string
  onProductClick: (product: ProductDoc) => void
  onAddToCart: (product: ProductDoc) => void
}

export function ProductGrid({
  products,
  storeId,
  isStoreOpen,
  timeZone,
  onProductClick,
  onAddToCart,
}: ProductGridProps) {
  const { isFavorite, toggleFavorite } = useFavorites()
  const { t } = useTranslation()

  // Loading state
  if (products === undefined) {
    return (
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-[2.5rem] border border-border bg-card">
            <Skeleton className="aspect-[4/3] w-full" />
            <div className="p-8 space-y-3">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
              <div className="flex items-center justify-between pt-4">
                <div className="space-y-1">
                  <Skeleton className="h-2 w-8" />
                  <Skeleton className="h-6 w-16" />
                </div>
                <Skeleton className="h-12 w-12 rounded-2xl" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Empty state
  if (products.length === 0) {
    return (
      <Empty className="col-span-full py-32">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search className="h-5 w-5" />
          </EmptyMedia>
          <EmptyTitle>{t("storefront.noDishesFound")}</EmptyTitle>
          <EmptyDescription>{t("storefront.noDishesMessage")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    // `storefront-menu` is the hook for the `menu` layout family (#507), not
    // styling. The default here IS `cards` — a grid of photo cards — so an
    // unstyled grid is already correct.
    <div className="storefront-menu grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
      {products.map((product) => (
        <StorefrontProductCard
          key={product._id}
          product={product}
          storeId={storeId ?? ""}
          isStoreOpen={isStoreOpen}
          timeZone={timeZone}
          isFavorite={storeId ? isFavorite(product._id, storeId) : false}
          onToggleFavorite={() => storeId && toggleFavorite(product._id, storeId)}
          onClick={() => onProductClick(product)}
          onAddToCart={() => onAddToCart(product)}
        />
      ))}
    </div>
  )
}
