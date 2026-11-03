/**
 * SumUp's OAuth tokens: the code exchange, and the refresh that keeps a connection alive.
 *
 * WHY THIS FILE EXISTS. `oauthConnect.exchangeOAuthToken` stored an access token, a refresh
 * token and `tokenExpiresAt`, and `getSumUpAccessToken` only ever decrypted the access token.
 * Once it expired every SumUp charge, refund and reservation deposit failed with a 401 until
 * the owner reconnected, and nothing told them why. The refresh half lives here.
 *
 * Everything is injected (fetch, clock, crypto, storage) so the rules are unit-tested without
 * a Convex runtime; `convex/sumup.ts` and `convex/oauthConnect.ts` wire the real ones.
 *
 * THE RULES
 *  - A connection with no `tokenExpiresAt` (an API-key style token) is returned untouched.
 *  - A token with more than `SUMUP_REFRESH_MARGIN_MS` left is returned untouched.
 *  - Inside the margin, a refresh token exists: refresh, persist the new pair encrypted.
 *    A response without a refresh token keeps the old one (the grant is not always rotated).
 *  - Inside the margin with no refresh token, the old token still works until it really
 *    expires; after that the connection is marked `error` and the call throws.
 *  - SumUp refusing the refresh (400 / 401) is the owner's cue to reconnect, UNLESS another
 *    action refreshed at the same moment: refresh tokens may be single-use, so the loser of
 *    that race is refused for a reason that is not real. It re-reads the row and uses the
 *    winner's token when that one is fresh. Only an unchanged row is marked `error`.
 *  - A 5xx or a network failure is transient: it throws and changes nothing.
 *
 * Every throw keeps the « SumUp is not connected » sentence, so each caller reports the
 * diner-facing « paiement indisponible » it already reports for a missing connection.
 */

/** Refresh an access token this close to its expiry, as the Uber Eats connection does. */
export const SUMUP_REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface SumUpConnectionRow {
  merchantId: string
  status: string
  encryptedAccessToken?: string
  encryptedRefreshToken?: string
  tokenExpiresAt?: number
}

/** What `paymentConnections.upsert` takes for SumUp. */
export interface SumUpConnectionWrite {
  merchantId: string
  encryptedAccessToken?: string
  encryptedRefreshToken?: string
  tokenExpiresAt?: number
  status: 'connected' | 'error'
}

export interface SumUpTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  merchant_code?: string
  error?: string
}

export interface SumUpTokenDeps {
  now: () => number
  /** Waits between the re-reads that follow a refusal (see `REFUSAL_RECHECK_DELAYS_MS`). */
  sleep: (ms: number) => Promise<void>
  fetch: typeof fetch
  /** The token endpoint, from `resolveSumUpOAuthEndpoints`. */
  tokenUrl: string
  /** `null` when `SUMUP_CLIENT_ID` / `SUMUP_CLIENT_SECRET` are not set on the deployment. */
  clientCredentials: () => { clientId: string; clientSecret: string } | null
  encrypt: (plaintext: string) => Promise<string>
  decrypt: (ciphertext: string) => Promise<string>
  readConnection: () => Promise<SumUpConnectionRow | null>
  writeConnection: (write: SumUpConnectionWrite) => Promise<void>
}

const NOT_CONNECTED = 'SumUp is not connected'

/**
 * After SumUp refuses a refresh, how long to keep looking at the row for another action's
 * fresh token before believing the refusal. The winner of a single-use refresh token is
 * accepted by SumUp BEFORE it has stored the pair, so the loser's refusal can come back
 * first: one immediate read is not enough. About a second in all; only a refusal pays it.
 */
const REFUSAL_RECHECK_DELAYS_MS = [0, 300, 700]

function secondsToExpiry(expiresIn: number | undefined, now: number): number | undefined {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn)
    ? now + expiresIn * 1000
    : undefined
}

function nearExpiry(conn: SumUpConnectionRow, now: number): boolean {
  return conn.tokenExpiresAt !== undefined && conn.tokenExpiresAt < now + SUMUP_REFRESH_MARGIN_MS
}

function expired(conn: SumUpConnectionRow, now: number): boolean {
  return conn.tokenExpiresAt !== undefined && conn.tokenExpiresAt <= now
}

/** The write that keeps the row as it is and flips its status. */
function withStatus(conn: SumUpConnectionRow, status: 'connected' | 'error'): SumUpConnectionWrite {
  return {
    merchantId: conn.merchantId,
    encryptedAccessToken: conn.encryptedAccessToken,
    encryptedRefreshToken: conn.encryptedRefreshToken,
    tokenExpiresAt: conn.tokenExpiresAt,
    status,
  }
}

async function readJson(res: Response): Promise<SumUpTokenResponse> {
  try {
    const parsed: unknown = await res.json()
    return parsed !== null && typeof parsed === 'object' ? (parsed as SumUpTokenResponse) : {}
  } catch {
    return {}
  }
}

