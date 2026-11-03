// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Auto Blog is a subscription with a schedule, and it had no scheduler.
 *
 * `blogAutoConfig` stored "weekly, Tuesday, 09:00, auto-publish"; `blogAutoQueue`
 * carried an index whose comment read "Cron: find pending jobs due for
 * execution"; `grep cronJobs` returned nothing. The owner's only way to get an
 * article was to press the button themselves.
 *
 * These run the real planner and the real queue transitions against the real
 * schema. The quota case is the one that costs money: the check and the
 * increment used to sit either side of a multi-minute OpenAI call, so ten
 * concurrent requests all read the same count and all passed.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import schema from "../../convex/schema"
import type { Id } from "../../convex/_generated/dataModel"
import {
  STALE_GENERATING_MS,
  claimJobCore,
  completeJobCore,
  failJobCore,
  planAutoBlogJobsCore,
  requeueStaleJobsCore,
} from "@be-yours/convex-functions/blogAutoPlanner"
import {
  releaseArticleQuota,
  releaseImageToProductQuota,
  reserveArticleQuota,
  reserveImageQuota,
  reserveImageToProductQuota,
  resolveApprovalMode,
} from "@be-yours/convex-functions/blogAutoGuards"

const modules = import.meta.glob("../../convex/**/*.ts")

/** Tuesday 7 July 2026, 07:00Z — 09:00 in Paris. */
const DUE_AT = Date.parse("2026-07-07T07:00:00Z")
const OWNER = "owner_auto_blog"

type Plan = "starter" | "pro" | "enterprise"

function newHarness() {
  return convexTest(schema, modules)
}

async function seedEntitlements(
  t: ReturnType<typeof convexTest>,
  over: {
    plan?: Plan
    monthlyQuota?: number
    monthlyImageQuota?: number
    allowAutoPublish?: boolean
    allowMultiLanguage?: boolean
    subscriptionStatus?: string
    enabled?: boolean
    ownerId?: string
  } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("ownerEntitlements", {
      ownerId: over.ownerId ?? OWNER,
      autoBlog: {
        enabled: over.enabled ?? true,
        plan: over.plan ?? "pro",
        monthlyQuota: over.monthlyQuota ?? 8,
        allowMultiLanguage: over.allowMultiLanguage ?? false,
        allowAutoPublish: over.allowAutoPublish ?? true,
        monthlyImageQuota: over.monthlyImageQuota ?? 20,
      },
      subscriptionStatus: over.subscriptionStatus ?? "active",
      createdAt: DUE_AT,
      updatedAt: DUE_AT,
    })
  })
}

async function seedStoreAndConfig(
  t: ReturnType<typeof convexTest>,
  over: {
    isEnabled?: boolean
    preferredHour?: number
    preferredWeekdays?: number[]
    themes?: string[]
    approvalMode?: "draft_review" | "auto_publish"
    autoTranslate?: boolean
    withCategory?: boolean
  } = {},
) {
  return t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
      name: "Chez Camille",
      slug: "chez-camille",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: DUE_AT,
      updatedAt: DUE_AT,
    })

    const categoryId =
      over.withCategory === false
        ? undefined
        : await ctx.db.insert("blogCategories", {
            storeId,
            name: "Recettes",
            slug: "recettes",
            sortOrder: 0,
            createdAt: DUE_AT,
            updatedAt: DUE_AT,
          })

    const configId = await ctx.db.insert("blogAutoConfig", {
      ownerId: OWNER,
      storeId,
      isEnabled: over.isEnabled ?? true,
      themes: over.themes ?? ["desserts de saison"],
      frequency: "weekly" as const,
      preferredWeekdays: over.preferredWeekdays ?? [2],
      preferredHour: over.preferredHour ?? 9,
      timezone: "Europe/Paris",
      tone: "decontracte" as const,
      primaryLocale: "fr",
      autoTranslate: over.autoTranslate ?? false,
      approvalMode: over.approvalMode ?? "draft_review",
      ...(categoryId ? { categoryId } : {}),
      createdAt: DUE_AT,
      updatedAt: DUE_AT,
    })

    return { storeId, configId, categoryId }
  })
}

async function queueRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("blogAutoQueue").collect())
}

