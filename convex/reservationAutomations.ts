import { internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import * as defs from '@be-yours/convex-functions/reservationAutomations'
import { noticeFailureInputValidator } from '@be-yours/convex-schema'
import { storeQuery, storeMutation } from './lib/storeFunctions'

/**
 * The built-in automations of the book and the daily report.
 *
 * Reading them is `reservations:read` (the screen shows every switch to everyone who
 * can open the settings); changing one is `reservations:manage`.
 */

export const get = storeQuery({
  permission: 'reservations:read',
  args: defs.getAutomations.args,
  handler: (ctx, args) => defs.getAutomations.handler(ctx, args),
})

export const save = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveAutomations.args,
  handler: (ctx, args) => defs.saveAutomations.handler(ctx, args),
})

/**
 * Claim and schedule the daily report of every establishment whose time has come
 * (cron, every quarter of an hour).
 */
export const sendDue = internalMutation({
  args: defs.sendDueReports.args,
  handler: async (ctx) => {
    const dispatches = await defs.sendDueReports.handler(ctx)
    for (const dispatch of dispatches) {
      await ctx.scheduler.runAfter(0, internal.customerEmail.sendDailyReport, {
        storeId: dispatch.storeId as Id<'stores'>,
        date: dispatch.date,
      })
    }
    return { reports: dispatches.length }
  },
})

/** What the sender needs; internal because the recipients' addresses are in it. */
export const reportPayload = internalQuery({
  args: { storeId: v.id('stores'), date: v.string() },
  handler: (ctx, args) => defs.buildDailyReportPayload(ctx, args.storeId, args.date),
})

/** Give back a report claim the sender could not use, and say why. */
export const releaseReportClaim = internalMutation({
  args: {
    storeId: v.id('stores'),
    date: v.string(),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) => defs.releaseDailyReportClaim(ctx, args.storeId, args.date, args.failure),
})
