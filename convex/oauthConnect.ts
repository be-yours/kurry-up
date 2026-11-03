"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { exchangeSumUpCode } from "./lib/sumupToken";

// ---------------------------------------------------------------------------
// OAuth provider configurations (SumUp only — Stripe uses Account Links, PayPal uses email)
// The authorize and token addresses are NOT here: `resolveSumUpOAuthEndpoints` builds them,
// the one place the stand-in seam can move them (see reservationProviders.ts).
// ---------------------------------------------------------------------------

const OAUTH_PROVIDERS = {
  sumup: {
    envClientId: "SUMUP_CLIENT_ID",
    envClientSecret: "SUMUP_CLIENT_SECRET",
    scope: "payments user.app-settings",
  },
} as const;

// ---------------------------------------------------------------------------
// Token response shapes
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
// Inline AES-256-GCM encryption (Node.js runtime only)
// ---------------------------------------------------------------------------

async function encrypt(plaintext: string): Promise<string> {
  const { randomBytes, createCipheriv } = await import("crypto");

  const { getSiteEnv } = await import("@be-yours/core/env");
  const hex = getSiteEnv().ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string");
  }

  const key = Buffer.from(hex, "hex");
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

// ---------------------------------------------------------------------------
// Action: generate connection URL for any provider
// ---------------------------------------------------------------------------

/**
 * Generate the connection URL for a given payment provider.
 *
 * - Stripe: Creates a connected account via Account Links (no OAuth).
 * - SumUp: Standard OAuth authorization URL.
 * - PayPal: uses email-based payee, no OAuth needed.
 *
 * The client redirects the browser to the returned URL.
 */
// @guarded-inline: checks settings:write by role — no store to scope against
export const generateOAuthUrl = action({
  args: {
    provider: v.union(
      v.literal("stripe"),
      v.literal("sumup")
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "settings:write",
    });

    const { getSiteEnv } = await import("@be-yours/core/env");
    const site = getSiteEnv();
    const siteUrl = site.CONVEX_SITE_URL;
    if (!siteUrl) throw new Error("CONVEX_SITE_URL environment variable is not configured");

    // -----------------------------------------------------------------------
    // Stripe: Account Links flow (no OAuth, no Client ID needed)
    // -----------------------------------------------------------------------
    if (args.provider === "stripe") {
      const stripeKey = site.STRIPE_SECRET_KEY;
      if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not configured");

      // 1. Create a Standard connected account
      const accountRes = await fetch("https://api.stripe.com/v1/accounts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "type=standard",
      });
      const account = (await accountRes.json()) as StripeAccountResponse;
      if (!accountRes.ok || account.error) {
        throw new Error(account.error?.message ?? "Failed to create Stripe account");
      }

      // 2. Issue and persist a single-use CSRF state (TTL) before handing the
      //    onboarding URL to the browser. Both Stripe redirect targets carry
      //    it, so neither can be driven with an account id alone — that was
      //    the whole of the stripeCallback / stripeRefresh gap.
      const { randomBytes } = await import("crypto");
      const stripeState = randomBytes(16).toString("hex");
      await ctx.runMutation(internal.oauthState.create, {
        provider: "stripe",
        state: stripeState,
      });

      // 3. Generate an onboarding link
      const linkRes = await fetch("https://api.stripe.com/v1/account_links", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          account: account.id,
          return_url: `${siteUrl}/connect/stripe/callback?account_id=${account.id}&state=${stripeState}`,
          refresh_url: `${siteUrl}/connect/stripe/refresh?account_id=${account.id}&state=${stripeState}`,
          type: "account_onboarding",
        }),
      });
      const link = (await linkRes.json()) as StripeAccountLinkResponse;
      if (!linkRes.ok || link.error) {
        throw new Error(link.error?.message ?? "Failed to create Stripe onboarding link");
      }

      return { url: link.url, state: stripeState };
    }

    // -----------------------------------------------------------------------
    // SumUp: Standard OAuth flow
    // -----------------------------------------------------------------------
    const config = OAUTH_PROVIDERS.sumup;
    const clientId = site.SUMUP_CLIENT_ID;
    if (!clientId) {
      throw new Error(`${config.envClientId} environment variable is not configured`);
    }

    const redirectUri = `${siteUrl}/connect/${args.provider}/callback`;

    const { randomBytes } = await import("crypto");
    const state = randomBytes(16).toString("hex");

    // Persist the state (single-use, TTL) so the callback can verify it (CSRF).
    // This one line was the SumUp hole: the state was generated and returned to
    // the caller but never stored, so sumupCallback had nothing to match against
    // and accepted any authorization code presented to it.
    await ctx.runMutation(internal.oauthState.create, {
      provider: "sumup",
      state,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: config.scope,
      state,
    });

    const { resolveSumUpOAuthEndpoints } = await import(
      "@be-yours/convex-functions/reservationProviders"
    );
    return {
      url: `${resolveSumUpOAuthEndpoints(process.env).authorizeUrl}?${params.toString()}`,
      state,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal action: exchange OAuth code for tokens, encrypt, and persist
// ---------------------------------------------------------------------------

/**
 * Exchange an OAuth authorization code for tokens, encrypt them, and persist
 * the connection. Runs in Node.js to access the crypto module for encryption.
 *
 * Called by httpAction callbacks in oauthCallbackHandlers.ts via ctx.runAction.
 */
export const exchangeOAuthToken = internalAction({
  args: {
    provider: v.literal("sumup"),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const { getSiteEnv } = await import("@be-yours/core/env");
    const siteEnv = getSiteEnv();
    const clientId = siteEnv.SUMUP_CLIENT_ID;
    const clientSecret = siteEnv.SUMUP_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("Missing SumUp credentials");
    }

    const siteUrl = siteEnv.CONVEX_SITE_URL ?? "";
    const redirectUri = `${siteUrl}/connect/sumup/callback`;

    const { resolveSumUpOAuthEndpoints } = await import(
      "@be-yours/convex-functions/reservationProviders"
    );
    const connection = await exchangeSumUpCode(
      {
        fetch,
        tokenUrl: resolveSumUpOAuthEndpoints(process.env).tokenUrl,
        now: () => Date.now(),
        encrypt,
      },
      { code: args.code, redirectUri, clientId, clientSecret },
    );

    await ctx.runMutation(internal.paymentConnections.upsert, {
      provider: "sumup" as const,
      ...connection,
    });
  },
});
