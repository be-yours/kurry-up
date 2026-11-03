import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { v } from 'convex/values'
import * as defs from '@be-yours/convex-functions/reservations'
import {
  buildReservationNoticePayload,
  releaseReservationNoticeClaim,
} from '@be-yours/convex-functions/reservationNotices'
import { noticeFailureInputValidator } from '@be-yours/convex-schema'
import { storeQuery, storeMutation, storeIdFromDocument } from './lib/storeFunctions'
import {
  scheduleMarketingConfirmation,
  schedulePaymentDispatches,
  scheduleReservationNotice as scheduleNotice,
  scheduleWaitlistOffers,
} from './lib/reservationSchedule'

const noticeKindValidator = v.union(
  v.literal('pending'),
  v.literal('confirmed'),
  v.literal('declined'),
  v.literal('cancelled_by_restaurant'),
  v.literal('cancelled_by_guest'),
  v.literal('reminder'),
  v.literal('modified'),
  v.literal('modified_restaurant'),
  v.literal('post_visit'),
  v.literal('payment_refunded'),
  v.literal('fee_charged'),
  v.literal('payment_failed'),
  v.literal('payment_failed_restaurant'),
  v.literal('group_received'),
  v.literal('group_approved'),
  v.literal('group_declined'),
  v.literal('group_counter'),
  v.literal('group_expired'),
)

/** What the sender needs; internal because the e-mail address is in it. */
export const noticePayload = internalQuery({
  args: { reservationId: v.id('reservations'), kind: noticeKindValidator },
  handler: (ctx, args) => buildReservationNoticePayload(ctx, args.reservationId, args.kind),
})

/** Give back a claim the sender could not use, and say why. */
export const releaseNoticeClaim = internalMutation({
  args: {
    reservationId: v.id('reservations'),
    kind: noticeKindValidator,
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) =>
    releaseReservationNoticeClaim(ctx, args.reservationId, args.kind, args.failure),
})

/**
 * E-mail the guests whose reminder is due (cron, every quarter of an hour).
 *
 * The defs layer decides who and claims each send in its own transaction; this
 * schedules them, which needs `internal.*`.
 */
export const sendDueReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const dispatches = await defs.remindDue.handler(ctx)
    for (const notice of dispatches) await scheduleNotice(ctx, notice)
    return { reminded: dispatches.length }
  },
})

/**
 * Close the requests nobody answered before their time came (cron, every
 * quarter of an hour).
 */
export const expireUnanswered = internalMutation({
  args: defs.expireUnanswered.args,
  handler: async (ctx) => {
    // A request that expired frees its table: the waitlist may be offered it.
    const { offers, payments, notices, ...result } = await defs.expireUnanswered.handler(ctx)
    // A group request that lapsed says so to its guest.
    for (const notice of notices) await scheduleNotice(ctx, notice)
    await scheduleWaitlistOffers(ctx, offers)
    // A request that expired may have been paid at the last minute: the money follows.
    await schedulePaymentDispatches(ctx, payments)
    return result
  },
})

// === Public — the storefront ===

/**
 * What the booking page renders from, or `null` when the establishment's
 * switch is not on `native`.
 */
// @public-by-design: the booking page is read by anonymous visitors, and answers null unless the switch is on
export const getPublicConfig = query({
  args: defs.getPublicConfig.args,
  handler: (ctx, args) => defs.getPublicConfig.handler(ctx, args),
})

// @public-by-design: the slot picker is read by anonymous visitors; table ids never leave the server
export const getAvailability = query({
  args: defs.getAvailability.args,
  handler: (ctx, args) => defs.getAvailability.handler(ctx, args),
})

// @public-by-design: the booking form is filled in by anonymous visitors; bounded by field lengths, two rate-limit windows and the consent version
export const create = mutation({
  args: defs.create.args,
  handler: async (ctx, args) => {
    // `notice` and `subscriberId` are for the scheduler, not for a diner: one names
    // a claim, the other a pending subscription whose confirmation link is mailed.
    const { notice, subscriberId, ...booking } = await defs.create.handler(ctx, args)
    await scheduleNotice(ctx, notice)
    await scheduleMarketingConfirmation(ctx, subscriberId)
    return booking
  },
})

// @public-by-design: the manage link in the guest's e-mail; the token is the credential
export const getByToken = query({
  args: defs.getByToken.args,
  handler: (ctx, args) => defs.getByToken.handler(ctx, args),
})

// @public-by-design: the manage link in the guest's e-mail; the token is the credential; read-only, and table ids never leave
export const getAvailabilityByToken = query({
  args: defs.getAvailabilityByToken.args,
  handler: (ctx, args) => defs.getAvailabilityByToken.handler(ctx, args),
})

// @public-by-design: the guest changes their booking from the link in their e-mail; the token is the credential, bounded by status, the change window, a per-booking rate limit and field caps
export const modifyByToken = mutation({
  args: defs.modifyByToken.args,
  handler: async (ctx, args) => {
    // `notices` names claims for the scheduler, not for a guest.
    const { notices, offers, ...result } = await defs.modifyByToken.handler(ctx, args)
    for (const notice of notices) await scheduleNotice(ctx, notice)
    await scheduleWaitlistOffers(ctx, offers)
    return result
  },
})

// @public-by-design: the manage link in the guest's e-mail; the token is the credential
export const cancelByToken = mutation({
  args: defs.cancelByToken.args,
  handler: async (ctx, args) => {
    const { notice, offers, payments, ...result } = await defs.cancelByToken.handler(ctx, args)
    await scheduleNotice(ctx, notice)
    await scheduleWaitlistOffers(ctx, offers)
    // A deposit cancelled in time is refunded; a guarantee is released.
    await schedulePaymentDispatches(ctx, payments)
    return result
  },
})

