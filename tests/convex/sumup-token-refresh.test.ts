/**
 * SumUp's access token expires and used to be used regardless: every charge, refund and
 * reservation deposit then failed with a 401 until the owner reconnected. These are the rules
 * `convex/lib/sumupToken.ts` now holds, driven with an in-memory connection row, a fake clock,
 * a fake provider and a reversible stand-in for the encryption.
 */

import { describe, expect, test } from 'vitest'
import {
  SUMUP_REFRESH_MARGIN_MS,
  exchangeSumUpCode,
  resolveSumUpAccessToken,
  type SumUpConnectionRow,
  type SumUpConnectionWrite,
  type SumUpTokenDeps,
} from '../../convex/lib/sumupToken'

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const MIN = 60_000
const TOKEN_URL = 'https://oauth.test/token'

const enc = (plain: string) => `enc(${plain})`
const dec = (cipher: string) => cipher.replace(/^enc\((.*)\)$/, '$1')

type Reply = { status?: number; body?: unknown; throws?: boolean; gate?: Promise<void> }

function harness(initial: SumUpConnectionRow | null, replies: Reply[] = []) {
  let row = initial ? { ...initial } : null
  const calls: Array<{ url: string; form: URLSearchParams }> = []
  const writes: SumUpConnectionWrite[] = []
  let clock = NOW
  const queue = [...replies]

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init?.body ?? '')) })
    const reply = queue.shift() ?? { status: 500 }
    if (reply.gate) await reply.gate
    if (reply.throws) throw new Error('network down')
    const status = reply.status ?? 200
    return new Response(JSON.stringify(reply.body ?? {}), { status })
  }) as unknown as typeof fetch

  let credentials: { clientId: string; clientSecret: string } | null = {
    clientId: 'client-1',
    clientSecret: 'secret-1',
  }

  const deps: SumUpTokenDeps = {
    now: () => clock,
    sleep: async () => {},
    fetch: fakeFetch,
    tokenUrl: TOKEN_URL,
    clientCredentials: () => credentials,
    encrypt: async (p) => enc(p),
    decrypt: async (c) => dec(c),
    readConnection: async () => (row ? { ...row } : null),
    writeConnection: async (write) => {
      writes.push(write)
      row = { ...write }
    },
  }
  return {
    deps,
    calls,
    writes,
    row: () => row,
    setRow: (next: SumUpConnectionRow) => (row = next),
    advance: (ms: number) => (clock += ms),
    noCredentials: () => (credentials = null),
  }
}

const connected = (over: Partial<SumUpConnectionRow> = {}): SumUpConnectionRow => ({
  merchantId: 'MC1',
  status: 'connected',
  encryptedAccessToken: enc('access-old'),
  encryptedRefreshToken: enc('refresh-old'),
  tokenExpiresAt: NOW + 60 * MIN,
  ...over,
})

describe('a token that is not about to expire', () => {
  test('is returned without any call to SumUp', async () => {
    const h = harness(connected())
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toEqual({
      accessToken: 'access-old',
      merchantCode: 'MC1',
    })
    expect(h.calls).toEqual([])
    expect(h.writes).toEqual([])
  })

  test('is still returned untouched one millisecond outside the margin', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + SUMUP_REFRESH_MARGIN_MS }))
    await resolveSumUpAccessToken(h.deps)
    expect(h.calls).toEqual([])
  })

  test('a connection with no expiry (an API-key style token) is never refreshed', async () => {
    const h = harness(connected({ tokenExpiresAt: undefined, encryptedRefreshToken: undefined }))
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-old',
    })
    h.advance(10 * 365 * 24 * 60 * MIN)
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-old',
    })
    expect(h.calls).toEqual([])
    expect(h.writes).toEqual([])
  })
})

describe('a missing or unusable connection', () => {
  test.each([
    ['no row', null],
    ['a row that is not connected', connected({ status: 'onboarding_complete' })],
    ['a row in error', connected({ status: 'error' })],
  ])('%s keeps the « SumUp is not connected » sentence', async (_label, row) => {
    const h = harness(row)
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.calls).toEqual([])
  })

  test('a row with no access token says so', async () => {
    const h = harness(connected({ encryptedAccessToken: undefined }))
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp access token is missing')
  })
})

