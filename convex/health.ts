/**
 * `GET $CONVEX_SITE_URL/health` — one URL an uptime monitor can watch.
 *
 * There was no health route anywhere, in any app. With one Convex deployment
 * per client, "is that restaurant's backend up?" had no answer short of opening
 * its dashboard, and nothing external could ask the question on a schedule. The
 * error reporting in `errorReporting.ts` covers the case where a function runs
 * and fails; this covers the case where nothing runs at all, which is the one
 * that produces no error to report.
 *
 * It lives on the Convex HTTP router rather than in Next.js on purpose. A Next
 * route answering `200` proves Vercel is serving — it proves nothing about the
 * deployment that holds the orders, and those are separate systems that fail
 * separately. `app/api/health/route.ts` calls THIS and reports both.
 *
 * ## What it deliberately does not do
 *
 * No authentication: a monitor cannot hold a credential, and the response is
 * built to be safe unauthenticated. It reports *whether* things are configured,
 * never what they are configured to — no DSN, no URL, no key, no count of
 * anything a competitor could read as trade.
 *
 * No write. A health check that writes is a health check that fills a table.
 */

import { resolveSentryOptions, type SentryEnvSource } from "@be-yours/core/sentry";
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";

/**
 * The cheapest read that proves the database actually answers.
 *
 * `take(1)` on an indexed table, not a count: a count walks the table, and this
 * runs every minute forever. An empty table is a healthy answer — a brand-new
 * client site has no stores yet and is not down.
 */
export const databaseReachable = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    await ctx.db.query("stores").take(1);
    return true;
  },
});

/** What the endpoint answers with. Stable — a monitor parses it. */
interface HealthReport {
  status: "ok" | "degraded";
  time: string;
  checks: {
    /** Whether the deployment's own database answered. */
    database: "ok" | "unreachable";
    /**
     * Whether backend errors have somewhere to go. `off` is NOT degraded: a
     * fresh client site legitimately has no Sentry project, and a monitor that
     * pages on it would be paging on a configuration decision.
     */
    errorReporting: "configured" | "off";
  };
}

// @public-by-design: a liveness probe an external uptime monitor calls on a
// schedule. It cannot hold a credential, and the body is built to be safe
// unauthenticated — it reports whether things are configured, never what to.
export const healthCheck = httpAction(async (ctx): Promise<Response> => {
  let database: HealthReport["checks"]["database"] = "ok";
  try {
    await ctx.runQuery(internal.health.databaseReachable, {});
  } catch (error) {
    // Logged rather than returned: the reason a database is unreachable can
    // name a table or an index, and this response is unauthenticated.
    console.error("[health] the database did not answer:", error);
    database = "unreachable";
  }

  const report: HealthReport = {
    status: database === "ok" ? "ok" : "degraded",
    time: new Date().toISOString(),
    checks: {
      database,
      // The warning sink is a no-op here, and only here. A monitor calls this
      // every minute forever; the "DSN set but unusable" warning is worth
      // shouting once from the reporter, not 1440 times a day from a probe.
      errorReporting: resolveSentryOptions("convex", process.env as SentryEnvSource, () => {})
        ? "configured"
        : "off",
    },
  };

  return new Response(JSON.stringify(report), {
    // 503 on degraded, because a monitor reads the status code and a body that
    // says "degraded" under a 200 is a body nobody configured an alert on.
    status: report.status === "ok" ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      // Never cached. A cached health check reports the last outage, or the
      // last recovery, and both are worse than no check.
      "Cache-Control": "no-store, max-age=0",
    },
  });
});
