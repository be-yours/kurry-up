import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import {
  RATE_LIMITS,
  consumeRateLimit,
  type RateLimitName,
} from "@be-yours/convex-functions/rateLimit";

/**
 * The rate limiter, reachable from an ACTION.
 *
 * WHY THIS MODULE EXISTS (#430.5). `consumeRateLimit` reads and writes the
 * `rateLimits` table, and it does so deliberately inside the same transaction
 * as the write it protects — a limiter that commits separately from the thing
 * it limits is a limiter with a gap in it. That works for a mutation and is
 * impossible for an action, which has no `ctx.db` at all.
 *
 * So every public-by-design mutation in this deployment was bounded and every
 * public-by-design ACTION was not — and the actions are the expensive half.
 * `stripe.createCheckoutSession`, `sumup.createCheckout`,
 * `paypal.createPayPalOrder` and `uberDirect.getDeliveryQuote` are reachable
 * with no session at all, and each one calls a third party the restaurant pays
 * for or is quota'd by. A script could burn an establishment's Uber Direct
 * quota until real deliveries stopped being quotable, at no cost to itself.
 *
 * WHAT IS DIFFERENT, AND STATED RATHER THAN GLOSSED. An action consuming
 * through this mutation gets a limiter that commits BEFORE the work it bounds,
 * not with it. That is strictly weaker than the mutation case: a caller whose
 * request dies between the two has spent a unit for nothing. It is also the
 * right way round for this use — the unit is spent before the third party is
 * called, so a flood is refused rather than merely counted afterwards — and
 * over-counting a dropped request costs a diner one of ten retries, where the
 * other order would leave the quota-burning call unmetered.
 */
export const consume = internalMutation({
  args: {
    /**
     * A key of `RATE_LIMITS`, checked at runtime.
     *
     * `v.string()` rather than a union of literals: the union would have to be
     * written out a second time here and would then be free to drift from the
     * table it names. Checked below instead, against the table itself, so a
     * typo is a loud refusal rather than a limit that silently does nothing —
     * which is the failure mode that matters, because a limiter that never
     * fires looks exactly like one that is never reached.
     */
    name: v.string(),
    /** What the limit is counted against — an order id, a store id. */
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Object.prototype.hasOwnProperty.call(RATE_LIMITS, args.name)) {
      throw new Error(
        `Unknown rate limit "${args.name}". Declare it in RATE_LIMITS ` +
          "(packages/convex-functions/src/rateLimit.ts) before consuming it."
      );
    }
    await consumeRateLimit(ctx, args.name as RateLimitName, args.subject);
  },
});
