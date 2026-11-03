import * as Sentry from '@sentry/nextjs'

export async function register() {
  // Sentry before the env check, not after: when a deployment refuses to boot
  // for a missing variable, the throw below is exactly the event the client
  // needs to see in their project.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }

  // Skip validation during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { validateAllEnv, formatEnvReport } = await import(
    '@be-yours/core/env'
  )

  const { ok, missing } = validateAllEnv()

  if (ok) {
    console.log('[env] All environment variables validated successfully')
    return
  }

  const report = formatEnvReport(missing)
  console.error(report)

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[env] ${missing.length} environment variable(s) missing or invalid. See report above.`
    )
  }
}

/**
 * Next hands every server-side request error to this hook — a failing server
 * component, route handler or server action. Without it those errors reach the
 * platform log and Sentry not at all, which is most of what actually breaks in
 * production.
 */
export const onRequestError = Sentry.captureRequestError
