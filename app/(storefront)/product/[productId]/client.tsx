"use client"

import type { ProductDoc } from "@be-yours/restaurant"
import { ProductDetailClient } from "@/components/storefront/product-detail-client"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { Skeleton } from "@be-yours/ui"

interface Props {
  product: ProductDoc
}

export function ProductDetailClientPage({ product }: Props) {
  const { storeId, isLoading } = useStoreId()

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="grid gap-8 md:grid-cols-2">
          <Skeleton className="aspect-square rounded-2xl" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (!storeId) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <p className="text-muted-foreground">Veuillez sélectionner un restaurant.</p>
        <a href="/store-selector" className="mt-4 inline-block text-accent-foreground hover:underline">
          Choisir un restaurant
        </a>
      </div>
    )
  }

  return <ProductDetailClient product={product} storeId={storeId} />
}
