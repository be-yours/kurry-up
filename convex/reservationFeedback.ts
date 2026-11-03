import { internalMutation, mutation, query } from './_generated/server'
import * as defs from '@be-yours/convex-functions/reservationFeedback'
import { storeQuery } from './lib/storeFunctions'
import { scheduleReservationNotice } from './lib/reservationSchedule'

/**
 * What a guest says of a visit, and the thank-you e-mail that asks.
 *
 * The answer is PRIVATE to the restaurant: the only public functions here return a
 * guest's OWN answer to the holder of their link, and the one reader a team member has
 * is `list`, behind `reservations:read`. Nothing adds answers up into something a
 * visitor can see.
 */

// @public-by-design: the link in the thank-you e-mail; the token is the credential; returns only the visit's own facts and the guest's own answer
export const getByToken = query({
  args: defs.getFeedbackByToken.args,
  handler: (ctx, args) => defs.getFeedbackByToken.handler(ctx, args),
})

// @public-by-design: a guest answers from the link in their e-mail; the token is the credential, bounded by the booking's status, a 24-hour edit window, the comment's length, the notice version and two rate-limit windows
export const submit = mutation({
  args: defs.submitFeedback.args,
  handler: (ctx, args) => defs.submitFeedback.handler(ctx, args),
})

export const list = storeQuery({
  permission: 'reservations:read',
  args: defs.listFeedback.args,
  handler: (ctx, args) => defs.listFeedback.handler(ctx, args),
})

/**
 * Claim and schedule the thank-you of every sitting that is due it (cron, every quarter
 * of an hour). The send itself is `customerEmail.sendReservationNotice` with kind
 * `post_visit`, like the other mails of the book.
 */
export const sendDue = internalMutation({
  args: defs.sendDuePostVisit.args,
  handler: async (ctx) => {
    const dispatches = await defs.sendDuePostVisit.handler(ctx)
    for (const notice of dispatches) await scheduleReservationNotice(ctx, notice)
    return { thanked: dispatches.length }
  },
})
