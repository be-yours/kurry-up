import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import type { PaymentBench } from './reservations.helpers'

/**
 * Driving the payment journey against `scripts/local-psp.mjs`, the stand-in for Stripe,
 * SumUp and PayPal.
 *
 * A bench with no provider account cannot run a payment end to end. The stand-in
 * (`apps/reference/scripts/local-psp.mjs`) serves the three providers' APIs on one private
 * port and a provider-looking payment page for each; the Convex deployment is pointed at it
 * through `RESERVATION_PSP_STAND_IN` and the three `RESERVATION_PSP_*_BASE_URL` variables
 * (see the header of that script). `E2E_PSP_URL` says where it listens; without it every
 * helper here reports « no stand-in » and a spec skips with that reason.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves our adapters send requests the
 * stand-in — written from OUR reading of the vendors' documentation — accepts, and that the
 * product settles, refunds and releases correctly from what such a provider answers. It
 * does not prove the vendors accept the same requests: that needs one run against the real
 * Stripe test mode, SumUp sandbox and PayPal sandbox.
 */

export const PSP_URL = (process.env.E2E_PSP_URL ?? '').replace(/\/+$/, '')

export type Psp = 'stripe' | 'sumup' | 'paypal'

/** Which provider a spec that is not about one provider connects: `E2E_PSP_PROVIDER`, Stripe by default. */
export const PSP_PROVIDER: Psp = ['stripe', 'sumup', 'paypal'].includes(
  process.env.E2E_PSP_PROVIDER ?? '',
)
  ? (process.env.E2E_PSP_PROVIDER as Psp)
  : 'stripe'

/** Test card numbers, as the vendors' own test modes use them (our reading). */
export const CARDS = {
  pays: '4242424242424242',
  declined: '4000000000000002',
  insufficientFunds: '4000000000009995',
  /** 3-D Secure once: the authentication done when the card is saved carries the later charge. */
  threeDSecure: '4000002500003155',
  /** 3-D Secure on every transaction: a charge with the guest absent cannot succeed. */
  threeDSecureAlways: '4000002760003184',
  /** Saves fine; every charge made later with the cardholder absent is declined. */
  savesThenDeclined: '4000000000000341',
  /** Pays, and a dispute is opened at once: Stripe sends its event before the payment's own. */
  dispute: '4000000000000259',
} as const

export const NO_STAND_IN =
  'no provider stand-in is reachable: start apps/reference/scripts/local-psp.mjs, point the Convex deployment at it and set E2E_PSP_URL (see the header of that script)'

/** The host the guest is sent to, to tell « left the site for the provider » from « stayed ». */
export function pspHost(): string {
  return PSP_URL ? new URL(PSP_URL).host : ''
}

export interface PspState {
  scenario: Record<string, Record<string, unknown>>
  violations: Array<{ provider: string; message: string; request: string | null }>
  webhooks: Array<{ id: string; type: string; status: number | string | null; body?: string }>
  requests: Array<{
    method: string
    path: string
    status: number | null
    headers: Record<string, string>
    body: string
  }>
  stripe: {
    customers: Array<{ id: string }>
    sessions: Array<{
      id: string
      mode: string
      status: string
      payment_status: string
      amount_total: number | null
      currency: string | null
      client_reference_id: string | null
      customer: string | null
      metadata: Record<string, string>
      payment_intent: string | null
      setup_intent: string | null
      expires_at: number
    }>
    intents: Array<{
      id: string
      amount: number
      amount_received: number
      status: string
      customer: string | null
      metadata: Record<string, string>
      last_payment_error: { code?: string; decline_code?: string } | null
    }>
    setupIntents: Array<{ id: string; status: string; customer: string | null }>
    refunds: Array<{
      id: string
      amount: number
      payment_intent: string
      status: string
      failure_reason: string | null
    }>
    events: string[]
  }
  sumup: {
    checkouts: Array<{
      id: string
      status: string
      checkout_reference: string
      amount: number
      currency: string
      transactions: Array<{ id: string; status: string }>
    }>
    transactions: Array<{ id: string; status: string; amount: number; refunded: number }>
  }
  paypal: {
    orders: Array<{
      id: string
      status: string
      purchase_units: Array<{ custom_id?: string; reference_id?: string }>
    }>
    captures: Array<{ id: string; status: string; refunded: number }>
    refunds: Array<{ id: string; status: string; amount: { value: string } }>
  }
}

