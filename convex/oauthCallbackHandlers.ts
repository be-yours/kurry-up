import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// CSRF state — shared by all three payment connect callbacks
// ---------------------------------------------------------------------------

/**
 * Verify the single-use CSRF state the connect flow issued.
 *
 * Returns `null` when the state is good, or the redirect to answer with when it
 * is not — so a caller reads `if (rejected) return rejected;` before doing
 * anything that costs money or writes a row.
 *
 * `oauthState.consume` deletes the matched row BEFORE it judges provider and
 * expiry, so a state survives exactly one presentation whatever the outcome:
 * a replay is refused even though the first attempt was legitimate. It is a
 * mutation, hence a transaction, so two callbacks racing with the same state
 * cannot both pass.
 *
 * The wording mirrors the Uber Eats callback (`uberEatsOAuthHttp.ts`), which
 * has done this correctly since it was built; these three routes are the ones
 * that never did.
 */
async function requireOAuthState(
  ctx: ActionCtx,
  url: URL,
  provider: string,
  adminUrl: string
): Promise<Response | null> {
  const fail = (message: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent(message)}`,
      },
    });

  const state = url.searchParams.get("state");
  if (!state) return fail("Missing OAuth state");

  const valid = await ctx.runMutation(internal.oauthState.consume, {
    provider,
    state,
  });
  if (!valid) return fail("Invalid or expired OAuth state");

  return null;
}

// ---------------------------------------------------------------------------
// Stripe response shapes
// ---------------------------------------------------------------------------

interface StripeAccountResponse {
  id: string;
  charges_enabled?: boolean;
  details_submitted?: boolean;
  error?: { message: string };
}

interface StripeAccountLinkResponse {
  url: string;
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// Stripe: Account Links callback (return from onboarding)
// ---------------------------------------------------------------------------

/**
 * Handle the return redirect after Stripe Account Links onboarding.
 * Checks that the account has charges_enabled and stores the connection.
 */
// @guarded-inline: consumes the single-use OAuth state issued by
// generateOAuthUrl, with a TTL, before trusting `account_id` or writing the row
export const stripeCallback = httpAction(async (ctx, request) => {
  const { getSiteEnv } = await import("@be-yours/core/env");
  const site = getSiteEnv();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account_id");
  const adminUrl = site.ADMIN_URL ?? "http://localhost:3000";

  if (!accountId) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Missing account ID")}` },
    });
  }

  // CSRF: `account_id` is attacker-supplied text until a state we issued backs
  // it. Refuse before any Stripe call, so a probe learns nothing about how the
  // deployment is configured either.
  const rejected = await requireOAuthState(ctx, url, "stripe", adminUrl);
  if (rejected) return rejected;

  const stripeKey = site.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Stripe not configured")}` },
    });
  }

  try {
    // Verify the account status
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const account = (await res.json()) as StripeAccountResponse;

    if (!res.ok || account.error) {
      throw new Error(account.error?.message ?? "Failed to verify Stripe account");
    }

    // Store the connection.
    //
    // NOT "connected", even when Stripe says charges are enabled. Onboarding
    // finishing does not mean the restaurant is being paid: `stripe.ts` builds
    // its client from the PLATFORM secret key with no `stripeAccount`, no
    // `on_behalf_of` and no `transfer_data`, and never reads this row. Every
    // euro lands in the platform balance. Writing "connected" put a green dot
    // and "Connecté" in front of an owner whose takings were going elsewhere —
    // the admin lying is worse than the missing feature.
    //
    // "onboarding_complete" is the state's own name in the union
    // (packages/convex-schema/src/tables/paymentConnections.ts): the account
    // exists and onboarding finished, and charges are not routed to it. The
    // settings screen shows it in amber and says where the money goes, and
    // "Déconnecter" stays reachable so a stranded account can be cleared —
    // "disconnected" was the closest available value before this literal
    // existed and it made the row unremovable. "error" keeps meaning the
    // Stripe-side failure it already meant: onboarding that never enabled
    // charges.
    //
    // Flip this to "connected" in the same commit that routes the charge —
    // see tasks/stripe-connect-runbook.md.
    await ctx.runMutation(internal.paymentConnections.upsert, {
      provider: "stripe" as const,
      merchantId: accountId,
      status: account.charges_enabled ? "onboarding_complete" as const : "error" as const,
    });

    if (!account.charges_enabled) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Inscription Stripe incomplète. Veuillez reconnecter pour terminer.")}` },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Compte Stripe vérifié, mais les encaissements ne sont pas encore reversés dessus. Contactez le support avant d'activer le paiement par carte.")}` },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stripe callback error:", message);
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent(message)}` },
    });
  }
});

