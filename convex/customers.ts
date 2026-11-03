import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import * as defs from "@be-yours/convex-functions/customers";
import {
  customerKey,
  recordOrder as recordCustomerOrder,
} from "@be-yours/convex-functions/customers";
import { storeQuery } from "./lib/storeFunctions";

/**
 * The establishment's book of the people who have ordered from it.
 *
 * `customers:read`, which a waiter holds — looking up the person standing at
 * the counter is what a waiter does. `customers:manage` is the erasure and the
 * export, and stays with `super_admin` and `client_admin`; see
 * `packages/core/src/auth/rbac.ts`.
 *
 * The writers are internal: the book is derived from orders by
 * `syncSubscriberOrderMetadata`, never edited by hand. An editable customer
 * book would disagree with the orders it is computed from within a week.
 */
export const list = storeQuery({
  permission: "customers:read",
  args: defs.list.args,
  handler: (ctx, args) => defs.list.handler(ctx, args),
});

export const get = storeQuery({
  permission: "customers:read",
  args: defs.get.args,
  handler: (ctx, args) => defs.get.handler(ctx, args),
});

/**
 * How many orders the book cannot account for.
 *
 * The honest footnote to every total on the screen: an order with no e-mail is
 * not a person here, and a list that silently omitted them would answer "how
 * many customers do I have?" with a number that is wrong in one direction and
 * never says so.
 */
export const anonymousOrderCount = storeQuery({
  permission: "customers:read",
  args: defs.anonymousOrderCount.args,
  handler: (ctx, args) => defs.anonymousOrderCount.handler(ctx, args),
});

export const recordOrder = internalMutation(defs.recordOrder);
export const reverseOrder = internalMutation(defs.reverseOrder);

/**
 * Build the customer book from the orders already there.
 *
 * WHY A MIGRATION AND NOT A READ (#364). `customers` is an aggregate maintained
 * incrementally, on the same transitions as `emailSubscribers.metadata` — so it
 * only holds people who have ordered SINCE it existed. An establishment trading
 * for two years would open a Clients screen showing whoever ordered that
 * afternoon, which is worse than an empty one: an empty screen is obviously
 * empty and a short one looks complete.
 *
 * ONE PAGE PER CALL, and the caller loops. Convex refuses a transaction that
 * reads more than 16,384 documents, which is the ceiling #432.4 was about — and
 * orders is the largest table a restaurant has, so a backfill written as one
 * pass would be a backfill that cannot run on exactly the deployments that need
 * it most.
 *
 * IDEMPOTENT ONLY FROM THE START. The accumulation is incremental — it adds
 * each order to whatever the book already holds — so running a PAGE twice
 * counts those orders twice. That matters because a paged migration is a
 * migration that can be interrupted, and the honest way to recover from one is
 * to run it again from the beginning.
 *
 * So `resetCustomerBook` below empties the book first, and the migration runs
 * it to completion before the first page. Re-running the whole migration
 * rebuilds from the orders and lands on the same numbers; resuming from a
 * saved cursor does not, and is not offered.
 *
 * WHAT IT COUNTS: orders that reached `confirmed` and were not cancelled, which
 * is the same rule the incremental writer applies. `status` is what it has to
 * go on — an order's history is not stored — so an order confirmed and then
 * cancelled counts as neither, where the incremental path would have counted it
 * and given it back. The two agree on the end state, which is what the screen
 * shows.
 */
export const resetCustomerBook = internalMutation({
  args: {
    storeId: v.id("stores"),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(args.numItems ?? 500, 1), 2_000);

    // Paged for the same reason the backfill is: a chain with a thousand
    // regulars per site has a customer book too large to delete in one
    // transaction, and that is exactly the deployment this runs on.
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_storeId_email", (q) => q.eq("storeId", args.storeId))
      .take(numItems);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    return { deleted: rows.length, isDone: rows.length < numItems };
  },
});

export const backfillCustomers = internalMutation({
  args: {
    storeId: v.id("stores"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(args.numItems ?? 500, 1), 2_000);

    const page = await ctx.db
      .query("orders")
      .withIndex("by_storeId", (q) => q.eq("storeId", args.storeId))
      .paginate({ numItems, cursor: args.cursor });

    let written = 0;
    let keyed = 0;

    for (const order of page.page) {
      const email = customerKey(order.customerInfo?.email);
      if (!email) continue;

      // The derived key, for the detail view's point lookup. Orders written
      // before #364 have none, and without it a customer's own orders are
      // unreachable except by scanning the establishment's whole history.
      if (order.customerEmailKey !== email) {
        await ctx.db.patch(order._id, { customerEmailKey: email });
        keyed += 1;
      }

      // Only what the incremental writer would have counted.
      if (order.status === "cancelled" || order.status === "pending") continue;

      await recordCustomerOrder.handler(ctx, {
        storeId: args.storeId,
        email,
        name: order.customerInfo?.name,
        phone: order.customerInfo?.phone,
        orderAmount: order.total,
        orderType: order.type,
        productIds: (order.items ?? [])
          .map((item: { productId?: string }) => item.productId)
          .filter((id): id is string => Boolean(id)),
        orderedAt: order.createdAt,
      });
      written += 1;
    }

    return {
      written,
      keyed,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
