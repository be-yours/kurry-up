import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { v } from 'convex/values'
import * as defs from '@be-yours/convex-functions/reservationWaitlist'
import { noticeFailureInputValidator } from '@be-yours/convex-schema'
import { storeQuery, storeMutation, storeIdFromDocument } from './lib/storeFunctions'
import { internal } from './_generated/api'
import {
  scheduleMarketingConfirmation,
  scheduleReservationNotice,
  scheduleWaitlistLink,
  scheduleWaitlistOffers,
} from './lib/reservationSchedule'

/**
 * The waitlist and the walk-in queue: the shared handlers in
 * `@be-yours/convex-functions/reservationWaitlist`, bound to this app's builders
 * and, where a transaction ends in an e-mail, to the scheduler.
 *
 * Every public function below says why it may be public; every staff function names
 * the permission that guards it.
 */

// === Public — the guest ===

// @public-by-design: the « Me prévenir » form is filled in by anonymous visitors; bounded by field lengths, two rate-limit windows, the privacy-notice version and the cap on one date's queue
export const join = mutation({
  args: defs.joinWaitlist.args,
  handler: async (ctx, args) => {
    // `link` is for the scheduler: the caller is told nothing about whether the address was
    // already in the line, and never receives the entry's token (it arrives by e-mail).
    const { link, ...result } = await defs.joinWaitlist.handler(ctx, args)
    await scheduleWaitlistLink(ctx, link)
    return result
  },
})

// @public-by-design: the link in the guest's e-mail; the token is the credential; table ids never leave
export const getByToken = query({
  args: defs.getWaitlistByToken.args,
  handler: (ctx, args) => defs.getWaitlistByToken.handler(ctx, args),
})

// @public-by-design: the guest leaves from the link in their e-mail; the token is the credential
export const leave = mutation({
  args: defs.leaveWaitlist.args,
  handler: async (ctx, args) => {
    const { offers, ...result } = await defs.leaveWaitlist.handler(ctx, args)
    await scheduleWaitlistOffers(ctx, offers)
    return result
  },
})

// @public-by-design: the guest takes the table offered from the link in their e-mail; the token is the credential, bounded by the offer's lifetime, a per-entry rate limit and the consent versions
export const claim = mutation({
  args: defs.claimOffer.args,
  handler: async (ctx, args) => {
    const result = await defs.claimOffer.handler(ctx, args)
    await scheduleWaitlistOffers(ctx, result.offers)
    if (!result.claimed) return { claimed: false as const }
    // `notice` and `subscriberId` are for the scheduler, not for a guest.
    const { notice, subscriberId, ...booking } = result.booking
    await scheduleReservationNotice(ctx, notice)
    await scheduleMarketingConfirmation(ctx, subscriberId)
    return { claimed: true as const, booking }
  },
})

// === Staff — the panel ===

export const list = storeQuery({
  permission: 'reservations:read',
  args: defs.listWaitlist.args,
  handler: (ctx, args) => defs.listWaitlist.handler(ctx, args),
})

export const proposeTable = storeMutation({
  permission: 'reservations:write',
  args: defs.proposeTable.args,
  storeIdFrom: storeIdFromDocument('Waitlist entry not found'),
  handler: async (ctx, args) => {
    const { offers } = await defs.proposeTable.handler(ctx, args)
    await scheduleWaitlistOffers(ctx, offers)
    return { offered: offers.length }
  },
})

export const remove = storeMutation({
  permission: 'reservations:write',
  args: defs.removeEntry.args,
  storeIdFrom: storeIdFromDocument('Waitlist entry not found'),
  handler: async (ctx, args) => {
    const { offers } = await defs.removeEntry.handler(ctx, args)
    await scheduleWaitlistOffers(ctx, offers)
  },
})

export const addToQueue = storeMutation({
  permission: 'reservations:write',
  args: defs.addToQueue.args,
  handler: (ctx, args) => defs.addToQueue.handler(ctx, args),
})

export const seatFromQueue = storeMutation({
  permission: 'reservations:write',
  args: defs.seatFromQueue.args,
  storeIdFrom: storeIdFromDocument('Waitlist entry not found'),
  handler: (ctx, args) => defs.seatFromQueue.handler(ctx, args),
})

// === Scheduled — no identity ===

/**
 * Let the offers nobody took lapse and offer their tables to the next in line
 * (cron, every five minutes). Reschedules itself while a backlog remains.
 */
export const expireOffers = internalMutation({
  args: defs.expireOffers.args,
  handler: async (ctx) => {
    const { offers, hasMore, ...result } = await defs.expireOffers.handler(ctx)
    await scheduleWaitlistOffers(ctx, offers)
    if (hasMore) await ctx.scheduler.runAfter(60_000, internal.reservationWaitlist.expireOffers, {})
    return result
  },
})

/** What the sender needs; internal because the e-mail address is in it. */
export const offerPayload = internalQuery({
  args: { waitlistEntryId: v.id('waitlistEntries') },
  handler: (ctx, args) => defs.buildWaitlistOfferPayload(ctx, args.waitlistEntryId),
})

/** What the « your link » sender needs; internal because the e-mail address is in it. */
export const linkPayload = internalQuery({
  args: { waitlistEntryId: v.id('waitlistEntries') },
  handler: (ctx, args) => defs.buildWaitlistLinkPayload(ctx, args.waitlistEntryId),
})

/** Give back the link claim when the sender could not mail it, and say why. */
export const releaseLinkClaim = internalMutation({
  args: {
    waitlistEntryId: v.id('waitlistEntries'),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) => defs.releaseWaitlistLinkClaim(ctx, args.waitlistEntryId, args.failure),
})

/** Give back an offer the sender could not mail, and say why. */
export const releaseOfferClaim = internalMutation({
  args: {
    waitlistEntryId: v.id('waitlistEntries'),
    failure: v.optional(noticeFailureInputValidator),
  },
  handler: (ctx, args) => defs.releaseWaitlistOfferClaim(ctx, args.waitlistEntryId, args.failure),
})
