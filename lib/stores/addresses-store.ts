"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Saved address for checkout
 */
export interface SavedAddress {
  id: string
  label?: string
  street: string
  city: string
  postalCode: string
  country: string
  isDefault: boolean
  /** Filled by the autocomplete when the address is first saved. Absent on
   *  addresses saved before Uber Direct quoting existed — the checkout falls
   *  back to asking for the address again rather than guessing a location. */
  latitude?: number
  longitude?: number
}

interface AddressesState {
  addresses: SavedAddress[]
}

interface AddressesActions {
  addAddress: (address: Omit<SavedAddress, "id" | "isDefault">) => void
  updateAddress: (id: string, address: Omit<SavedAddress, "id" | "isDefault">) => void
  removeAddress: (id: string) => void
  setDefault: (id: string) => void
  getDefault: () => SavedAddress | undefined
  clearAddresses: () => void
}

type AddressesStore = AddressesState & AddressesActions

/**
 * Addresses Zustand store — V1 localStorage persistence
 *
 * Plain storage, with no delivery-zone validation.
 * V2: validate the address against the selected store's delivery zone.
 * V2: sync to Convex per authenticated user.
 */
export const useAddressesStore = create<AddressesStore>()(
  persist(
    (set, get) => ({
      addresses: [],

      addAddress: (address) => {
        const id = crypto.randomUUID()
        const isFirst = get().addresses.length === 0
        set((state) => ({
          addresses: [
            ...state.addresses,
            { ...address, id, isDefault: isFirst },
          ],
        }))
      },

      updateAddress: (id, address) => {
        set((state) => ({
          addresses: state.addresses.map((a) =>
            a.id === id ? { ...a, ...address } : a
          ),
        }))
      },

      removeAddress: (id) => {
        set((state) => {
          const filtered = state.addresses.filter((a) => a.id !== id)
          // If we removed the default, set the first remaining as default
          if (
            filtered.length > 0 &&
            !filtered.some((a) => a.isDefault)
          ) {
            filtered[0] = { ...filtered[0]!, isDefault: true }
          }
          return { addresses: filtered }
        })
      },

      setDefault: (id) => {
        set((state) => ({
          addresses: state.addresses.map((a) => ({
            ...a,
            isDefault: a.id === id,
          })),
        }))
      },

      getDefault: () => {
        return get().addresses.find((a) => a.isDefault)
      },

      clearAddresses: () => {
        set({ addresses: [] })
      },
    }),
    {
      name: "beindigital-addresses",
    }
  )
)
