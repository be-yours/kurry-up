import { describe, it, expect } from "vitest"
import { buildContentSecurityPolicy } from "../content-security-policy"

const parse = (policy: string): Record<string, string[]> =>
  Object.fromEntries(
    policy.split(";").map((part) => {
      const [directive, ...values] = part.trim().split(/\s+/)
      return [directive, values]
    }),
  )

const production = () => parse(buildContentSecurityPolicy({ isDevelopment: false }))
const development = () => parse(buildContentSecurityPolicy({ isDevelopment: true }))

describe("buildContentSecurityPolicy", () => {
  it.each([
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["default-src", "'self'"],
  ])("locks %s to %s in production", (directive, value) => {
    expect(production()[directive]).toEqual([value])
  })

  it("does not grant eval in production", () => {
    expect(production()["script-src"]).not.toContain("'unsafe-eval'")
  })

  it("grants eval and the HMR socket only in development", () => {
    expect(development()["script-src"]).toContain("'unsafe-eval'")
    expect(development()["connect-src"]).toContain("ws:")
    expect(production()["connect-src"]).not.toContain("ws:")
  })

  it("admits the Google Maps hosts the address field loads from", () => {
    // The policy used to be `'self' 'unsafe-inline'`, which blocked
    // maps.googleapis.com outright: `window.google` never appeared and the
    // address autocomplete stopped suggesting, in production as well as under
    // test. Asserted in both environments, since a developer hits the same
    // field.
    for (const policy of [production(), development()]) {
      expect(policy["script-src"]).toContain("https://maps.googleapis.com")
      expect(policy["script-src"]).toContain("https://maps.gstatic.com")
    }
  })

  it("still allows the inline script Next.js hydrates from", () => {
    // Stated rather than assumed: this policy does not stop injected inline
    // script. Removing 'unsafe-inline' needs a per-request nonce, which needs
    // middleware, which opts every page out of static rendering.
    expect(production()["script-src"]).toContain("'unsafe-inline'")
  })

  it("lets the Places autocomplete load its script", () => {
    // Neither origin was listed, so `script-src 'self'` refused the loader and
    // the address field offered no suggestions at all — in every production
    // build, not only under test. The browser blocks the tag before the request
    // leaves, which is why the e2e mock of the Google endpoint intercepted
    // nothing and the failure read as "element(s) not found".
    for (const environment of [production(), development()]) {
      expect(environment["script-src"]).toContain("https://maps.googleapis.com")
      expect(environment["script-src"]).toContain("https://maps.gstatic.com")
    }
  })

  it("admits those two hosts and not every Google API", () => {
    // A wildcard would have been shorter and would have granted script to every
    // *.googleapis.com host, none of which this application loads code from.
    expect(production()["script-src"]).not.toContain("https://*.googleapis.com")
  })

  it("leaves connect-src open to https/wss for the per-client Convex backend", () => {
    // headers() is evaluated at build time; the deployment URL is a runtime
    // value that differs per client.
    expect(production()["connect-src"]).toContain("https:")
    expect(production()["connect-src"]).toContain("wss:")
  })

  describe("a Convex backend on this machine", () => {
    // The e2e suite runs a production build against a local Convex backend, so
    // the socket it needs is ws://127.0.0.1 — which a production policy refuses.
    const withConvex = (convexUrl: string) =>
      parse(buildContentSecurityPolicy({ isDevelopment: false, convexUrl }))

    it("admits the loopback origin and its websocket", () => {
      const sources = withConvex("http://127.0.0.1:3310")["connect-src"]
      expect(sources).toContain("http://127.0.0.1:3310")
      expect(sources).toContain("ws://127.0.0.1:3310")
    })

    it("changes nothing for a real deployment", () => {
      expect(withConvex("https://sturdy-lion-42.convex.cloud")["connect-src"]).toEqual(
        production()["connect-src"],
      )
    })

    it("still refuses ws: wholesale", () => {
      // The specific origin is admitted; the scheme is not. A page on a client
      // deployment must not be free to open a socket to any host it likes.
      expect(withConvex("http://localhost:3310")["connect-src"]).not.toContain("ws:")
    })

    it("ignores a value that is not a URL", () => {
      expect(withConvex("not a url")["connect-src"]).toEqual(production()["connect-src"])
    })
  })

  describe("framing", () => {
    // This block replaces an assertion that read
    // `["frame-ancestors", "'none'"]` and sat in the table above. It was green,
    // and it was pinning the defect in place: the CMS preview at
    // `app/preview/[pageSlug]` renders the storefront in a same-origin
    // <iframe>, and `'none'` refuses that frame, so the preview was blank in
    // every environment while the suite stayed green.
    it("admits a same-origin frame, so the CMS preview renders", () => {
      expect(production()["frame-ancestors"]).toEqual(["'self'"])
      expect(development()["frame-ancestors"]).toEqual(["'self'"])
    })

    it("still refuses every other origin", () => {
      // The point of loosening the directive was the preview, not framing in
      // general. Nothing here may become '*', 'https:' or a named third party:
      // clickjacking needs a cross-origin frame and this is what refuses it.
      const sources = production()["frame-ancestors"]
      expect(sources).not.toContain("*")
      expect(sources).not.toContain("https:")
      expect(sources).toHaveLength(1)
    })

    describe("the X-Frame-Options header next.config.ts sends beside it", () => {
      // Where a browser honours both, the header is applied as the stricter of
      // the two — so `DENY` beside `frame-ancestors 'self'` keeps the preview
      // blank and makes the directive above a lie. The header is kept rather
      // than dropped for browsers that never implemented `frame-ancestors`.
      const frameOptions = async (): Promise<Array<[string, string]>> => {
        const config = (await import("../../../next.config")).default
        return (await config.headers!()).flatMap((group) =>
          group.headers
            .filter((header) => header.key.toLowerCase() === "x-frame-options")
            .map((header) => [group.source, header.value] as [string, string]),
        )
      }

      it("says SAMEORIGIN on the pages the CSP covers", async () => {
        const pages = (await frameOptions()).filter(
          ([source]) => !source.startsWith("/api/files"),
        )

        expect(pages).toHaveLength(1)
        expect(pages[0]![1]).toBe("SAMEORIGIN")
      })

      it("keeps DENY on the user-upload proxy", async () => {
        // `/api/files/*` answers with `default-src 'none'; sandbox`, and
        // `default-src` is not a fallback for `frame-ancestors` — this header
        // is the only thing that has ever stopped an uploaded file being
        // framed. Widening it for the preview would have been collateral: the
        // preview frames pages, not the proxy.
        const uploads = (await frameOptions()).filter(([source]) =>
          source.startsWith("/api/files"),
        )

        expect(uploads).toHaveLength(1)
        expect(uploads[0]![1]).toBe("DENY")
      })
    })
  })

  it("emits one well-formed directive per entry", () => {
    const policy = buildContentSecurityPolicy({ isDevelopment: false })
    expect(policy).not.toContain(";;")
    expect(policy.trim().endsWith(";")).toBe(false)
    for (const part of policy.split(";")) {
      expect(part.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2)
    }
  })
})