async function control<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${PSP_URL}/_control${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`stand-in ${path}: HTTP ${response.status}`)
  return (await response.json()) as T
}

/** Is a stand-in listening, and is the Convex deployment pointed at it? */
export async function pspReachable(): Promise<boolean> {
  if (!PSP_URL) return false
  try {
    await control('GET', '/health')
    return true
  } catch {
    return false
  }
}

export const psp = {
  state: () => control<PspState>('GET', '/state'),
  /** Forget everything the stand-in holds and put the scenario back to its defaults. */
  async reset() {
    await control('POST', '/reset')
  },
  /** How the next payments go. Only what is given changes. */
  scenario: (values: Record<string, Record<string, unknown>>) =>
    control('POST', '/scenario', values),
  defaultScenario: () => control('POST', '/default-scenario'),
  /** The provider confirms a payment the guest already left behind (`settle: 'manual'`). */
  settle: (provider: Psp, id: string) => control('POST', '/settle', { provider, id }),
  /**
   * Settle a Stripe refund that was left `pending` (scenario `{ stripe: { refund: 'pending' } }`):
   * it succeeds, or fails with a `failure_reason`, or is canceled. The latest refund unless an
   * `id` is given. `webhook: false` sends no event, so only a read of the refund finds out.
   */
  settleRefund: (body: {
    status: 'succeeded' | 'failed' | 'canceled'
    id?: string
    reason?: string
    webhook?: boolean
  }) =>
    control<{ id: string; status: string; failure_reason: string | null }>('POST', '/refund', body),
  /** Send a signed Stripe event, or replay one by id. */
  event: (body: Record<string, unknown>) =>
    control<{ delivered: { id: string; status: number | string | null; body?: string } }>(
      'POST',
      '/event',
      body,
    ),
}

/* ------------------------------------------------------------------ */
/* The provider's own page                                              */
/* ------------------------------------------------------------------ */

/**
 * Pay on the provider's page the way a guest does, and stop where the provider leaves
 * them: this does NOT wait for the redirect back, because a spec sometimes wants to look at
 * the provider's own words first (a decline stays on the provider's page).
 */
export async function payOnProviderPage(
  page: Page,
  provider: Psp,
  options: { card?: string; funding?: 'balance' | 'declined' } = {},
): Promise<void> {
  const ours = pspHost()
  await expect.poll(() => new URL(page.url()).host, { timeout: 60_000 }).toBe(ours)
  if (provider === 'paypal') {
    const funding = options.funding ?? 'balance'
    await page
      .getByRole('button', {
        name: funding === 'balance' ? 'Pay with PayPal balance' : /card that will be declined/,
      })
      .click()
    return
  }
  await page.getByLabel('Card number').fill(options.card ?? CARDS.pays)
  await page.getByRole('button', { name: 'Pay', exact: true }).click()
  if (provider === 'sumup') {
    // SumUp's success page does not redirect (sandbox, 28 October 2026): it shows « Paiement
    // réussi » and ONE link back to the merchant, which is what a guest presses. A refused card
    // keeps the guest on the hosted page, with the form offered again.
    const back = page.getByRole('link', { name: 'Return to the merchant' })
    await expect(back.or(page.getByRole('alert'))).toBeVisible({ timeout: 30_000 })
    if ((await back.count()) > 0) await back.click()
  }
}

/** The words the provider's page shows after a refused payment. */
export function providerAlert(page: Page): Locator {
  return page.getByRole('alert')
}

/** Wait for the browser to come back to the site from the provider. */
export async function waitBackOnSite(page: Page, baseURL: string | undefined): Promise<void> {
  const ours = new URL(baseURL ?? page.url()).host
  await page.waitForURL((url) => url.host === ours, { timeout: 60_000 })
}

/**
 * On the payment page: pick the provider when the guest is offered a choice, then press the
 * button that leaves for the provider. Returns once the browser is on the provider's page.
 */
