"use client"

import { MapPin, Loader2, Navigation } from "lucide-react"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@be-yours/ui"
import {
  useStorefrontStoreSelection,
  useCartStore,
  useNearestStore,
  useStoreStatusLabels,
  type StoreWithDistance,
} from "@be-yours/restaurant"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(1)} km`
}

function StoreOption({
  store,
  isSelected,
  onSelect,
}: {
  store: StoreWithDistance
  isSelected: boolean
  onSelect: () => void
}) {
  // Ouvert / Fermé / Temporairement indisponible, in the language this
  // storefront is being read in — the same vocabulary and the same hook the
  // full store-selector page uses, so the two screens cannot drift apart.
  const statusLabels = useStoreStatusLabels()
  const isOpen = store.status === "open"

  // `store.status` also admits "draft", which the published list never
  // contains. Read it as closed rather than as `undefined`, exactly as
  // `StoreStatusBadge` does: it is the reading that does not tell a diner a
  // place is taking orders.
  const statusLabel = Object.hasOwn(statusLabels, store.status)
    ? statusLabels[store.status as keyof typeof statusLabels]
    : statusLabels.closed

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors ${
        isSelected
          ? "bg-accent border border-primary/20"
          : "hover:bg-muted border border-transparent"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-foreground truncate">
            {store.name}
          </span>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {store.address?.street}, {store.address?.city}
          </p>
          {/*
            The dot used to be the ONLY thing saying whether this location was
            taking orders — a hue, and nothing else, on the panel a diner picks
            a restaurant from (WCAG 1.4.1). It kept its colour and gained the
            word beside it, which is what the full store-selector page has
            always printed.
          */}
          <p className="mt-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                isOpen ? "bg-primary" : "bg-muted-foreground"
              }`}
            />
            <span className="truncate">{statusLabel}</span>
          </p>
        </div>
        {store.distance != null && (
          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex-shrink-0 mt-0.5">
            {formatDistance(store.distance)}
          </span>
        )}
      </div>
    </button>
  )
}

export function StoreSelectorDropdown({
  variant = "solid",
}: {
  variant?: "transparent" | "solid"
}) {
  const convexStores = useQuery(api.stores.list)
  const storeId = useStorefrontStoreSelection((s) => s.storeId)
  const setStoreId = useStorefrontStoreSelection((s) => s.setStoreId)
  const setCartStoreId = useCartStore((s) => s.setStoreId)

  const stores = convexStores ?? []
  // Distances belong in this panel, but the panel is mounted in the header of
  // every page - so asking on mount asks everywhere. A visitor who already
  // granted their position gets distances straight away; everyone else gets
  // the "Localiser" button below, and no prompt they did not ask for.
  const { storesWithDistance, isLocating, requestLocation } =
    useNearestStore(stores, { useGrantedLocation: true })

  const currentStore =
    stores.find((s: { _id: string }) => s._id === storeId) ?? null

  function handleSelectStore(store: StoreWithDistance) {
    if (storeId === store._id) return
    setStoreId(store._id)
    setCartStoreId(store._id)
  }

  // Don't render if only one store
  if (stores.length <= 1) return null

  const isTransparent = variant === "transparent"

  const tooltipLabel = currentStore?.name ?? "Choisir un restaurant"

  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
                  isTransparent
                    ? "bg-white/10 border-white/20 text-white hover:bg-white/20"
                    : "bg-card border-border shadow-sm text-accent-foreground hover:bg-muted"
                }`}
                aria-label={tooltipLabel}
              >
                <MapPin className="h-4 w-4" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltipLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-2 rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between px-3 pt-2 pb-3">
          <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">
            Nos restaurants
          </h3>
          {isLocating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              onClick={requestLocation}
              className="flex items-center gap-1 text-[10px] font-bold text-accent-foreground hover:text-primary-ink uppercase tracking-widest transition-colors"
            >
              <Navigation className="h-3 w-3" />
              Localiser
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
          {storesWithDistance.map((store) => (
            <StoreOption
              key={store._id}
              store={store}
              isSelected={currentStore?._id === store._id}
              onSelect={() => handleSelectStore(store)}
            />
          ))}
        </div>

        {stores.length === 0 && (
          <Empty className="py-4">
            <EmptyHeader>
              <EmptyTitle>Aucun restaurant disponible</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </PopoverContent>
    </Popover>
  )
}
