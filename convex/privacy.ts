import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/privacy";
import { schedulePaymentDispatches } from "./lib/reservationSchedule";

/**
 * Answering a diner's RGPD request, and enforcing the retention window.
 *
 * The policy is in `@be-yours/convex-functions/privacy` so that both this
 * bench and `apps/themes` — the template cloned for every client — apply the
 * same rules. What lives here is what cannot: the `internal` references the
 * scheduler needs, which the package has none of. Same split as
 * `stores.remove` and its cascade.
 *
 * WHY THESE ARE `query`/`mutation` RATHER THAN `storeQuery`/`storeMutation`:
 * a data-subject request spans every establishment the caller administers, and
 * three of the tables it has to reach — `customerAddresses`, `rateLimits`,
 * `userProfiles` — have no `storeId` at all. There is no single store to scope
 * to. `requirePrivacyScope` is the guard instead: it throws unless the caller
 * holds `customers:manage`, and returns the establishments they may act on,
 * which the report then names.
 *
 * WHY THE GUARD IS CALLED HERE rather than left inside the shared handler: an
 * exposed function should say how it is authorised at the point it is exposed.
 * The policy still lives in one place — this is a call to it, not a second
 * copy — and the scope it returns is passed on, so nothing is resolved twice.
 */

// @guarded-inline: requirePrivacyScope throws `denied("permission_denied")`
// unless the caller holds `customers:manage`.
export const previewErasure = query({
  args: defs.previewErasure.args,
  handler: async (ctx, args) => {
    const scope = await defs.requirePrivacyScope(ctx);
    return defs.previewErasure.handler(ctx, args, scope);
  },
});

// @guarded-inline: requirePrivacyScope throws unless the caller holds
// `customers:manage`. An export is a full dossier on one person, so it is
// gated exactly as hard as the erasure.
export const exportDataSubject = query({
  args: defs.exportDataSubject.args,
  handler: async (ctx, args) => {
    const scope = await defs.requirePrivacyScope(ctx);
    return defs.exportDataSubject.handler(ctx, args, scope);
  },
});

/**
 * One pass of an erasure, then as many more as it takes.
 *
 * A diner with three years of orders across two establishments is more rows
 * than one Convex transaction may touch, so the pass returns where it got to
 * and this reschedules from there. The report the operator is shown carries
 * `complete`, and the screen has to render it: a partial erasure reported as
 * finished is the failure the whole module is built to avoid.
 */
// @guarded-inline: requirePrivacyScope throws unless the caller holds
// `customers:manage`, and bounds the walk to the establishments they
// administer.
export const eraseDataSubject = mutation({
  args: defs.eraseDataSubject.args,
  handler: async (ctx, args) => {
    const scope = await defs.requirePrivacyScope(ctx);
    const { payments, ...result } = await defs.eraseDataSubject.handler(ctx, args, scope);
    // The payment pages of an unpaid booking that was erased are closed at the provider.
    await schedulePaymentDispatches(ctx, payments);
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.privacy.continueErasure, {
        email: args.email,
        fingerprint: args.fingerprint,
        storeIds: result.storeIds as never,
        everyStore: result.everyStore,
        actor: result.actor,
        state: result.state,
      });
    }
    return result;
  },
});

/**
 * The rest of the erasure, one pass per run, until there is nothing left.
 *
 * Internal only, and that is load-bearing: it takes the establishments to act
 * on as an argument because a scheduled job has no identity to derive them
 * from, so a public version of this would let any caller name any
 * establishment and erase inside it.
 */
export const continueErasure = internalMutation({
  args: defs.continueErasure.args,
  handler: async (ctx, args) => {
    const { payments, ...result } = await defs.continueErasure.handler(ctx, args);
    await schedulePaymentDispatches(ctx, payments);
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.privacy.continueErasure, {
        ...args,
        state: result.state,
      });
    }
    return result;
  },
});

// @guarded-inline: requirePrivacyScope throws unless the caller holds
// `customers:manage`. The window is the controller's legal position, not a
// display preference, so it is not `settings:write`.
export const setRetention = mutation({
  args: defs.setRetention.args,
  handler: async (ctx, args) => {
    const scope = await defs.requirePrivacyScope(ctx);
    return defs.setRetention.handler(ctx, args, scope);
  },
});

// @public-by-design: the retention window is quoted to the diner in the game's
// consent notice, so it is not a secret from them. It returns one number and
// one boolean and names nobody.
export const getRetention = query({
  args: defs.getRetention.args,
  handler: (ctx) => defs.getRetention.handler(ctx),
});

/**
 * Carry away what has outlived the retention window.
 *
 * Reschedules itself a minute later while there is more to do, the same shape
 * as the kitchen-ticket purge: one bounded pass per run, and a backlog that
 * drains rather than a transaction that dies.
 *
 * THE CURSOR IS THE POINT OF THE RESCHEDULE, not the delay. Rows the sweep
 * skips — an order already anonymised, a subscriber still in touch — stay in
 * the range it walks, so a run that restarted from the beginning would be
 * handed the same skipped rows every night and never reach what is behind
 * them. It would report a clean run while doing nothing, which is
 * indistinguishable from having nothing to do. Passing the state back is what
 * makes the walk move.
 */
export const sweepExpiredCustomerData = internalMutation({
  args: defs.sweepExpiredCustomerData.args,
  handler: async (ctx, args) => {
    const report = await defs.sweepExpiredCustomerData.handler(ctx, args);
    if (report.hasMore && report.state) {
      await ctx.scheduler.runAfter(
        60_000,
        internal.privacy.sweepExpiredCustomerData,
        { ...args, state: report.state },
      );
    }
    return report;
  },
});
