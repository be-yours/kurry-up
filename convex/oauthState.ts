import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * CSRF state store for OAuth connect flows (Uber Eats, and reusable for others).
 *
 * `create` is called when the authorize URL is built (admin-authenticated).
 * `consume` is called on the provider redirect callback: it matches the state,
 * deletes it (single-use), and confirms it has not expired. A missing/expired/
 * mismatched state must abort the token exchange.
 *
 * WHY THERE IS NO SWEEP, unlike `paymentEvents`. A row survives only when a
 * flow is ABANDONED — `consume` deletes it on every presentation — and a row is
 * only ever created by an admin clicking "Connecter" (`oauthConnect`, behind
 * `settings:write`) or by `stripeRefresh`, which mints one only after spending
 * one, so it is net zero. That is a handful of rows per deployment for its
 * whole life, not the thousands a webhook table collects, and a leftover row is
 * inert: `consume` refuses it forever once expired. Sweeping it would cost a
 * new `by_expiresAt` index in `packages/convex-schema`, a package definition,
 * a wrapper in both apps and a cron in both apps — surface out of all
 * proportion to what it deletes.
 *
 * What would change that answer: a route that mints a state WITHOUT an admin
 * session and without consuming one first. That makes the table growable by
 * anyone who can call it, and it would need the index and the sweep together.
 */

/**
 * How long a state stays valid, per provider.
 *
 * WHY THIS IS NOT ONE NUMBER: ten minutes is right for a consent screen — Uber
 * Eats and SumUp show a page with an "Autoriser" button, and the round trip is
 * one click. Stripe Connect is not that. It is KYC: a long form, company and
 * bank details, and an identity document to photograph and upload. An owner who
 * takes twenty-five minutes over it came back to "Invalid or expired OAuth
 * state", was refused, and had to start again — and starting again mints a
 * BRAND NEW connected account each time, so the abandoned ones pile up on the
 * Stripe side. The window has to outlast the form, not the click.
 *
 * WHY 45 MINUTES: long enough for a real onboarding session including the
 * document upload and a pause to find a bank statement, short enough that an
 * abandoned state is not a day-long liability. A 30-60 minute state lifetime is
 * ordinary for OAuth. Widening it does not make the token guessable either: it
 * is 16 random bytes (`randomBytes(16)` in `oauthConnect.ts`, `getRandomValues`
 * on the refresh hop), so 128 bits stay 128 bits however long the row lives.
 * What actually protects the flow is that the state is SINGLE-USE — `consume`
 * deletes the row on every match, before it judges provider or expiry — and
 * that property is untouched here.
 *
 * Only Stripe is widened. There is no reason to give Uber Eats or SumUp a
 * longer window than their one click needs, and a global bump would have handed
 * them one for free.
 *
 * The expiry is decided HERE, on the server, from the provider alone. Letting a
 * caller pass its own TTL would turn this guard into advice.
 */
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — one consent click
const STRIPE_STATE_TTL_MS = 45 * 60 * 1000; // 45 minutes — KYC form + document

const STATE_TTL_MS_BY_PROVIDER: Readonly<Record<string, number>> = {
  stripe: STRIPE_STATE_TTL_MS,
};

/** The window this provider's flow gets. Unknown providers get the short one. */
function stateTtlMs(provider: string): number {
  return STATE_TTL_MS_BY_PROVIDER[provider] ?? DEFAULT_STATE_TTL_MS;
}

export const create = internalMutation({
  args: { provider: v.string(), state: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("oauthStates", {
      provider: args.provider,
      state: args.state,
      expiresAt: Date.now() + stateTtlMs(args.provider),
    });
  },
});

export const consume = internalMutation({
  args: { provider: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
    if (!row) return false;
    // Single-use: always delete once matched, even on provider/expiry mismatch.
    await ctx.db.delete(row._id);
    if (row.provider !== args.provider) return false;
    if (row.expiresAt < Date.now()) return false;
    return true;
  },
});
