/**
 * Which establishment `useCmsPage` is allowed to ask the backend about.
 *
 * The rule lives outside the hook so it can be read and tested without a
 * browser, and because getting it wrong does not degrade a page - it removes
 * one.
 *
 * WHY IT EXISTS. The storefront selection is a bare id in localStorage, and
 * localStorage outlives the deployment that issued it. `cms.getPageBlocks`
 * declares `storeId: v.id("stores")`, so an id this deployment never issued is
 * refused at the argument validator - "Value does not match validator
 * `v.id("stores")`. Path: .storeId" - and Convex raises that out of `useQuery`,
 * during render. Nothing catches it: `StorefrontShell` sits in the
 * `(storefront)` layout, so every storefront page unmounts into a blank "This
 * page couldn't load" rather than falling back to its code defaults.
 *
 * WHAT THE CHECK IS. Presence in `stores.list`, the public unscoped query that
 * collects every row of the `stores` table of this deployment
 * (`packages/convex-functions/src/stores.ts`). It answers whether the
 * establishment exists here, which covers both ways the persisted value goes
 * stale: a store that was deleted, and an id left in this browser by another
 * deployment. Checking the id's shape instead would catch neither - a sibling
 * deployment issues perfectly well-formed ids, and only the table they name
 * makes them wrong.
 *
 * WHAT IT IS NOT. Not an authorisation check. `stores.list` returns the same
 * list to everyone, so this says nothing about who may read what; the CMS
 * content it gates is public either way. It is the same existence check
 * `StoreGuard` applies in the admin (`packages/admin/src/components/
 * store-selection.ts`), asked for a different purpose: that one decides what to
 * persist, this one decides what is safe to send.
 */

/** The only field of a store document this decision reads. */
export interface IdentifiedStore {
  _id: string
}

/**
 * Decide which store id to query the CMS with, or `null` for "ask nothing".
 *
 * `null` is what the caller already does something sensible with: the query is
 * skipped and every block falls back to the default written in the code, which
 * is what a first-time visitor sees anyway.
 */
export function resolveCmsStoreId(params: {
  /** The store the caller named, if it named one. The admin layout does. */
  requestedStoreId?: string | null
  /** The storefront selection as persisted in this browser. */
  persistedStoreId: string | null
  /** Every establishment of this deployment; `undefined` while it loads. */
  stores: readonly IdentifiedStore[] | undefined
}): string | null {
  const { requestedStoreId, persistedStoreId, stores } = params

  const candidate = requestedStoreId ?? persistedStoreId
  if (!candidate) return null

  // The list is the whole basis for trusting the id, so there is nothing to
  // send until it arrives. It costs the CMS overrides one round-trip on a page
  // that renders its defaults meanwhile.
  if (!stores) return null

  return stores.some((store) => store._id === candidate) ? candidate : null
}
