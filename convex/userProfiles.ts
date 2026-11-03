import { query, mutation, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import * as defs from "@be-yours/convex-functions/userProfiles";
import { getAuthUser } from "@be-yours/convex-functions/auth";
import {
  assertCanAssignProfile,
  bootstrapTokenMatches,
  canClaimFirstAdmin,
} from "@be-yours/convex-functions/profileProvisioning";
import {
  ACCESS_AUDIT_OPERATIONS,
  recordAccessAudit,
} from "@be-yours/convex-functions/accessAudit";
import { Role } from "@be-yours/core/auth/rbac";


// === Queries ===
//
// NOTE: `getByUserId` used to be exported here as a bare `query(defs.getByUserId)`.
// Its core performs no identity check at all, so anyone could read any user's
// role, permissions and store list by guessing a user id. Its only caller —
// `AdminAuthSync` — was reading the *current* user's own profile, which is what
// `getMyProfile` below does safely.

/**
 * Get the authenticated user's own profile.
 */
// @guarded-inline: session-derived, or policy-checked in the handler
export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .first();
  },
});

/**
 * Does this deployment still need its first administrator?
 *
 * `/setup` is the only screen a fresh deployment can offer, and without this it
 * would have to guess: it would show a token field to someone whose deployment
 * was configured months ago, and it could not tell "wrong token" from "nobody
 * ever set one". Both answers are deployment state, not credentials — knowing
 * that a bootstrap token EXISTS gets you no closer to holding it, and the claim
 * still refuses everything but the token itself.
 */
// @public-by-design: reports deployment state, reveals no secret, and is the
// only way the setup screen can say something true before anyone is an admin.
export const bootstrapStatus = query({
  args: {},
  handler: async (ctx) => {
    const superAdmin = await ctx.db
      .query("userProfiles")
      .withIndex("by_role", (q) => q.eq("role", Role.SUPER_ADMIN))
      .first();

    return {
      /** True once somebody holds the super-admin seat: `/setup` is closed. */
      claimed: superAdmin !== null,
      /** False when `ADMIN_BOOTSTRAP_TOKEN` is unset — nobody can claim it. */
      configured: Boolean(process.env.ADMIN_BOOTSTRAP_TOKEN),
    };
  },
});

// === Mutations ===

/**
 * Create or update another user's profile.
 *
 * INTERNAL, and that is the point. The previous guard only rejected the literal
 * strings "super_admin" and "client_admin", so `manager` — which carries
 * products, orders and customers write access — passed straight through, on any
 * store id the caller chose. The whole policy now lives in
 * `assertCanAssignProfile`, and it held: an adversarial pass over seven
 * starting roles, three target roles and both self and other could not get an
 * administrative profile out of it.
 *
 * It was still a PUBLIC mutation whose validator accepts `super_admin`, with no
 * caller in either app's interface — the entire product reaches profiles
 * through `teamMembers.*` instead. A publicly reachable escalation surface that
 * nothing uses is a surface kept alive by its guard alone, and this repository
 * has already shipped one regression (#129) through an `any`-typed API injector
 * that hid a call the compiler could not see. Internal removes the surface
 * rather than defending it.
 *
 * The policy still runs, and is still tested — the tests reach it through
 * `internal.` now, and one of them asserts it is no longer publicly callable.
 * A super admin who genuinely has to rewrite a profile by hand still can,
 * through `internalUpsert` and a deploy key, which is how `seed-users.mts`
 * already provisions every seeded account.
 */
// Not `@guarded-inline`: that marker is for the ESLint rule in
// `packages/convex-functions/eslint/convex-auth.mjs`, which inspects bare
// `query`/`mutation` builders only. An internal mutation is outside its scope,
// so leaving the marker here would assert a check that no longer watches this
// function. The policy call below is the guard, and the tests reach it through
// `internal.`.
export const upsert = internalMutation({
  args: defs.upsert.args,
  handler: async (ctx, args) => {
    const actor = await getAuthUser(ctx);

    // `upsert` OVERWRITES role and storeIds, so the policy has to see who the
    // target is today — not only the role being requested.
    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    assertCanAssignProfile({
      actor: {
        userId: actor.userId,
        role: actor.role,
        storeIds: actor.storeIds,
      },
      target: {
        userId: args.userId,
        role: args.role as Role,
        storeIds: args.storeIds,
        permissions: args.permissions,
      },
      existingTarget: existing
        ? { role: existing.role as Role, storeIds: existing.storeIds }
        : null,
    });

    const result = await defs.upsert.handler(ctx, args);

    // After the write, inside the same transaction: an audit entry that
    // survives a change it does not describe is worse than none.
    await recordAccessAudit(ctx, {
      targetUserId: args.userId,
      operation: ACCESS_AUDIT_OPERATIONS.assign,
      before: existing
        ? {
            role: existing.role,
            storeIds: existing.storeIds,
            permissions: existing.permissions,
          }
        : null,
      after: {
        role: args.role,
        storeIds: args.storeIds,
        permissions: args.permissions,
      },
    });

    return result;
  },
});