// @public-by-design: the guest confirms from the link in their reminder; the token is the credential
export const reconfirmByToken = mutation({
  args: defs.reconfirmByToken.args,
  handler: (ctx, args) => defs.reconfirmByToken.handler(ctx, args),
})

// === Staff — the day's book ===

export const listDay = storeQuery({
  permission: 'reservations:read',
  args: defs.listDay.args,
  handler: (ctx, args) => defs.listDay.handler(ctx, args),
})

export const listCarryOver = storeQuery({
  permission: 'reservations:read',
  args: defs.listCarryOver.args,
  handler: (ctx, args) => defs.listCarryOver.handler(ctx, args),
})

export const calendarRange = storeQuery({
  permission: 'reservations:read',
  args: defs.calendarRange.args,
  handler: (ctx, args) => defs.calendarRange.handler(ctx, args),
})

export const history = storeQuery({
  permission: 'reservations:read',
  args: defs.history.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: (ctx, args) => defs.history.handler(ctx, args),
})

export const staffAvailability = storeQuery({
  permission: 'reservations:read',
  args: defs.staffAvailability.args,
  handler: (ctx, args) => defs.staffAvailability.handler(ctx, args),
})

export const getSetup = storeQuery({
  permission: 'reservations:read',
  args: defs.getSetup.args,
  handler: (ctx, args) => defs.getSetup.handler(ctx, args),
})

export const createByStaff = storeMutation({
  permission: 'reservations:write',
  args: defs.createByStaff.args,
  handler: async (ctx, args) => {
    const { notice, subscriberId, ...booking } = await defs.createByStaff.handler(ctx, args)
    await scheduleNotice(ctx, notice)
    await scheduleMarketingConfirmation(ctx, subscriberId)
    return booking
  },
})

export const updateByStaff = storeMutation({
  permission: 'reservations:write',
  args: defs.updateByStaff.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { notices, offers, ...result } = await defs.updateByStaff.handler(ctx, args)
    for (const notice of notices) await scheduleNotice(ctx, notice)
    await scheduleWaitlistOffers(ctx, offers)
    return result
  },
})

export const moveTables = storeMutation({
  permission: 'reservations:write',
  args: defs.moveTables.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { offers, ...result } = await defs.moveTables.handler(ctx, args)
    await scheduleWaitlistOffers(ctx, offers)
    return result
  },
})

export const walkInOutlook = storeQuery({
  permission: 'reservations:read',
  args: defs.walkInOutlook.args,
  handler: (ctx, args) => defs.walkInOutlook.handler(ctx, args),
})

export const seatWalkIn = storeMutation({
  permission: 'reservations:write',
  args: defs.seatWalkIn.args,
  handler: (ctx, args) => defs.seatWalkIn.handler(ctx, args),
})

export const setStatus = storeMutation({
  permission: 'reservations:write',
  args: defs.setStatus.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: async (ctx, args) => {
    const { notice, offers, payments, ...result } = await defs.setStatus.handler(ctx, args)
    await scheduleNotice(ctx, notice)
    await scheduleWaitlistOffers(ctx, offers)
    await schedulePaymentDispatches(ctx, payments)
    return result
  },
})

export const setInternalNote = storeMutation({
  permission: 'reservations:write',
  args: defs.setInternalNote.args,
  storeIdFrom: storeIdFromDocument('Reservation not found'),
  handler: (ctx, args) => defs.setInternalNote.handler(ctx, args),
})

// === Staff — settings ===

export const getConfig = storeQuery({
  permission: 'reservations:read',
  args: defs.getConfig.args,
  handler: (ctx, args) => defs.getConfig.handler(ctx, args),
})

export const saveSettings = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveSettings.args,
  handler: (ctx, args) => defs.saveSettings.handler(ctx, args),
})

export const saveService = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveService.args,
  handler: (ctx, args) => defs.saveService.handler(ctx, args),
})

export const removeService = storeMutation({
  permission: 'reservations:manage',
  args: defs.removeService.args,
  storeIdFrom: storeIdFromDocument('Service not found'),
  handler: (ctx, args) => defs.removeService.handler(ctx, args),
})

export const saveClosure = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveClosure.args,
  handler: (ctx, args) => defs.saveClosure.handler(ctx, args),
})

export const removeClosure = storeMutation({
  permission: 'reservations:manage',
  args: defs.removeClosure.args,
  storeIdFrom: storeIdFromDocument('Closure not found'),
  handler: (ctx, args) => defs.removeClosure.handler(ctx, args),
})

export const saveTable = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveTable.args,
  handler: (ctx, args) => defs.saveTable.handler(ctx, args),
})

export const saveRoom = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveRoom.args,
  handler: (ctx, args) => defs.saveRoom.handler(ctx, args),
})

export const reorderRooms = storeMutation({
  permission: 'reservations:manage',
  args: defs.reorderRooms.args,
  handler: (ctx, args) => defs.reorderRooms.handler(ctx, args),
})

export const archiveRoom = storeMutation({
  permission: 'reservations:manage',
  args: defs.archiveRoom.args,
  storeIdFrom: storeIdFromDocument('Room not found'),
  handler: (ctx, args) => defs.archiveRoom.handler(ctx, args),
})

export const saveTableLayout = storeMutation({
  permission: 'reservations:manage',
  args: defs.saveTableLayout.args,
  handler: (ctx, args) => defs.saveTableLayout.handler(ctx, args),
})
