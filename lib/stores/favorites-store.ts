"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Favorite item with store context for multi-store support
 */
export interface FavoriteItem {
  productId: string
  storeId: string
}

interface FavoritesState {
  favorites: FavoriteItem[]
}

interface FavoritesActions {
  toggleFavorite: (productId: string, storeId: string) => void
  isFavorite: (productId: string, storeId: string) => boolean
  getFavoritesByStore: (storeId: string) => FavoriteItem[]
  clearFavorites: () => void
}

type FavoritesStore = FavoritesState & FavoritesActions

/**
 * Favorites Zustand store — V1 localStorage persistence
 *
 * Each favorite stores { productId, storeId } to support multi-store filtering.
 * Sync to Convex per authenticated user is planned for V2.
 */
export const useFavoritesStore = create<FavoritesStore>()(
  persist(
    (set, get) => ({
      favorites: [],

      toggleFavorite: (productId, storeId) => {
        set((state) => {
          const exists = state.favorites.some(
            (f) => f.productId === productId && f.storeId === storeId
          )
          if (exists) {
            return {
              favorites: state.favorites.filter(
                (f) => !(f.productId === productId && f.storeId === storeId)
              ),
            }
          }
          return {
            favorites: [...state.favorites, { productId, storeId }],
          }
        })
      },

      isFavorite: (productId, storeId) => {
        return get().favorites.some(
          (f) => f.productId === productId && f.storeId === storeId
        )
      },

      getFavoritesByStore: (storeId) => {
        return get().favorites.filter((f) => f.storeId === storeId)
      },

      clearFavorites: () => {
        set({ favorites: [] })
      },
    }),
    {
      name: "beindigital-favorites",
    }
  )
)