/**
 * Handle the refresh redirect when the Stripe onboarding link has expired.
 * Generates a new Account Link and redirects the user back to Stripe.
 */
// @guarded-inline: consumes the single-use OAuth state before minting a link,
// then issues a fresh one for the link it hands back
export const stripeRefresh = httpAction(async (ctx, request) => {
  const { getSiteEnv } = await import("@be-yours/core/env");
  const site = getSiteEnv();
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account_id");
  const adminUrl = site.ADMIN_URL ?? "http://localhost:3000";

  if (!accountId) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Missing account ID")}` },
    });
  }

  // CSRF: without this, anyone could mint a live Stripe onboarding link for any
  // account id they could name.
  const rejected = await requireOAuthState(ctx, url, "stripe", adminUrl);
  if (rejected) return rejected;

  const stripeKey = site.STRIPE_SECRET_KEY;
  const siteUrl = site.CONVEX_SITE_URL;
  if (!stripeKey || !siteUrl) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent("Stripe not configured")}` },
    });
  }

  try {
    // The state just consumed is spent, so the link we are about to hand back
    // needs its own or the next hop would arrive with nothing to present. This
    // is the whole reason the refresh route exists: Stripe bounces the owner
    // here when the onboarding link ages out, and the chain has to survive it.
    //
    // Web Crypto, not `import("crypto")`: this file carries no "use node", so
    // it runs in the V8 isolate where the Node module does not exist. Same 16
    // random bytes as hex that generateOAuthUrl issues.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nextState = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.runMutation(internal.oauthState.create, {
      provider: "stripe",
      state: nextState,
    });

    const linkRes = await fetch("https://api.stripe.com/v1/account_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        account: accountId,
        return_url: `${siteUrl}/connect/stripe/callback?account_id=${accountId}&state=${nextState}`,
        refresh_url: `${siteUrl}/connect/stripe/refresh?account_id=${accountId}&state=${nextState}`,
        type: "account_onboarding",
      }),
    });
    const link = (await linkRes.json()) as StripeAccountLinkResponse;

    if (!linkRes.ok || link.error) {
      throw new Error(link.error?.message ?? "Failed to refresh Stripe link");
    }

    return new Response(null, {
      status: 302,
      headers: { Location: link.url },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stripe refresh error:", message);
    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent(message)}` },
    });
  }
});

// ---------------------------------------------------------------------------
// SumUp: OAuth callback handler
// ---------------------------------------------------------------------------

/**
 * Handle the SumUp OAuth redirect callback.
 * Delegates token exchange and encryption to the Node.js internalAction.
 */
// @guarded-inline: consumes the single-use OAuth state issued by
// generateOAuthUrl, with a TTL, before the code reaches the token exchange
//
// This was the severe one of the three. `generateOAuthUrl` minted a state and
// never persisted it, so the callback had nothing to compare against and read
// `code` straight out of the query string: an injected authorization code bound
// a third party's SumUp merchant account and routed the restaurant's card
// takings into it.
export const sumupCallback = httpAction(async (ctx, request) => {
  const { getSiteEnv } = await import("@be-yours/core/env");
  const site = getSiteEnv();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const adminUrl = site.ADMIN_URL ?? "http://localhost:3000";

  if (error || !code) {
    const errorMsg =
      error ??
      url.searchParams.get("error_description") ??
      "Authorization denied";
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent(errorMsg)}`,
      },
    });
  }

  // CSRF: refuse before the code reaches the exchange. Everything past this
  // point spends a real authorization code and writes a live payment
  // connection, so this is the last place a forged callback can be stopped.
  const rejected = await requireOAuthState(ctx, url, "sumup", adminUrl);
  if (rejected) return rejected;

  try {
    // Delegate token exchange + encryption to Node.js action
    await ctx.runAction(internal.oauthConnect.exchangeOAuthToken, {
      provider: "sumup" as const,
      code,
    });

    return new Response(null, {
      status: 302,
      headers: { Location: `${adminUrl}/settings?tab=payments&connected=sumup` },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("SumUp OAuth callback error:", message);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${adminUrl}/settings?tab=payments&error=${encodeURIComponent(message)}`,
      },
    });
  }
});