describe('a token inside the five-minute margin', () => {
  const fresh = {
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    expires_in: 3600,
    merchant_code: 'MC1',
  }

  test('is refreshed once, with the documented request, and the new pair is stored encrypted', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + 4 * MIN }), [{ body: fresh }])
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toEqual({
      accessToken: 'access-new',
      merchantCode: 'MC1',
    })

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toBe(TOKEN_URL)
    expect(Object.fromEntries(h.calls[0]!.form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: 'client-1',
      client_secret: 'secret-1',
    })
    expect(h.writes).toEqual([
      {
        merchantId: 'MC1',
        encryptedAccessToken: 'enc(access-new)',
        encryptedRefreshToken: 'enc(refresh-new)',
        tokenExpiresAt: NOW + 3600 * 1000,
        status: 'connected',
      },
    ])
    // Nothing readable is persisted.
    expect(JSON.stringify(h.writes)).not.toMatch(/"access-new"|"refresh-new"/)
  })

  test('the next call, once the new token is stored, makes no second call', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + 4 * MIN }), [{ body: fresh }])
    await resolveSumUpAccessToken(h.deps)
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-new',
    })
    expect(h.calls).toHaveLength(1)
  })

  test('is refreshed when it has already expired', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW - 10 * MIN }), [{ body: fresh }])
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-new',
    })
    expect(h.calls).toHaveLength(1)
  })

  test('keeps the old refresh token and merchant when the answer carries neither', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      { body: { access_token: 'access-new', expires_in: 1800 } },
    ])
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toEqual({
      accessToken: 'access-new',
      merchantCode: 'MC1',
    })
    expect(h.writes[0]).toMatchObject({
      merchantId: 'MC1',
      encryptedRefreshToken: 'enc(refresh-old)',
      tokenExpiresAt: NOW + 1800 * 1000,
    })
  })

  test('takes the merchant code SumUp answers when there is one', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      { body: { ...fresh, merchant_code: 'MC2' } },
    ])
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({ merchantCode: 'MC2' })
    expect(h.writes[0]!.merchantId).toBe('MC2')
  })
})

describe('a refresh SumUp refuses', () => {
  test.each([400, 401])(
    'a %i marks the connection in error, keeps its tokens, and throws the not-connected sentence',
    async (status) => {
      const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
        { status, body: { error: 'invalid_grant' } },
      ])
      await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
      expect(h.writes).toEqual([
        {
          merchantId: 'MC1',
          encryptedAccessToken: 'enc(access-old)',
          encryptedRefreshToken: 'enc(refresh-old)',
          tokenExpiresAt: NOW + MIN,
          status: 'error',
        },
      ])
      // Once marked, the next caller is refused without another call to SumUp.
      await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
      expect(h.calls).toHaveLength(1)
    },
  )

  test.each([500, 503])(
    'a %i is transient: it throws and changes nothing, so the next call tries again',
    async (status) => {
      const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [{ status }])
      await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
      expect(h.writes).toEqual([])
      expect(h.row()!.status).toBe('connected')
    },
  )

  test('an unreachable token endpoint is transient as well', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [{ throws: true }])
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.writes).toEqual([])
  })

  test('an answer with no access token is refused without being stored', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [{ body: {} }])
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.writes).toEqual([])
  })
})

describe('an expiring token with no refresh token', () => {
  test('is used while it is still valid', async () => {
    const h = harness(
      connected({ tokenExpiresAt: NOW + 2 * MIN, encryptedRefreshToken: undefined }),
    )
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-old',
    })
    expect(h.calls).toEqual([])
    expect(h.writes).toEqual([])
  })

  test('once expired, marks the connection in error and throws the not-connected sentence', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW - 1, encryptedRefreshToken: undefined }))
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.calls).toEqual([])
    expect(h.row()!.status).toBe('error')
  })
})

