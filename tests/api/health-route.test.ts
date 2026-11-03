/**
 * `GET /api/health` — the URL an uptime monitor watches for one client site.
 *
 * A client site is two systems that fail separately: the Next.js app on Vercel
 * and its own Convex deployment. Vercel serving is the half that almost never
 * breaks; the orders, the kitchen tickets and every webhook are in the other
 * one. So the contract asserted here is that the route is not merely alive —
 * it goes and asks the backend, and it goes RED when the backend does not
 * answer. A health check that reports the app it is running inside is a health
 * check that can never fail, and a monitor watching it learns nothing.
 *
 * `503` matters as much as the body: a monitor reads the status code, and a
 * page that says "degraded" under a `200` is one nobody has an alert on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { GET } = await import("@/app/api/health/route")

interface HealthBody {
  status: string
  time: string
  checks: { web: string; backend: string }
}

const backendAnswers = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", "https://tidy-otter-123.convex.site")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("both halves are up", () => {
  it("answers 200 and says so", async () => {
    vi.stubGlobal("fetch", backendAnswers({ status: "ok", checks: { database: "ok" } }))

    const response = await GET()
    const body = (await response.json()) as HealthBody

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: "ok", checks: { web: "ok", backend: "ok" } })
    expect(Number.isNaN(Date.parse(body.time))).toBe(false)
  })

  it("asks the Convex deployment's own health route, uncached", async () => {
    const fetchMock = backendAnswers({ status: "ok" })
    vi.stubGlobal("fetch", fetchMock)

    await GET()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://tidy-otter-123.convex.site/health")
    // Next caches `fetch` inside a route handler by default, which would pin
    // this to the first answer it ever received, forever.
    expect(init.cache).toBe("no-store")
  })
})

describe("the backend is the half that fails", () => {
  it("goes 503 when Convex answers unhealthy", async () => {
    vi.stubGlobal("fetch", backendAnswers({ status: "degraded" }, 503))

    const response = await GET()
    const body = (await response.json()) as HealthBody

    expect(response.status).toBe(503)
    expect(body.checks.backend).toBe("degraded")
    // The web half is genuinely fine, and saying so is what tells whoever is
    // paged which of the two systems to look at.
    expect(body.checks.web).toBe("ok")
  })

  it("goes 503 when Convex does not answer at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.4:443")
      }),
    )

    const response = await GET()
    const body = (await response.json()) as HealthBody

    expect(response.status).toBe(503)
    expect(body.checks.backend).toBe("unreachable")
    // The route is unauthenticated and the failure names an internal host.
    expect(JSON.stringify(body)).not.toContain("10.0.0.4")
  })

  /**
   * A 200 whose body does not say `ok` is the shape that would otherwise slip
   * through: an error page, a proxy's courtesy response, a rewritten route.
   */
  it("does not trust a 200 that does not say ok", async () => {
    vi.stubGlobal("fetch", backendAnswers({ hello: "world" }))

    expect((await GET()).status).toBe(503)
  })
})

/**
 * A preview build with no backend URL is not an outage. Reporting it as one
 * would page on a configuration decision, and whoever carries the pager would
 * learn to ignore the alert — which costs more than the check is worth.
 */
describe("no backend configured", () => {
  it("stays 200 and says the backend is unconfigured", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "")
    const fetchMock = backendAnswers({ status: "ok" })
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET()
    const body = (await response.json()) as HealthBody

    expect(response.status).toBe(200)
    expect(body.status).toBe("ok")
    expect(body.checks.backend).toBe("unconfigured")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
