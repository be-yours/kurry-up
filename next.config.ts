// PATCH BOILERPLATE vs engine:
//  1. transpilePackages extended — the @be-yours/* packages are installed
//     from GitHub Packages as TypeScript source (not as workspace packages),
//     so Next has to transpile them explicitly.
//  2. images.remotePatterns driven by site.config.ts (client zone).
import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { siteConfig } from "./site.config";
import { buildContentSecurityPolicy } from "./lib/security/content-security-policy";
import { withSentryConfig } from "@sentry/nextjs";

const contentSecurityPolicy = buildContentSecurityPolicy({
  isDevelopment: process.env.NODE_ENV !== "production",
  // Only has an effect when it names a loopback backend — the e2e suite's.
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
});

/**
 * The S3 bucket is private, so its hostname is never in `remotePatterns`:
 * uploaded media is served same-origin by `/api/files`. A site that puts a CDN
 * in front of the bucket declares it once, in `AWS_S3_PUBLIC_BASE_URL`.
 * See `apps/docs/deployment/s3-bucket-policy.md`.
 */
function cdnPattern() {
  const base = process.env.AWS_S3_PUBLIC_BASE_URL?.trim();
  if (!base) return [];

  try {
    const { protocol, hostname } = new URL(base);
    return [{ protocol: protocol.replace(":", "") as "http" | "https", hostname }];
  } catch {
    throw new Error(
      `AWS_S3_PUBLIC_BASE_URL is not a valid URL: ${base}. ` +
        "Expected the CDN origin, e.g. https://cdn.example.com",
    );
  }
}

// engine-link mode (pnpm engine:link): the @be-yours/* packages are
// symlinks to a local clone outside the project. Turbopack rejects files
// outside the root — so we widen the tracing root to the common ancestor
// computed by scripts/engine-link.js. Without the marker file (normal
// registry mode, prod, CI), this block is inert.
const engineLinkMarker = join(__dirname, ".engine-link.json");
const engineLink = existsSync(engineLinkMarker)
  ? (JSON.parse(readFileSync(engineLinkMarker, "utf8")) as {
      tracingRoot: string;
    })
  : null;

const nextConfig: NextConfig = {
  ...(engineLink ? { outputFileTracingRoot: engineLink.tracingRoot } : {}),
  // App TypeScript errors fail the build (production safety). Convex backend
  // files are type-checked separately (`npx convex deploy`) and are already
  // excluded from this app's tsconfig (`exclude: ["convex"]`), so they are not
  // part of the Next.js build regardless of this flag.
  typescript: {
    ignoreBuildErrors: false,
  },
  transpilePackages: [
    "@be-yours/admin",
    "@be-yours/cms",
    "@be-yours/convex-functions",
    "@be-yours/convex-schema",
    "@be-yours/core",
    "@be-yours/integrations",
    "@be-yours/marketing",
    "@be-yours/restaurant",
    "@be-yours/ui",
    "@convex-dev/better-auth",
  ],
  async headers() {
    return [
      // /api/files serves user-supplied bytes and answers with its own, far
      // stricter policy (`default-src 'none'; sandbox`). It is excluded here so
      // that policy is the only one on those responses.
      {
        source: '/((?!api/files/).*)',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          // SAMEORIGIN, not DENY. The CMS preview renders the storefront in an
          // <iframe> on this same origin, and DENY refuses a same-origin frame
          // as flatly as a cross-origin one — the preview was blank everywhere.
          // Widening `frame-ancestors` alone would not have fixed it: where a
          // browser honours both, this header is applied as the stricter of the
          // two, so DENY here would have overridden the CSP beside it. The two
          // now say the same thing. Dropping the header was the alternative; it
          // is kept for the browsers that never implemented `frame-ancestors`,
          // which would otherwise have no framing protection at all.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      // The one route that stays at DENY.
      //
      // `/api/files/*` proxies bytes a user uploaded. Its own policy
      // (`default-src 'none'; sandbox`, in `lib/services/file-serving.ts`) is
      // strict, but `default-src` is not a fallback for `frame-ancestors` —
      // this header is the only thing that has ever stopped those responses
      // being framed. The preview frames pages, never the file proxy, so
      // nothing needs it loosened here.
      {
        source: '/api/files/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  images: {
    // AVIF first, WebP behind it. A menu page carries a dozen dish photographs
    // and they are the whole payload; AVIF is roughly half the bytes of the
    // JPEG an owner uploads from a phone, and a browser that cannot read it
    // is served the WebP instead.
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      ...siteConfig.images.remoteHosts.map((hostname) => ({
        protocol: "https" as const,
        hostname,
      })),
      ...cdnPattern(),
    ],
  },
};

/**
 * Sentry wraps the config even when this deployment has no Sentry project.
 *
 * The wrapper is what instruments the server build and injects the release
 * into the client bundle; `Sentry.init` alone does not. With no DSN nothing is
 * sent anyway, so the cost of leaving it on is a slightly longer build — and
 * the benefit is that a client who fills in their DSN gets a working setup
 * without editing this file.
 *
 * Source-map upload is the part that needs credentials, and it is switched off
 * unless all three are present. Without them a build would otherwise emit maps
 * it cannot upload and warn about it on every CI run.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  sourcemaps: {
    disable: !(
      process.env.SENTRY_ORG &&
      process.env.SENTRY_PROJECT &&
      process.env.SENTRY_AUTH_TOKEN
    ),
  },

  // Client chunks are code-split; without this the maps for a lazily loaded
  // route are left behind and its stack traces stay minified.
  widenClientFileUpload: true,

  // Nothing about this repo leaves the build host unless a client opts in.
  telemetry: false,
  // The plugin is chatty on every build; keep it to CI, where a failed upload
  // is worth reading.
  silent: !process.env.CI,

  // `disableLogger` is deliberately absent. The SDK deprecates it in favour of
  // `webpack.treeshake.removeDebugLogging`, and Next 16 builds with Turbopack,
  // where no `webpack.*` option applies — so setting either one only prints a
  // deprecation notice on every build of every client site, and shakes nothing.
});