export async function goToProvider(page: Page, provider: Psp, button: RegExp | string) {
  // The page lists its providers once the server has answered: look for the choice only after
  // the button that leaves for the provider is there, or a page still loading shows no choice.
  const leave = page.getByRole('button', { name: button })
  await expect(leave).toBeVisible({ timeout: 30_000 })
  const radio = page.getByRole('radio', { name: PROVIDER_LABELS[provider] })
  if ((await radio.count()) > 0) await radio.check({ force: true })
  await leave.click()
  await expect.poll(() => new URL(page.url()).host, { timeout: 60_000 }).toBe(pspHost())
}

export const PROVIDER_LABELS: Record<Psp, RegExp> = {
  stripe: /Stripe/,
  sumup: /SumUp/,
  paypal: /PayPal/,
}

/* ------------------------------------------------------------------ */
/* The establishment's provider configuration                           */
/* ------------------------------------------------------------------ */

type PaymentsSetting = { cardProvider: 'stripe' | 'sumup' | 'none'; paypal: boolean; cash: boolean }

const getAdminSettings = makeFunctionReference<
  'query',
  Record<string, never>,
  { payments?: PaymentsSetting } | null
>('globalSettings:getAdmin')
const upsertSettings = makeFunctionReference<'mutation', { payments: PaymentsSetting }, unknown>(
  'globalSettings:upsert',
)

/**
 * Make the establishment take cards through `provider`, the way the owner does in
 * Réglages → Paiements: Stripe and SumUp are the card provider; PayPal is a switch that
 * sits beside whichever card provider is chosen (the deployment holds the keys). The guest is
 * then offered both and picks PayPal on the payment page.
 *
 * Returns a function that puts the setting back as it was found.
 */
export async function connectProvider(
  bench: PaymentBench,
  provider: Psp,
): Promise<() => Promise<void>> {
  const before = await bench.client.query(getAdminSettings, {})
  const original: PaymentsSetting = before?.payments ?? {
    cardProvider: 'stripe',
    paypal: false,
    cash: false,
  }
  // PayPal is a switch beside the card provider, and a card provider has to be chosen for it
  // to count (`none` refuses every deposit). It sits beside SumUp here, not Stripe: neither
  // can secure a card, so what is under test is PayPal's own answer to a guarantee, not the
  // answer of the Stripe that happens to be next to it.
  const wanted: PaymentsSetting =
    provider === 'paypal'
      ? { ...original, cardProvider: 'sumup', paypal: true }
      : { ...original, cardProvider: provider, paypal: false }
  await bench.client.mutation(upsertSettings, { payments: wanted })
  return async () => {
    await bench.client.mutation(upsertSettings, { payments: original })
  }
}

/* ------------------------------------------------------------------ */
/* Moving a booking in time (local bench only)                          */
/* ------------------------------------------------------------------ */

/** Playwright runs from the app's own directory, where the Convex CLI finds `convex.json`. */
const APP_ROOT = resolve(process.cwd())

