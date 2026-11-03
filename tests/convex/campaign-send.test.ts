// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Starting, pausing and resuming a campaign send.
 *
 * The send itself calls SES from a `"use node"` action and cannot run here.
 * What can, and what the defects were actually about, is everything around it:
 * which subscribers a page yields, that the cursor survives, that the scheduler
 * starts a campaign exactly once, and that a paused campaign stays paused.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

function newHarness() {
  return convexTest(schema, modules)
}

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

async function seedSubscribers(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  count: number,
  status: "active" | "unsubscribed" = "active"
) {
  return t.run(async (ctx) => {
    const ids: Id<"emailSubscribers">[] = []
    for (let i = 0; i < count; i++) {
      ids.push(
        await ctx.db.insert("emailSubscribers", {
          storeId,
          email: `sub${i}-${status}@resto.example`,
          status,
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
    return ids
  })
}

async function seedCampaign(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: { status?: string; scheduledAt?: number } = {}
) {
  return t.run(async (ctx) => {
    const templateId = await ctx.db.insert("emailTemplates", {
      storeId,
      name: "Brunch",
      subject: "Brunch",
      blocks: [],
      category: "marketing" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("emailCampaigns", {
      storeId,
      name: "Brunch de samedi",
      subject: "Brunch",
      templateId,
      status: (over.status ?? "scheduled") as "scheduled",
      scheduledAt: over.scheduledAt,
      abTestEnabled: false,
      stats: {
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        unsubscribed: 0,
        converted: 0,
        revenue: 0,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

const campaignRow = (t: ReturnType<typeof convexTest>, id: Id<"emailCampaigns">) =>
  t.run((ctx) => ctx.db.get(id))

/**
 * Drop the batch the dispatcher scheduled, without running it.
 *
 * `dispatchScheduled` hands off to `sendBatch`, which lives in a `"use node"`
 * module and cannot execute under this harness. Left pending it writes to
 * `_scheduled_functions` after the test's transaction has gone — an unhandled
 * rejection that fails the run while every assertion still reads green, which
 * is exactly the shape of failure worth not shipping.
 *
 * What these tests are about is the dispatcher's decisions — which campaigns it
 * starts and which it leaves alone — so cancelling the hand-off loses nothing.
 * The pieces the batch itself uses have their own tests.
 */
async function cancelScheduled(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const pending = await ctx.db.system.query("_scheduled_functions").collect()
    for (const job of pending) {
      if (job.state.kind === "pending" || job.state.kind === "inProgress") {
        await ctx.scheduler.cancel(job._id)
      }
    }
  })
}

describe("pageForSending", () => {
  test("walks the whole list once, in pages, following its own cursor", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedSubscribers(t, storeId, 25)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0

    for (;;) {
      const page = await t.query(internal.emailSubscribers.pageForSending, {
        storeId,
        cursor,
        numItems: 10,
      })
      pages++
      seen.push(...page.page.map((s: { _id: string }) => s._id))
      if (page.isDone) break
      cursor = page.continueCursor
      expect(pages).toBeLessThan(10) // a cursor that does not advance
    }

    // Every subscriber exactly once — the property the whole batching design
    // rests on. A page that repeated one would mail them twice.
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    expect(pages).toBe(3)
  })

  test("offers only active subscribers", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedSubscribers(t, storeId, 3, "active")
    await seedSubscribers(t, storeId, 4, "unsubscribed")

    const page = await t.query(internal.emailSubscribers.pageForSending, {
      storeId,
      cursor: null,
      numItems: 50,
    })

    expect(page.page).toHaveLength(3)
  })
})

describe("saveSendCursor", () => {
  test("survives so the next batch resumes where the last stopped", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, { status: "sending" })

    await t.mutation(internal.emailCampaigns.saveSendCursor, { id, cursor: "abc" })
    expect((await campaignRow(t, id))?.sendCursor).toBe("abc")

    // Null clears it: a fresh run must not resume at the end of the last one.
    await t.mutation(internal.emailCampaigns.saveSendCursor, { id, cursor: null })
    expect((await campaignRow(t, id))?.sendCursor).toBeUndefined()
  })
})

describe("dispatchScheduled", () => {
  test("starts a campaign whose time has come", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, {
      status: "scheduled",
      scheduledAt: Date.now() - 60_000,
    })

    await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)

    // It sat at `scheduled` for good before: nothing read `scheduledAt`, and
    // the only way to send was the manual menu item.
    expect((await campaignRow(t, id))?.status).toBe("sending")
  })

  test("leaves a campaign scheduled for later alone", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, {
      status: "scheduled",
      scheduledAt: Date.now() + 3_600_000,
    })

    await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)
    expect((await campaignRow(t, id))?.status).toBe("scheduled")
  })

  test("cannot start the same campaign twice", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, {
      status: "scheduled",
      scheduledAt: Date.now() - 60_000,
    })

    await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)
    // The cron fires every minute. The second tick must find nothing, or a long
    // campaign would be started again on top of itself.
    const second = await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)

    expect(second).toEqual({ started: 0 })
    expect((await campaignRow(t, id))?.status).toBe("sending")
  })

  test("does not restart a campaign the owner paused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, {
      status: "paused",
      scheduledAt: Date.now() - 60_000,
    })

    await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)

    // Pausing is a decision. A cron undoing it a minute later would make the
    // button meaningless.
    expect((await campaignRow(t, id))?.status).toBe("paused")
  })
})
/**
 * A send that cannot finish says so, on the screen the owner is looking at
 * (#326.2).
 *
 * `sendBatch` had one reaction to a template, a config or a segment it could
 * not read: `console.error` and `return`. The campaign stayed at `sending` for
 * ever, the campaigns screen went on reading "En cours" against a send that had
 * stopped, and the only record was a log line no restaurant sees.
 *
 * The batch itself is a `"use node"` action and cannot run under this harness —
 * see `cancelScheduled` above. What can, and what the defect was actually about,
 * is the state it now writes: `failed` plus the sentence naming what to fix, who
 * may write it, and what relaunching does.
 */
