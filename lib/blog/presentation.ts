/**
 * Presentation helpers shared by every storefront surface that shows articles.
 *
 * The demo content these replaced carried its own formatted date string ("12
 * Mars 2026") and a colour map keyed by six French category names. Real
 * categories are whatever the owner created, so the palette is derived from the
 * slug instead: the same category keeps the same colour on every page, and one
 * nobody anticipated still gets one.
 */

const CATEGORY_PALETTE = [
  "bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  "bg-emerald-100 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
  "bg-purple-100 dark:bg-purple-950/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800",
  "bg-orange-100 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800",
  "bg-rose-100 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800",
  "bg-amber-100 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
] as const

/** Tailwind classes for a category badge, stable for a given slug. */
export function articleCategoryClasses(slug: string | null | undefined): string {
  if (!slug) return CATEGORY_PALETTE[0]!
  let hash = 0
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0
  }
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length]!
}

/** "12 mars 2026" — the publication date as a French reader expects it. */
export function formatArticleDate(timestamp: number | null | undefined): string {
  if (!timestamp) return ""
  return new Date(timestamp).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}
