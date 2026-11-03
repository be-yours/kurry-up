/**
 * Where a backend error goes.
 *
 * Before this file the answer was `console.error`, 112 times in this directory
 * alone, and a `console.error` in a Convex function lands in the dashboard of
 * ONE client's deployment. Every Stripe, Deliveroo, Uber Eats and SES webhook
 * runs here; so does every order mutation and the whole kitchen path. With one
 * deployment per client, a Saturday-night order that fails inside Convex was
 * visible to nobody, and finding it meant logging into each client's console
 * one at a time — while the maintenance contract sells support.
 *
 * The Next.js half has reported to Sentry for a while (`sentry.server.config.ts`,
 * `instrumentation.ts`, `app/global-error.tsx`). `apps/docs/deployment/sentry.md`
 * said the rest out loud: *"Convex. Backend functions run outside Next and
 * report nothing here."* This is that sentence being retired. Same DSN, same
 * per-client project, same scrubbing — so a failed checkout raises one issue
 * whether it broke in the browser, in the route handler or in the mutation.
 *
 * NO `"use node"`, deliberately. A `"use node"` module may only export actions,
 * and nothing outside one can import from it — which would exclude every
 * `httpAction` (they cannot be `"use node"` at all) and therefore every webhook,
 * i.e. exactly the surface this exists for. The default Convex runtime has
 * `fetch`, and `@be-yours/core/sentry` builds the envelope with no SDK.
 *
 * ## How to use it
 *
 * From an action or an `httpAction`:
 *
 * ```ts
 * } catch (error) {
 *   console.error("[Stripe Webhook] …", error);
 *   await captureBackendError(ctx, { error, source: "stripeWebhook", tags: { … } });
 *   return new Response("Processing error", { status: 500 });
 * }
 * ```
 *
 * `console.error` STAYS. The Convex dashboard is still the fastest place to
 * read a log while a deploy is in front of you; this adds a second destination,
 * it does not replace the first.
 *
 * ## The one trap
 *
 * From a **mutation**, the report is scheduled inside the mutation's
 * transaction — so it survives only if the mutation goes on to COMMIT. That is
 * the right behaviour for the `console.error`-and-continue pattern this
 * codebase uses everywhere, and the wrong one for a mutation that rethrows: the
 * throw rolls the transaction back and takes the scheduled report with it.
 * Report a rethrowing mutation from the action or `httpAction` above it, which
 * is not a transaction and cannot be rolled back.
 *
 * See `apps/docs/deployment/sentry.md`.
 */

import { v } from "convex/values";
import {
  buildSentryEnvelope,
  buildSentryErrorEvent,
  describeUnknownError,
  formatSentryEventId,
  parseSentryDsn,
  resolveSentryOptions,
  sentryAuthHeader,
  type SentryEnvSource,
} from "@be-yours/core/sentry";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

/** Identifies this transport to Sentry, and appears on every event. */
const SENTRY_CLIENT = "beyours-convex/1.0.0";

/**
 * How long the ingest POST may take.
 *
 * A Convex action has a finite budget and a webhook has a provider waiting on
 * it. Sentry being slow must cost a report, never an order: past this the
 * request is aborted and the failure is logged like any other.
 */
const INGEST_TIMEOUT_MS = 3_000;

/** What a report carries. Flat and validated, because it crosses a function boundary. */
const reportArgs = {
  /** What was running — `"stripeWebhook"`, `"kitchenTickets.confirmOrder"`. */
  source: v.string(),
  /** The exception class. Titles the Sentry issue. */
  name: v.string(),
  message: v.string(),
  stack: v.optional(v.string()),
  level: v.optional(
    v.union(v.literal("fatal"), v.literal("error"), v.literal("warning"), v.literal("info")),
  ),
  /** Searchable in Sentry. Keep them low-cardinality: a store id, an event type. */
  tags: v.optional(v.record(v.string(), v.string())),
  /**
   * Context. Scrubbed by `redactSentryExtra` before it leaves, so a key named
   * `signature` or `token` is filtered even when a call site forgets.
   */
  extra: v.optional(
    v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null())),
  ),
};

/** What `reportError` answers, so a caller and a test can tell what happened. */
export type ReportOutcome =
  | { reported: true; eventId: string }
  | { reported: false; reason: "no-dsn" | "bad-dsn" | "rejected" | "threw" };

/**
 * Sends one event to this deployment's Sentry project.
 *
 * `internalAction`, so it is unreachable from a browser: the argument list is
 * an arbitrary message and arbitrary tags, and a public version of it would let
 * anyone write into a client's issue stream and exhaust the quota that a real
 * incident needs.
 *
 * Never throws. Every failure — no DSN, a malformed DSN, a 429, a timeout —
 * ends as a returned reason and a `console.error`. A reporter that throws while
 * reporting turns one failed order into two, and the second one is invisible
 * for exactly the same reason as the first.
 */
