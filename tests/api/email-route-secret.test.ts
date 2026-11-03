/**
 * `POST /api/email/send` authenticates with the secret a fresh site has.
 *
 * WHAT WENT WRONG. `.env.example` ships `EMAIL_API_SECRET=` as a bare line, and
 * the setup wizard copies it into `.env.local` as it stands: set, and empty. The
 * route read `process.env.EMAIL_API_SECRET ?? process.env.BETTER_AUTH_SECRET`,
 * and `??` keeps an empty string, so the route authenticated against `""`, found
 * it shorter than 32 bytes and refused every request with « Email route not
 * configured » — on a site whose `BETTER_AUTH_SECRET` was set and fine. No
 * verification mail, no password reset, no « votre commande est prête »; the
 * only trace was a 503 in a log nobody was watching. Found by creating a
 * restaurant from scratch: removing the one blank line was enough for the next
 * error to be AWS's.
 *
 * The route and `convex/auth.ts` are two halves of one handshake in two
 * runtimes (the Convex action presents the secret, the route checks it), so the
 * second half of this file holds that they read it THE SAME WAY: a fix to one
 * alone is how a deployment ends up presenting what the other refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BETTER_AUTH_SECRET = 'better-auth-secret-0123456789abcdef-0123456789'
const DEDICATED_SECRET = 'dedicated-email-secret-0123456789abcdef-012345'

/**
 * The route, imported fresh: the secret is read when the module is evaluated,
 * so each case has to set its environment first and import after.
 */
async function loadRoute(env: Record<string, string | undefined>) {
  vi.resetModules()
  // `undefined` removes the variable, which is « not set at all »; `""` is the
  // blank line the wizard leaves. Two different states, and the second is the
  // one that broke.
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return import('@/app/api/email/send/route')
}

/** A well-authenticated request whose BODY is refused — so only the gate is on trial. */
const withBearer = (token: string) =>
  new Request('https://chez-mario.test/api/email/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'not-a-mail-type' }),
  })

beforeEach(() => {
  vi.stubEnv('SITE_URL', 'https://chez-mario.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("the route's gate", () => {
  it('accepts BETTER_AUTH_SECRET when EMAIL_API_SECRET is a blank line, as the wizard leaves it', async () => {
    const { POST } = await loadRoute({
      EMAIL_API_SECRET: '',
      BETTER_AUTH_SECRET,
    })

    const response = await POST(withBearer(BETTER_AUTH_SECRET))

    // 400: past the gate, refused for the body. 503 is « Email route not
    // configured » — the defect — and 401 would mean the secret was not honoured.
    expect(response.status).toBe(400)
  })

  it('accepts BETTER_AUTH_SECRET when EMAIL_API_SECRET is not set at all', async () => {
    const { POST } = await loadRoute({ EMAIL_API_SECRET: undefined, BETTER_AUTH_SECRET })

    expect((await POST(withBearer(BETTER_AUTH_SECRET))).status).toBe(400)
  })

  it('prefers the dedicated secret once it is set, and then refuses the fallback', async () => {
    const { POST } = await loadRoute({
      EMAIL_API_SECRET: DEDICATED_SECRET,
      BETTER_AUTH_SECRET,
    })

    expect((await POST(withBearer(DEDICATED_SECRET))).status).toBe(400)
    expect((await POST(withBearer(BETTER_AUTH_SECRET))).status).toBe(401)
  })

  it('still refuses every request when there is no secret anywhere', async () => {
    const { POST } = await loadRoute({ EMAIL_API_SECRET: '', BETTER_AUTH_SECRET: '' })

    expect((await POST(withBearer('anything'))).status).toBe(503)
  })
})

describe('the two halves of the handshake', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', '..', file), 'utf8')

  /** The expression each half resolves the secret with, comments removed. */
  const resolution = (source: string): string => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const found = code.match(
      /process\.env\.EMAIL_API_SECRET\s*(\?\?|\|\|)\s*process\.env\.BETTER_AUTH_SECRET/,
    )
    if (!found) throw new Error('no EMAIL_API_SECRET resolution found')
    return found[1]
  }

  it('the route and the Convex action both treat a blank secret as unset', () => {
    expect(resolution(read('app/api/email/send/route.ts'))).toBe('||')
    expect(resolution(read('convex/auth.ts'))).toBe('||')
  })
})
