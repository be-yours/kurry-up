import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import * as defs from '@be-yours/convex-functions/reservationGuests'
import {
  storeQuery,
  storeMutation,
  storeIdFromDocument,
  storeIdFromField,
} from './lib/storeFunctions'

/**
 * The guest book: profiles, the host's notes and tags, the merge of two profiles,
 * the CSV export, and the nightly erasure of the notes that outlived their sitting.
 *
 * The shared handlers are in `@be-yours/convex-functions/reservationGuests`. Reading
 * and editing a profile follow `reservations:read` / `:write`; merging two profiles
 * and exporting the book move a lot of personal data at once and need
 * `reservations:manage`.
 */

export const list = storeQuery({
  permission: 'reservations:read',
  args: defs.listGuests.args,
  handler: (ctx, args) => defs.listGuests.handler(ctx, args),
})

export const get = storeQuery({
  permission: 'reservations:read',
  args: defs.getGuest.args,
  storeIdFrom: storeIdFromDocument('Guest not found'),
  handler: (ctx, args) => defs.getGuest.handler(ctx, args),
})

export const flags = storeQuery({
  permission: 'reservations:read',
  args: defs.guestFlags.args,
  handler: (ctx, args) => defs.guestFlags.handler(ctx, args),
})

export const update = storeMutation({
  permission: 'reservations:write',
  args: defs.updateGuest.args,
  storeIdFrom: storeIdFromDocument('Guest not found'),
  handler: (ctx, args) => defs.updateGuest.handler(ctx, args),
})

export const merge = storeMutation({
  permission: 'reservations:manage',
  args: defs.mergeGuests.args,
  storeIdFrom: storeIdFromField('keepId', 'Guest not found'),
  handler: (ctx, args) => defs.mergeGuests.handler(ctx, args),
})

export const exportAll = storeQuery({
  permission: 'reservations:manage',
  args: defs.exportGuests.args,
  handler: (ctx, args) => defs.exportGuests.handler(ctx, args),
})

/**
 * Erase the free-text request of every booking whose sitting ended a few days ago
 * (cron, daily). Reschedules itself a minute later while a backlog remains.
 */
export const purgeGuestNotes = internalMutation({
  args: defs.purgeGuestNotes.args,
  handler: async (ctx, args) => {
    const result = await defs.purgeGuestNotes.handler(ctx, args)
    if (result.hasMore) {
      await ctx.scheduler.runAfter(60_000, internal.reservationGuests.purgeGuestNotes, {})
    }
    return result
  },
})
