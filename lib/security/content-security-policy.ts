/**
 * The application's Content-Security-Policy.
 *
 * There was none. The header block next to it set five other security headers,
 * so the omission read like a decision rather than a gap.
 *
 * What this policy is, and is not
 * -------------------------------
 * `script-src` still carries `'unsafe-inline'`. Next.js bootstraps hydration
 * from inline `<script>` tags, and the alternative — a per-request nonce — has
 * to be minted in middleware, which opts every page out of static rendering.
 * That is a rendering-architecture decision, not a security fix, and it is not
 * made here.
 *
 * So this policy does not stop injected inline script. What it does stop is
 * cheap and worth having: `<base>` hijacking, plugin and object embedding,
 * framing by another site, and forms that post somewhere else.
 *
 * It is deliberately not the control that closes the stored-XSS report. That
 * one is `buildFileResponseHeaders` in `lib/services/file-serving.ts`, which
 * puts `default-src 'none'; sandbox` on every proxied upload — a strict policy,
 * on the only responses whose bodies a user supplied, needing no nonce.
 */

/**
 * Directives whose values do not change between environments.
 *
 * `connect-src` stays open to `https:`/`wss:`: the Convex deployment URL is a
 * per-client runtime value, and `headers()` is evaluated at build time, so
 * pinning it here would bake one client's backend into another client's build.
 */
const BASE_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  // Blocks a <base> tag redirecting every relative URL on the page.
  "base-uri": ["'self'"],
  // No <object>/<embed>: legacy plugin content is a scripting surface.
  "object-src": ["'none'"],
  // Same-origin framing only.
  //
  // This was `'none'`, which is the right default for a storefront and the
  // wrong one for this application: the CMS preview at `app/preview/[pageSlug]`
  // renders the storefront in an `<iframe>` on this very origin, and `'none'`
  // refuses that too. The frame was blank in every environment, which is not a
  // rendering bug anyone could find by reading the preview component.
  //
  // `'self'` is the narrowest value that lets the preview render. Another site
  // still cannot frame this one, which is the whole point of the directive —
  // clickjacking needs a cross-origin frame, and that is still refused.
  //
  // The `X-Frame-Options` header set beside this one in `next.config.ts` must
  // agree: it says `SAMEORIGIN`, not `DENY`. A browser that honours both takes
  // the header as the stricter of the two, so `DENY` there would have kept the
  // frame blank however permissive this directive is.
  "frame-ancestors": ["'self'"],
  // An injected form cannot post the page's fields to another origin.
  "form-action": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:"],
  "media-src": ["'self'", "blob:", "https:"],
  "frame-src": ["'self'", "https:"],
  "worker-src": ["'self'", "blob:"],
  "manifest-src": ["'self'"],
}

/**
 * The Convex origin, but only when it is a loopback address.
 *
 * `connect-src` is open to `https:`/`wss:`, which covers every real deployment.
 * It does not cover a Convex backend running on the machine itself, because
 * that one is plain `http:`/`ws:` — and a production build refuses `ws:`, by
 * design and by test. The end-to-end suite runs `pnpm start` against exactly
 * such a backend, so without this every Convex query in the browser is blocked
 * and every admin screen sits on a loading skeleton forever.
 *
 * Only loopback hosts are admitted, so this cannot widen a deployed policy: a
 * client's `NEXT_PUBLIC_CONVEX_URL` is an `https://…convex.cloud` address and
 * returns nothing here. Granting a page the right to talk to 127.0.0.1 also
 * grants nothing to a remote attacker.
 */
function loopbackConvexSources(convexUrl?: string): string[] {
  if (!convexUrl) return []
  let url: URL
  try {
    url = new URL(convexUrl)
  } catch {
    return []
  }
  const host = url.hostname
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  if (!isLoopback) return []
  const socket = url.protocol === "https:" ? "wss:" : "ws:"
  return [url.origin, `${socket}//${url.host}`]
}

/**
 * Where the Places autocomplete loads its code from.
 *
 * `useGooglePlacesAutocomplete` appends a `<script>` for
 * `maps.googleapis.com/maps/api/js`, and that loader then fetches its own
 * chunks from `maps.gstatic.com`. Neither was listed, so `script-src 'self'`
 * refused both and the address field silently offered no suggestions — in every
 * production build, not only under test. The browser blocks the tag before the
 * request leaves, which is why the e2e suite's mock of the Google endpoint
 * never intercepted anything and read as "element(s) not found".
 *
 * Two origins and no wildcard: `*.googleapis.com` would also admit every other
 * Google API host, which this application does not load script from.
 *
 * Nothing else needs widening. `img-src` already allows `https:` for the
 * dropdown's sprites, `style-src` carries `'unsafe-inline'` for the styles the
 * widget injects, and `connect-src` allows `https:` for its own requests.
 */
const GOOGLE_MAPS_SCRIPT_SOURCES = [
  "https://maps.googleapis.com",
  "https://maps.gstatic.com",
]

export function buildContentSecurityPolicy(options: {
  isDevelopment: boolean
  /** `NEXT_PUBLIC_CONVEX_URL`. Only used when it names a loopback backend. */
  convexUrl?: string
}): string {
  const directives: Record<string, string[]> = {
    ...BASE_DIRECTIVES,
    // 'unsafe-eval' is the dev server's: React Refresh and the Turbopack
    // runtime evaluate modules. A production build does not, so it is not
    // granted there.
    "script-src": options.isDevelopment
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...GOOGLE_MAPS_SCRIPT_SOURCES]
      : ["'self'", "'unsafe-inline'", ...GOOGLE_MAPS_SCRIPT_SOURCES],
    // ws: is the HMR socket.
    "connect-src": [
      ...(options.isDevelopment
        ? ["'self'", "https:", "wss:", "ws:"]
        : ["'self'", "https:", "wss:"]),
      ...loopbackConvexSources(options.convexUrl),
    ],
  }

  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ")
}
