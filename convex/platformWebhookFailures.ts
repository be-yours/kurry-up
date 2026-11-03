import { internalMutation, query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import * as defs from "@be-yours/convex-functions/platformWebhookFailures";
import { getAuthUser } from "@be-yours/convex-functions/auth";
import { profileAllowsPermission } from "@be-yours/convex-functions/teamAccess";
import {
  hasAllPermissions,
  hasPermission,
  type Permission,
  type Role,
} from "@be-yours/core/auth/rbac";

/**
 * WHO MAY READ THIS QUEUE (#614).
 *
 * It was `orders:read`, which six roles hold — including `kitchen`, `waiter`
 * and `delivery`. The rows are verbatim Uber Eats and Deliveroo payloads
 * carrying the diner's name, address and telephone, and the table has no
 * `storeId`, so there is no scoping available either: a waiter attached to one
 * location received every unresolved event of every location. The nav entry
 * gates the screen on `stores:read` — three roles — so the UI was hiding what
 * the server handed out.
 *
 * `stores:read` here matches the screen exactly: `super_admin`, `client_admin`
 * and `manager`, and nobody else.
 */
const PERM_QUEUE_READ = "stores:read" as Permission;

/**
 * WHO MAY CLEAR IT.
 *
 * `markResolved` is a mutation and was gated on a read permission, so any
 * `orders:read` holder could empty the operator's queue. It needs a write, and
 * it needs one the three roles invited to the screen all hold — a gate only
 * `client_admin` satisfies would leave a manager looking at a « Marquer
 * traité » button that always refuses, which is the defect this audit is
 * about, moved rather than fixed.
 *
 * `stores:read` AND `orders:write` is exactly those three: `manager` holds both,
 * `waiter` holds `orders:write` and not `stores:read`, so the compound is what
 * makes the write no wider than the read.
 */
const PERM_QUEUE_WRITE = ["stores:read", "orders:write"] as Permission[];

/**
 * WHO MAY READ A PAYLOAD.
 *
 * `customers:manage` — `super_admin` and `client_admin` only, the same gate the
 * « Données personnelles » screen uses. A manager runs the queue and does not
 * need the diner's address to do it.
 */
const PERM_RAW_BODY = "customers:manage" as Permission;

/**
 * The dead-letter queue is not scoped to one establishment: an entry whose
 * reason is `unidentified_store` has, by definition, no establishment. So it
 * cannot go through `storeQuery`, and the permission is checked directly.
 */
/**
 * The module gate runs here too.
 *
 * `requireStorePermission` runs `profileAllowsPermission` after the role check,
 * so a member invited with a narrowed module list is narrowed on every
 * store-scoped path. An inline guard that calls `hasPermission` alone skips
 * that second gate, and this queue is exactly the sort of screen an owner would
 * untick for somebody. `privacy.ts:287` sets the precedent and says why.
 *
 * Modules only ever NARROW what the role granted, never widen it, which is why
 * each check runs after its `hasPermission` and not instead of it.
 */
function allowsModule(
  user: { role: Role; permissions: string[] },
  permission: Permission,
): boolean {
  return profileAllowsPermission(
    { role: user.role, permissions: user.permissions },
    permission,
  );
}

async function requireQueueRead(ctx: QueryCtx | MutationCtx) {
  const user = await getAuthUser(ctx);
  if (!hasPermission(user.role, PERM_QUEUE_READ) || !allowsModule(user, PERM_QUEUE_READ)) {
    throw new Error('Permission "stores:read" requise');
  }
  return user;
}

async function requireQueueWrite(ctx: MutationCtx) {
  const user = await getAuthUser(ctx);
  const allowed =
    hasAllPermissions(user.role, PERM_QUEUE_WRITE) &&
    PERM_QUEUE_WRITE.every((permission) => allowsModule(user, permission));
  if (!allowed) {
    throw new Error('Permissions "stores:read" et "orders:write" requises');
  }
  return user;
}

async function requireRawBodyRead(ctx: QueryCtx) {
  const user = await getAuthUser(ctx);
  if (!hasPermission(user.role, PERM_RAW_BODY) || !allowsModule(user, PERM_RAW_BODY)) {
    throw new Error('Permission "customers:manage" requise');
  }
  return user;
}

// === INTERNAL (called from webhook handlers, after signature verification) ===

/** Keep a delivery-platform event we could not act on. */
export const record = internalMutation(defs.record);

/** Flag whether the platform really accepted an order. */
export const setPlatformSyncStatus = internalMutation(defs.setPlatformSyncStatus);

// === OPERATOR-FACING ===

// @guarded-inline: requireQueueRead resolves the caller with getAuthUser and
// checks "stores:read" before any document is returned.
export const listUnresolved = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireQueueRead(ctx);
    return defs.listUnresolved.handler(ctx, args);
  },
});

// @guarded-inline: requireRawBodyRead checks "customers:manage" — this returns
// the diner's name, address and telephone as the platform sent them.
export const getRawBody = query({
  args: { id: v.id("platformWebhookFailures") },
  handler: async (ctx, args) => {
    await requireRawBodyRead(ctx);
    return defs.getRawBody.handler(ctx, args);
  },
});

// @guarded-inline: requireQueueWrite checks "stores:read" and "orders:write"
// before the write.
export const markResolved = mutation({
  args: { id: v.id("platformWebhookFailures") },
  handler: async (ctx, args) => {
    const user = await requireQueueWrite(ctx);
    return defs.markResolved.handler(ctx, {
      id: args.id,
      resolvedBy: user.userId,
    });
  },
});
