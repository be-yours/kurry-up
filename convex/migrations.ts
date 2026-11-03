/**
 * One-time data migrations — catalog/stores schema-drift backfill.
 *
 * Context: the catalog revamp renamed product stock fields and added required
 * fields; documents created before it fail schema validation, which forced
 * `schemaValidation: false` in convex/schema.ts (see
 * tasks/uber-eats-go-live-runbook.md §0).
 *
 * Usage (per deployment, dev then prod):
 *   npx convex run migrations:auditSchemaDrift      # dry-run report
 *   npx convex run migrations:backfillSchemaDrift   # apply fixes
 *   # set schemaValidation: true in convex/schema.ts, then push
 *
 * Idempotent: re-running is a no-op once documents are clean.
 */
import { internalMutation, internalQuery } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"

/** Pre-revamp product stock shape (may coexist with the new one mid-migration) */
type LegacyProductStock = {
  tracked?: boolean
  trackStock?: boolean
  quantity?: number
  lowStockThreshold?: number
  autoDisableWhenEmpty?: boolean
  autoDisableOnZero?: boolean
}

type LegacyProduct = {
  stock?: LegacyProductStock
  isFeatured?: boolean
  source?: string
  tags?: string[]
}

/** Pre-revamp store fields (isActive predates the status union) */
type LegacyStore = {
  status: string
  isActive?: boolean
}

function productPatch(product: Doc<"products">): Partial<Doc<"products">> | null {
  const legacy = product as unknown as LegacyProduct
  const patch: Record<string, unknown> = {}

  const stock = legacy.stock
  if (stock && ("trackStock" in stock || "autoDisableOnZero" in stock)) {
    const autoDisable = stock.autoDisableWhenEmpty ?? stock.autoDisableOnZero
    patch.stock = {
      tracked: stock.tracked ?? stock.trackStock ?? false,
      quantity: stock.quantity ?? 0,
      lowStockThreshold: stock.lowStockThreshold ?? 0,
      ...(autoDisable !== undefined ? { autoDisableWhenEmpty: autoDisable } : {}),
    }
  }
  if (legacy.isFeatured === undefined) patch.isFeatured = false
  if (legacy.source === undefined) patch.source = "manual"
  if (legacy.tags === undefined) patch.tags = []

  return Object.keys(patch).length > 0 ? (patch as Partial<Doc<"products">>) : null
}

function storePatch(store: Doc<"stores">): Partial<Doc<"stores">> | null {
  const legacy = store as unknown as LegacyStore
  const patch: Record<string, unknown> = {}

  if (legacy.status === "active") patch.status = "open"
  // isActive is no longer in the schema and unread by code — drop it
  if (legacy.isActive !== undefined) patch.isActive = undefined

  return Object.keys(patch).length > 0 ? (patch as Partial<Doc<"stores">>) : null
}

/**
 * Dry run: counts documents that backfillSchemaDrift would touch.
 */
export const auditSchemaDrift = internalQuery({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect()
    const stores = await ctx.db.query("stores").collect()

    return {
      products: {
        total: products.length,
        drifted: products.filter((p) => productPatch(p) !== null).length,
      },
      stores: {
        total: stores.length,
        drifted: stores.filter((s) => storePatch(s) !== null).length,
      },
    }
  },
})

/**
 * Applies the backfill:
 * - products: stock.trackStock→tracked, stock.autoDisableOnZero→autoDisableWhenEmpty,
 *   isFeatured→false, source→"manual", tags→[] where missing
 * - stores: status "active"→"open"; drop legacy isActive
 */
export const backfillSchemaDrift = internalMutation({
  args: {},
  handler: async (ctx) => {
    let productsPatched = 0
    let storesPatched = 0

    for (const product of await ctx.db.query("products").collect()) {
      const patch = productPatch(product)
      if (patch) {
        await ctx.db.patch(product._id, patch)
        productsPatched++
      }
    }

    for (const store of await ctx.db.query("stores").collect()) {
      const patch = storePatch(store)
      if (patch) {
        await ctx.db.patch(store._id, patch)
        storesPatched++
      }
    }

    return { productsPatched, storesPatched }
  },
})


/* ═══════════════════════════════════════════════════════════════════════════
   The per-store delivery radius, metres → kilometres (#623)

   `stores.overrides.deliveryRadius` was written as `km * 1000` by the store
   settings form while the input was labelled « (km) » and
   `globalSettings.delivery.radius` — the value `assertWithinDeliveryRadius`
   has always read — is in kilometres. Nothing read the override, so neither
   half was visible.

   Since #623 the order path DOES read it, and the form writes kilometres. A
   row written before that carries metres, and a stored `5000` read as
   kilometres is a radius that refuses nobody.

   `resolveStoreDelivery` already fails safe on an un-migrated row: anything
   above `MAX_TRUSTED_DELIVERY_RADIUS_KM` (200) is ignored and the global
   applies, which is exactly today's behaviour. So this migration RESTORES the
   owner's intent; it does not prevent a defect. Run it, and the establishment
   gets the radius it set.

   Usage, per deployment:
     npx convex run migrations:auditDeliveryRadiusUnit     # dry-run report
     npx convex run migrations:convertDeliveryRadiusToKm   # apply

   Idempotent: a value already in kilometres is below the threshold and is left
   alone, so re-running is a no-op.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A radius above this is metres written by the old form.
 *
 * Deliberately the same number `resolveStoreDelivery` refuses to trust, so the
 * migration converts exactly the rows the reader is ignoring — no row is both
 * honoured and converted, and none is neither.
 */
const METRES_THRESHOLD_KM = 200

function radiusInMetres(store: Doc<"stores">): number | null {
  const radius = (store.overrides as { deliveryRadius?: number } | undefined)?.deliveryRadius
  if (typeof radius !== "number") return null
  return radius > METRES_THRESHOLD_KM ? radius : null
}

/** What the conversion would do, without doing it. */
export const auditDeliveryRadiusUnit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const affected: Array<{ storeId: string; name: string; metres: number; kilometres: number }> = []
    for (const store of await ctx.db.query("stores").collect()) {
      const metres = radiusInMetres(store)
      if (metres === null) continue
      affected.push({
        storeId: store._id,
        name: store.name,
        metres,
        kilometres: metres / 1000,
      })
    }
    return { affected, count: affected.length }
  },
})

/** Converts `overrides.deliveryRadius` from metres to kilometres. */
export const convertDeliveryRadiusToKm = internalMutation({
  args: {},
  handler: async (ctx) => {
    let converted = 0
    for (const store of await ctx.db.query("stores").collect()) {
      const metres = radiusInMetres(store)
      if (metres === null) continue
      await ctx.db.patch(store._id, {
        overrides: { ...store.overrides, deliveryRadius: metres / 1000 },
      } as Partial<Doc<"stores">>)
      converted++
    }
    return { converted }
  },
})
