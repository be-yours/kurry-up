"use client"

import { useMemo } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { isStoreOpen, resolveStoreHours } from "@be-yours/restaurant"
import {
  isWithinBusinessHours,
  resolveStoreServices,
} from "@be-yours/convex-schema"
import type { Id } from "@/convex/_generated/dataModel"
import type { StoreHoursStatus } from "@be-yours/restaurant"

/**
 * Hook: useStoreStatus
 *
 * Queries a store by ID and returns its real-time status:
 * - open/closed based on hours
 * - store status field (draft/open/closed/temporarily_unavailable)
 * - current day hours
 * - available services
 *
 * Two things it used to get wrong, both of them settings the dashboard writes
 * and this hook did not read (#169):
 *
 * - It took `store.hours` unconditionally, so `useGlobalHours` decided nothing.
 *   An owner who edited the global week and left every location on "horaires
 *   globaux" changed nothing a visitor could see — the storefront kept showing
 *   the hard-coded 09:00–22:00 that `stores.create` seeds.
 * - It compared against the visitor's own clock. `globalSettings.timezone` was
 *   written and never read, so a customer abroad got the wrong answer and
 *   anyone could change it by changing their system clock.
 * - It returned `store.overrides.services` raw, and that override is
 *   `undefined` on every establishment that has not customised it. The
 *   order-type selector read `undefined` as "offer everything", so a restaurant
 *   that does not deliver still showed Livraison.
 */
export function useStoreStatus(storeId: string | null) {
  const store = useQuery(
    api.stores.getById,
    storeId ? { id: storeId as Id<"stores"> } : "skip"
  )
  // Public query: tax rate, delivery config and the opening rules, with the
  // Uber Direct credentials stripped. The storefront needs it before sign-in.
  const globalSettings = useQuery(api.globalSettings.get)

  // Both answers off one reading of the clock, so they cannot describe two
  // different moments. `openNow` comes from the same function `orders.create`
  // asks, so the button this hook disables and the order the mutation refuses
  // can no longer disagree; `hoursStatus` is everything the storefront shows
  // *around* that answer — when it next changes, and which service is running.
  //
  // `isOpen` used to be `hoursStatus?.isOpen ?? false`, which also read a store
  // with no declared week as shut. The mutation has never done that, and a
  // location whose hours row is empty would have been unable to sell anything.
  const { hoursStatus, openNow } = useMemo((): {
    hoursStatus: StoreHoursStatus | null
    openNow: boolean
  } => {
    if (!store) return { hoursStatus: null, openNow: false }
    const hours = resolveStoreHours(store, globalSettings)
    const now = new Date()
    return {
      hoursStatus:
        hours.length === 0
          ? null
          : isStoreOpen(hours, now, globalSettings?.timezone),
      openNow: isWithinBusinessHours(
        hours,
        now.getTime(),
        globalSettings?.timezone
      ),
    }
  }, [store, globalSettings])

  const isOpen = store?.status === "open" && openNow

  return {
    store,
    isLoading: store === undefined && storeId !== null,
    isOpen,
    hoursStatus,
    /**
     * The establishment's clock. A serving window is the kitchen's, not the
     * visitor's, so anything asking whether a dish is on right now needs it.
     */
    timeZone: globalSettings?.timezone,
    status: store?.status ?? null,
    // `null` while the two queries are in flight — the selector renders
    // nothing rather than guessing, and guessing is what offered a service the
    // restaurant does not run.
    services:
      store && globalSettings !== undefined
        ? resolveStoreServices(store, globalSettings)
        : null,
  }
}
