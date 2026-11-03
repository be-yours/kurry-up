/**
 * SEO primitives for `generateMetadata()`.
 *
 * One place decides what a canonical URL is and what an Open Graph card looks
 * like, so the storefront cannot answer the same question two different ways on
 * two different pages. The robots directive is read by `lib/crawler-policy`,
 * which a page can import without dragging a Convex client behind it.
 */

import "server-only"
import { headers } from "next/headers"
import type { Metadata } from "next"
import type { ServerCmsPageResult } from "@/lib/cms/server"
import {
  INDEXABLE,
  parseRobotsDirective,
  type RobotsDirective,
} from "@/lib/crawler-policy"

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

const DEV_BASE_URL = "http://localhost:3000"

function normaliseBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin + new URL(trimmed).pathname.replace(/\/+$/, "")
  } catch {
    return null
  }
}

/**
 * The site's own address, from configuration alone.
 *
 * Configuration wins over the request host, and deliberately: `sitemap.ts` and
 * `robots.ts` are rendered without a request and can only read the environment,
 * so a canonical URL built from the host would disagree with the sitemap on any
 * deployment reachable at more than one name — a preview domain, an internal
 * load-balancer name, a bare apex beside its `www`.
 */
export function siteBaseUrlFromEnv(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  return configured ? normaliseBaseUrl(configured) : null
}

/**
 * The site's own address for a page being rendered for a visitor.
 *
 * Falls back to the request's host so that a deployment which never set
 * `NEXT_PUBLIC_SITE_URL` still emits canonicals that resolve, rather than
 * pointing every page at localhost.
 */
export async function resolveSiteBaseUrl(): Promise<string> {
  const configured = siteBaseUrlFromEnv()
  if (configured) return configured

  try {
    const requestHeaders = await headers()
    const host = requestHeaders.get("host")
    const forwarded = requestHeaders.get("x-forwarded-proto")
    const protocol = forwarded === "http" || forwarded === "https" ? forwarded : "https"
    if (host) return `${protocol}://${host}`
  } catch {
    // headers() is unavailable outside a request (build time, sitemap).
  }

  return DEV_BASE_URL
}

/** Turns a path or a relative URL into an absolute one. Absolute input passes through. */
export function absoluteUrl(value: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `${baseUrl}${value.startsWith("/") ? "" : "/"}${value}`
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface SeoMetadataOptions {
  /** CMS page data, when the page has an SEO block. */
  cms?: ServerCmsPageResult | null
  /** Title used when the CMS says nothing. */
  fallbackTitle: string
  /** Description used when the CMS says nothing. */
  fallbackDescription?: string
  /** Open Graph image used when the CMS says nothing. Absolute or app-relative. */
  fallbackOgImage?: string
  /** The page's own path, e.g. `/menu`. Canonical and `og:url` are built from it. */
  pathname: string
  /** The establishment's name, for `og:site_name`. */
  siteName?: string
  /** BCP-47 locale of the rendered page, e.g. `fr_FR`. */
  ogLocale?: string
  /**
   * Overrides the CMS directive outright. Private and transactional pages pass
   * `PRIVATE_PAGE` here: an owner must not be able to publish a customer's
   * order confirmation by picking "Index, Follow" in a dropdown.
   */
  robots?: RobotsDirective
}

/**
 * Builds the metadata Next.js writes into `<head>`.
 *
 * Everything a crawler resolves from the outside is absolute: `metadataBase`
 * covers the relative cases Next.js can expand itself, and the canonical, the
 * `og:url` and the image are written out in full because a relative OG image is
 * simply not fetched by the crawlers that matter.
 */
export async function buildSeoMetadata(options: SeoMetadataOptions): Promise<Metadata> {
  const {
    cms,
    fallbackTitle,
    fallbackDescription,
    fallbackOgImage,
    pathname,
    siteName,
    ogLocale,
    robots: robotsOverride,
  } = options

  const baseUrl = await resolveSiteBaseUrl()
  const seo = cms?.block("seo")

  const title = seo?.field("metaTitle").text || fallbackTitle
  const description = seo?.field("metaDescription").text || fallbackDescription || undefined
  const ogImage = seo?.field("ogImage").mediaUrl || fallbackOgImage
  const resolvedOgImage = ogImage ? absoluteUrl(ogImage, baseUrl) : undefined

  const robots =
    robotsOverride ?? parseRobotsDirective(seo?.field("robots").text, INDEXABLE)

  const canonical = absoluteUrl(pathname, baseUrl)
  const images = resolvedOgImage ? [{ url: resolvedOgImage }] : undefined

  return {
    metadataBase: new URL(baseUrl),
    title,
    description,
    alternates: { canonical },
    robots: {
      index: robots.index,
      follow: robots.follow,
      googleBot: { index: robots.index, follow: robots.follow },
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      ...(siteName ? { siteName } : {}),
      ...(ogLocale ? { locale: ogLocale } : {}),
      ...(images ? { images } : {}),
    },
    twitter: {
      card: resolvedOgImage ? "summary_large_image" : "summary",
      title,
      description,
      ...(resolvedOgImage ? { images: [resolvedOgImage] } : {}),
    },
  }
}
