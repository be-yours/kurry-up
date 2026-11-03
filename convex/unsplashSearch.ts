"use node"

/**
 * Unsplash Search — Actions (Node Runtime)
 *
 * Client-facing actions to search Unsplash and trigger download tracking.
 * Used by the UnsplashImagePicker component in the blog editor.
 */

import { v } from "convex/values"
import { action } from "./_generated/server"
import { internal } from "./_generated/api"

interface UnsplashPhotoRaw {
  id: string
  urls: { regular: string; small: string }
  alt_description: string | null
  user: { name: string; links: { html: string } }
  links: { download_location: string }
}

// @guarded-inline: checks content:write by role — no store to scope against
export const searchPhotos = action({
  args: {
    query: v.string(),
    page: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "content:write",
    });

    const accessKey = process.env.UNSPLASH_ACCESS_KEY
    if (!accessKey) {
      throw new Error("UNSPLASH_ACCESS_KEY not configured")
    }

    const params = new URLSearchParams({
      query: args.query,
      per_page: "12",
      page: String(args.page ?? 1),
      orientation: "landscape",
      order_by: "relevant",
    })

    const res = await fetch(
      `https://api.unsplash.com/search/photos?${params}`,
      { headers: { Authorization: `Client-ID ${accessKey}` } }
    )

    if (!res.ok) {
      throw new Error(`Unsplash API error: ${res.status}`)
    }

    const data = (await res.json()) as {
      total: number
      total_pages: number
      results: UnsplashPhotoRaw[]
    }

    return {
      total: data.total,
      totalPages: data.total_pages,
      results: data.results.map((photo) => ({
        id: photo.id,
        url: photo.urls.regular,
        thumbUrl: photo.urls.small,
        alt: photo.alt_description || args.query,
        photographerName: photo.user.name,
        photographerUrl: photo.user.links.html,
        downloadLocation: photo.links.download_location,
      })),
    }
  },
})

// @guarded-inline: checks content:write by role — no store to scope against
export const triggerDownload = action({
  args: {
    downloadLocation: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "content:write",
    });

    const accessKey = process.env.UNSPLASH_ACCESS_KEY
    if (!accessKey) return

    // Validate URL to prevent SSRF — only allow Unsplash API domain
    try {
      const url = new URL(args.downloadLocation)
      if (url.hostname !== "api.unsplash.com") {
        throw new Error("Invalid download location")
      }
    } catch {
      return
    }

    // Unsplash download tracking
    await fetch(`${args.downloadLocation}?client_id=${accessKey}`).catch(() => {})
  },
})