describe('a deployment without the OAuth app credentials', () => {
  test('uses a still-valid token and leaves the row alone', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + 2 * MIN }))
    h.noCredentials()
    await expect(resolveSumUpAccessToken(h.deps)).resolves.toMatchObject({
      accessToken: 'access-old',
    })
    expect(h.calls).toEqual([])
  })

  test('refuses an expired one without marking the owner’s connection broken', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW - MIN }))
    h.noCredentials()
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.writes).toEqual([])
  })
})

describe('two actions refreshing at the same moment', () => {
  test('the loser of a single-use refresh token uses the winner’s fresh token and breaks nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      // First request: SumUp accepts it, but the winner stores its pair only once released.
      {
        body: { access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 3600 },
        gate,
      },
      // Second request: the same refresh token again, spent already.
      { status: 400, body: { error: 'invalid_grant' } },
    ])

    // The loser is refused at once and its first re-read finds the old row; the winner
    // stores its pair while the loser waits before the next read.
    h.deps.sleep = async () => {
      release()
      await first
    }
    const first = resolveSumUpAccessToken(h.deps)
    // Let the first one reach its (gated) request, then start the second.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = resolveSumUpAccessToken(h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.calls).toHaveLength(2)

    const [a, b] = await Promise.all([first, second])

    expect(a.accessToken).toBe('access-a')
    expect(b.accessToken).toBe('access-a')
    expect(h.row()).toMatchObject({ status: 'connected', encryptedAccessToken: 'enc(access-a)' })
    expect(h.writes.every((w) => w.status === 'connected')).toBe(true)
  })

  test('a real refusal waits for nobody who is not there, then marks the connection', async () => {
    const waits: number[] = []
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      { status: 400, body: { error: 'invalid_grant' } },
    ])
    h.deps.sleep = async (ms) => void waits.push(ms)
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(waits).toEqual([300, 700])
    expect(h.row()!.status).toBe('error')
  })

  test('a refusal with nobody else having refreshed is a real one', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      { status: 400, body: { error: 'invalid_grant' } },
    ])
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.row()!.status).toBe('error')
  })

  test('a refusal after the owner disconnected writes nothing back', async () => {
    const h = harness(connected({ tokenExpiresAt: NOW + MIN }), [
      { status: 400, body: { error: 'invalid_grant' } },
    ])
    const original = h.deps.readConnection
    let reads = 0
    h.deps.readConnection = async () => (++reads === 1 ? original() : null)
    await expect(resolveSumUpAccessToken(h.deps)).rejects.toThrow('SumUp is not connected')
    expect(h.writes).toEqual([])
  })
})

describe('exchanging the authorization code', () => {
  const input = {
    code: 'code-1',
    redirectUri: 'https://site.test/connect/sumup/callback',
    clientId: 'client-1',
    clientSecret: 'secret-1',
  }

  test('sends the documented request and returns the encrypted connection', async () => {
    const h = harness(null, [
      {
        body: {
          access_token: 'a1',
          refresh_token: 'r1',
          expires_in: 3600,
          merchant_code: 'MC9',
        },
      },
    ])
    const write = await exchangeSumUpCode(h.deps, input)
    expect(Object.fromEntries(h.calls[0]!.form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: 'client-1',
      client_secret: 'secret-1',
      redirect_uri: input.redirectUri,
    })
    expect(write).toEqual({
      merchantId: 'MC9',
      encryptedAccessToken: 'enc(a1)',
      encryptedRefreshToken: 'enc(r1)',
      tokenExpiresAt: NOW + 3600 * 1000,
      status: 'connected',
    })
  })

  test('stores no expiry when SumUp states none, and no refresh token when none is given', async () => {
    const h = harness(null, [{ body: { access_token: 'a1' } }])
    await expect(exchangeSumUpCode(h.deps, input)).resolves.toEqual({
      merchantId: '',
      encryptedAccessToken: 'enc(a1)',
      encryptedRefreshToken: undefined,
      tokenExpiresAt: undefined,
      status: 'connected',
    })
  })

  test.each([
    [400, { error: 'invalid_grant' }],
    [200, {}],
  ])('a refusal (%i) throws the exchange error', async (status, body) => {
    const h = harness(null, [{ status, body }])
    await expect(exchangeSumUpCode(h.deps, input)).rejects.toThrow('SumUp token exchange failed')
  })
})
