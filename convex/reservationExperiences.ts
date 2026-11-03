import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import * as defs from '@be-yours/convex-functions/reservationExperiences'
import { noticeFailureInputValidator } from '@be-yours/convex-schema'
import { storeQuery, storeMutation, storeIdFromDocument } from './lib/storeFunctions'
import {
  scheduleMarketingConfirmation,
  scheduleReservationNotice,
  schedulePaymentEffects,
} from './lib/reservationSchedule'

/**
 * Limited-seat experiences: the shared handlers in
 * `@be-yours/convex-functions/reservationExperiences`, bound to this app's builders and,
 * where a transaction ends in an e-mail or in money to move, to the scheduler.
 *
 * Every public function below says why it may be public; every staff function names the
 * permission that guards it. Writing an event, publishing it, cancelling it and exporting
 * its attendees need `reservations:manage` (they sell, hold a room and refund money, and the
 * export leaves the building with the guests' details); reading the list and the door list
 * needs `reservations:read`.
 */

// === Public — the booking page ===

// @public-by-design: the booking page is read by anonymous visitors; it answers what the establishment published (a title, a time, a price, a seat count) and nothing about who bought, and an empty list unless the online switch is on
export const listPublic = query({
  args: defs.listPublic.args,
  handler: (ctx, args) => defs.listPublic.handler(ctx, args),
})

// @public-by-design: the purchase form reads what the seats would cost before the guest submits; it answers the establishment's published terms, never how it is configured
export const getPurchaseQuote = query({
  args: defs.getPurchaseQuote.args,
  handler: (ctx, args) => defs.getPurchaseQuote.handler(ctx, args),
})

// @public-by-design: the purchase form is filled in by anonymous visitors; bounded by field lengths, two rate-limit windows, the consent versions, the seats left in this transaction and the sales window
export const buy = mutation({
  args: defs.buyExperience.args,
  handler: async (ctx, args) => {
    // `notice` and `subscriberId` are for the scheduler, not for a diner.
    const { notice, subscriberId, ...ticket } = await defs.buyExperience.handler(ctx, args)
    await scheduleReservationNotice(ctx, notice)
    await scheduleMarketingConfirmation(ctx, subscriberId)
    return ticket
  },
})

// @public-by-design: the « Me prévenir » form on a sold-out event is filled in by anonymous visitors; bounded by field lengths, two rate-limit windows, the notice version and the cap on one event's list
export const joinAlert = mutation({
  args: defs.joinAlert.args,
  handler: (ctx, args) => defs.joinAlert.handler(ctx, args),
})

// === Staff ===

export const listExperiences = storeQuery({
  permission: 'reservations:read',
  args: defs.listExperiences.args,
  handler: (ctx, args) => defs.listExperiences.handler(ctx, args),
})

export const getExperienceOptions = storeQuery({
  permission: 'reservations:read',
  args: defs.getExperienceOptions.args,
  handler: (ctx, args) => defs.getExperienceOptions.handler(ctx, args),
})

export const listAttendees = storeQuery({
  permission: 'reservations:read',
  args: defs.listAttendees.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: (ctx, args) => defs.listAttendees.handler(ctx, args),
})

export const exportAttendees = storeQuery({
  permission: 'reservations:manage',
  args: defs.exportAttendees.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: (ctx, args) => defs.exportAttendees.handler(ctx, args),
})

export const checkExperience = storeQuery({
  permission: 'reservations:manage',
  args: defs.checkExperience.args,
  handler: (ctx, args) => defs.checkExperience.handler(ctx, args),
})

export const saveExperience = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveExperience.args,
  handler: (ctx, args) => defs.saveExperience.handler(ctx, args),
})

export const publishExperience = storeMutation({
  permission: 'reservations:manage',
  args: defs.publishExperience.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: (ctx, args) => defs.publishExperience.handler(ctx, args),
})

export const unpublishExperience = storeMutation({
  permission: 'reservations:manage',
  args: defs.unpublishExperience.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: (ctx, args) => defs.unpublishExperience.handler(ctx, args),
})

export const removeExperience = storeMutation({
  permission: 'reservations:manage',
  args: defs.removeExperience.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: (ctx, args) => defs.removeExperience.handler(ctx, args),
})

/**
 * Cancel a whole event: every ticket cancelled by the establishment, refunded in full and
 * mailed. A large event takes several runs: the first answers `hasMore` and the rest follows
 * (`cancelTickets`), a minute apart, until no ticket is left.
 */
export const cancelExperience = storeMutation({
  permission: 'reservations:manage',
  args: defs.cancelExperience.args,
  storeIdFrom: storeIdFromDocument('Experience not found'),
  handler: async (ctx, args) => {
    const { notices, offers, payments, hasMore, ...result } = await defs.cancelExperience.handler(
      ctx,
      args,
    )
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    if (hasMore) {
      await ctx.scheduler.runAfter(1_000, internal.reservationExperiences.cancelTickets, {
        id: args.id,
      })
    }
    return { ...result, hasMore }
  },
})

// === Scheduled and internal — no identity ===

/** The rest of a cancelled event's tickets, when it was too large for one run. */
export const cancelTickets = internalMutation({
  args: defs.cancelTickets.args,
  handler: async (ctx, args) => {
    const { notices, offers, payments, hasMore, ...result } = await defs.cancelTickets.handler(
      ctx,
      args,
    )
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    if (hasMore) {
      await ctx.scheduler.runAfter(1_000, internal.reservationExperiences.cancelTickets, args)
    }
    return result
  },
})

/**
 * Resume the cancellations whose chain of batches died (cron, every ten minutes): the tickets
 * of a cancelled event that were not reached stay confirmed and unrefunded until someone does.
 */
export const resumeCancellations = internalMutation({
  args: defs.resumeCancellations.args,
  handler: async (ctx) => {
    const { runs } = await defs.resumeCancellations.handler(ctx)
    for (const run of runs) {
      const { id, hasMore, notices, offers, payments } = run
      await schedulePaymentEffects(ctx, { notices, offers, payments })
      if (hasMore) {
        await ctx.scheduler.runAfter(1_000, internal.reservationExperiences.cancelTickets, {
          id: id as Id<'reservationExperiences'>,
        })
      }
    }
    return { resumed: runs.length }
  },
})

/**
 * Tell the guests who asked that seats came back at a sold-out event (cron, every five
 * minutes). One mail per entry, claimed before it is scheduled.
 */
export const mailSeatAlerts = internalMutation({
  args: defs.mailSeatAlerts.args,
  handler: async (ctx) => {
    const { alerts, ...result } = await defs.mailSeatAlerts.handler(ctx)
    for (const alert of alerts) {
      await ctx.scheduler.runAfter(0, internal.customerEmail.sendExperienceSeatAlert, {
        waitlistEntryId: alert.waitlistEntryId as Id<'waitlistEntries'>,
      })
    }
    return result
  },
})

/** What the sender needs; internal because the e-mail address is in it. */
export const alertPayload = internalQuery({
  args: { waitlistEntryId: v.id('waitlistEntries') },
  handler: (ctx, args) => defs.buildSeatAlertPayload(ctx, args.waitlistEntryId),
})

/** Give back an alert the sender could not mail, and say why. */
export const releaseAlertClaim = internalMutation({
  args: {
    waitlistEntryId: v.id('waitlistEntries'),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) => defs.releaseSeatAlertClaim(ctx, args.waitlistEntryId, args.failure),
})
