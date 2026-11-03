// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The two triggers #258 unblocked.
 *
 * Both waited on the same thing: `updateMetadataIncremental` had no caller, so
 * `lastOrderAt` was never written and no order path reached the marketing side.
 *
 * The step that sends lives in a `"use node"` module and cannot run here, so
 * what these cover is the dispatch: does a confirmed order start a sequence,
 * does the SECOND order start another, and does the settings toggle stop it.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const EMAIL = "yanis@resto.example"

const newHarness = () => convexTest(schema, modules)

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

const scheduledNames = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs.map((j) => j.name)
  })

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedConfig(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  settings: Record<string, boolean> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("emailConfig", {
      storeId,
      senderName: "Chez Luigi",
      fromEmail: "luigi@resto.example",
      replyToEmail: "contact@resto.example",
      branding: { primaryColor: "#111", secondaryColor: "#eee" },
      unsubscribeText: "Se désabonner",
      maxEmailsPerWeek: 10,
      automationSettings: {
        welcomeEnabled: true,
        postOrderEnabled: true,
        birthdayEnabled: false,
        inactiveEnabled: true,
        abandonedCartEnabled: false,
        ...settings,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedAutomation(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  trigger: "post_order" | "inactive",
  over: { inactiveAfterDays?: number } = {}
) {
  return t.run(async (ctx) => {
    const templateId = await ctx.db.insert("emailTemplates", {
      storeId, name: "T", subject: "Merci !", blocks: [],
      category: "automation" as const, createdAt: NOW, updatedAt: NOW,
    })
    return ctx.db.insert("emailAutomations", {
      storeId,
      name: trigger,
      trigger,
      status: "active" as const,
      steps: [{ id: "s1", delayMinutes: 0, templateId }],
      inactiveAfterDays: over.inactiveAfterDays,
      stats: {
        sent: 0, delivered: 0, opened: 0, clicked: 0,
        bounced: 0, unsubscribed: 0, converted: 0, revenue: 0,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

async function seedSubscriber(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  lastOrderAt?: number
) {
  return t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId, email: EMAIL, status: "active" as const,
      source: "storefront_form" as const, tags: [],
      consentAt: NOW, consentSource: "test", bounceCount: 0,
      metadata: {
        totalOrders: lastOrderAt ? 1 : 0, totalSpent: 0, averageOrderValue: 0,
        favoriteProducts: [], orderTypes: [], lastOrderAt,
      },
      createdAt: NOW, updatedAt: NOW,
    })
  )
}

async function seedOrder(t: ReturnType<typeof convexTest>, storeId: Id<"stores">, n: number) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId, orderNumber: `A-${n}`,
      customerInfo: { name: "Yanis", email: EMAIL },
      type: "delivery" as const, status: "pending" as const, items: [],
      subtotal: 4000, taxAmount: 0, total: 4000,
      paymentMethod: "card" as const, paymentStatus: "paid" as const,
      source: "website" as const, createdAt: NOW, updatedAt: NOW,
    })
  )
}

const confirm = (t: ReturnType<typeof convexTest>, id: Id<"orders">) =>
  t.mutation(internal.orders.internalUpdateStatus, { id, status: "confirmed" })

describe("post_order", () => {
  test("a confirmed order starts the sequence", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    await seedAutomation(t, storeId, "post_order")
    await seedSubscriber(t, storeId)

    await confirm(t, await seedOrder(t, storeId, 1))

    // Nothing dispatched on this trigger before: no order path reached the
    // marketing side at all.
    expect((await scheduledNames(t)).some((n) => n.includes("startPostOrder"))).toBe(true)
    await cancelScheduled(t)
  })

  test("the second order is thanked too", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    const automationId = await seedAutomation(t, storeId, "post_order")
    const subscriberId = await seedSubscriber(t, storeId)

    const first = await seedOrder(t, storeId, 1)
    const second = await seedOrder(t, storeId, 2)

    await t.mutation(internal.emailAutomationRuns.record, {
      automationId, subscriberId, storeId, stepId: "s1",
      occurrenceKey: String(first),
    })

    // Keyed by occurrence, so the second order's sequence starts at step one
    // rather than finding itself already finished. Without that key a customer
    // is thanked for their first order and never again.
    expect(
      await t.query(internal.emailAutomationRuns.stepsSentTo, {
        automationId, subscriberId, occurrenceKey: String(second),
      })
    ).toEqual([])

    expect(
      await t.query(internal.emailAutomationRuns.stepsSentTo, {
        automationId, subscriberId, occurrenceKey: String(first),
      })
    ).toEqual(["s1"])
  })

  test("a customer who never subscribed starts nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    await seedAutomation(t, storeId, "post_order")
    // No subscriber row: an order is a purchase, not consent.

    await confirm(t, await seedOrder(t, storeId, 1))

    expect((await scheduledNames(t)).some((n) => n.includes("startPostOrder"))).toBe(false)
    await cancelScheduled(t)
  })
})

describe("inactive", () => {
  test("the sweep starts a win-back for a lapsed customer", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    await seedAutomation(t, storeId, "inactive", { inactiveAfterDays: 30 })
    await seedSubscriber(t, storeId, Date.now() - 60 * DAY)

    expect(await t.action(internal.emailAutomationActions.sweepInactive, {}))
      .toEqual({ started: 1 })
    await cancelScheduled(t)
  })

  test("it leaves a recent customer alone", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    await seedAutomation(t, storeId, "inactive", { inactiveAfterDays: 30 })
    await seedSubscriber(t, storeId, Date.now() - 5 * DAY)

    expect(await t.action(internal.emailAutomationActions.sweepInactive, {}))
      .toEqual({ started: 0 })
    await cancelScheduled(t)
  })

  test("it never chases someone who has never ordered", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId)
    await seedAutomation(t, storeId, "inactive", { inactiveAfterDays: 30 })
    await seedSubscriber(t, storeId, undefined)

    // "Come back, we miss you" to someone who has never been is how a sender
    // gets reported.
    expect(await t.action(internal.emailAutomationActions.sweepInactive, {}))
      .toEqual({ started: 0 })
    await cancelScheduled(t)
  })

  test("its toggle stops it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedConfig(t, storeId, { inactiveEnabled: false })
    await seedAutomation(t, storeId, "inactive", { inactiveAfterDays: 30 })
    await seedSubscriber(t, storeId, Date.now() - 60 * DAY)

    // The switch has to mean what it says; nothing read it anywhere until now.
    expect(await t.action(internal.emailAutomationActions.sweepInactive, {}))
      .toEqual({ started: 0 })
    await cancelScheduled(t)
  })
})