/**
 * `grant_type=authorization_code`: what the OAuth callback does with the code.
 * Throws `SumUp token exchange failed` on any refusal, as it always has.
 */
export async function exchangeSumUpCode(
  deps: Pick<SumUpTokenDeps, 'fetch' | 'tokenUrl' | 'now' | 'encrypt'>,
  input: { code: string; redirectUri: string; clientId: string; clientSecret: string },
): Promise<SumUpConnectionWrite> {
  const res = await deps.fetch(deps.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }),
  })
  const json = await readJson(res)
  if (!res.ok || !json.access_token) throw new Error('SumUp token exchange failed')
  return {
    merchantId: json.merchant_code ?? '',
    encryptedAccessToken: await deps.encrypt(json.access_token),
    encryptedRefreshToken: json.refresh_token ? await deps.encrypt(json.refresh_token) : undefined,
    tokenExpiresAt: secondsToExpiry(json.expires_in, deps.now()),
    status: 'connected',
  }
}

/**
 * The access token to call SumUp with, refreshed first when it is about to expire.
 * See the rules in the file header.
 */
export async function resolveSumUpAccessToken(
  deps: SumUpTokenDeps,
): Promise<{ accessToken: string; merchantCode: string }> {
  const conn = await deps.readConnection()
  if (!conn || conn.status !== 'connected') throw new Error(NOT_CONNECTED)
  if (!conn.encryptedAccessToken) throw new Error('SumUp access token is missing')

  const started = deps.now()
  if (!nearExpiry(conn, started)) {
    return {
      accessToken: await deps.decrypt(conn.encryptedAccessToken),
      merchantCode: conn.merchantId,
    }
  }

  // Inside the margin and nothing to refresh with: the token is good until it is not.
  if (!conn.encryptedRefreshToken) {
    if (!expired(conn, started)) {
      return {
        accessToken: await deps.decrypt(conn.encryptedAccessToken),
        merchantCode: conn.merchantId,
      }
    }
    await deps.writeConnection(withStatus(conn, 'error'))
    throw new Error(`${NOT_CONNECTED}: the access token expired and no refresh token is held`)
  }

  const credentials = deps.clientCredentials()
  if (!credentials) {
    // Not an owner problem: the deployment lacks the app credentials. Leave the row alone.
    if (!expired(conn, started)) {
      return {
        accessToken: await deps.decrypt(conn.encryptedAccessToken),
        merchantCode: conn.merchantId,
      }
    }
    throw new Error(`${NOT_CONNECTED}: SUMUP_CLIENT_ID and SUMUP_CLIENT_SECRET are not set`)
  }

  const refreshToken = await deps.decrypt(conn.encryptedRefreshToken)
  let res: Response
  try {
    res = await deps.fetch(deps.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    })
  } catch {
    throw new Error(`${NOT_CONNECTED}: the SumUp token endpoint is unreachable`)
  }

  if (res.ok) {
    const json = await readJson(res)
    if (!json.access_token)
      throw new Error(`${NOT_CONNECTED}: the SumUp token refresh answered no token`)
    const now = deps.now()
    await deps.writeConnection({
      merchantId: json.merchant_code ?? conn.merchantId,
      encryptedAccessToken: await deps.encrypt(json.access_token),
      encryptedRefreshToken: json.refresh_token
        ? await deps.encrypt(json.refresh_token)
        : conn.encryptedRefreshToken,
      tokenExpiresAt: secondsToExpiry(json.expires_in, now),
      status: 'connected',
    })
    return { accessToken: json.access_token, merchantCode: json.merchant_code ?? conn.merchantId }
  }

  if (res.status !== 400 && res.status !== 401) {
    throw new Error(`${NOT_CONNECTED}: the SumUp token refresh failed (${res.status})`)
  }

  // Refused. Another action may have spent the same single-use refresh token a moment
  // ago and stored a fresh pair: believe the row, not the refusal.
  let current: SumUpConnectionRow | null = null
  for (const delay of REFUSAL_RECHECK_DELAYS_MS) {
    if (delay > 0) await deps.sleep(delay)
    current = await deps.readConnection()
    if (
      current &&
      current.status === 'connected' &&
      current.encryptedAccessToken &&
      current.encryptedAccessToken !== conn.encryptedAccessToken &&
      !nearExpiry(current, deps.now())
    ) {
      return {
        accessToken: await deps.decrypt(current.encryptedAccessToken),
        merchantCode: current.merchantId,
      }
    }
    // Disconnected, or already marked by someone else: nothing to wait for.
    if (!current || current.status !== 'connected') break
  }
  if (current && current.encryptedAccessToken === conn.encryptedAccessToken) {
    await deps.writeConnection(withStatus(current, 'error'))
  }
  throw new Error(`${NOT_CONNECTED}: SumUp refused the refresh, the owner has to reconnect`)
}
