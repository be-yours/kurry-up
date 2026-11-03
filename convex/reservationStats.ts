import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import * as defs from '@be-yours/convex-functions/reservationStats'
import { storeQuery, storeMutation } from './lib/storeFunctions'

/**
 * The statistics of the book: the shared handlers in
 * `@be-yours/convex-functions/reservationStats`, bound to this app's builders.
 *
 * Reading the figures needs `reservations:read`, like the day book; the CSV export and
 * the recomputation of a period are a manager's (`reservations:manage`). The two sweeps
 * have no identity: they are crons.
 */

export const get = storeQuery({
  permission: 'reservations:read',
  args: defs.getStats.args,
  handler: (ctx, args) => defs.getStats.handler(ctx, args),
})

export const exportDays = storeQuery({
  permission: 'reservations:manage',
  args: defs.exportStats.args,
  handler: (ctx, args) => defs.exportStats.handler(ctx, args),
})

export const rebuild = storeMutation({
  permission: 'reservations:manage',
  args: defs.requestRebuild.args,
  handler: (ctx, args) => defs.requestRebuild.handler(ctx, args),
})

/**
 * Recompute the days that were marked (cron, every minute). Runs again at once while
 * marked days remain, so a rebuild of a long period does not wait a minute per batch.
 */
export const sweepDirty = internalMutation({
  args: defs.sweepDirtyStats.args,
  handler: async (ctx) => {
    const result = await defs.sweepDirtyStats.handler(ctx)
    if (result.hasMore) await ctx.scheduler.runAfter(0, internal.reservationStats.sweepDirty, {})
    return result
  },
})

/** Re-mark the last two weeks and drop the oldest rows (cron, nightly). */
export const repair = internalMutation({
  args: defs.repairStats.args,
  handler: (ctx) => defs.repairStats.handler(ctx),
})
