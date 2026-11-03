/**
 * `GET /api/health` — the one URL an uptime monitor watches per client site.
 *
 * A client site is two systems that fail separately: the Next.js app on Vercel
 * and its own Convex deployment. A route that only answers `200` proves Vercel
 * is serving, which is the half that almost never breaks — the orders, the
 * kitchen tickets and every webhook live in the other one. So this asks Convex
 * as well, and reports both.
 *
 * There was no health route in any app before this, in either half. With one
 * deployment per client, "is that restaurant's backend up?" could only be
 * answered by opening its dashboard, one client at a time, while the
 * maintenance contract sells support.
 *
 * ## What it deliberately does not do
 *
 * No authentication, and no configuration values in the body. A monitor cannot
 * hold a credential, so the response is built to be safe for anyone to read: it
 * says whether a thing is configured, never what it is configured to. The
 * Convex side follows the same rule — see `convex/health.ts`.
 */

import { NextResponse } from "next/server"

/** Never cached, never statically rendered: a cached health check is a lie. */
export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * Past this the backend is treated as unreachable.
 *
 * A monitor's own timeout is usually 10s and it reports a timeout as "down"
 * with no detail. Failing first, with a body that names which half is down, is
 * the difference between a page that says "Convex is not answering" and one
 * that says nothing.
 */
const BACKEND_TIMEOUT_MS = 5_000

interface BackendReport {
  status?: string
  checks?: Record<string, string>
}

/** The shape a monitor parses. Stable. */
interface HealthReport {
  status: "ok" | "degraded"
  time: string
  checks: {
    /** This process. If you are reading a response at all, it is `ok`. */
    web: "ok"
    /**
     * The Convex deployment behind it.
     *
     * `unconfigured` is not `degraded`: a preview build with no backend URL is
     * not an outage, and paging on it would train whoever carries the pager to
     * ignore the alert.
     */
    backend: "ok" | "degraded" | "unreachable" | "unconfigured"
  }
}

export async function GET(): Promise<NextResponse<HealthReport>> {
  const siteUrl = process.env.CONVEX_SITE_URL?.trim()

  let backend: HealthReport["checks"]["backend"] = "unconfigured"
  if (siteUrl) {
    try {
      const response = await fetch(`${siteUrl.replace(/\/+$/, "")}/health`, {
        // Next caches `fetch` by default in a route handler, which would make
        // this report the first answer it ever received, forever.
        cache: "no-store",
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      })
      const body = (await response.json().catch(() => null)) as BackendReport | null
      backend = response.ok && body?.status === "ok" ? "ok" : "degraded"
    } catch {
      // The error itself is not reported: this route is unauthenticated, and a
      // fetch failure names the internal host.
      backend = "unreachable"
    }
  }

  const report: HealthReport = {
    status: backend === "degraded" || backend === "unreachable" ? "degraded" : "ok",
    time: new Date().toISOString(),
    checks: { web: "ok", backend },
  }

  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store, max-age=0" },
  })
}
