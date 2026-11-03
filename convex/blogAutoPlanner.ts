/**
 * Auto Blog scheduling — app wrappers.
 *
 * Everything here is `internal`: a cron runs with no user identity, so a
 * guarded wrapper would refuse it and a public one should not exist. The
 * establishment was authorised when the owner saved the configuration
 * (`blogAutoConfig.upsert` calls `requireStorePermission`), and the queue row
 * carries that decision forward.
 */

import { v } from "convex/values"
import { internalQuery, internalMutation } from "./_generated/server"
import {
  claimJobCore,
  completeJobCore,
  dueJobIdsCore,
  failJobCore,
  planAutoBlogJobsCore,
} from "@be-yours/convex-functions/blogAutoPlanner"

/**
 * Hourly: queue an article for every configuration whose hour has come.
 *
 * Writes queue rows and nothing else — no OpenAI call happens here.
 */
export const planAutoBlogJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    return planAutoBlogJobsCore(ctx, Date.now())
  },
})

/** Pending jobs whose scheduled time has passed. */
export const _dueJobIds = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    return dueJobIdsCore(ctx, Date.now(), limit)
  },
})

/** Take a job, or return null because another run took it first. */
export const _claimJob = internalMutation({
  args: { jobId: v.id("blogAutoQueue") },
  handler: async (ctx, { jobId }) => {
    return claimJobCore(ctx, jobId, Date.now())
  },
})

/** Attach the generated article to its job. */
export const _completeJob = internalMutation({
  args: {
    jobId: v.id("blogAutoQueue"),
    articleId: v.id("blogArticles"),
    status: v.union(v.literal("draft"), v.literal("published")),
  },
  handler: async (ctx, args) => {
    await completeJobCore(ctx, {
      jobId: args.jobId,
      articleId: args.articleId,
      status: args.status,
      at: Date.now(),
    })
  },
})

/** Record a failure, and put the job back if it has retries left. */
export const _failJob = internalMutation({
  args: {
    jobId: v.id("blogAutoQueue"),
    errorCode: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await failJobCore(ctx, {
      jobId: args.jobId,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      at: Date.now(),
    })
  },
})