function adminKey(): string {
  return (process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? '').replace(/^['"]|['"]$/g, '')
}

/**
 * Can a spec move a booking back in time? Only on a LOCAL backend whose admin key is in the
 * environment: it rewrites the `reservations` table through the Convex CLI, which no
 * deployment a client owns would ever allow.
 */
export function canMoveBookingsInTime(): boolean {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? ''
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(url) && adminKey() !== ''
}

export const NO_TIME_TRAVEL =
  'moving a booking into the past needs a local Convex backend and its admin key (CONVEX_SELF_HOSTED_ADMIN_KEY): a no-show can only be recorded once the booking was due, and a booking cannot be made in the past'

function convexCli(args: string[]): string {
  return execFileSync('npx', ['convex', ...args], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL:
        process.env.CONVEX_SELF_HOSTED_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey(),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * Put a booking's start `hoursAgo` hours in the past (its end keeps the same distance), by
 * rewriting its row; ids are kept.
 *
 * The booking engine refuses to make a booking in the past, and refuses a no-show before the
 * booking was due; the only way a browser spec reaches « a guest who did not come » is to
 * move a real booking back. Local bench only (see `canMoveBookingsInTime`); run it while
 * nothing else is writing bookings.
 */
export function moveBookingToThePast(reference: string, hoursAgo = 2): void {
  moveBookingStart(reference, Date.now() - hoursAgo * 3_600_000)
}

/**
 * Put a booking's start at an instant (its end keeps the same distance), by rewriting its
 * row; ids are kept. How a spec brings a booking INSIDE its free-cancellation cut-off without
 * waiting for the clock. Local bench only, like `moveBookingToThePast`.
 */
export function moveBookingStart(reference: string, startsAt: number): void {
  const raw = convexCli(['data', 'reservations', '--limit', '5000', '--format', 'jsonLines'])
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const row = rows.find((candidate) => candidate.reference === reference)
  if (!row) throw new Error(`no booking ${reference} to move`)
  const length = (row.endsAt as number) - (row.startsAt as number)
  row.startsAt = startsAt
  row.endsAt = startsAt + length
  const dir = mkdtempSync(join(tmpdir(), 'psp-shift-'))
  const file = join(dir, 'reservations.jsonl')
  writeFileSync(file, `${rows.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`)
  convexCli(['import', '--replace', '--table', 'reservations', '--format', 'jsonLines', file, '-y'])
}

/** Every row of a table, through the Convex CLI. Local bench only, like `moveBookingToThePast`. */
export function readTable(table: string): Array<Record<string, unknown>> {
  return convexCli(['data', table, '--limit', '5000', '--format', 'jsonLines'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Append rows to a table (the system fields are dropped, so the ids are new): how a spec puts a
 * state the product cannot reach by itself in front of the real provider. Local bench only.
 */
export function appendRows(table: string, rows: Array<Record<string, unknown>>): void {
  const dir = mkdtempSync(join(tmpdir(), 'psp-append-'))
  const file = join(dir, `${table}.jsonl`)
  const clean = rows.map((row) => {
    const { _id: _drop, _creationTime: _time, ...rest } = row
    return rest
  })
  writeFileSync(file, `${clean.map((row) => JSON.stringify(row)).join('\n')}\n`)
  convexCli(['import', '--append', '--table', table, '--format', 'jsonLines', file, '-y'])
}

/** Change fields of one row (ids are kept), by rewriting the table through the Convex CLI. Local bench only. */
export function updateRow(table: string, id: string, patch: Record<string, unknown>): void {
  const rows = readTable(table)
  const row = rows.find((candidate) => String(candidate._id) === id)
  if (!row) throw new Error(`no row ${id} in ${table}`)
  Object.assign(row, patch)
  const dir = mkdtempSync(join(tmpdir(), 'psp-update-'))
  const file = join(dir, `${table}.jsonl`)
  writeFileSync(file, `${rows.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`)
  convexCli(['import', '--replace', '--table', table, '--format', 'jsonLines', file, '-y'])
}

/** The Convex id of a booking, from its reference. Local bench only, like `moveBookingToThePast`. */
export function reservationIdOf(reference: string): string {
  const raw = convexCli(['data', 'reservations', '--limit', '5000', '--format', 'jsonLines'])
  const row = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((candidate) => candidate.reference === reference)
  if (!row) throw new Error(`no booking ${reference}`)
  return String(row._id)
}

/**
 * Make a booking's refunds `hoursAgo` hours old, by rewriting their rows (ids are kept): how a
 * spec brings a refund whose outcome is unknown to the age at which the sweep stops asking about
 * it (`PAYMENT_REPLAY_HORIZON_MS`, 20 hours) without waiting a day. Run the sweep's flagging
 * (`reservationPayments:flagStalled`) afterwards. Local bench only, like `moveBookingToThePast`.
 */
export function ageRefunds(reference: string, hoursAgo = 30): void {
  const read = (table: string) =>
    convexCli(['data', table, '--limit', '5000', '--format', 'jsonLines'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const booking = read('reservations').find((candidate) => candidate.reference === reference)
  if (!booking) throw new Error(`no booking ${reference} whose refunds to age`)
  const rows = read('reservationPayments')
  const at = Date.now() - hoursAgo * 3_600_000
  let aged = 0
  for (const row of rows) {
    if (row.reservationId !== booking._id || row.kind !== 'refund') continue
    row.createdAt = at
    aged += 1
  }
  if (aged === 0) throw new Error(`booking ${reference} has no refund to age`)
  const dir = mkdtempSync(join(tmpdir(), 'psp-age-'))
  const file = join(dir, 'reservationPayments.jsonl')
  writeFileSync(file, `${rows.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`)
  convexCli([
    'import',
    '--replace',
    '--table',
    'reservationPayments',
    '--format',
    'jsonLines',
    file,
    '-y',
  ])
}

/** Run an internal Convex function with the admin key (the sweeps a cron would run). */
export function runInternal(functionName: string, args: Record<string, unknown> = {}): string {
  return convexCli(['run', functionName, JSON.stringify(args)])
}

/** An unauthenticated client, as a guest's browser is: for calls only a guest may make. */
export function guestClient(): ConvexHttpClient {
  return new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL ?? '')
}

/* ------------------------------------------------------------------ */
/* Policy, and what the booking engine says about a slot                */
/* ------------------------------------------------------------------ */

const savePolicyRef = makeFunctionReference<'mutation', Record<string, unknown>, unknown>(
  'reservationPayments:savePaymentPolicy',
)
const availabilityRef = makeFunctionReference<
  'query',
  { storeId: string; date: string; partySize: number },
  Array<{ time: string; startsAt: number; available: boolean }>
>('reservations:getAvailability')
const createByStaffRef = makeFunctionReference<
  'mutation',
  Record<string, unknown>,
  { reference: string }
>('reservations:createByStaff')
const setStatusRef = makeFunctionReference<'mutation', { id: string; to: string }, unknown>(
  'reservations:setStatus',
)

/** The amount a spec asks for: 20 € flat as a deposit, up to 25 € as a no-show fee. */
export const PSP_DEPOSIT_CENTS = 2000
export const PSP_FEE_CAP_CENTS = 2500

/**
 * Save the policy the next bookings will be quoted: one rule on the dinner service, the
 * provider the establishment offers first, a cut-off in hours and a hold in minutes. Throws
 * the server's refusal when the connected providers cannot honour it.
 */
export async function savePolicy(
  bench: PaymentBench,
  options: {
    kind: 'deposit' | 'guarantee'
    freeCancellationHours: number
    holdMinutes: number
    primaryProvider?: Psp
    /** The deposit, in cents (the default is `PSP_DEPOSIT_CENTS`); a provider's « always declined » amount, for one. */
    depositCents?: number
  },
): Promise<void> {
  await bench.client.mutation(savePolicyRef, {
    storeId: bench.storeId,
    enabled: true,
    rules: [
      options.kind === 'deposit'
        ? {
            id: 'e2e-psp-deposit',
            kind: 'deposit',
            deposit: { mode: 'flat', cents: options.depositCents ?? PSP_DEPOSIT_CENTS },
            serviceIds: [bench.serviceId],
          }
        : {
            id: 'e2e-psp-guarantee',
            kind: 'guarantee',
            noShowFee: { mode: 'flat', cents: PSP_FEE_CAP_CENTS },
            serviceIds: [bench.serviceId],
          },
    ],
    freeCancellationHours: options.freeCancellationHours,
    holdMinutes: options.holdMinutes,
    ...(options.primaryProvider ? { primaryProvider: options.primaryProvider } : {}),
  })
}

/** The slots the booking page would offer a party on a date, with whether each is open. */
export async function slotsFor(bench: PaymentBench, date: string, partySize: number) {
  return bench.client.query(availabilityRef, { storeId: bench.storeId, date, partySize })
}

/** A booking the team types in on a slot: it owes nothing and holds a table. */
export async function staffBooking(
  bench: PaymentBench,
  input: { date: string; startsAt: number; partySize: number; name: string; email: string },
): Promise<string> {
  const booking = await bench.client.mutation(createByStaffRef, {
    storeId: bench.storeId,
    date: input.date,
    serviceId: bench.serviceId,
    startsAt: input.startsAt,
    partySize: input.partySize,
    guest: { name: input.name, email: input.email, phone: '0600000000' },
  })
  return booking.reference
}

/** The establishment ends a booking (used to leave the shared book as it was found). */
export async function cancelAsHost(bench: PaymentBench, bookingId: string): Promise<void> {
  await bench.client.mutation(setStatusRef, { id: bookingId, to: 'cancelled_by_restaurant' })
}