describe("planAutoBlogJobs", () => {
  test("queues an article when the configured hour arrives", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    const { storeId, configId } = await seedStoreAndConfig(t)

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(summary.queued).toBe(1)
    const rows = await queueRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      storeId,
      configId,
      ownerId: OWNER,
      status: "pending",
      theme: "desserts de saison",
      locale: "fr",
      retryCount: 0,
    })
  })

  test("records the sweep on the configuration", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    const { configId } = await seedStoreAndConfig(t)

    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    const config = await t.run(async (ctx) => ctx.db.get(configId))
    expect(config?.lastPlannedAt).toBe(DUE_AT)
  })

  test("a second sweep of the same hour queues nothing", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t)

    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const second = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT + 59 * 60_000))

    expect(second.skippedDuplicate).toBe(1)
    expect(await queueRows(t)).toHaveLength(1)
  })

  test("the following week is a new slot", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t)

    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT + 7 * 24 * 3600_000))

    expect(await queueRows(t)).toHaveLength(2)
  })

  test("queues a slot the previous sweep missed", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t)

    // Three hours after the configured 09:00, as if the cron had not run.
    const summary = await t.run(async (ctx) =>
      planAutoBlogJobsCore(ctx, DUE_AT + 3 * 3600_000),
    )

    expect(summary.queued).toBe(1)
    expect((await queueRows(t))[0]?.idempotencyKey).toContain("2026-07-07T09")
  })

  test("a catch-up cannot duplicate a slot that was already queued", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t)

    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const second = await t.run(async (ctx) =>
      planAutoBlogJobsCore(ctx, DUE_AT + 3 * 3600_000),
    )

    expect(second.skippedDuplicate).toBe(1)
    expect(await queueRows(t)).toHaveLength(1)
  })

  test("a configuration saved with the deprecated single weekday still fires", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await t.run(async (ctx) => {
      const storeId = await ctx.db.insert("stores", {
        name: "Chez Lucien",
        slug: "chez-lucien",
        address: { street: "2 rue Neuve", city: "Lyon", postalCode: "69001", country: "France" },
        hours: [],
        status: "open" as const,
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
      })
      const categoryId = await ctx.db.insert("blogCategories", {
        storeId,
        name: "Recettes",
        slug: "recettes",
        sortOrder: 0,
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
      })
      await ctx.db.insert("blogAutoConfig", {
        ownerId: OWNER,
        storeId,
        isEnabled: true,
        themes: ["desserts"],
        frequency: "weekly" as const,
        // The old shape: singular, no array.
        preferredWeekday: 2,
        preferredHour: 9,
        timezone: "Europe/Paris",
        tone: "decontracte" as const,
        primaryLocale: "fr",
        autoTranslate: false,
        approvalMode: "draft_review" as const,
        categoryId,
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
      })
    })

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(summary.queued).toBe(1)
  })

  test("does not fire an hour early", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t)

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT - 3600_000))

    expect(summary.queued).toBe(0)
    expect(await queueRows(t)).toHaveLength(0)
  })

  test("ignores a configuration that is switched off", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t, { isEnabled: false })

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(summary.considered).toBe(0)
    expect(await queueRows(t)).toHaveLength(0)
  })

  test("skips an owner whose monthly quota is spent, without failing anything", async () => {
    const t = newHarness()
    await seedEntitlements(t, { monthlyQuota: 1 })
    await seedStoreAndConfig(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("blogAutoUsage", {
        ownerId: OWNER,
        periodKey: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
        generatedCount: 1,
        publishedCount: 0,
        updatedAt: DUE_AT,
      })
    })

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(summary.skippedNoAccess).toBe(1)
    expect(await queueRows(t)).toHaveLength(0)
  })

  test("skips an owner whose subscription has lapsed", async () => {
    const t = newHarness()
    await seedEntitlements(t, { subscriptionStatus: "past_due" })
    await seedStoreAndConfig(t)

    const summary = await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(summary.skippedNoAccess).toBe(1)
    expect(await queueRows(t)).toHaveLength(0)
  })

  test("queues nothing for a configuration with no themes", async () => {
    const t = newHarness()
    await seedEntitlements(t)
    await seedStoreAndConfig(t, { themes: [] })

    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))

    expect(await queueRows(t)).toHaveLength(0)
  })
})

