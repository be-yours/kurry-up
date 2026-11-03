import { mutation, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import * as defs from "@be-yours/convex-functions/emailSubscribers";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

const emailSubscribersStoreId = storeIdFromDocument("Subscriber not found");

/**
 * Hand a freshly created subscriber the link that confirms them.
 *
 * The scheduling lives here rather than in the shared handler for the same
 * reason `confirmDoubleOptIn`'s does: `ctx.scheduler` needs `internal.*`, which
 * only an app has. The shared handler mints the token and stores it; getting it
 * to the person is the app's half, and it was the half that did not exist.
 *
 * Scheduled rather than awaited, and deliberately not guarded by a try/catch:
 * a signup must not fail in front of a visitor because SES is slow, and a send
 * that throws should surface in the Convex logs rather than be swallowed.
 *
 * Re-reads the row instead of taking the token as an argument — a token in a
 * scheduler argument is a credential written to a second place, and the action
 * has to re-read the subscriber anyway to know they are still `pending`.
 */
async function scheduleConfirmation(
  ctx: MutationCtx,
  id: Id<"emailSubscribers">
): Promise<void> {
  const subscriber = await ctx.db.get(id);

  // A `manual` subscriber is written `active` with no token: nothing to
  // confirm, and mailing them a confirmation link would be a message about a
  // step that did not happen.
  if (!subscriber || subscriber.status !== "pending") return;
  if (!subscriber.doubleOptInToken) return;

  await ctx.scheduler.runAfter(
    0,
    internal.emailAutomationActions.sendConfirmation,
    { subscriberId: id }
  );
}

// === Queries (auth-protected) ===

export const list = storeQuery({
  permission: "marketing:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

export const countByStatus = storeQuery({
  permission: "marketing:read",
  args: defs.countByStatus.args,
  handler: (ctx, args) => defs.countByStatus.handler(ctx, args),
});

// === Mutations (auth-protected) ===

/**
 * Add a subscriber, and — unless the owner typed the address in themselves —
 * ask them to confirm it.
 *
 * `source: "manual"` is the one case that skips the confirmation: the shared
 * handler writes it `active` with `doubleOptInAt` already set, because an owner
 * entering an address they collected on paper is asserting the consent
 * directly. Every other source is a claim someone else made, and a claim is
 * what the confirmation link exists to test.
 */
export const create = storeMutation({
  permission: "marketing:write",
  args: defs.create.args,
  handler: async (ctx, args) => {
    const id = await defs.create.handler(ctx, args);
    await scheduleConfirmation(ctx, id as Id<"emailSubscribers">);
    return id;
  },
});

export const remove = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailSubscribersStoreId,
  args: defs.remove.args,
  handler: async (ctx, args) => {
    const result = await defs.remove.handler(ctx, args);
    // The subscriber's events and automation runs go first — both columns are
    // REQUIRED — and a long-standing subscriber can carry more of them than one
    // transaction may touch. The subscriber survives until the pass that
    // finishes them, so this drains rather than leaving half a person behind.
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.emailSubscribers.purgeRemoval, {
        id: args.id,
      });
    }
    return result;
  },
});

export const purgeRemoval = internalMutation({
  args: defs.purgeRemoval.args,
  handler: async (ctx, args) => {
    const result = await defs.purgeRemoval.handler(ctx, args);
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.emailSubscribers.purgeRemoval, args);
    }
    return result;
  },
});

export const importBatch = storeMutation({
  permission: "marketing:write",
  args: defs.importBatch.args,
  handler: async (ctx, args) => {
    const result = await defs.importBatch.handler(ctx, args);
    // Every imported row is `pending`: a CSV is a list someone else compiled,
    // which is exactly the claim a double opt-in is for. Without this the whole
    // import was unreachable — inserted, counted, and never mailable.
    for (const id of result.pendingIds as string[]) {
      await scheduleConfirmation(ctx, id as Id<"emailSubscribers">);
    }
    return result;
  },
});

/**
 * Public mutation — allows storefront visitors to subscribe to the newsletter.
 * Only accepts source "storefront_form" to prevent abuse.
 */
// @public-by-design: newsletter sign-up from the storefront (rate limiting tracked as S3-7)
export const subscribe = mutation({
  args: {
    storeId: defs.create.args.storeId,
    email: defs.create.args.email,
  },
  handler: async (ctx, args) => {
    const id = await defs.create.handler(ctx, {
      ...args,
      source: "storefront_form",
      tags: ["newsletter"],
    });
    await scheduleConfirmation(ctx, id as Id<"emailSubscribers">);
    return id;
  },
});

// === Internal mutations (called by schedulers / HTTP actions) ===

export const pageForSending = internalQuery(defs.pageForSending);
/**
 * Confirm the double opt-in, and start whatever welcome sequence is waiting.
 *
 * The hook lives here rather than in the shared handler because scheduling
 * needs `internal.*`, which only an app has. It is the one automation trigger
 * the current schema can detect — see `automationDispatch` for what the other
 * four are missing.
 *
 * Scheduled rather than awaited: a welcome email is not a reason for a
 * confirmation to fail, and the mutation should commit either way.
 */
export const confirmDoubleOptIn = internalMutation({
  args: defs.confirmDoubleOptIn.args,
  handler: async (ctx, args) => {
    const result = await defs.confirmDoubleOptIn.handler(ctx, args);

    // The shared handler returns the confirmed subscriber's id, untyped —
    // naming the table is what stops `ctx.db.get` widening to every row shape
    // in the schema.
    const subscriber = await ctx.db.get(result as Id<"emailSubscribers">);

    if (subscriber) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailAutomationActions.startWelcome,
        { storeId: subscriber.storeId, subscriberId: subscriber._id }
      );
    }

    return result;
  },
});
export const unsubscribe = internalMutation(defs.unsubscribe);
export const markBounced = internalMutation(defs.markBounced);
export const markComplained = internalMutation(defs.markComplained);
export const updateMetadataIncremental = internalMutation(defs.updateMetadataIncremental);

/**
 * One subscriber, for a caller with no session.
 *
 * The automation engine re-reads the subscriber before every step: someone who
 * has unsubscribed, bounced or complained since the trigger must not receive
 * the rest of a sequence they are no longer part of.
 */
export const getByIdInternal = internalQuery({
  args: defs.getById.args,
  handler: (ctx, args) => defs.getById.handler(ctx, args),
});

/**
 * Every subscriber holding an address, for the SES feedback webhook.
 *
 * Internal only, and it has to stay that way: it takes an address and no store,
 * so a public twin would let anyone ask which of an owner's stores a given
 * person has subscribed to.
 */
export const listByEmailInternal = internalQuery({
  args: defs.listByEmail.args,
  handler: (ctx, args) => defs.listByEmail.handler(ctx, args),
});
