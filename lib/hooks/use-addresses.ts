"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { useAddressesStore, type SavedAddress } from "@/lib/stores/addresses-store"

/**
 * Hook: useAddresses
 *
 * One address list, wherever it lives.
 *
 * A signed-in customer reads and writes the database, so their addresses
 * follow them from phone to laptop. A guest keeps using the browser, because
 * there is no account to attach an address to — and losing the guest path
 * would mean asking for the full address on every single order.
 *
 * On the first authenticated render, whatever the browser was holding is
 * imported once and then cleared locally. The import is keyed on the local id,
 * so signing in on a second device does not duplicate anything.
 */
export function useAddresses(isAuthenticated: boolean) {
  const remote = useQuery(
    api.customerAddresses.myAddresses,
    isAuthenticated ? {} : "skip"
  )
  const addRemote = useMutation(api.customerAddresses.addAddress)
  const updateRemote = useMutation(api.customerAddresses.updateAddress)
  const removeRemote = useMutation(api.customerAddresses.removeAddress)
  const setDefaultRemote = useMutation(api.customerAddresses.setDefaultAddress)
  const importRemote = useMutation(api.customerAddresses.importLocalAddresses)

  const local = useAddressesStore((s) => s.addresses)
  const addLocal = useAddressesStore((s) => s.addAddress)
  const updateLocal = useAddressesStore((s) => s.updateAddress)
  const removeLocal = useAddressesStore((s) => s.removeAddress)
  const setDefaultLocal = useAddressesStore((s) => s.setDefault)
  const clearLocal = useAddressesStore((s) => s.clearAddresses)

  // Guard against the import firing twice on a re-render before the mutation
  // settles — it is idempotent server-side, but a second call is pure noise.
  const importStarted = useRef(false)

  useEffect(() => {
    if (!isAuthenticated) return
    if (remote === undefined) return // still loading
    if (local.length === 0) return
    if (importStarted.current) return

    importStarted.current = true
    importRemote({
      addresses: local.map((a) => ({
        localId: a.id,
        isDefault: a.isDefault,
        label: a.label,
        street: a.street,
        city: a.city,
        postalCode: a.postalCode,
        country: a.country,
        latitude: a.latitude,
        longitude: a.longitude,
      })),
    })
      .then(() => clearLocal())
      .catch(() => {
        // Keep the local copy on failure: losing an address to a transient
        // network error is worse than importing it again next time.
        importStarted.current = false
      })
  }, [isAuthenticated, remote, local, importRemote, clearLocal])

  const addresses: SavedAddress[] = useMemo(() => {
    if (!isAuthenticated) return local
    return (remote ?? []).map((a: Doc<"customerAddresses">) => ({
      id: a._id,
      label: a.label,
      street: a.street,
      city: a.city,
      postalCode: a.postalCode,
      country: a.country,
      isDefault: a.isDefault,
      latitude: a.latitude,
      longitude: a.longitude,
    }))
  }, [isAuthenticated, remote, local])

  const addAddress = useCallback(
    async (address: Omit<SavedAddress, "id" | "isDefault">) => {
      if (!isAuthenticated) return addLocal(address)
      await addRemote({
        label: address.label,
        street: address.street,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
        latitude: address.latitude,
        longitude: address.longitude,
      })
    },
    [isAuthenticated, addLocal, addRemote]
  )

  const updateAddress = useCallback(
    async (id: string, address: Omit<SavedAddress, "id" | "isDefault">) => {
      if (!isAuthenticated) return updateLocal(id, address)
      await updateRemote({
        addressId: id as Id<"customerAddresses">,
        label: address.label,
        street: address.street,
        city: address.city,
        postalCode: address.postalCode,
        country: address.country,
        latitude: address.latitude,
        longitude: address.longitude,
      })
    },
    [isAuthenticated, updateLocal, updateRemote]
  )

  const removeAddress = useCallback(
    async (id: string) => {
      if (!isAuthenticated) return removeLocal(id)
      await removeRemote({ addressId: id as Id<"customerAddresses"> })
    },
    [isAuthenticated, removeLocal, removeRemote]
  )

  const setDefault = useCallback(
    async (id: string) => {
      if (!isAuthenticated) return setDefaultLocal(id)
      await setDefaultRemote({ addressId: id as Id<"customerAddresses"> })
    },
    [isAuthenticated, setDefaultLocal, setDefaultRemote]
  )

  const defaultAddress = useMemo(
    () => addresses.find((a) => a.isDefault),
    [addresses]
  )

  return {
    addresses,
    defaultAddress,
    addAddress,
    updateAddress,
    removeAddress,
    setDefault,
    /** True while the server list is still loading for a signed-in customer. */
    isLoading: isAuthenticated && remote === undefined,
  }
}
