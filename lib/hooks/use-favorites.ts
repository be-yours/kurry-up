"use client"

import { useCallback, useMemo } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/**
 * Hook: useFavorites
 *
 * Provides favorites state and actions backed by Convex.
 * Returns empty favorites for unauthenticated users.
 */
export function useFavorites() {
  const favorites = useQuery(api.favorites.myFavorites) ?? []
  const toggleMutation = useMutation(api.favorites.toggleFavorite)

  const favoriteProductIds = useMemo(
    () => new Set(favorites.map((f: { productId: string; storeId: string }) => `${f.productId}:${f.storeId}`)),
    [favorites]
  )

  const isFavorite = useCallback(
    (productId: string, storeId: string) => {
      return favoriteProductIds.has(`${productId}:${storeId}`)
    },
    [favoriteProductIds]
  )

  const toggleFavorite = useCallback(
    (productId: string, storeId: string) => {
      toggleMutation({
        productId: productId as Id<"products">,
        storeId: storeId as Id<"stores">,
      })
    },
    [toggleMutation]
  )

  const getFavoritesByStore = useCallback(
    (storeId: string) => {
      return favorites.filter((f: { storeId: string }) => f.storeId === storeId)
    },
    [favorites]
  )

  return {
    favorites,
    isFavorite,
    toggleFavorite,
    getFavoritesByStore,
  }
}
