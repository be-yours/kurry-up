"use client"

import { useEffect } from "react"
import { useCmsPage } from "@/lib/cms/useCmsPage"

/**
 * Injects a dynamic favicon <link> tag from CMS branding data.
 *
 * The CMS `branding` block is the only source: `store.branding.faviconUrl` is
 * written by nothing since the Design screen sent the logo settings to the CMS,
 * and reading it here would contradict what that screen tells the owner.
 *
 * Falls back to the static /favicon.ico when the block carries none.
 */
export function DynamicFavicon() {
  const cms = useCmsPage("storefront-layout")
  const faviconUrl = cms.block("branding").field("favicon").mediaUrl

  useEffect(() => {
    if (!faviconUrl) return

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      document.head.appendChild(link)
    }
    link.href = faviconUrl
  }, [faviconUrl])

  return null
}