export const reportError = internalAction({
  args: reportArgs,
  handler: async (_ctx, args): Promise<ReportOutcome> => {
    try {
      const options = resolveSentryOptions("convex", process.env as SentryEnvSource);
      // The normal state of a fresh client site, of CI and of local
      // development. It has to cost nothing and say nothing.
      if (!options) return { reported: false, reason: "no-dsn" };

      // Unreachable in practice, and kept because "in practice" is doing work
      // in that sentence: `resolveSentryOptions` gates on `isSentryDsn`, which
      // IS `parseSentryDsn(...) !== null`, so a malformed DSN has already
      // returned `no-dsn` above — with a named `console.warn` naming the
      // variable, which is the message an operator needs. This branch is what
      // stops the two ever drifting into disagreeing silently again.
      const dsn = parseSentryDsn(options.dsn);
      if (!dsn) {
        console.error("[errorReporting] SENTRY_DSN is not a usable DSN; the report was dropped");
        return { reported: false, reason: "bad-dsn" };
      }

      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const now = Date.now();

      const event = buildSentryErrorEvent({
        error: rebuildError(args.name, args.message, args.stack),
        eventId: formatSentryEventId(bytes),
        now,
        environment: options.environment,
        release: options.release,
        level: args.level,
        source: args.source,
        tags: { ...options.initialScope.tags, ...args.tags },
        extra: args.extra,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
      try {
        const response = await fetch(dsn.envelopeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": sentryAuthHeader(dsn, SENTRY_CLIENT),
          },
          body: buildSentryEnvelope(event, options.dsn, now),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 429 is the interesting one: the project is over quota, which is a
          // configuration problem on our side and not a transient fault.
          console.error(
            `[errorReporting] Sentry refused the event: ${response.status} ${response.statusText}`,
          );
          return { reported: false, reason: "rejected" };
        }

        return { reported: true, eventId: event.event_id };
      } finally {
        clearTimeout(timer);
      }
    } catch (failure) {
      console.error("[errorReporting] the reporter itself failed:", failure);
      return { reported: false, reason: "threw" };
    }
  },
});

/**
 * Rebuilds an `Error` from the flattened fields, so `describeUnknownError` and
 * the stack parser see the same shape here as they would at the call site.
 *
 * The alternative — passing the described pieces straight through — would give
 * two code paths producing Sentry events, and the one used in production would
 * be the one no unit test covers.
 */
function rebuildError(name: string, message: string, stack: string | undefined): Error {
  const error = new Error(message);
  error.name = name;
  // Assigning `undefined` would leave V8's own capture in place, pointing at
  // this function rather than at the code that failed. Clear it instead.
  error.stack = stack ?? "";
  return error;
}

/** Only the scheduler is needed, so a query, a mutation and an action all fit. */
type ReportingCtx = { scheduler: MutationCtx["scheduler"] };

/** What a call site passes. `error` is the caught value, whatever shape it has. */
export interface CaptureInput {
  error: unknown;
  source: string;
  level?: "fatal" | "error" | "warning" | "info";
  tags?: Record<string, string>;
  extra?: Record<string, string | number | boolean | null>;
}

/**
 * Hands one caught error to the reporter, from anywhere with a scheduler.
 *
 * Scheduled rather than awaited even from an action: a webhook must answer its
 * provider before Sentry answers us, and a `runAfter(0)` is a database write
 * that returns immediately. It also means one code path from every kind of
 * function instead of a branch per context.
 *
 * Never throws, so it is safe inside a `catch` — the whole point is that adding
 * it to an existing handler cannot change what that handler does.
 *
 * @see the transaction trap in this module's header before calling it from a
 *      mutation that rethrows.
 */
export async function captureBackendError(
  ctx: ReportingCtx,
  input: CaptureInput,
): Promise<void> {
  try {
    const described = describeUnknownError(input.error);
    await ctx.scheduler.runAfter(0, internal.errorReporting.reportError, {
      source: input.source,
      name: described.type,
      message: described.value,
      ...(described.stack ? { stack: described.stack } : {}),
      ...(input.level ? { level: input.level } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.extra ? { extra: input.extra } : {}),
    });
  } catch (schedulingFailure) {
    // The original error has already been logged by the call site. This one is
    // about the reporting itself, and it must not replace it.
    console.error("[errorReporting] could not schedule a report:", schedulingFailure);
  }
}
