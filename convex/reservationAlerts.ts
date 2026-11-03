import { internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import * as defs from '@be-yours/convex-functions/reservationAlerts'
import { storeQuery, storeMutation } from './lib/storeFunctions'

/**
 * The alert centre: what the book raises for the host, derived on each read.
 *
 * Reading, dismissing and restoring are all `reservations:read`: marking an alert as
 * read changes what THIS person sees and nothing about the book. The e-mail sweep and
 * the clean-up are crons.
 */

export const list = storeQuery({
  permission: 'reservations:read',
  args: defs.listAlerts.args,
  handler: (ctx, args, identity) => defs.listAlerts.handler(ctx, args, identity),
})

export const dismiss = storeMutation({
  permission: 'reservations:read',
  args: defs.dismissAlerts.args,
  handler: (ctx, args, identity) => defs.dismissAlerts.handler(ctx, args, identity),
})

export const restore = storeMutation({
  permission: 'reservations:read',
  args: defs.restoreAlerts.args,
  handler: (ctx, args, identity) => defs.restoreAlerts.handler(ctx, args, identity),
})

/**
 * The dispatcher of the e-mail sweep (cron, every quarter of an hour): one bounded page of
 * establishments that want the digest, one claim scheduled for each, and the next page.
 * It reads no book — each establishment is read by its own job below.
 */
export const sendDue = internalMutation({
  args: defs.listStoresForAlertEmails.args,
  handler: async (ctx, args) => {
    const page = await defs.listStoresForAlertEmails.handler(ctx, args)
    for (const storeId of page.storeIds) {
      await ctx.scheduler.runAfter(0, internal.reservationAlerts.sendDueForStore, {
        storeId: storeId as Id<'stores'>,
      })
    }
    if (page.continueCursor) {
      await ctx.scheduler.runAfter(0, internal.reservationAlerts.sendDue, {
        cursor: page.continueCursor,
      })
    }
    return { stores: page.storeIds.length }
  },
})

/**
 * Claim the alerts nobody was e-mailed about for ONE establishment and schedule its
 * message. A job of its own: a failure here is that establishment's alone and is not
 * retried — its alerts are still in the centre, and the next sweep claims them.
 */
export const sendDueForStore = internalMutation({
  args: defs.claimAlertEmailsForStore.args,
  handler: async (ctx, args) => {
    const dispatch = await defs.claimAlertEmailsForStore.handler(ctx, args)
    if (!dispatch) return { digests: 0 }
    await ctx.scheduler.runAfter(0, internal.customerEmail.sendAlertDigest, {
      storeId: dispatch.storeId as Id<'stores'>,
      keys: dispatch.keys,
    })
    return { digests: 1 }
  },
})

/** What the sender needs; internal because the recipients' addresses are in it. */
export const digestPayload = internalQuery({
  args: { storeId: v.id('stores'), keys: v.array(v.string()) },
  handler: (ctx, args) => defs.buildAlertDigestPayload(ctx, args.storeId, args.keys),
})

/** Drop the marks of what is over (cron, nightly). */
export const prune = internalMutation({
  args: defs.pruneAlertMarks.args,
  handler: async (ctx) => {
    const result = await defs.pruneAlertMarks.handler(ctx)
    if (result.hasMore) await ctx.scheduler.runAfter(60_000, internal.reservationAlerts.prune, {})
    return result
  },
})
