import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/gamePlay";

/**
 * Public player-facing gamification endpoints.
 * Players are anonymous (QR scan at the table) — no auth on purpose.
 * All outcomes are resolved server-side in the shared defs.
 */

// @public-by-design: the whole point is an anonymous customer scanning a QR
// code at a table. The draw itself is server-side and cannot be forged, and
// since #323 every one of these is bounded by `consumeRateLimit` inside the
// shared def — partly on a key the server resolved, so rotating `fingerprint`
// no longer buys another turn. Since NEW-N `play` also charges the
// establishment's prize budget and applies the store's required-actions rule,
// neither of which any argument can move. What none of it restores is the
// cooldown itself, nor identity: a stock smaller than the budget in force still
// goes to whoever asks first. See the note at the top of
// `packages/convex-functions/src/gamePlay.ts`.
// @public-by-design: anonymous customer scanning a table QR code; the draw is server-side
export const getSession = query(defs.getSession);

// @public-by-design: anonymous customer scanning a table QR code; the draw itself is server-side
export const recordScan = mutation(defs.recordScan);

// @public-by-design: anonymous customer scanning a table QR code; the draw is server-side
export const play = mutation(defs.play);

// @public-by-design: anonymous customer scanning a table QR code; the draw itself is server-side
export const ensureReferralCode = mutation(defs.ensureReferralCode);

// @public-by-design: anonymous customer scanning a table QR code; the draw is server-side
export const claim = mutation({
  args: defs.claim.args,
  handler: async (ctx, args) => {
    const result = await defs.claim.handler(ctx, args);

    // Send the prize email (best effort, never blocks the claim)
    if (!result.alreadyClaimed) {
      const play = await ctx.db.get(args.playId);
      const prize = play?.prizeId ? await ctx.db.get(play.prizeId) : null;
      const store = play ? await ctx.db.get(play.storeId) : null;
      if (play && prize && store) {
        await ctx.scheduler.runAfter(0, internal.customerEmail.sendPrizeEmail, {
          toEmail: args.email,
          firstName: args.firstName,
          storeName: store.name,
          prizeName: prize.name,
          prizeDescription: prize.description,
          code: result.code,
          expiresAt: result.expiresAt,
        });
      }
    }

    return result;
  },
});

// @public-by-design: anonymous customer scanning a table QR code; the draw itself is server-side
export const getRedemptionByCode = query(defs.getRedemptionByCode);
