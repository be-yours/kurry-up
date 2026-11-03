"use client"

import { useEffect } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import {
  useStorefrontStoreSelection,
  useCartStore,
  useNearestStore,
  type StoreDoc,
} from "@be-yours/restaurant"

/**
 * Hook: useStoreId
 *
 * Resolves the store the visitor is browsing:
 *   persisted selection > nearest store (geolocation) > first store
 *
 * The selection is an id, and the document comes back from Convex, so a
 * renamed store or a change of opening hours reaches the visitor on the next
 * render. Storing the whole document meant it stayed frozen in localStorage.
 *
 * The visitor is never asked for their position here. If they granted it
 * earlier the nearest store wins; otherwise the first one does. Asking on
 * arrival - which is what this used to do on every storefront page - puts a
 * permission prompt in front of someone who came to read a menu.
 *
 * Every candidate here comes from `stores.list`, which returns only published
 * establishments. That is what keeps the automatic selection off a draft: this
 * hook picks blind, so a draft in the list would be picked like any other, and
 * the visitor would land on a restaurant nobody has opened yet.
 *
 * `storeCount` is the length of that same list: how many establishments this
 * deployment offers, `0` until it has loaded. It exists so a surface that only
 * makes sense with a choice to make — the footer's « Nos restaurants » link,
 * which leads to a selector — can stay away from a deployment with one, the way
 * the header's picker already does. Read from the list this hook already holds,
 * so it costs no second subscription.
 */
export function useStoreId(): {
  storeId: string | null
  store: StoreDoc | null
  storeCount: number
  isLoading: boolean
} {
  const storeId = useStorefrontStoreSelection((s) => s.storeId)
  const setStoreId = useStorefrontStoreSelection((s) => s.setStoreId)
  const cartStoreId = useCartStore((s) => s.storeId)
  const setCartStoreId = useCartStore((s) => s.setStoreId)

  const stores = useQuery(api.stores.list)

  const store = (stores as StoreDoc[] | undefined)?.find((s) => s._id === storeId) ?? null
  const needsResolution = !!stores && !store

  /**
   * The list is in and nothing has been picked from it yet.
   *
   * The effect below does the picking, and it runs in the same commit as the
   * effects of whoever called this hook - which closed over the `storeId` of
   * the render that preceded it. So for exactly one render a caller reads
   * `null` while a store is already being chosen, and the checkout guard read
   * that as "this visitor has no restaurant": a cold arrival at /checkout with
   * a full basket was sent to /store-selector, every time. Reporting the render
   * as loading says what is true of it - nothing is resolved, and something
   * will be.
   *
   * An empty list is not that: there is nothing to pick, and `null` is the
   * final answer rather than a pending one.
   */
  const isResolving = needsResolution && (stores?.length ?? 0) > 0

  const { nearestStore } = useNearestStore(stores ?? [], {
    useGrantedLocation: needsResolution && (stores?.length ?? 0) > 1,
  })

  useEffect(() => {
    if (!stores) return // still loading

    if (store) {
      // Sync cart storeId with store selection
      if (cartStoreId !== store._id) {
        setCartStoreId(store._id)
      }
      return
    }

    // Nothing selected, or a selection that no longer exists. `nearestStore` is
    // the closest one when the visitor shared their position and simply the
    // first otherwise.
    const next = nearestStore ?? stores[0]
    if (next) {
      setStoreId(next._id)
      setCartStoreId(next._id)
    }
  }, [stores, store, cartStoreId, nearestStore, setStoreId, setCartStoreId])

  /**
   * Tell the server which establishment this visitor is reading.
   *
   * Three server-side readers ask for a `storeSlug` cookie — `generateCmsMetadata`,
   * `resolveDefaultStoreSlug` and the storefront's own store resolution — and
   * nothing in the repository had ever written one. So a server render always
   * fell back to the first published establishment while the browser, resolving
   * here, could be on a different one: on a multi-store deployment the blog
   * listed store B's articles and linked to `/blog/<B-slug>`, which the server
   * then looked for in store A and answered 404 — the very dead links the blog
   * work set out to remove.
   *
   * Written from the client because that is where the choice is made. It is not
   * a credential: it names a published establishment, which `stores.list`
   * already gives anyone, and every reader re-resolves it through
   * `stores.getBySlug`, which refuses a draft to an anonymous caller.
   */
  useEffect(() => {
    const slug = store?.slug
    if (!slug || typeof document === "undefined") return

    const secure = window.location.protocol === "https:" ? "; Secure" : ""
    document.cookie = `storeSlug=${encodeURIComponent(slug)}; path=/; max-age=31536000; SameSite=Lax${secure}`
  }, [store?.slug])

  return {
    storeId: store?._id ?? null,
    store,
    storeCount: stores?.length ?? 0,
    isLoading: stores === undefined || isResolving,
  }
}
