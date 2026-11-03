"use client"

import { useCallback } from "react"
import { usePathname } from "next/navigation"
import { useMutation } from "convex/react"

import { PortalThemeProvider } from "@be-yours/ui"
import { useAudienceCollector, type AudienceHit } from "@be-yours/restaurant"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

import { CartAnnouncer } from "./cart-announcer"
import { StorefrontHeader } from "./storefront-header"
import { StorefrontFooter } from "./storefront-footer"
import { StoreClosedBanner } from "./store-closed-banner"
import { StorefrontI18nProvider } from "./storefront-i18n-provider"
import { DynamicFavicon } from "../dynamic-favicon"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { useStoreStatus } from "@/lib/hooks/use-store-status"

interface StorefrontShellProps {
  children: React.ReactNode
}

export function StorefrontShell({ children }: StorefrontShellProps) {
  const { storeId } = useStoreId()
  const { isOpen, isLoading, hoursStatus } = useStoreStatus(storeId)

  const nextOpenTime = hoursStatus?.nextChange
    ? hoursStatus.nextChange.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null

  /*
   * Counts pages and named interactions, and holds no identifier of any kind —
   * which is why there is no consent banner on this site. The rules live in
   * `@be-yours/restaurant`; what stays here is the wiring the engine cannot do
   * for itself.
   *
   * THE ADAPTER IS THE WIRING. Convex types `storeId` as `Id<"stores">`, a
   * string branded by this app's generated data model, and an engine package
   * has no generated model to brand against — so its contract is a plain
   * string and the brand is put back here, on the one field that carries it.
   * `useMutation` returns a stable reference, so this callback is stable too
   * and does not re-arm the collector on every render.
   */
  const recordHits = useMutation(api.audience.record)
  const record = useCallback(
    (args: { storeId: string; hits: AudienceHit[] }) =>
      recordHits({ storeId: args.storeId as Id<"stores">, hits: args.hits }),
    [recordHits]
  )

  useAudienceCollector({
    storeId: storeId ?? null,
    pathname: usePathname(),
    record,
  })

  const showBanner = !!storeId && !isLoading && !isOpen

  return (
    // Every overlay in the shop — the cart sheet first among them — renders
    // through a Radix portal that appends to `document.body`, outside the div
    // below. Naming the surface here is what carries this palette across that
    // gap; the measurement is in `portal-theme.tsx`.
    <PortalThemeProvider className="storefront-theme">
      {/* `storefront-theme` is what makes the tokens below resolve to this
          establishment's colours rather than the administration's. It carries
          the storefront's own default palette (`app/globals.css`), which an
          establishment's saved branding then overrides from `StoreTheme`. */}
      <div className="storefront-theme flex min-h-screen flex-col bg-background text-foreground">
        <StorefrontI18nProvider />
        <DynamicFavicon />
        {/*
          Here rather than in the cart sheet, and for a reason that is not
          tidiness: a live region has to be in the document before its contents
          change, and the sheet is a dialog that unmounts when closed. Every
          mutation made from a product card — which is most of them — would
          happen while a region inside the sheet did not exist.
        */}
        <CartAnnouncer />
        {showBanner && <StoreClosedBanner nextOpenTime={nextOpenTime} />}
        <StorefrontHeader hasBanner={showBanner} />
        <main className="flex-1">{children}</main>
        <StorefrontFooter />
      </div>
    </PortalThemeProvider>
  )
}
