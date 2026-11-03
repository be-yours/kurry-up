import { internalMutation, internalQuery } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/emailAutomations";
import { storeQuery, storeMutation, storeIdFromDocument } from "./lib/storeFunctions";

const emailAutomationsStoreId = storeIdFromDocument("Automation not found");

// === Queries (auth-protected) ===

/**
 * Every automation of the establishment, drafts and paused ones included.
 *
 * The automations screen (#270). Unfiltered on purpose, for the same reason
 * `menus.list` is: the screen with the activate and pause buttons has to see
 * what it switched off. `listActive` below is what the dashboard card and the
 * dispatcher read.
 */
export const list = storeQuery({
  permission: "marketing:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

export const listActive = storeQuery({
  permission: "marketing:read",
  args: defs.listActive.args,
  handler: (ctx, args) => defs.listActive.handler(ctx, args),
});

// === Mutations (auth-protected) ===

// The automations screen calls all five (#270). `create` and `activate` were
// kept through #413 for `apps/reference`'s ops script —
// `scripts/verify-resume-and-automation.mjs` creates an automation and activates
// it to prove the internal dispatcher resumes a stopped send — and `list`,
// `update`, `remove` and `pause` were removed then for having no caller of any
// kind. They have one now: an editor. The dispatch side stays internal, in
// `automationDispatch`.
export const create = storeMutation({
  permission: "marketing:write",
  args: defs.create.args,
  handler: (ctx, args) => defs.create.handler(ctx, args),
});

export const update = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailAutomationsStoreId,
  args: defs.update.args,
  handler: (ctx, args) => defs.update.handler(ctx, args),
});

export const activate = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailAutomationsStoreId,
  args: defs.activate.args,
  handler: (ctx, args) => defs.activate.handler(ctx, args),
});

export const pause = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailAutomationsStoreId,
  args: defs.pause.args,
  handler: (ctx, args) => defs.pause.handler(ctx, args),
});

/**
 * Delete an automation — unless it has already mailed somebody.
 *
 * The refusal lives in the handler and says why, and offers `pause` instead. See
 * the docblock on `remove` in `@be-yours/convex-functions/emailAutomations`:
 * `emailAutomationRuns` is the record of who received what and the dedupe that
 * stops a rescheduled step mailing the same person twice, and those rows outlive
 * the trigger by days.
 */
export const remove = storeMutation({
  permission: "marketing:write",
  storeIdFrom: emailAutomationsStoreId,
  args: defs.remove.args,
  handler: (ctx, args) => defs.remove.handler(ctx, args),
});

// === Internal mutations ===

export const incrementStats = internalMutation(defs.incrementStats);

/**
 * The same rows, for the engine.
 *
 * `getById` and `listActive` are store-scoped, and a scheduled automation step
 * has no identity to scope with. The authorisation happened when the owner
 * activated the automation.
 */
export const getByIdInternal = internalQuery({
  args: defs.getById.args,
  handler: (ctx, args) => defs.getById.handler(ctx, args),
});

export const listActiveByTriggerInternal = internalQuery({
  args: defs.listActiveByTrigger.args,
  handler: (ctx, args) => defs.listActiveByTrigger.handler(ctx, args),
});

export const listActiveInternal = internalQuery({
  args: defs.listActive.args,
  handler: (ctx, args) => defs.listActive.handler(ctx, args),
});
