"use client"

import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { MapPin, Clock } from "lucide-react"
import {
  Card,
  CardContent,
  Button,
  Skeleton,
  Empty,
  EmptyHeader,
  EmptyTitle,
  StoreStatusBadge,
  type StoreStatus,
} from "@be-yours/ui"
import {
  useStorefrontStoreSelection,
  useCartStore,
  useStoreStatusLabels,
} from "@be-yours/restaurant"
import type { StoreDoc } from "@be-yours/restaurant"

export default function StoreSelectorContent() {
  const router = useRouter()
  // The published list. A draft establishment is not in it, so nothing on
  // this page can offer one a "Commander ici" button — the rule is the
  // server's, and this page simply renders what it is given.
  const stores = useQuery(api.stores.list)
  const setStoreId = useStorefrontStoreSelection((s) => s.setStoreId)
  const setCartStoreId = useCartStore((s) => s.setStoreId)
  // Ouvert / Fermé / Temporairement indisponible, in the language this page is
  // being read in. The badge used to hold three English words and no way past
  // them, on a page whose every other string is French.
  const statusLabels = useStoreStatusLabels()

  const handleSelect = (store: StoreDoc) => {
    setStoreId(store._id)
    setCartStoreId(store._id)
    router.push("/menu")
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="mb-2 font-black text-3xl tracking-tighter">
        Choisir un restaurant
      </h1>
      <p className="mb-8 text-muted-foreground">
        Sélectionnez le restaurant où vous souhaitez commander.
      </p>

      {/* Loading */}
      {stores === undefined && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      )}

      {/* Empty */}
      {stores && stores.length === 0 && (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyTitle>Aucun restaurant disponible pour le moment</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {/* Store cards */}
      {stores && stores.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {stores.map((store: StoreDoc) => (
            /*
              A `<div onClick>` reported `tabIndex: -1` and `role: null` on the
              bench, so choosing a restaurant — the first step of ordering
              anything — could not be done from a keyboard.

              Unlike the dish card, this one contains no other control, so it
              can simply BE the button: `role`, `tabIndex`, and Enter/Space,
              which is what a real `<button>` gives for free and what a `div`
              has to be told. The accessible name is the restaurant's own,
              because "button" repeated across a grid of them says nothing.
            */
            <Card
              key={store._id}
              role="button"
              tabIndex={0}
              aria-label={`Choisir ${store.name}`}
              className="cursor-pointer rounded-2xl transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => handleSelect(store)}
              onKeyDown={(event) => {
                // Space scrolls the page by default, which is why it is
                // prevented rather than merely handled.
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  handleSelect(store)
                }
              }}
            >
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <h2 className="font-bold text-lg">{store.name}</h2>
                  <StoreStatusBadge
                    status={store.status as StoreStatus}
                    labels={statusLabels}
                  />
                </div>

                {store.address && (
                  <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                    <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>
                      {store.address.street}, {store.address.postalCode}{" "}
                      {store.address.city}
                    </span>
                  </div>
                )}

                {store.hours && store.hours.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4 flex-shrink-0" />
                    <span>
                      {store.hours
                        .filter((h: { isClosed?: boolean }) => !h.isClosed)
                        .slice(0, 1)
                        .map((h: { open: string; close: string }) => `${h.open} — ${h.close}`)
                        .join(", ") || "Voir horaires"}
                    </span>
                  </div>
                )}

                <Button className="mt-4 w-full" size="sm">
                  Commander ici
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
