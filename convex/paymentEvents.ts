import { internalMutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/paymentEvents";

// === Internal Mutations (for provider webhooks and the nightly sweep) ===
//
// Every export here is internal by design: a webhook is served by an httpAction
// that already proved the provider signed the body, and the sweep runs on the
// scheduler with no identity at all. Nothing outside this backend has any
// business claiming or retiring a provider delivery.

/**
 * Claim a provider delivery before handling it.
 *
 * Returns "fresh" (record written, go ahead), "in_flight" (a previous attempt
 * died before finishing — let the retry through) or "already_processed".
 */
export const beginEvent = internalMutation(defs.beginEvent);

/** Mark a delivery finished, so the provider's next retry is a no-op. */
export const markProcessed = internalMutation(defs.markProcessed);

/** Drop the deliveries whose 30-day replay window has closed. */
export const sweepExpired = internalMutation(defs.sweepExpired);
