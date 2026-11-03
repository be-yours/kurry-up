/**
 * robots.txt
 *
 * It used to allow `/s/` — the removed store-prefixed routing — and disallowed
 * neither the basket, the checkout, nor a signed-in customer's account. The
 * rules come from `lib/crawler-policy` now, which is the same list the
 * sitemap filters through, so the two cannot contradict each other.
 *
 * Answer engines are named beside `*` rather than folded into it: a restaurant
 * is exactly what they are asked about, and an owner who wants out has one
 * obvious place to say so.
 */

import type { MetadataRoute } from "next"
import { siteBaseUrlFromEnv } from "@/lib/seo"
import {
  ANSWER_ENGINE_USER_AGENTS,
  CRAWLER_DISALLOWED_PATHS,
} from "@/lib/crawler-policy"

function getBaseUrl(): string {
  return siteBaseUrlFromEnv() ?? "http://localhost:3000"
}

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl()
  const disallow = [...CRAWLER_DISALLOWED_PATHS]

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow,
      },
      {
        userAgent: [...ANSWER_ENGINE_USER_AGENTS],
        allow: "/",
        disallow,
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  }
}
