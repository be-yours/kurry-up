/**
 * Whose name the storefront puts in its own header (#613).
 *
 * WHAT WAS WRONG. `storefront-header.tsx` read
 * `cms.block("branding").field("brandName").text ?? "BeYours"`, and
 * `grep -c branding apps/themes/convex/cmsSeed.ts` returned 0. The `branding`
 * block is the only branding the header, the favicon, the JSON-LD and the admin
 * sidebar read, and it is the one block the seed never wrote — the seed filled
 * `header.brandName` instead, one accordion below in the same editor, a field
 * with no reader at all. So an owner opened the CMS, found « Nom de la marque
 * (header) » already filled in, concluded the job was done, and their customers
 * were served the vendor's name on the client's own domain.
 *
 * Worse than a bad default: `cmsSeed` is an `internalAction` whose only
 * invocation anywhere is a comment, so the realistic delivered state is no CMS
 * rows at all and the fallback fired unconditionally.
 *
 * THE RULE. A name the establishment did not choose is never shown. The chain
 * ends at `store.name`, which every establishment has because the schema
 * requires it, and then at the empty string — never at a literal naming us.
 *
 * `header.brandName` is read as the second link on purpose rather than deleted:
 * every site seeded before this has its name there and nowhere else, and a fix
 * that blanked those headers would be a worse defect than the one it replaces.
 */

/** A candidate that is present, is a string, and is not only whitespace. */
function usable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface BrandNameSources {
  /** `storefront-layout::branding.brandName` — the field the admin edits. */
  branding?: string | null
  /** `storefront-layout::header.brandName` — what `cmsSeed` writes. Legacy. */
  legacyHeader?: string | null
  /** `stores.name`. Required by the schema, so this is where the chain lands. */
  storeName?: string | null
}

/**
 * The establishment's own name, or nothing.
 *
 * Deliberately returns `""` rather than a placeholder when every source is
 * empty: an empty header is a visible gap somebody fixes, and a vendor's name
 * is a defect nobody notices until a diner does.
 */
export function resolveBrandName(sources: BrandNameSources): string {
  return (
    usable(sources.branding) ??
    usable(sources.legacyHeader) ??
    usable(sources.storeName) ??
    ""
  )
}
