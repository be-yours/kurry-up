"use client"

import { buildBrandingCss } from "@be-yours/ui/branding"

import { useStoreId } from "@/lib/hooks/use-store-id"

/**
 * The element the storefront palette is declared on, and therefore an element
 * this stylesheet has to reach.
 *
 * `globals.css` puts the storefront's own cream-and-green defaults on
 * `.storefront-theme` — a `<div>` in `storefront-shell.tsx`, not `<html>`. A
 * custom property declared on an element beats the one it would inherit,
 * whatever the layer, so tokens written only to `:root` and `.dark` never
 * reached a diner: measured in Chromium, an establishment that picked
 * `#d32f2f` got a red admin and a storefront still painted engine green. #410.
 */
export const STOREFRONT_SCOPES = [".storefront-theme"]

/**
 * The establishment's own colours, on the pages a diner actually reads.
 *
 * WHAT WAS BROKEN. `/dashboard/design` has always written
 * `stores.branding.primaryColor` and nothing has ever read it back:
 * `--primary` had exactly one definition per app, the literal `24 95% 53%` in
 * `app/globals.css`, so every establishment the engine has delivered shipped
 * the same orange. A product priced per store, sold as "a theme by restaurant
 * type", had a theme picker that changed nothing.
 *
 * WHY IT IS A CLIENT COMPONENT. The theme has to follow the same establishment
 * the rest of the storefront is showing, and that choice is made in the
 * browser: `useStoreId` reads the persisted selection, falls back to the
 * nearest or the first published store, and returns the document. Resolving it
 * on the server instead would paint store A's colours around store B's menu on
 * any multi-store site.
 *
 * WHY IT STILL TAKES `initialCss`. `useQuery` has no answer during the server
 * render or before the first round trip completes, so without a server-resolved
 * starting point every visitor would see the engine orange repaint into the
 * establishment's red a moment after the page appeared. The layout resolves the
 * cookie's store — the one `useStoreId` itself wrote on the last visit — and
 * hands the stylesheet down, so a returning visitor never sees the flash and a
 * new one sees it once.
 *
 * `dangerouslySetInnerHTML` is how a stylesheet reaches the DOM; what makes it
 * safe is that `buildBrandingCss` never interpolates a stored string. See the
 * injection note in `packages/ui/src/lib/branding.ts`.
 */
export function StoreTheme({ initialCss = "" }: { initialCss?: string }) {
  const { store } = useStoreId()

  // `store` is null until the query lands. Falling back to the server's answer
  // rather than to nothing keeps the palette stable across hydration.
  const css = store
    ? buildBrandingCss(store.branding, { scopes: STOREFRONT_SCOPES })
    : initialCss
  if (!css) return null

  return <style data-store-theme="" dangerouslySetInnerHTML={{ __html: css }} />
}
