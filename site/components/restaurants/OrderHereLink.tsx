'use client'

/**
 * « Commander ici »: a link that opens the carte of ONE engine establishment. CLIENT ZONE.
 * Owner: agent « réseau + franchise ».
 *
 * The engine keeps the chosen establishment in two persisted stores (the storefront selection and the
 * cart's own), as /store-selector does: both are set to the establishment whose slug matches, then /menu
 * opens. The href is always /menu, so the link works without JavaScript and before the list has loaded
 * (the site has one establishment, which the engine picks by itself). A modified click (new tab) is left
 * to the browser.
 */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { useCartStore, useStorefrontStoreSelection } from '@be-yours/restaurant'

type Rest = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'children'>

export function OrderHereLink({
  storeSlug,
  children,
  ...rest
}: Rest & { storeSlug: string; children: ReactNode }) {
  const router = useRouter()
  const stores = useQuery(api.stores.list)
  const setStoreId = useStorefrontStoreSelection((s) => s.setStoreId)
  const setCartStoreId = useCartStore((s) => s.setStoreId)
  const store = stores?.find((s: { slug?: string }) => s.slug === storeSlug)

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!store || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    setStoreId(store._id)
    setCartStoreId(store._id)
    if (event.defaultPrevented) return
    event.preventDefault()
    router.push('/menu')
  }

  return (
    <a {...rest} href="/menu" onClick={handleClick}>
      {children}
    </a>
  )
}
