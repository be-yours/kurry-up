/**
 * Sentry, edge runtime. Imported by `instrumentation.ts` when
 * `NEXT_RUNTIME === 'edge'`.
 *
 * Separate from the Node config because the edge runtime gets its own build of
 * the SDK — one `Sentry.init` cannot serve both.
 */
import * as Sentry from '@sentry/nextjs'
import { resolveSentryOptions } from '@be-yours/core/sentry'

const options = resolveSentryOptions('edge')

if (options) {
  Sentry.init(options)
}
