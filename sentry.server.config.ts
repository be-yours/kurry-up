/**
 * Sentry, Node runtime. Imported by `instrumentation.ts` when
 * `NEXT_RUNTIME === 'nodejs'`.
 *
 * `process.env` is a real object here, so the resolver reads it directly —
 * unlike the browser, where each key has to be named for Next to inline it.
 */
import * as Sentry from '@sentry/nextjs'
import { resolveSentryOptions } from '@be-yours/core/sentry'

const options = resolveSentryOptions('server')

if (options) {
  Sentry.init(options)
}
