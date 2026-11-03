'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { useStorefrontStoreSelection } from '@be-yours/restaurant'
import {
  resolveReservationEntry,
  type ReservationEntry,
  type ReservationModeSource,
} from '@be-yours/convex-schema'

/**
 * What every « Réserver » control on the storefront should render, or `null`.
 *
 * The ONE place the storefront asks the question. The header, the mobile menu
 * and the footer all read this hook, and it reads `stores.reservationMode`
 * through `resolveReservationEntry` — so « désactivé » removes the button
 * everywhere at once, and no surface can keep a stale copy of the answer.
 *
 * It rides on `stores.list`, which the header already subscribes to, so the
 * switch costs no extra query and reaches a visitor as soon as the owner saves
 * it. `null` while the list loads: a button that appears and vanishes is worse
 * than one that arrives a beat late.
 *
 * Read for the establishment the visitor selected, falling back to the first
 * published one — the same choice `useStoreId` makes, without its side effects.
 */
export function useReservationEntry(): ReservationEntry | null {
  const stores = useQuery(api.stores.list)
  const storeId = useStorefrontStoreSelection((s) => s.storeId)
  if (!stores || stores.length === 0) return null
  const store =
    (stores as Array<ReservationModeSource & { _id: string }>).find((s) => s._id === storeId) ??
    stores[0]
  return resolveReservationEntry(store as ReservationModeSource | undefined)
}