describe("claiming a queued job", () => {
  async function seedOnePendingJob(over: Parameters<typeof seedStoreAndConfig>[1] = {}) {
    const t = newHarness()
    await seedEntitlements(t, {
      allowAutoPublish: over.approvalMode === "auto_publish",
      allowMultiLanguage: over.autoTranslate === true,
    })
    const seeded = await seedStoreAndConfig(t, over)
    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const rows = await queueRows(t)
    return { t, jobId: rows[0]!._id as Id<"blogAutoQueue">, ...seeded }
  }

  test("moves the job to generating and hands back what it needs", async () => {
    const { t, jobId, storeId, categoryId } = await seedOnePendingJob()

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed).toMatchObject({
      jobId,
      ownerId: OWNER,
      storeId,
      categoryId,
      theme: "desserts de saison",
      tone: "decontracte",
      locale: "fr",
    })
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("generating")
    expect(row?.startedAt).toBe(DUE_AT)
  })

  test("a second claim of the same job returns null", async () => {
    const { t, jobId } = await seedOnePendingJob()

    await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))
    const second = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(second).toBeNull()
  })

  test("cancels a job whose configuration was switched off after queueing", async () => {
    const { t, jobId, configId } = await seedOnePendingJob()
    await t.run(async (ctx) => ctx.db.patch(configId, { isEnabled: false }))

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed).toBeNull()
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("cancelled")
    expect(row?.errorCode).toBe("config_disabled")
  })

  test("cancels a job whose subscription lapsed while it waited", async () => {
    const { t, jobId } = await seedOnePendingJob()
    await t.run(async (ctx) => {
      const ent = await ctx.db
        .query("ownerEntitlements")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER))
        .first()
      if (ent) await ctx.db.patch(ent._id, { subscriptionStatus: "canceled" })
    })

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed).toBeNull()
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("cancelled")
    expect(row?.errorCode).toBe("no_access")
  })

  test("auto-publish survives the claim when the plan allows it", async () => {
    const { t, jobId } = await seedOnePendingJob({ approvalMode: "auto_publish" })

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed?.approvalMode).toBe("auto_publish")
  })

  test("a downgraded plan turns auto-publish back into a draft", async () => {
    const { t, jobId } = await seedOnePendingJob({ approvalMode: "auto_publish" })
    await t.run(async (ctx) => {
      const ent = await ctx.db
        .query("ownerEntitlements")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER))
        .first()
      if (ent) {
        await ctx.db.patch(ent._id, {
          autoBlog: { ...ent.autoBlog, allowAutoPublish: false },
        })
      }
    })

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed?.approvalMode).toBe("draft_review")
  })

  test("auto-translation is dropped when the plan does not include it", async () => {
    const t = newHarness()
    await seedEntitlements(t, { allowMultiLanguage: false })
    await seedStoreAndConfig(t, { autoTranslate: true })
    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const jobId = (await queueRows(t))[0]!._id as Id<"blogAutoQueue">

    const claimed = await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))

    expect(claimed?.autoTranslate).toBe(false)
  })
})

describe("finishing a job", () => {
  async function pendingJob() {
    const t = newHarness()
    await seedEntitlements(t)
    const seeded = await seedStoreAndConfig(t)
    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const jobId = (await queueRows(t))[0]!._id as Id<"blogAutoQueue">
    return { t, jobId, ...seeded }
  }

  test("a draft is recorded as draft_created", async () => {
    const { t, jobId, storeId, categoryId } = await pendingJob()
    const articleId = await t.run(async (ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "s",
        draftCategoryId: categoryId!,
        draftAuthorId: OWNER,
        draftContent: { title: "T", slug: "s", excerpt: "e", content: "<p>c</p>", updatedAt: DUE_AT },
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
        updatedBy: OWNER,
      }),
    )

    await t.run(async (ctx) =>
      completeJobCore(ctx, { jobId, articleId, status: "draft", at: DUE_AT }),
    )

    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("draft_created")
    expect(row?.articleId).toBe(articleId)
  })

  test("a failure goes back to pending, later, until the retries run out", async () => {
    const { t, jobId } = await pendingJob()

    for (let attempt = 1; attempt <= 3; attempt++) {
      await t.run(async (ctx) =>
        failJobCore(ctx, { jobId, errorCode: "generation_failed", errorMessage: "boom", at: DUE_AT }),
      )
      const row = await t.run(async (ctx) => ctx.db.get(jobId))
      expect(row?.status).toBe("pending")
      expect(row?.retryCount).toBe(attempt)
      expect(row?.scheduledFor).toBeGreaterThan(DUE_AT)
    }

    await t.run(async (ctx) =>
      failJobCore(ctx, { jobId, errorCode: "generation_failed", errorMessage: "boom", at: DUE_AT }),
    )
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("failed")
    expect(row?.retryCount).toBe(4)
  })

  test("a failure message is truncated rather than stored whole", async () => {
    const { t, jobId } = await pendingJob()

    await t.run(async (ctx) =>
      failJobCore(ctx, {
        jobId,
        errorCode: "generation_failed",
        errorMessage: "x".repeat(2000),
        at: DUE_AT,
      }),
    )

    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.errorMessage?.length).toBe(500)
  })
})

