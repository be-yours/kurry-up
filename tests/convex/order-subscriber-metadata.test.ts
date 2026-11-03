// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * An order confirming, and the segment that can finally find the customer.
 *
 * `updateMetadataIncremental` existed for this and had no caller anywhere, so
 * `totalOrders`, `totalSpent` and `lastOrderAt` were never written. The visible
 * cost was not in the automations that need them — it was the segment editor:
 * an owner could build "clients ayant dépensé plus de 100 €", attach it to a
 * campaign, and send to nobody, with no error to explain it.
 *
 * These go through the real `updateStatus` mutation rather than the shared
 * handler, because the claim is that every path into a status change carries
 * the order through — and then check the segment filter the owner would
 * actually write.
 */

import { convexTest } from "convex-test"
import { buildSegmentFilter } from "@be-yours/marketing"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const EMAIL = "yanis@resto.example"

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Mutations here queue work through `ctx.scheduler.runAfter`. A test finishes
 * in milliseconds and leaves it pending; whatever fires it next writes against
 * a transaction that closed, and because nothing awaits it that arrives as an
 * unhandled rejection — every assertion green and the run still exiting 1,
 * blaming whichever file happened to be running.
 *
 * Cancel rather than run: several of these hand off to actions, and an action
 * has no transaction for convex-test to record its completion in.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})


async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedSubscriber(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  email = EMAIL
) {
  return t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email,
      status: "active" as const,
      source: "storefront_form" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "test",
      bounceCount: 0,
      metadata: {
        totalOrders: 0,
        totalSpent: 0,
        averageOrderValue: 0,
        favoriteProducts: [],
        orderTypes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** A pending order, the state every order starts in. */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  opts: { total: number; email?: string | undefined }
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: `A-${opts.total}`,
      customerInfo: { name: "Yanis", email: opts.email },
      type: "delivery" as const,
      status: "pending" as const,
      items: [],
      subtotal: opts.total,
      taxAmount: 0,
      total: opts.total,
      paymentMethod: "card" as const,
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const metadataOf = (t: ReturnType<typeof convexTest>, id: Id<"emailSubscribers">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.metadata)

const confirm = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, { id, status: "confirmed" })

describe("confirming an order", () => {
  test("writes the order onto the subscriber", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 4_250, email: EMAIL })

    await confirm(t, orderId)

    const meta = await metadataOf(t, subscriberId)
    expect(meta).toMatchObject({
      totalOrders: 1,
      totalSpent: 4_250,
      averageOrderValue: 4_250,
      orderTypes: ["delivery"],
    })
    expect(meta?.lastOrderAt).toBeGreaterThan(0)
  })

  test("a customer who never subscribed is not created as one", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, {
      total: 9_999,
      email: "stranger@example.test",
    })

    await confirm(t, orderId)

    // An order is a purchase, not consent to receive marketing.
    const subscribers = await t.run((ctx) =>
      ctx.db.query("emailSubscribers").collect()
    )
    expect(subscribers).toHaveLength(0)
  })

  test("an order with no email address is simply skipped", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 5_000, email: undefined })

    await confirm(t, orderId)

    expect((await metadataOf(t, subscriberId))?.totalOrders).toBe(0)
  })

  test("replaying the same status does not count twice", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 4_000, email: EMAIL })

    await confirm(t, orderId)
    // Webhook retries and double-clicked buttons both land here. `updateStatus`
    // treats a repeat as a no-op, which is what keeps the total honest.
    await confirm(t, orderId)

    expect((await metadataOf(t, subscriberId))?.totalOrders).toBe(1)
  })
})

describe("cancelling a confirmed order", () => {
  test("gives the money back", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 4_250, email: EMAIL })

    await confirm(t, orderId)
    // Asserted before the cancellation as well as after: without it this test
    // passes in a codebase where nothing counts the order in the first place,
    // which is precisely the state it exists to rule out.
    expect((await metadataOf(t, subscriberId))?.totalSpent).toBe(4_250)

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "cancelled",
    })

    // `confirmed -> cancelled` is allowed for the window before the kitchen
    // starts. Revenue the restaurant never took must not stay in the field an
    // owner segments on.
    const meta = await metadataOf(t, subscriberId)
    expect(meta).toMatchObject({ totalOrders: 0, totalSpent: 0, averageOrderValue: 0 })
  })

  test("a cancellation before confirmation changes nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 4_250, email: EMAIL })

    await t.mutation(internal.orders.internalUpdateStatus, {
      id: orderId,
      status: "cancelled",
    })

    // Nothing was counted, so nothing is given back — and the totals must not
    // go negative.
    expect(await metadataOf(t, subscriberId)).toMatchObject({
      totalOrders: 0,
      totalSpent: 0,
    })
  })
})

describe("the segment the owner actually writes", () => {
  test("selects a customer who has spent over 100 euros", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    for (const total of [6_000, 5_500]) {
      const orderId = await seedOrder(t, storeId, { total, email: EMAIL })
      await confirm(t, orderId)
    }

    const subscriber = await t.run((ctx) => ctx.db.get(subscriberId))
    const predicate = buildSegmentFilter(
      [
        {
          id: "r1",
          field: "metadata.totalSpent",
          operator: "gt",
          value: "10000",
        },
      ],
      "and"
    )

    // The whole point of the issue: this returned false for everyone, because
    // `totalSpent` was always zero.
    expect(predicate(subscriber)).toBe(true)
  })

  test("still refuses someone below the threshold", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const orderId = await seedOrder(t, storeId, { total: 2_000, email: EMAIL })
    await confirm(t, orderId)

    const subscriber = await t.run((ctx) => ctx.db.get(subscriberId))
    const predicate = buildSegmentFilter(
      [
        {
          id: "r1",
          field: "metadata.totalSpent",
          operator: "gt",
          value: "10000",
        },
      ],
      "and"
    )
    expect(predicate(subscriber)).toBe(false)
  })
})
