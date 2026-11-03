import { internalMutation, mutation } from './_generated/server'
import { internal } from './_generated/api'
import * as defs from '@be-yours/convex-functions/reservationGroups'
import { storeQuery, storeMutation, storeIdFromDocument } from './lib/storeFunctions'
import {
  scheduleMarketingConfirmation,
  scheduleReservationNotice,
  schedulePaymentEffects,
} from './lib/reservationSchedule'

/**
 * Groups, answered by the host: the shared handlers in
 * `@be-yours/convex-functions/reservationGroups`, bound to this app's builders and, where a
 * transaction ends in an e-mail, a refund or a waitlist offer, to the scheduler.
 *
 * Every public function below says why it may be public; every staff function names the
 * permission that guards it. Attaching a payment to an answer needs
 * `reservations:manage`, checked inside the handler (the money terms are the owner's).
 */

// === Public — the guest ===

// @public-by-design: the group request form is filled in by anonymous visitors; bounded by field lengths, two rate-limit windows, the consent version, the policy's party-size bands and the recomputed availability
export const requestGroup = mutation({
  args: defs.requestGroup.args,
  handler: async (ctx, args) => {
    // `notice` and `subscriberId` are for the scheduler, not for a diner.
    const { notice, subscriberId, ...booking } = await defs.requestGroup.handler(ctx, args)
    await scheduleReservationNotice(ctx, notice)
    await scheduleMarketingConfirmation(ctx, subscriberId)
    return booking
  },
})

// @public-by-design: the guest answers the host's counter-proposal from the link in their e-mail; the token is the credential, bounded by the booking's status, the offer's lifetime and a per-booking rate limit
export const respondToProposal = mutation({
  args: defs.respondToProposal.args,
  handler: async (ctx, args) => {
    const { notices, offers, payments, ...result } = await defs.respondToProposal.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    return result
  },
})

// === Staff — the settings card ===

export const getGroupPolicy = storeQuery({
  permission: 'reservations:read',
  args: defs.getGroupPolicy.args,
  handler: (ctx, args) => defs.getGroupPolicy.handler(ctx, args),
})

export const saveGroupPolicy = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveGroupPolicy.args,
  handler: (ctx, args) => defs.saveGroupPolicy.handler(ctx, args),
})

// === Staff — the requests ===

export const listGroupRequests = storeQuery({
  permission: 'reservations:read',
  args: defs.listGroupRequests.args,
  handler: (ctx, args) => defs.listGroupRequests.handler(ctx, args),
})

export const getApprovalOptions = storeQuery({
  permission: 'reservations:read',
  args: defs.getApprovalOptions.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: (ctx, args) => defs.getApprovalOptions.handler(ctx, args),
})

export const groupSlots = storeQuery({
  permission: 'reservations:read',
  args: defs.groupSlots.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: (ctx, args) => defs.groupSlots.handler(ctx, args),
})

export const approveGroup = storeMutation({
  permission: 'reservations:write',
  args: defs.approveGroup.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { notices, offers, payments, ...result } = await defs.approveGroup.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    return result
  },
})

export const declineGroup = storeMutation({
  permission: 'reservations:write',
  args: defs.declineGroup.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { notices, offers, payments, ...result } = await defs.declineGroup.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    return result
  },
})

export const proposeGroupAlternative = storeMutation({
  permission: 'reservations:write',
  args: defs.proposeGroupAlternative.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { notices, offers, payments } = await defs.proposeGroupAlternative.handler(ctx, args)
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    return { proposed: true as const }
  },
})

// === Scheduled — no identity ===

/**
 * Let the group requests nobody answered go, and tell their guests (cron, every ten
 * minutes). Reschedules itself while a backlog remains.
 */
export const expireReviews = internalMutation({
  args: defs.expireReviews.args,
  handler: async (ctx) => {
    const { notices, offers, payments, hasMore, ...result } = await defs.expireReviews.handler(ctx)
    await schedulePaymentEffects(ctx, { notices, offers, payments })
    if (hasMore) await ctx.scheduler.runAfter(60_000, internal.reservationGroups.expireReviews, {})
    return result
  },
})