describe("a job whose executor never came back", () => {
  async function claimedJob() {
    const t = newHarness()
    await seedEntitlements(t)
    const seeded = await seedStoreAndConfig(t)
    await t.run(async (ctx) => planAutoBlogJobsCore(ctx, DUE_AT))
    const jobId = (await queueRows(t))[0]!._id as Id<"blogAutoQueue">
    await t.run(async (ctx) => claimJobCore(ctx, jobId, DUE_AT))
    return { t, jobId, ...seeded }
  }

  test("is left alone while the generation could still be running", async () => {
    const { t, jobId } = await claimedJob()

    const recovered = await t.run(async (ctx) =>
      requeueStaleJobsCore(ctx, DUE_AT + 60_000),
    )

    expect(recovered.requeued).toBe(0)
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("generating")
  })

  test("is put back in the queue once it is plainly dead", async () => {
    const { t, jobId } = await claimedJob()

    const recovered = await t.run(async (ctx) =>
      requeueStaleJobsCore(ctx, DUE_AT + STALE_GENERATING_MS + 1),
    )

    expect(recovered.requeued).toBe(1)
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("pending")
    expect(row?.errorCode).toBe("executor_lost")
    expect(row?.retryCount).toBe(1)
  })

  test("hands the reserved slot back, so a dead executor costs nothing", async () => {
    const { t, jobId } = await claimedJob()
    await t.run(async (ctx) => reserveArticleQuota(ctx, OWNER))
    const before = await t.run(async (ctx) => ctx.db.query("blogAutoUsage").first())
    expect(before?.generatedCount).toBe(1)

    await t.run(async (ctx) => requeueStaleJobsCore(ctx, DUE_AT + STALE_GENERATING_MS + 1))

    const after = await t.run(async (ctx) => ctx.db.query("blogAutoUsage").first())
    expect(after?.generatedCount).toBe(0)
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("pending")
  })

  /**
   * The executor can die after `_saveGeneratedArticle` has committed: the
   * article exists and the job still reads `generating`. Re-queueing it would
   * produce a second article for a slot the owner paid for once.
   */
  test("completes rather than retries a job whose article was already written", async () => {
    const { t, jobId, storeId, categoryId } = await claimedJob()
    const articleId = await t.run(async (ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "s",
        draftCategoryId: categoryId!,
        draftAuthorId: OWNER,
        draftContent: { title: "T", slug: "s", excerpt: "e", content: "<p>c</p>", updatedAt: DUE_AT },
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
        updatedBy: OWNER,
      }),
    )
    await t.run(async (ctx) => ctx.db.patch(jobId, { articleId }))

    const recovered = await t.run(async (ctx) =>
      requeueStaleJobsCore(ctx, DUE_AT + STALE_GENERATING_MS + 1),
    )

    expect(recovered).toEqual({ requeued: 0, salvaged: 1 })
    const row = await t.run(async (ctx) => ctx.db.get(jobId))
    expect(row?.status).toBe("draft_created")
    expect(row?.articleId).toBe(articleId)
  })

  test("never resurrects a job somebody cancelled", async () => {
    const { t, jobId } = await claimedJob()
    await t.run(async (ctx) => ctx.db.patch(jobId, { status: "cancelled" as const }))

    await t.run(async (ctx) =>
      failJobCore(ctx, { jobId, errorCode: "x", errorMessage: "y", at: DUE_AT }),
    )

    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("cancelled")
  })

  test("stops cycling once its retries are spent", async () => {
    const { t, jobId } = await claimedJob()

    for (let i = 0; i < 5; i++) {
      await t.run(async (ctx) => ctx.db.patch(jobId, { status: "generating", startedAt: DUE_AT }))
      await t.run(async (ctx) => requeueStaleJobsCore(ctx, DUE_AT + STALE_GENERATING_MS + 1))
    }

    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("failed")
  })

  test("the hourly planner is what performs the recovery", async () => {
    const { t, jobId } = await claimedJob()

    const summary = await t.run(async (ctx) =>
      planAutoBlogJobsCore(ctx, DUE_AT + STALE_GENERATING_MS + 1),
    )

    expect(summary.requeuedStale).toBe(1)
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("pending")
  })
})

