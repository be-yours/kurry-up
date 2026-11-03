"use client"

import "@/lib/cms/init"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { getPageDefinition } from "@be-yours/cms"

interface PreviewClientProps {
  pageSlug: string
}

export function PreviewClient({ pageSlug }: PreviewClientProps) {
  // Auto-select store (preview opens in new tab, Zustand is empty)
  useStoreId()

  const pageDef = getPageDefinition(pageSlug)
  const storefrontRoute = pageDef?.route ?? `/${pageSlug}`
  const iframeSrc = `${storefrontRoute}${storefrontRoute.includes("?") ? "&" : "?"}preview=true`

  if (!pageDef) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-center text-muted-foreground">
          Page &quot;{pageSlug}&quot; non trouvee dans le registry.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Preview banner */}
      <div className="sticky top-0 z-50 bg-yellow-400 text-yellow-900 text-center py-2 text-sm font-medium shadow-sm shrink-0">
        Mode preview — {pageDef.label}
        {" "}
        <a
          href={`/dashboard/content/pages/${pageSlug}`}
          className="underline hover:no-underline ml-2"
        >
          Retour a l&apos;editeur
        </a>
      </div>

      {/* Iframe with the actual storefront page */}
      <iframe
        src={iframeSrc}
        className="flex-1 w-full border-none"
        title={`Preview: ${pageDef.label}`}
      />
    </div>
  )
}
