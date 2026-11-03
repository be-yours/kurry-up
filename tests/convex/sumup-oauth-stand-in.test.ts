/**
 * The SumUp connection, end to end against the provider stand-in (`scripts/local-psp.mjs`):
 * authorize, code exchange, an access token that runs out, its refresh, and what happens when a
 * refresh token is used twice.
 *
 * The REAL `convex/lib/sumupToken.ts` runs here, over real HTTP, against the REAL stand-in
 * process; only the Convex row is an in-memory object and the encryption a reversible
 * stand-in. What this does NOT run: the `/connect/sumup/callback` HTTP action and the Convex
 * actions around these functions (they need a deployment), SumUp's own authorize page, and
 * SumUp itself — the stand-in encodes OUR reading of SumUp's OAuth documentation.
 *
 * The stand-in lives in `apps/reference` only; in a delivered site the suite skips.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { resolveSumUpOAuthEndpoints } from '@be-yours/convex-functions/reservationProviders'
import {
  exchangeSumUpCode,
  resolveSumUpAccessToken,
  type SumUpConnectionRow,
  type SumUpTokenDeps,
} from '../../convex/lib/sumupToken'
import { APP_ROOT } from '../lib/repo-layout'

const SCRIPT = join(APP_ROOT, 'scripts', 'local-psp.mjs')
const CLIENT = { clientId: 'standin-sumup-client', clientSecret: 'standin-sumup-secret' }
const REDIRECT = 'http://127.0.0.1:9/connect/sumup/callback'

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

let child: ChildProcess | undefined
let origin = ''
let endpoints = { authorizeUrl: '', tokenUrl: '' }

beforeAll(async () => {
  if (!existsSync(SCRIPT)) return
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, PSP_PORT: String(port), PSP_WEBHOOK_URL: '' },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${origin}/_control/health`)).ok) break
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // The same helper the Convex actions use, with the same two variables a bench sets.
  endpoints = resolveSumUpOAuthEndpoints({
    RESERVATION_PSP_STAND_IN: 'true',
    RESERVATION_PSP_SUMUP_OAUTH_BASE_URL: `${origin}/sumup-oauth`,
  })
}, 30_000)

afterAll(() => {
  child?.kill()
})

const control = (path: string, body?: unknown) =>
  fetch(`${origin}/_control${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>)

/** Authorize as the owner's browser would, and read the redirect back to the callback. */
async function authorize(state: string): Promise<URL> {
  const url = new URL(endpoints.authorizeUrl)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    scope: 'payments user.app-settings',
    state,
  }).toString()
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(303)
  return new URL(res.headers.get('location')!)
}

const enc = (plain: string) => `enc(${plain})`
const dec = (cipher: string) => cipher.replace(/^enc\((.*)\)$/, '$1')

function connection(initial: SumUpConnectionRow | null = null) {
  let row = initial
  const deps: SumUpTokenDeps = {
    now: () => Date.now(),
    sleep: async () => {},
    fetch,
    tokenUrl: endpoints.tokenUrl,
    clientCredentials: () => CLIENT,
    encrypt: async (p) => enc(p),
    decrypt: async (c) => dec(c),
    readConnection: async () => (row ? { ...row } : null),
    writeConnection: async (write) => {
      row = { ...write }
    },
  }
  return { deps, row: () => row }
}

async function connect(expiresIn: number) {
  await control('/scenario', { sumupOauth: { expiresIn } })
  const back = await authorize('state-1')
  expect(back.origin + back.pathname).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe('state-1')
  const store = connection()
  const exchanged = await exchangeSumUpCode(store.deps, {
    code: back.searchParams.get('code')!,
    redirectUri: REDIRECT,
    ...CLIENT,
  })
  await store.deps.writeConnection(exchanged)
  return store
}