describe("quota reservation", () => {
  test("ten concurrent generations cannot exceed a quota of two", async () => {
    const t = newHarness()
    await seedEntitlements(t, { monthlyQuota: 2 })

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const reservation = await t.run(async (ctx) => reserveArticleQuota(ctx, OWNER))
        return reservation.ok ? "generated" : "refused"
      }),
    )

    expect(outcomes.filter((o) => o === "generated")).toHaveLength(2)
    const usage = await t.run(async (ctx) =>
      ctx.db.query("blogAutoUsage").first(),
    )
    expect(usage?.generatedCount).toBe(2)
  })

  test("the image quota holds under the same pressure", async () => {
    const t = newHarness()
    await seedEntitlements(t, { monthlyImageQuota: 3 })

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const reservation = await t.run(async (ctx) => reserveImageQuota(ctx, OWNER))
        return reservation.ok
      }),
    )

    expect(outcomes.filter(Boolean)).toHaveLength(3)
  })

  test("releasing gives the slot back", async () => {
    const t = newHarness()
    await seedEntitlements(t, { monthlyQuota: 1 })

    expect((await t.run(async (ctx) => reserveArticleQuota(ctx, OWNER))).ok).toBe(true)
    expect((await t.run(async (ctx) => reserveArticleQuota(ctx, OWNER))).ok).toBe(false)

    await t.run(async (ctx) => releaseArticleQuota(ctx, OWNER))

    expect((await t.run(async (ctx) => reserveArticleQuota(ctx, OWNER))).ok).toBe(true)
  })

  test("a release that runs twice cannot mint free quota", async () => {
    const t = newHarness()
    await seedEntitlements(t, { monthlyQuota: 1 })

    await t.run(async (ctx) => releaseArticleQuota(ctx, OWNER))
    await t.run(async (ctx) => releaseArticleQuota(ctx, OWNER))

    const usage = await t.run(async (ctx) => ctx.db.query("blogAutoUsage").first())
    expect(usage?.generatedCount).toBe(0)
  })

  /**
   * Not one of the eight sub-points, and the same defect: `imageToProduct`
   * checked the quota, made three OpenAI requests, and incremented the counter
   * seventy-five lines later.
   */
  test("the Image-to-Product analysis quota holds too", async () => {
    const t = newHarness()
    await t.run(async (ctx) => {
      await ctx.db.insert("ownerEntitlements", {
        ownerId: OWNER,
        autoBlog: {
          enabled: true,
          plan: "pro" as const,
          monthlyQuota: 8,
          allowMultiLanguage: false,
          allowAutoPublish: true,
        },
        imageToProduct: { enabled: true, monthlyAnalysisQuota: 3 },
        subscriptionStatus: "active",
        createdAt: DUE_AT,
        updatedAt: DUE_AT,
      })
    })

    const outcomes = await Promise.all(
      Array.from({ length: 15 }, async () => {
        const reservation = await t.run(async (ctx) =>
          reserveImageToProductQuota(ctx, OWNER),
        )
        return reservation.ok
      }),
    )

    expect(outcomes.filter(Boolean)).toHaveLength(3)

    await t.run(async (ctx) => releaseImageToProductQuota(ctx, OWNER))
    expect((await t.run(async (ctx) => reserveImageToProductQuota(ctx, OWNER))).ok).toBe(true)
  })

  test("an owner without the Image-to-Product entitlement reserves nothing", async () => {
    const t = newHarness()
    await seedEntitlements(t)

    const reservation = await t.run(async (ctx) =>
      reserveImageToProductQuota(ctx, OWNER),
    )

    expect(reservation.ok).toBe(false)
  })

  test("an owner with no subscription reserves nothing", async () => {
    const t = newHarness()

    const reservation = await t.run(async (ctx) => reserveArticleQuota(ctx, "stranger"))

    expect(reservation.ok).toBe(false)
    expect(await t.run(async (ctx) => ctx.db.query("blogAutoUsage").collect())).toHaveLength(0)
  })
})

describe("resolveApprovalMode", () => {
  const plan = (allowAutoPublish: boolean) => ({ autoBlog: { allowAutoPublish } })

  test("auto-publish is honoured where the plan allows it", () => {
    expect(resolveApprovalMode(plan(true), "auto_publish")).toBe("auto_publish")
  })

  test("auto-publish becomes a draft where it does not", () => {
    expect(resolveApprovalMode(plan(false), "auto_publish")).toBe("draft_review")
  })

  test("anything unset is a draft", () => {
    expect(resolveApprovalMode(plan(true), undefined)).toBe("draft_review")
    expect(resolveApprovalMode(null, "auto_publish")).toBe("draft_review")
  })
})