describe("markFailed", () => {
  test("stops the send and keeps the reason the owner has to act on", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, { status: "sending" })

    await t.mutation(internal.emailCampaigns.markFailed, {
      id,
      reason: "Le modèle d'email de cette campagne est introuvable : il a été supprimé.",
    })

    const campaign = await campaignRow(t, id)
    expect(campaign?.status).toBe("failed")
    // A status word on its own would be no better than the log line it replaces.
    expect(campaign?.failureReason).toContain("modèle")
  })

  test("does not overwrite a state a person chose", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, { status: "paused" })

    // A batch still in flight when the owner presses Pause lands here late.
    // Pausing is a decision, and a straggler must not undo it.
    await t.mutation(internal.emailCampaigns.markFailed, { id, reason: "trop tard" })

    expect((await campaignRow(t, id))?.status).toBe("paused")
    expect((await campaignRow(t, id))?.failureReason).toBeUndefined()
  })

  test("relaunching clears the reason and resumes from the cursor", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, { status: "sending" })

    await t.mutation(internal.emailCampaigns.saveSendCursor, { id, cursor: "page-3" })
    await t.mutation(internal.emailCampaigns.markFailed, { id, reason: "segment supprimé" })
    await t.mutation(internal.emailCampaigns.markSending, { id })

    const campaign = await campaignRow(t, id)
    expect(campaign?.status).toBe("sending")
    // Stale under a running campaign, it would read as a live problem.
    expect(campaign?.failureReason).toBeUndefined()
    // Untouched, so "Relancer" continues rather than mailing the first batch
    // a second time.
    expect(campaign?.sendCursor).toBe("page-3")
  })

  test("is not picked up again by the scheduler on its own", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedCampaign(t, storeId, {
      status: "sending",
      scheduledAt: Date.now() - 60_000,
    })

    await t.mutation(internal.emailCampaigns.markFailed, { id, reason: "modèle supprimé" })
    await t.action(internal.emailCampaigns.dispatchScheduled, {})
    await cancelScheduled(t)

    // `dueForSending` reads `scheduled` only. A cron restarting a send that
    // stopped for a reason nobody has fixed would loop for ever.
    expect((await campaignRow(t, id))?.status).toBe("failed")
  })
})
