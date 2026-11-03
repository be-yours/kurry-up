/**
 * Sentry, browser side.
 *
 * Next runs this file before anything else on the client. It is the modern
 * replacement for `sentry.client.config.ts`, which no longer works under
 * Turbopack — and Next 16 builds with Turbopack.
 *
 * The DSN decides everything: no DSN, no `Sentry.init`, no transport and no
 * bundle cost beyond this file. That is the state of every CI build, of local
 * development and of a client site whose Sentry project has not been created
 * yet. See `apps/docs/deployment/sentry.md`.
 */
import * as Sentry from '@sentry/nextjs'
import { resolveSentryOptions } from '@be-yours/core/sentry'

const options = resolveSentryOptions('browser', {
  // Spelled out one key at a time, and deliberately not `process.env`.
  //
  // Next substitutes a `NEXT_PUBLIC_*` variable only where it can see the
  // literal `process.env.NEXT_PUBLIC_X` in the source it compiles. Handing the
  // whole `process.env` object to a function that lives in another package
  // reads an empty object in the browser: Sentry would resolve to `null` and
  // stay silently off — the exact failure this integration exists to end.
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NODE_ENV: process.env.NODE_ENV,
  // The browser cannot see `VERCEL_ENV`; Vercel exposes this public twin when
  // "Automatically expose System Environment Variables" is on, which is the
  // default. When it is off, set NEXT_PUBLIC_SENTRY_ENVIRONMENT instead, or a
  // client's preview deploys file their errors under `production`.
  VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
})

if (options) {
  Sentry.init(options)
}

/**
 * App Router navigations are client-side, so Next has to tell the SDK when one
 * starts. Without this export the SDK warns at build time and every navigation
 * after the first page load is untraced.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
