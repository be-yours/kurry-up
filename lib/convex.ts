/* eslint-disable @typescript-eslint/no-explicit-any */
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

/**
 * Development origins, trusted only outside a production build.
 *
 * They used to be unconditional, and `http://localhost:3000` was also the
 * FALLBACK for an unset `BETTER_AUTH_URL` — so a delivered restaurant site
 * accepted auth callbacks addressed to a developer's machine, on its own
 * domain, forever. Next sets `NODE_ENV` to "production" in a built app and
 * "development" under `next dev`, which is exactly the line this needs to
 * fall on: convenience for us, nothing extra at the restaurant.
 */
const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];

/** The origins this deployment was configured with, in order of precedence. */
function trustedOrigins(): string[] {
  const configured = [process.env.BETTER_AUTH_URL, process.env.SITE_URL].filter(
    (origin): origin is string => Boolean(origin),
  );
  return process.env.NODE_ENV === "production"
    ? configured
    : [...configured, ...DEV_ORIGINS];
}

// Lazy singleton to avoid throwing during Next.js build
// when CONVEX_SITE_URL is not available in the build environment.
let _auth: any;
function auth() {
  if (!_auth) {
    _auth = convexBetterAuthNextJs({
      convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
      convexSiteUrl: process.env.CONVEX_SITE_URL!,
      trustedOrigins: trustedOrigins(),
    } as any);
  }
  return _auth;
}

export const handler = {
  GET: (request: Request) => auth().handler.GET(request),
  POST: (request: Request) => auth().handler.POST(request),
};
export const getToken = (...args: any[]) => auth().getToken(...args);
export const isAuthenticated = (...args: any[]) => auth().isAuthenticated(...args);
export const preloadAuthQuery = (...args: any[]) => auth().preloadAuthQuery(...args);
export const fetchAuthQuery = (...args: any[]) => auth().fetchAuthQuery(...args);
export const fetchAuthMutation = (...args: any[]) => auth().fetchAuthMutation(...args);
export const fetchAuthAction = (...args: any[]) => auth().fetchAuthAction(...args);
