import { query } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/globalSettings";

/**
 * Whether this deployment can actually take a card right now.
 *
 * `globalSettings.payments.cardProvider` declares WHICH provider; the signal
 * that decides whether an attempt can succeed — the Stripe platform key, the
 * SumUp connection — never reached the storefront, so the checkout
 * pre-selected a card tile every fresh deployment could not serve and the
 * natural first journey was a failed card submit (#374).
 */
// @public-by-design: answers a single boolean before any sign-in — "a card can
// be taken" is all the checkout needs to stop pre-selecting a dead tile. The
// key, the connection row and its token never leave the server.
export const get = query({
  args: {},
  handler: async (ctx) => defs.cardPaymentAvailability.handler(ctx),
});
