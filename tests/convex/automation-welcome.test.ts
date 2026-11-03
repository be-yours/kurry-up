// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The welcome automation, from the confirmation click to the run record.
 *
 * `emailAutomations` was CRUD and nothing else: an owner could build a
 * sequence, set its delays, activate it, and switch on five toggles in the
 * settings screen, and no code anywhere dispatched on a trigger.
 *
 * The step that sends lives in a `"use node"` module and cannot run here, so
 * these cover the parts that decide whether it runs at all — the trigger firing
 * on confirmation, and the record that stops a step going twice.
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

/** Drop the step the trigger scheduled; it cannot execute under this harness. */
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

async function seedAutomation(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: { trigger?: string; status?: string; steps?: number } = {}
) {
  return t.run(async (ctx) => {
    const templateId = await ctx.db.insert("emailTemplates", {
      storeId,
      name: "Bienvenue",
      subject: "Bienvenue chez Luigi",
      blocks: [],
      category: "automation" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("emailAutomations", {
      storeId,
      name: "Séquence de bienvenue",
      trigger: (over.trigger ?? "welcome") as "welcome",
      status: (over.status ?? "active") as "active",
      steps: Array.from({ length: over.steps ?? 2 }, (_, i) => ({
        id: `s${i + 1}`,
        delayMinutes: i * 1440,
        templateId,
      })),
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

/** A subscriber awaiting confirmation, with the token the link carries. */
async function seedPending(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  token: string
) {
  return t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email: "yanis@resto.example",
      status: "pending" as const,
      source: "storefront_form" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "test",
      doubleOptInToken: token,
      doubleOptInExpiresAt: Date.now() + 48 * 3600_000,
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

const pendingJobs = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())

describe("confirming a double opt-in", () => {
  test("starts the welcome sequence", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedAutomation(t, storeId)
    await seedPending(t, storeId, "tok-welcome")

    await t.mutation(internal.emailSubscribers.confirmDoubleOptIn, {
      token: "tok-welcome",
    })

    // Nothing dispatched on any trigger before this: an active automation with
    // steps and delays sat there and never sent anything.
    const jobs = await pendingJobs(t)
    expect(jobs.some((j) => j.name.includes("startWelcome"))).toBe(true)

    await cancelScheduled(t)
  })

  test("still confirms when no automation is waiting", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const id = await seedPending(t, storeId, "tok-none")

    await t.mutation(internal.emailSubscribers.confirmDoubleOptIn, {
      token: "tok-none",
    })

    // The confirmation is the subscriber's, not the marketing sequence's. A
    // missing automation must not cost them their opt-in.
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("active")
    await cancelScheduled(t)
  })
})

describe("the run record", () => {
  test("keeps one row per step and refuses a second", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const automationId = await seedAutomation(t, storeId)
    const subscriberId = await seedPending(t, storeId, "tok-record")

    const first = await t.mutation(internal.emailAutomationRuns.record, {
      automationId,
      subscriberId,
      storeId,
      stepId: "s1",
    })
    // The race the index exists for: two dispatches of the same step landing
    // together. The second must find the first rather than insert beside it.
    const again = await t.mutation(internal.emailAutomationRuns.record, {
      automationId,
      subscriberId,
      storeId,
      stepId: "s1",
    })

    expect(again).toBe(first)
    const rows = await t.run((ctx) => ctx.db.query("emailAutomationRuns").collect())
    expect(rows).toHaveLength(1)
  })

  test("reports what a subscriber has already been sent", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const automationId = await seedAutomation(t, storeId)
    const subscriberId = await seedPending(t, storeId, "tok-sent")

    for (const stepId of ["s1", "s2"]) {
      await t.mutation(internal.emailAutomationRuns.record, {
        automationId,
        subscriberId,
        storeId,
        stepId,
      })
    }

    const sent = await t.query(internal.emailAutomationRuns.stepsSentTo, {
      automationId,
      subscriberId,
    })
    expect(sent.sort()).toEqual(["s1", "s2"])
  })

  test("does not confuse two subscribers of the same automation", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const automationId = await seedAutomation(t, storeId)
    const one = await seedPending(t, storeId, "tok-a")
    const two = await t.run((ctx) =>
      ctx.db.insert("emailSubscribers", {
        storeId,
        email: "claire@resto.example",
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

    await t.mutation(internal.emailAutomationRuns.record, {
      automationId,
      subscriberId: one,
      storeId,
      stepId: "s1",
    })

    // Claire has had nothing, and must still get step one.
    expect(
      await t.query(internal.emailAutomationRuns.stepsSentTo, {
        automationId,
        subscriberId: two,
      })
    ).toEqual([])
  })
})
