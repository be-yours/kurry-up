/**
 * Which URLs a directory of App Router pages answers.
 *
 * Shared by the two suites that ask it: `sitemap-robots.test.ts` over the real
 * `app/`, and `site-routes.test.ts` over a throwaway tree holding one page a site
 * added. They have to agree on what "a route" is, or the second would prove
 * nothing about the first.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every path the App Router actually serves under `dir`. */
export function routeTree(dir: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // `_components` is opted out of routing; a group folder adds no segment.
      if (entry.startsWith('_')) continue
      found.push(...routeTree(full, prefix + (entry.startsWith('(') ? '' : `/${entry}`)))
    } else if (entry === 'page.tsx') {
      found.push(prefix || '/')
    }
  }
  return found
}

/**
 * The two dynamic templates the sitemap fills from the catalogue.
 *
 * Public, but not listed anywhere as a fixed path: `/product/{id}` and
 * `/blog/{slug}` come from the database, so the route tree holds their template.
 */
export const DYNAMIC_PUBLIC_ROUTES: readonly string[] = [
  '/product/[productId]',
  '/blog/[slug]',
  // Public only while an establishment's switch is on `native`, so the sitemap
  // adds it from the store list, like the catalogue, instead of a fixed route.
  '/reservation',
]