/**
 * Claim the first super-admin seat on a deployment that has none.
 *
 * Provisioning requires a super admin, and a fresh deployment starts without
 * one — there would otherwise be no way to appoint the first administrator
 * short of editing the database by hand.
 *
 * "Self-closing" was not enough. Sign-up is open on the storefront, so on a
 * fresh deployment the first authenticated caller took the whole thing — and
 * that need not be the restaurateur. Convex function names are discoverable
 * from the client bundle; "nothing in the UI calls it" protects no one.
 *
 * So the claim now also demands a secret only whoever deployed the backend
 * holds. It FAILS CLOSED: with `ADMIN_BOOTSTRAP_TOKEN` unset there is no way
 * in at all, because an unset variable that waved everyone through would
 * recreate the hole on precisely the deployments nobody has configured yet.
 */
// @guarded-inline: session-derived, or policy-checked in the handler
export const claimFirstAdmin = mutation({
  args: { bootstrapToken: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "not_authenticated",
        message: "Connectez-vous avant de réclamer le siège d'administrateur.",
      });
    }

    // ConvexError, not Error: Convex redacts a plain thrown message in
    // production and the UI receives "Server Error". These three refusals are
    // the only feedback an operator gets while setting a deployment up, and
    // "Server Error" for all three is indistinguishable from a broken backend.
    // `data` survives the redaction; the `code` is what the screen switches on,
    // so the copy never has to guess from a string.
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!expected) {
      throw new ConvexError({
        code: "bootstrap_not_configured",
        message:
          "L'amorçage administrateur n'est pas configuré sur ce déploiement.",
      });
    }
    if (!bootstrapTokenMatches(args.bootstrapToken, expected)) {
      throw new ConvexError({
        code: "bootstrap_token_invalid",
        message: "Jeton d'amorçage invalide.",
      });
    }

    const superAdmins = await ctx.db
      .query("userProfiles")
      .filter((q) => q.eq(q.field("role"), Role.SUPER_ADMIN))
      .collect();

    if (!canClaimFirstAdmin({ existingSuperAdminCount: superAdmins.length })) {
      throw new ConvexError({
        code: "bootstrap_already_claimed",
        message: "Un super administrateur existe déjà sur ce déploiement.",
      });
    }

    // Reuse the shared upsert so the profile is built with every field the
    // schema requires, rather than a second hand-rolled insert that drifts.
    const result = await defs.upsert.handler(ctx, {
      userId: identity.subject,
      role: Role.SUPER_ADMIN,
      storeIds: [],
      permissions: [],
    });

    // The single most consequential change a deployment ever sees: somebody
    // took the keys. It is also the one nobody is around to witness.
    await recordAccessAudit(ctx, {
      targetUserId: identity.subject,
      operation: ACCESS_AUDIT_OPERATIONS.bootstrap,
      before: null,
      after: { role: Role.SUPER_ADMIN, storeIds: [], permissions: [] },
    });

    return result;
  },
});

/**
 * Update own profile (customer-facing: phones, language, avatar)
 */
// @guarded-inline: session-derived, or policy-checked in the handler
export const updateMyProfile = mutation({
  args: {
    phones: defs.updateProfile.args.phones,
    language: defs.updateProfile.args.language,
    avatarUrl: defs.updateProfile.args.avatarUrl,
    notificationPreferences: defs.updateProfile.args.notificationPreferences,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return defs.updateProfile.handler(ctx, {
      userId: identity.subject,
      ...args,
    });
  },
});

// === Internal ===

/**
 * Provision a profile without an authenticated actor.
 *
 * Internal only — reachable from seed scripts and server-side flows through the
 * deploy key, never from a browser.
 */
export const internalUpsert = internalMutation(defs.upsert);
