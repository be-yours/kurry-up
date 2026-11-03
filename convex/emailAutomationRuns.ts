import { internalMutation, internalQuery } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/emailAutomationRuns";

/**
 * What an automation has already sent, and to whom.
 *
 * Internal only, both of them: these are the engine's own bookkeeping, written
 * and read by scheduled steps that carry no session. Nothing in the admin reads
 * them yet — when something does, it wants a store-scoped query, not these.
 */
export const stepsSentTo = internalQuery(defs.stepsSentTo);
export const record = internalMutation(defs.record);
