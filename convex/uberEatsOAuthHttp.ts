import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Handle the redirect back from Uber's OAuth consent screen.
 * Receives ?code=...&state=... (or ?error=...), delegates token exchange +
 * encryption to the Node.js internalAction, then redirects to the admin UI.
 */
// @guarded-inline: consumes a single-use OAuth state we issued, with a TTL,
// before exchanging the code
export const uberEatsConnectCallback = httpAction(async (ctx, request) => {
  const { getSiteEnv } = await import("@be-yours/core/env");
  const site = getSiteEnv();
  const adminUrl = site.ADMIN_URL ?? "http://localhost:3000";

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const dest = (qs: string) => `${adminUrl}/settings?tab=integrations&${qs}`;

  if (error || !code) {
    const msg = error ?? url.searchParams.get("error_description") ?? "Authorization denied";
    return new Response(null, {
      status: 302,
      headers: { Location: dest(`error=${encodeURIComponent(msg)}`) },
    });
  }

  // CSRF protection: the state must match one we issued (single-use + TTL).
  // Reject before any token exchange if it is missing/expired/forged.
  if (!state) {
    return new Response(null, {
      status: 302,
      headers: { Location: dest(`error=${encodeURIComponent("Missing OAuth state")}`) },
    });
  }
  const stateValid = await ctx.runMutation(internal.oauthState.consume, {
    provider: "uberEats",
    state,
  });
  if (!stateValid) {
    return new Response(null, {
      status: 302,
      headers: { Location: dest(`error=${encodeURIComponent("Invalid or expired OAuth state")}`) },
    });
  }

  try {
    await ctx.runAction(internal.uberEatsOAuth.exchangeOAuthToken, { code });
    return new Response(null, {
      status: 302,
      headers: { Location: dest("connected=uber-eats") },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const detail = (err as { internalDetail?: string })?.internalDetail;
    console.error("Uber Eats OAuth callback error:", message, "| detail:", detail ?? "(none)");
    return new Response(null, {
      status: 302,
      headers: { Location: dest(`error=${encodeURIComponent(message)}`) },
    });
  }
});