describe.skipIf(!existsSync(SCRIPT))('SumUp OAuth against the provider stand-in', () => {
  test('connect: authorize, redirect with code and state, exchange, row connected', async () => {
    await control('/reset', {})
    const store = await connect(3600)
    const row = store.row()!
    expect(row.status).toBe('connected')
    expect(row.merchantId).toBe('MSTANDIN1')
    expect(row.tokenExpiresAt! - Date.now()).toBeGreaterThan(3500 * 1000)
    expect(row.encryptedRefreshToken).toMatch(/^enc\(standin_sur_/)

    // The token works on the payment API (an unknown checkout is 404, never 401).
    const { accessToken } = await resolveSumUpAccessToken(store.deps)
    const res = await fetch(`${origin}/sumup/v0.1/checkouts/none`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(404)
    expect((await control('/state')).violations).toEqual([])
  })

  test('a code is single-use', async () => {
    await control('/reset', {})
    const back = await authorize('s')
    const code = back.searchParams.get('code')!
    const exchange = () =>
      fetch(endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          ...{ client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret },
        }),
      })
    expect((await exchange()).status).toBe(200)
    const second = await exchange()
    expect(second.status).toBe(400)
    expect(((await second.json()) as { error: string }).error).toBe('invalid_grant')
  })

  test('refresh: a token inside the margin is refreshed once, the pair rotates and the new token works', async () => {
    await control('/reset', {})
    const store = await connect(120) // 2 minutes: inside the five-minute margin at once
    const before = store.row()!

    const { accessToken } = await resolveSumUpAccessToken(store.deps)
    const after = store.row()!
    const state = await control('/state')

    const grants = state.sumupOauth.grants as Array<{ grant: string }>
    expect(grants.map((g) => g.grant)).toEqual(['authorization_code', 'refresh_token'])
    expect(after.encryptedAccessToken).not.toBe(before.encryptedAccessToken)
    expect(after.encryptedRefreshToken).not.toBe(before.encryptedRefreshToken)
    expect(after.status).toBe('connected')
    expect(after.tokenExpiresAt).toBeGreaterThan(Date.now())
    expect(dec(after.encryptedAccessToken!)).toBe(accessToken)

    const res = await fetch(`${origin}/sumup/v0.1/checkouts/none`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(404)
    expect(state.violations).toEqual([])
  })

  test('a refresh token used twice is refused with invalid_grant, and the connection is marked', async () => {
    await control('/reset', {})
    const store = await connect(120)
    const spent = store.row()!.encryptedRefreshToken!

    await resolveSumUpAccessToken(store.deps) // spends it and stores the next pair

    // A connection still holding the spent token (what a lost race, or a restored backup, is).
    const stale = connection({
      ...store.row()!,
      encryptedRefreshToken: spent,
      tokenExpiresAt: Date.now() + 1000,
    })
    await expect(resolveSumUpAccessToken(stale.deps)).rejects.toThrow('SumUp is not connected')
    expect(stale.row()!.status).toBe('error')
  })

  test('an access token that ran out is refused by the payment API, and that is a recorded violation', async () => {
    await control('/reset', {})
    const store = await connect(1)
    const { encryptedAccessToken } = store.row()!
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const res = await fetch(`${origin}/sumup/v0.1/checkouts/none`, {
      headers: { Authorization: `Bearer ${dec(encryptedAccessToken!)}` },
    })
    expect(res.status).toBe(401)
    const state = await control('/state')
    expect(state.violations.map((v: { message: string }) => v.message)).toEqual([
      'expired OAuth access token sent to the payment API',
    ])

    // And refreshing first, as the product does, gives a token it accepts.
    const { accessToken } = await resolveSumUpAccessToken(store.deps)
    const ok = await fetch(`${origin}/sumup/v0.1/checkouts/none`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(ok.status).toBe(404)
  })

  test('the stand-in refuses wrong client credentials and an authorize without response_type=code', async () => {
    await control('/reset', {})
    const badSecret = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_id: CLIENT.clientId,
        client_secret: 'wrong',
      }),
    })
    expect(badSecret.status).toBe(401)
    const noType = await fetch(`${endpoints.authorizeUrl}?client_id=${CLIENT.clientId}`, {
      redirect: 'manual',
    })
    expect(noType.status).toBe(400)
  })
})
