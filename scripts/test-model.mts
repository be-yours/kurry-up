/**
 * Builds (or repairs) the shared test model on ONE deployment.
 *
 * Creates the sign-in accounts through Better Auth, then runs
 * `seedTestModel:internalSeedTestModel`, which gives each account its profile
 * and its restaurants and fills the three restaurants with a catalogue, orders,
 * kitchen tickets, promotions and a game. Safe to run again.
 *
 * Prerequisites, in this order:
 *   1. The Next.js site is reachable at BETTER_AUTH_URL (local `pnpm start`, or
 *      the hosted test site). Accounts are created through ITS auth route.
 *   2. The Convex deployment has `AUTH_ALLOW_UNVERIFIED_EMAIL=true`,
 *      `SITE_URL=<BETTER_AUTH_URL>` and `TEST_MODEL_ENABLED=true`
 *      (`npx convex env set …`). The seed refuses without the last one.
 *   3. This shell can reach the deployment: `NEXT_PUBLIC_CONVEX_URL` plus either
 *      `CONVEX_DEPLOY_KEY` (cloud) or `CONVEX_SELF_HOSTED_URL` and
 *      `CONVEX_SELF_HOSTED_ADMIN_KEY` (local backend).
 *
 * Password: `TEST_MODEL_PASSWORD`, or generated on the first run and kept in
 * `.env.test-model` (git-ignored). Better Auth cannot reset a password from
 * here, so keep that file or the accounts are only reachable by e-mail reset.
 *
 * Usage:
 *   cd apps/themes
 *   pnpm test-model
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadEnvFiles } from '../e2e/load-env.js'
import { TEST_MODEL_ACCOUNTS, TEST_MODEL_STORE_SLUGS } from '../convex/lib/testModelRoster.js'

const run = promisify(execFile)

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PASSWORD_FILE = resolve(appRoot, '.env.test-model')
loadEnvFiles(appRoot, ['.env.test-model', '.env.local'])

const BASE_URL = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? ''
const MIN_PASSWORD_LENGTH = 12

if (!CONVEX_URL) {
  console.error('NEXT_PUBLIC_CONVEX_URL is required (.env.local or the shell). Aborting.')
  process.exit(1)
}

/** Reuse the stored password, or mint one and write it BEFORE any account exists. */
function resolvePassword(): string {
  const fromEnv = process.env.TEST_MODEL_PASSWORD
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSWORD_LENGTH) {
      console.error(
        `TEST_MODEL_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters ` +
          `(convex/auth.ts, minPasswordLength). Aborting.`,
      )
      process.exit(1)
    }
    return fromEnv
  }
  const generated = randomBytes(18).toString('base64url')
  const line = `TEST_MODEL_PASSWORD=${generated}\n`
  if (existsSync(PASSWORD_FILE)) appendFileSync(PASSWORD_FILE, line)
  else writeFileSync(PASSWORD_FILE, line, { mode: 0o600 })
  console.log(`Generated a password and saved it to ${PASSWORD_FILE}\n`)
  return generated
}

const PASSWORD = resolvePassword()

// Better Auth refuses a state-changing request with no Origin; Node's fetch
// sends none. The value must be in the deployment's `trustedOrigins` (SITE_URL).
const AUTH_HEADERS = { 'Content-Type': 'application/json', Origin: BASE_URL } as const

interface AuthUser {
  id: string
}

async function authCall(path: string, body: Record<string, string>): Promise<AuthUser | string> {
  const res = await fetch(`${BASE_URL}/api/auth/${path}`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id?: string }
    id?: string
    code?: string
    message?: string
  }
  const id = data.user?.id ?? data.id
  if (res.ok && id) return { id }
  return data.code ?? data.message ?? `HTTP ${res.status}`
}

async function ensureAccount(email: string, name: string): Promise<AuthUser | string> {
  const created = await authCall('sign-up/email', { name, email, password: PASSWORD })
  if (typeof created !== 'string') return created
  // Already there (a previous run) or refused: signing in tells which.
  const opened = await authCall('sign-in/email', { email, password: PASSWORD })
  if (typeof opened !== 'string') return opened
  if (opened === 'EMAIL_NOT_VERIFIED') {
    return (
      'EMAIL_NOT_VERIFIED: set AUTH_ALLOW_UNVERIFIED_EMAIL=true on the Convex ' +
      'deployment (npx convex env set). Test deployment only.'
    )
  }
  return `${created} / ${opened}`
}

async function main() {
  console.log('=== BeYours test model ===\n')
  console.log(`Site (Better Auth): ${BASE_URL}`)
  console.log(`Convex:             ${CONVEX_URL}\n`)

  console.log('Step 1: accounts\n')
  const userIds: Record<string, string> = {}
  let failed = 0

  for (const account of TEST_MODEL_ACCOUNTS) {
    const result = await ensureAccount(account.email, account.name)
    if (typeof result === 'string') {
      failed += 1
      console.error(`  [ERR] ${account.email}: ${result}`)
    } else {
      userIds[account.email] = result.id
      console.log(`  [OK]  ${account.email}`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  if (failed > 0) {
    console.error(`\n${failed}/${TEST_MODEL_ACCOUNTS.length} accounts failed. Nothing seeded.`)
    process.exitCode = 1
    return
  }

  console.log('\nStep 2: restaurants, catalogue, orders, promotions, game\n')
  try {
    const { stdout } = await run(
      'npx',
      ['convex', 'run', 'seedTestModel:internalSeedTestModel', JSON.stringify({ userIds })],
      { cwd: appRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 },
    )
    console.log(stdout.trim())
  } catch (err: unknown) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : String(err)
    console.error(`  [ERR] seed failed:\n${stderr.trim()}`)
    process.exitCode = 1
    return
  }

  console.log('\n=== Test model ready ===\n')
  console.log(`Password (all accounts): ${PASSWORD}\n`)
  console.log(`${'Email'.padEnd(30)} ${'Role'.padEnd(13)} Purpose`)
  console.log('-'.repeat(100))
  for (const account of TEST_MODEL_ACCOUNTS) {
    console.log(`${account.email.padEnd(30)} ${account.role.padEnd(13)} ${account.purpose}`)
  }
  console.log(`\nRestaurants: ${TEST_MODEL_STORE_SLUGS.join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
