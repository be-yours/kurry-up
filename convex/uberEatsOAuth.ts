"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { encrypt, decrypt } from "@be-yours/convex-functions/encryption";

/**
 * Uber Eats OAuth Authorization Code flow (eats.pos_provisioning).
 *
 * Demonstrates the three "Integration Config" endpoints Uber requires:
 *   1. generateAuthorizeUrl → merchant consents at Uber, gets redirected back
 *   2. exchangeOAuthToken (callback) → user token stored, encrypted
 *   3. activateAndListStores → uses the user token to call
 *      GET /v1/eats/stores (stores-to-user) + POST /pos_data (activate)
 */

const REDIRECT_PATH = "/connect/uber-eats/callback";

async function readCredentials() {
  const { getPackageEnv, getSiteEnv, isSandbox } = await import(
    "@be-yours/core/env"
  );
  const pkg = getPackageEnv();
  const site = getSiteEnv();
  const clientId = pkg.UBER_EATS_CLIENT_ID;
  const clientSecret = pkg.UBER_EATS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Uber Eats credentials not configured in environment");
  }
  return {
    credentials: {
      clientId,
      clientSecret,
      sandboxMode: isSandbox("uberEats"),
    },
    siteUrl: site.CONVEX_SITE_URL as string | undefined,
    adminUrl: (site.ADMIN_URL as string | undefined) ?? "http://localhost:3000",
  };
}

/**
 * Exchange the authorization code for a user-scoped token, encrypt it, and
 * persist the connection. Called by the callback httpAction via ctx.runAction.
 */
export const exchangeOAuthToken = internalAction({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const { credentials, siteUrl } = await readCredentials();
    if (!siteUrl) throw new Error("CONVEX_SITE_URL is not configured");

    const { uberEats } = await import("@be-yours/integrations");
    const token = await uberEats.exchangeCodeForToken(
      credentials,
      args.code,
      `${siteUrl}${REDIRECT_PATH}`
    );

    await ctx.runMutation(internal.uberEatsConnections.upsert, {
      encryptedAccessToken: encrypt(token.accessToken),
      encryptedRefreshToken: token.refreshToken ? encrypt(token.refreshToken) : undefined,
      tokenExpiresAt: token.expiresAt,
      scope: token.scope,
      status: "connected" as const,
    });
  },
});

/**
 * Core logic for the demo/validation flow: use the stored merchant token to
 * exercise the two user-token Integration Config endpoints (Get Stores to User
 * + Activate Integration), refreshing the token first if near expiry. Returns
 * both responses so the result can be screenshotted for Uber's validation.
 *
 * internalAction so it can be run from the CLI / scheduler without a user
 * identity; the public wrapper below enforces auth.
 */
export const activateAndListStoresCore = internalAction({
  args: {
    storeId: v.string(),
    integratorStoreId: v.optional(v.string()),
    integratorBrandId: v.optional(v.string()),
    // Opt-in: also enable scheduled-order webhooks for the store (needed to
    // receive orders.scheduled notifications when the feature is active).
    enableScheduledOrderWebhooks: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { credentials } = await readCredentials();
    const { uberEats } = await import("@be-yours/integrations");

    const conn = await ctx.runQuery(internal.uberEatsConnections.getConnection, {});
    if (!conn) {
      throw new Error("No Uber Eats merchant connection. Run the OAuth consent flow first.");
    }

    let accessToken = decrypt(conn.encryptedAccessToken);

    // Refresh if the token is within 5 minutes of expiry and we have a refresh token.
    const nearExpiry = conn.tokenExpiresAt !== undefined && conn.tokenExpiresAt < Date.now() + 5 * 60 * 1000;
    if (nearExpiry && conn.encryptedRefreshToken) {
      const refreshed = await uberEats.refreshUserToken(credentials, decrypt(conn.encryptedRefreshToken));
      accessToken = refreshed.accessToken;
      await ctx.runMutation(internal.uberEatsConnections.upsert, {
        encryptedAccessToken: encrypt(refreshed.accessToken),
        encryptedRefreshToken: refreshed.refreshToken ? encrypt(refreshed.refreshToken) : conn.encryptedRefreshToken,
        tokenExpiresAt: refreshed.expiresAt,
        scope: refreshed.scope,
        status: "connected" as const,
      });
    }

    // 1. Get stores to user (user-scoped token)
    const stores = await uberEats.getStoresForUser(credentials, { limit: 50, accessToken });

    // 2. Activate integration on the requested store (user-scoped token)
    await uberEats.activateIntegration(
      credentials,
      args.storeId,
      {
        integration_enabled: true,
        integrator_store_id: args.integratorStoreId ?? "beindigital-test-store",
        integrator_brand_id: args.integratorBrandId ?? "beindigital",
        ...(args.enableScheduledOrderWebhooks
          ? { webhooks_config: { schedule_order_webhooks: { is_enabled: true } } }
          : {}),
      },
      accessToken
    );

    return {
      success: true,
      storesCount: stores.stores?.length ?? 0,
      // Cast to structural type so the package interface name does not leak
      // into Convex's generated .d.ts (TS4023).
      stores: (stores.stores ?? []) as Array<Record<string, unknown>>,
      activatedStoreId: args.storeId,
    };
  },
});

// Called from the admin since #274 — the Uber Eats connection card on a store's
// Integrations tab. It used to be `@kept-callerless`, kept alive on the strength
// of being the ONLY writer of a `uberEats` row in `oauthStates`, which the live
// `uberEatsConnectCallback` HTTP route validates before exchanging the code:
// with no writer the callback could only ever answer "Invalid or expired OAuth
// state", so Uber Eats could never be connected at all (#413). An owner now
// reaches step 2 of the provisioning flow from a button instead of from
// `apps/docs/guides/delivery-integrations.md:125`.
// @guarded-inline: checks settings:write by role — no store to scope against
export const generateAuthorizeUrl = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "settings:write",
    });

    const { credentials, siteUrl } = await readCredentials();
    if (!siteUrl) throw new Error("CONVEX_SITE_URL is not configured");

    const { randomBytes } = await import("crypto");
    const state = randomBytes(16).toString("hex");

    // Persist the state (single-use, TTL) so the callback can verify it (CSRF).
    await ctx.runMutation(internal.oauthState.create, { provider: "uberEats", state });

    const { uberEats } = await import("@be-yours/integrations");
    const url = uberEats.buildAuthorizeUrl({
      clientId: credentials.clientId,
      redirectUri: `${siteUrl}${REDIRECT_PATH}`,
      state,
      sandboxMode: credentials.sandboxMode,
    });

    return { url, state };
  },
});

// @kept-callerless: no screen calls this. `tasks/uber-eats-go-live-runbook.md:89`
// makes it a go-live step — "activateAndListStores against a real prod store →
// 200" — and it is step 3 of the OAuth provisioning flow the guide documents.
// It is also the only caller of `activateAndListStoresCore` below (#413).
// @guarded-inline: checks settings:write by role — no store to scope against
export const activateAndListStores = action({
  args: {
    storeId: v.string(),
    integratorStoreId: v.optional(v.string()),
    integratorBrandId: v.optional(v.string()),
    enableScheduledOrderWebhooks: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; storesCount: number; stores: Array<Record<string, unknown>>; activatedStoreId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "settings:write",
    });
    return await ctx.runAction(internal.uberEatsOAuth.activateAndListStoresCore, args);
  },
});
