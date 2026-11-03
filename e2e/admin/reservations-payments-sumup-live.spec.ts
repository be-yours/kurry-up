import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { makeFunctionReference } from 'convex/server'
import {
  SUMUP_MIN_REFUND_MINOR,
  readSumUpCheckout,
  sumupClient,
} from '@be-yours/convex-functions/reservationProviders'
import {
  MAIL_LOG,
  NO_MAIL_LOG,
  card,
  ensureBook,
  fillBookingForm,
  isoDateAhead,
  mailsTo,
  openDayBook,
  openPaymentBench,
  openSettings,
  paymentBox,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  NO_TIME_TRAVEL,
  PSP_DEPOSIT_CENTS,
  appendRows,
  canMoveBookingsInTime,
  connectProvider,
  guestClient,
  readTable,
  runInternal,
  savePolicy,
  updateRow,
} from '../helpers/psp-standin.helpers'

/**
 * The SumUp payment journey of a booking against SumUp's REAL SANDBOX: the Convex actions call
 * `api.sumup.com` with a sandbox merchant's key, and the browser is sent to SumUp's own hosted
 * checkout (`checkout.sumup.com`), where a published test card is typed into SumUp's fields.
 *
 * OPT-IN. This file runs only with `E2E_SUMUP_LIVE=1`, `SUMUP_API_KEY` and `SUMUP_MERCHANT_CODE`.
 * It refuses anything that is not a sandbox merchant: `GET /v0.1/me` must answer the merchant code
 * given in `SUMUP_MERCHANT_CODE` and flag the account as a developer sandbox (`extdev`), and every
 * checkout it reads back must say `merchant_sandbox: true`. The key is read here only to READ
 * BACK what SumUp holds (checkouts, transactions) and to make the few requests no screen makes;
 * it is never printed or written, and every request of this file goes to `api.sumup.com` (a
 * constant, never read from the environment).
 *
 * THE CONNECTION. In production an establishment connects SumUp through OAuth and the product
 * stores the access token encrypted (`paymentConnections`). The OAuth connect and refresh flow
 * was NOT exercised: no OAuth app exists for the sandbox. The deployment under test holds a
 * `paymentConnections` row shaped like the real one, whose token is the sandbox API key (a SumUp
 * API key is a bearer token for the same API), encrypted with the deployment's ENCRYPTION_KEY,
 * and NONE of the `RESERVATION_PSP_*` stand-in variables (checked below), so the adapters reach
 * the real host. What this does not cover: the token's expiry and refresh, the OAuth scopes.
 *
 * Amounts. SumUp documents that a checkout of 11 (any currency) is always turned down, to test a
 * failed payment, and publishes its test cards (developer.sumup.com/online-payments/testing).
 * Only those are used. If SumUp ever shows a bot check, the case stops: it is reported, never solved.
 *
 * See `tasks/reservations-sandbox-acceptance.md` for what each case found.
 */
test.setTimeout(300_000)

const API_KEY = process.env.SUMUP_API_KEY ?? ''
const MERCHANT = process.env.SUMUP_MERCHANT_CODE ?? ''
const LIVE = process.env.E2E_SUMUP_LIVE === '1' && API_KEY !== '' && MERCHANT !== ''
const SKIP_REASON =
  'run with E2E_SUMUP_LIVE=1 and the SANDBOX merchant in SUMUP_API_KEY / SUMUP_MERCHANT_CODE'

/** The one host this file talks to. Not read from the environment. */
const SUMUP_API = 'https://api.sumup.com'
const HOSTED_HOST = 'checkout.sumup.com'
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const ADMIN_STATE = 'e2e/.auth/admin.json'
const RUN = Date.now().toString(36)
const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
const PAY_BUTTON = new RegExp(`^Payer ${MONEY}$`)
/** SumUp's always-failing amount (« 11 » in any currency), in cents. */
const MAGIC_FAILING_CENTS = 1100

/** SumUp's published test cards: frictionless success, and 3-D Secure « technical error ». */
const TEST_CARD = { pays: '4200000000000091', refused: '4012001037461114' } as const

/**
 * Each case books a day of its own, from the 31st day on; a second run on the same backend
 * moves them with `E2E_DAY_OFFSET`, or the days booked by the first would be full.
 */
let dayCounter = 30 + Number(process.env.E2E_DAY_OFFSET ?? 0)

function freshDate(): string {
  dayCounter += 1
  return isoDateAhead(dayCounter)
}

/* ------------------------------------------------------------------ */
/* What SumUp holds, read back with the sandbox key                      */
/* ------------------------------------------------------------------ */

// SumUp's objects are read field by field for what a case asserts: a typed model would only
// restate the API reference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SumUpObject = any

async function sumupApi(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SumUpObject }> {
  const response = await fetch(`${SUMUP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: SumUpObject = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // an empty (204) or non-JSON body is returned as text
  }
  return { status: response.status, body: parsed }
}

async function checkoutOf(id: string): Promise<SumUpObject> {
  const { status, body } = await sumupApi('GET', `/v0.1/checkouts/${id}`)
  expect(status, `SumUp knows checkout ${id}`).toBe(200)
  expect(body.merchant_sandbox, 'this checkout belongs to a sandbox merchant').toBe(true)
  expect(body.merchant_code).toBe(MERCHANT)
  return body
}

/** The successful transaction of a checkout: what a refund targets (`transactions[].id`). */
function successfulOf(checkout: SumUpObject): SumUpObject {
  return (checkout.transactions ?? []).find(
    (txn: SumUpObject) => txn.status === 'SUCCESSFUL',
  ) as SumUpObject
}

/** SumUp's own record of a transaction: its refund events, in cents, and what it still lets us refund. */
async function transactionOf(id: string): Promise<{
  status: string
  refunds: Array<{ amount: number; status: string }>
  maxRefundable: number | null
}> {
  // A read right after a write can lag for a moment on the sandbox: it is a read, so it is asked again.
  let last = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { status, body } = await sumupApi(
      'GET',
      `/v2.1/merchants/${MERCHANT}/transactions?id=${id}`,
    )
    last = status
    if (status === 200) {
      const events: SumUpObject[] = body.events ?? []
      const link = (body.links ?? []).find((candidate: SumUpObject) => candidate.rel === 'refund')
      return {
        status: body.status,
        refunds: events
          .filter((event) => event.type === 'REFUND')
          .map((event) => ({
            amount: Math.round(Number(event.amount) * 100),
            status: event.status,
          })),
        maxRefundable: link ? Math.round(Number(link.max_amount) * 100) : null,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  expect(last, `SumUp knows transaction ${id}`).toBe(200)
  throw new Error('unreachable')
}

/** A checkout made straight at SumUp for one of OUR payment rows, outside the adapter. */
async function checkoutForRow(rowId: string, label: string, cents = PSP_DEPOSIT_CENTS) {
  const { status, body } = await sumupApi('POST', '/v0.1/checkouts', {
    checkout_reference: rowId,
    amount: cents / 100,
    currency: 'EUR',
    merchant_code: MERCHANT,
    description: `Acompte — ${label}`,
    valid_until: new Date(Date.now() + 31 * 60_000).toISOString(),
    hosted_checkout: { enabled: true },
  })
  expect(status).toBe(201)
  return { id: String(body.id), url: String(body.hosted_checkout_url) }
}

/* ------------------------------------------------------------------ */
/* The deployment under test                                            */
/* ------------------------------------------------------------------ */

/** The names of the deployment's environment variables, or null when it cannot be listed here. */
async function deploymentEnvNames(): Promise<string[] | null> {
  if (!canMoveBookingsInTime()) return null
  const { execFileSync } = await import('node:child_process')
  const key = (process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? '').replace(/^['"]|['"]$/g, '')
  const out = execFileSync('npx', ['convex', 'env', 'list'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL:
        process.env.CONVEX_SELF_HOSTED_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL,
      CONVEX_SELF_HOSTED_ADMIN_KEY: key,
    },
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .map((line) => line.split('=')[0]!.trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
}

/* ------------------------------------------------------------------ */
/* The guest's side                                                     */
/* ------------------------------------------------------------------ */

/**
 * A guest's browser, signed out, in French: SumUp's hosted page speaks the language the browser
 * asks for, and this file reads its words (« Paiement réussi », « Mode test »).
 */
async function frenchGuest(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    locale: 'fr-FR',
    storageState: { cookies: [], origins: [] },
  })
}

interface Booked {
  email: string
  context: BrowserContext
  page: Page
  paymentUrl: string
  manageUrl: string
  reference: string
  date: string
}

async function bookForPayment(
  browser: Browser,
  baseURL: string | undefined,
  options: { label: string; date?: string; time?: string; partySize?: number; money?: RegExp },
): Promise<Booked> {
  const date = options.date ?? freshDate()
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')
  const context = await frenchGuest(browser, baseURL)
  const page = await context.newPage()
  const email = `e2e.sumup.${slug}.${RUN}@example.com`
  await fillBookingForm(page, {
    date,
    time: options.time ?? '19:00',
    partySize: options.partySize ?? 2,
    guest: { name: `E2E SumUp ${options.label} ${RUN}`, email, phone: '0612345678' },
  })
  // The box states the amount and the terms in words before anything is asked of the guest.
  await expect(paymentBox(page)).toContainText(options.money ?? new RegExp(MONEY))
  await paymentBox(page).getByRole('checkbox').click()
  await page.getByRole('button', { name: /^Continuer vers/ }).click()
  await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
  const paymentUrl = page.url().split('?')[0]!
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  // SumUp is the only connected provider: no chooser is offered.
  await expect(page.getByRole('button', { name: /^Payer / })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('radio')).toHaveCount(0)
  const reference =
    (await page
      .getByText(/^RES-\d{4}-\d{5}$/)
      .first()
      .textContent()) ?? ''
  return {
    email,
    context,
    page,
    paymentUrl,
    manageUrl: paymentUrl.replace('/reservation/payment/', '/reservation/manage/'),
    reference,
    date,
  }
}

/**
 * Press the button that leaves for SumUp and read where the site sent the browser: it has to be
 * SumUp's own hosted page, over https, naming a checkout. Returns that checkout's id.
 */
async function goToSumUp(page: Page, button: RegExp | string = PAY_BUTTON): Promise<string> {
  const leave = page.getByRole('button', { name: button })
  await expect(leave).toBeVisible({ timeout: 30_000 })
  await leave.click()
  await page.waitForURL((url) => url.host === HOSTED_HOST, { timeout: 60_000 })
  const url = new URL(page.url())
  expect(url.protocol).toBe('https:')
  const match = url.pathname.match(/^\/pay\/c-([0-9a-f-]{36})$/)
  expect(match, 'the hosted address names the checkout').toBeTruthy()
  return match![1]!
}

/** SumUp's own bot check is never solved here: say so and stop. */
async function refuseBotCheck(page: Page) {
  const botCheck = page.getByText(/verify you are human|I am human|captcha|security challenge/i)
  if ((await botCheck.count()) > 0) throw new Error('SumUp shows a bot check: case stopped')
}

/**
 * Type a published test card into SumUp's hosted fields (four iframes, one input each) and press
 * the pay button. Returns what the page says: `paid` or `refused`.
 */
async function payOnSumUp(page: Page, number: string): Promise<'paid' | 'refused'> {
  await page.waitForLoadState('domcontentloaded')
  await refuseBotCheck(page)
  const fields: Array<[string, string]> = [
    ['cardholder-name', 'E2E Sandbox Buyer'],
    ['credit-card-number', number],
    ['expiration', '1230'],
    ['cvv', '123'],
  ]
  const fieldFrames = () =>
    page.frames().filter((frame) => frame.url().includes('hosted-fields-frame')).length
  try {
    await expect.poll(fieldFrames, { timeout: 20_000 }).toBeGreaterThanOrEqual(4)
  } catch {
    // Seen once in a run of many payments: the page rendered « Moyens de paiement » with no
    // method under it. SumUp's page, not our adapter: a reload shows the card form.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(fieldFrames, { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
  }
  for (const [id, value] of fields) {
    let done = false
    for (const frame of page.frames()) {
      if (!frame.url().includes('hosted-fields-frame')) continue
      const input = frame.locator(`input#${id}`)
      if ((await input.count()) === 0) continue
      await input.click()
      await input.pressSequentially(value, { delay: 25 })
      done = true
      break
    }
    expect(done, `the hosted page has a ${id} field`).toBe(true)
  }
  await page.getByRole('button', { name: /^Payer/ }).click()
  const paid = page.getByText('Paiement réussi')
  const refused = page.getByText('Paiement refusé')
  await expect(paid.or(refused)).toBeVisible({ timeout: 60_000 })
  await refuseBotCheck(page)
  return (await paid.count()) > 0 ? 'paid' : 'refused'
}

/** SumUp's success page has one link back to the merchant: our `redirect_url`, as sent. */
async function backToSite(page: Page) {
  await page.getByRole('link', { name: 'Retour sur le site du commerçant' }).click()
  await page.waitForURL((url) => url.origin === BASE, { timeout: 60_000 })
}

async function expectConfirmed(page: Page) {
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
    timeout: 60_000,
  })
}

function paymentRegion(page: Page) {
  return page.getByRole('region', { name: 'Paiement', exact: true })
}

function bookingCard(page: Page, reference: string) {
  return page.locator('[data-slot="card"]').filter({ hasText: reference })
}

async function openPaymentDialog(page: Page, reference: string, date: string) {
  await openDayBook(page, date)
  const cardForBooking = bookingCard(page, reference)
  await expect(cardForBooking).toBeVisible({ timeout: 30_000 })
  await cardForBooking.getByRole('button', { name: 'Paiement', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^Paiement de / })
  await expect(dialog).toBeVisible()
  return dialog
}

function rowFor(checkoutRef: string) {
  return readTable('reservationPayments').find((row) => row.checkoutRef === checkoutRef)
}

/** Book, go to SumUp, pay with the success card, come back: the booking is confirmed. */
async function payDeposit(
  browser: Browser,
  baseURL: string | undefined,
  label: string,
  options: { date?: string } = {},
): Promise<{ booked: Booked; checkoutId: string }> {
  const booked = await bookForPayment(browser, baseURL, { label, ...options })
  const checkoutId = await goToSumUp(booked.page)
  expect(await payOnSumUp(booked.page, TEST_CARD.pays)).toBe('paid')
  await backToSite(booked.page)
  await expectConfirmed(booked.page)
  return { booked, checkoutId }
}

test.describe('SumUp sandbox, end to end', () => {
  test.describe.configure({ mode: 'serial' })

  let bench: PaymentBench | null = null
  let restoreProvider: (() => Promise<void>) | null = null
  /** A booking whose deposit the later tests replay as a double. */
  let paidFirst: { booked: Booked; checkoutId: string } | null = null
  let hold: { booked: Booked; checkoutId: string } | null = null
  let holdMagic: { booked: Booked; checkoutId: string } | null = null

  test.beforeAll(async ({ browser }) => {
    if (!LIVE) return
    // The sandbox guard: nothing below runs against a merchant that is not a developer sandbox.
    const me = await sumupApi('GET', '/v0.1/me')
    if (
      me.status !== 200 ||
      me.body?.merchant_profile?.merchant_code !== MERCHANT ||
      me.body?.merchant_profile?.extdev !== true
    ) {
      throw new Error(
        'refused: SUMUP_API_KEY is not the sandbox merchant named in SUMUP_MERCHANT_CODE',
      )
    }
    const names = await deploymentEnvNames()
    if (names) {
      expect(
        names.filter((name) => name.startsWith('RESERVATION_PSP_')),
        'no stand-in variable on the deployment: the adapters must reach api.sumup.com',
      ).toEqual([])
    }
    const context = await browser.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
    const page = await context.newPage()
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    // The way the product holds « connected to SumUp »: the card provider, and a connected
    // `paymentConnections` row (seeded with the sandbox key as the token, see the header).
    restoreProvider = await connectProvider(bench, 'sumup')
    await savePolicy(bench, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    await context.close()
  })

  test.afterAll(async () => {
    await bench?.restore().catch(() => undefined)
    await restoreProvider?.().catch(() => undefined)
  })

  test.beforeEach(() => {
    test.skip(!LIVE, SKIP_REASON)
    test.skip(!MAIL_LOG, NO_MAIL_LOG)
  })

  /* ---------------------------------------------------------------- */
  /* The page our adapter opens                                         */
  /* ---------------------------------------------------------------- */

  test('(hold) the booking page sends the guest to SumUp’s real hosted checkout, opened as the adapter asked; leaving it keeps the table held', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Hold', partySize: 2 })
    const checkoutId = await goToSumUp(booked.page)
    // The browser really is on SumUp's page, in test mode, and it states the amount.
    await booked.page.waitForLoadState('domcontentloaded')
    await refuseBotCheck(booked.page)
    await expect(booked.page.getByText('Mode test')).toBeVisible({ timeout: 30_000 })
    await expect(booked.page.locator('body')).toContainText(new RegExp(MONEY))
    await expect(booked.page.locator('body')).toContainText('Acompte')

    // What our adapter asked SumUp for, read back.
    const checkout = await checkoutOf(checkoutId)
    expect(checkout.status).toBe('PENDING')
    expect(checkout.transactions).toEqual([])
    expect(checkout.amount).toBe(PSP_DEPOSIT_CENTS / 100)
    expect(checkout.currency).toBe('EUR')
    expect(checkout.purpose).toBe('CHECKOUT')
    expect(checkout.hosted_checkout).toEqual({ enabled: true })
    expect(checkout.hosted_checkout_url).toBe(`https://${HOSTED_HOST}/pay/c-${checkoutId}`)
    expect(checkout.description).toContain('Acompte')
    expect(checkout.redirect_url).toBe(
      `${BASE}/reservation/payment/${booked.paymentUrl.split('/').pop()}?return=success`,
    )
    // Our row id is the reference, and the deadline is the hold (5 minutes) or the 4-minute floor,
    // never the documented 30 minutes of an unconfigured page.
    expect(checkout.checkout_reference).toMatch(/^[a-z0-9]{20,40}$/)
    const minutesLeft = (Date.parse(checkout.valid_until) - Date.now()) / 60_000
    expect(minutesLeft).toBeGreaterThan(2)
    expect(minutesLeft).toBeLessThan(6)
    if (canMoveBookingsInTime()) {
      const row = rowFor(checkoutId)
      expect(row, 'the row remembers the checkout').toBeTruthy()
      expect(String(row!._id)).toBe(checkout.checkout_reference)
      expect(row!.status).toBe('pending')
    }

    // A reference SumUp has seen answers 409 whatever the new body says, which is what the
    // adapter resumes from (the next case).
    const again = await sumupApi('POST', '/v0.1/checkouts', {
      checkout_reference: checkout.checkout_reference,
      amount: 99,
      currency: 'EUR',
      merchant_code: MERCHANT,
    })
    expect(again.status).toBe(409)
    expect(again.body.error_code).toBe('DUPLICATED_CHECKOUT')

    // The booking is not paid, and the guest's link says so.
    const context = await frenchGuest(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()
    hold = { booked, checkoutId }
    await booked.context.close()
  })

  test('the sweep over a checkout nobody paid reads it back and leaves the row pending', async () => {
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    test.skip(hold === null, 'the hold test did not start')
    runInternal('reservationPaymentActions:reconcile')
    expect((await checkoutOf(hold!.checkoutId)).status).toBe('PENDING')
    expect(rowFor(hold!.checkoutId)!.status).toBe('pending')
  })

  /* ---------------------------------------------------------------- */
  /* Paying                                                            */
  /* ---------------------------------------------------------------- */

  test('the booking is confirmed only after OUR read-back: paid at SumUp is not yet confirmed until the guest, or the sweep, asks', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Paid' })
    expect(mailsTo(booked.email)).toHaveLength(0)
    const checkoutId = await goToSumUp(booked.page)
    expect(await payOnSumUp(booked.page, TEST_CARD.pays)).toBe('paid')

    // SumUp says PAID, with its transaction. SumUp has an unsigned status callback (`return_url`)
    // that this engine does not use, so nothing tells our side yet: the booking waits, and no
    // mail has gone, whatever the guest's browser does.
    const paid = await checkoutOf(checkoutId)
    expect(paid.status).toBe('PAID')
    expect(paid.checkout_reference).toBe(rowFor(checkoutId)?.['_id'] ?? paid.checkout_reference)
    const txn = successfulOf(paid)
    expect(txn).toMatchObject({
      amount: PSP_DEPOSIT_CENTS / 100,
      currency: 'EUR',
      status: 'SUCCESSFUL',
    })
    expect(txn.id, 'the transaction id a refund targets').toBe(paid.transaction_id)
    const wait = await frenchGuest(browser, baseURL)
    const waiting = await wait.newPage()
    await waiting.goto(booked.manageUrl)
    await expect(paymentRegion(waiting)).not.toContainText('Payé')
    await wait.close()
    expect(mailsTo(booked.email)).toHaveLength(0)

    // The guest follows SumUp's link back: OUR action reads the checkout and settles.
    await backToSite(booked.page)
    await expectConfirmed(booked.page)
    await expect(
      booked.page.getByText(new RegExp(`Votre acompte de ${MONEY} est payé`)),
    ).toBeVisible()
    await expect
      .poll(() => mailsTo(booked.email).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1)
    await booked.page.waitForTimeout(3_000)
    expect(mailsTo(booked.email)).toHaveLength(1)
    if (canMoveBookingsInTime()) {
      const row = rowFor(checkoutId)!
      expect(row.status).toBe('succeeded')
      expect(row.externalId, 'the row keeps the transaction a refund will target').toBe(txn.id)
    }

    await booked.page.goto(booked.manageUrl)
    const region = paymentRegion(booked.page)
    await expect(region).toContainText('Payé')
    await expect(region).toContainText(new RegExp(MONEY))
    // A paid checkout cannot be paid again: its hosted page says so.
    const context = await frenchGuest(browser, baseURL)
    const page = await context.newPage()
    await page.goto(`https://${HOSTED_HOST}/pay/c-${checkoutId}`)
    await expect(page.getByText('Paiement réussi')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /^Payer/ })).toHaveCount(0)
    await context.close()
    paidFirst = { booked, checkoutId }
    await booked.context.close()
  })

  test('a guest who paid and was never sent back is confirmed by the sweep (SumUp’s callback is not used)', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(420_000)
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    const booked = await bookForPayment(browser, baseURL, { label: 'Sweep' })
    const checkoutId = await goToSumUp(booked.page)
    expect(await payOnSumUp(booked.page, TEST_CARD.pays)).toBe('paid')
    await booked.context.close()

    let context = await frenchGuest(browser, baseURL)
    let page = await context.newPage()
    await page.goto(booked.manageUrl)
    await page.waitForTimeout(3_000)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()

    // The sweep leaves an attempt alone for its first three minutes (the guest may still be on
    // the page): run it as the clock would, until it has read SumUp and settled.
    context = await frenchGuest(browser, baseURL)
    page = await context.newPage()
    await expect
      .poll(
        async () => {
          runInternal('reservationPaymentActions:reconcile')
          await page.goto(booked.manageUrl)
          return await paymentRegion(page).innerText()
        },
        { timeout: 300_000, intervals: [20_000] },
      )
      .toContain('Payé')
    await context.close()
    expect((await checkoutOf(checkoutId)).status).toBe('PAID')
    expect(
      mailsTo(booked.email).filter((body) => body.includes('confirm')),
      'one confirmation, however many sweeps read it',
    ).toHaveLength(1)
  })

  test('closing the SumUp page without paying keeps the booking held, and the same link pays later on the same checkout', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Closed tab' })
    const first = await goToSumUp(booked.page)
    await booked.context.close()

    const context = await frenchGuest(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await page.goto(booked.paymentUrl)
    const again = await goToSumUp(page, /^(Payer|Réessayer le paiement)/)
    expect(again, 'the live checkout is handed back, not remade').toBe(first)
    expect(await payOnSumUp(page, TEST_CARD.pays)).toBe('paid')
    await backToSite(page)
    await expectConfirmed(page)
    expect((await checkoutOf(first)).status).toBe('PAID')
    await context.close()
  })

  /* ---------------------------------------------------------------- */
  /* A payment that fails                                              */
  /* ---------------------------------------------------------------- */

  test('a refused card leaves the checkout FAILED but OPEN: the row stays pending, the same page takes another card, and one checkout pays', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Declined' })
    const checkoutId = await goToSumUp(booked.page)
    expect(await payOnSumUp(booked.page, TEST_CARD.refused)).toBe('refused')

    const failed = await checkoutOf(checkoutId)
    expect(failed.status, 'SumUp reads a refused card back as FAILED').toBe('FAILED')
    expect(failed.transactions.map((txn: SumUpObject) => txn.status)).toEqual(['FAILED'])
    // Our reading of it: not an end. Nothing is confirmed, nothing is closed.
    expect(readSumUpCheckout(failed).status).toBe('pending')
    if (canMoveBookingsInTime()) {
      runInternal('reservationPaymentActions:reconcile')
      expect(rowFor(checkoutId)!.status, 'the sweep does not close a FAILED checkout').toBe(
        'pending',
      )
    }

    // The same link, opened again: the hosted page offers the card form once more (SumUp's
    // « Essayez à nouveau » only shows in the session that failed).
    const context = await frenchGuest(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.paymentUrl)
    const again = await goToSumUp(page, /^(Payer|Réessayer le paiement)/)
    expect(again, 'the live checkout is handed back, not remade').toBe(checkoutId)
    expect(await payOnSumUp(page, TEST_CARD.pays)).toBe('paid')
    await backToSite(page)
    await expectConfirmed(page)

    const paid = await checkoutOf(checkoutId)
    expect(paid.status).toBe('PAID')
    expect(paid.transactions.map((txn: SumUpObject) => txn.status).sort()).toEqual([
      'FAILED',
      'SUCCESSFUL',
    ])
    expect(readSumUpCheckout(paid)).toMatchObject({
      status: 'completed',
      externalId: successfulOf(paid).id,
    })
    await context.close()
    await booked.context.close()
  })

  test('a payment SumUp always turns down (an amount of 11) leaves the table held and the checkout payable until the hold is over', async ({
    browser,
    baseURL,
  }) => {
    await savePolicy(bench!, {
      kind: 'deposit',
      freeCancellationHours: 24,
      holdMinutes: 5,
      depositCents: MAGIC_FAILING_CENTS,
    })
    try {
      const booked = await bookForPayment(browser, baseURL, {
        label: 'Magic 11',
        money: /11,00\s€/,
      })
      const checkoutId = await goToSumUp(booked.page, /^Payer 11,00\s€$/)
      // Even the success card is turned down at this amount: it is SumUp's way to test a failure.
      expect(await payOnSumUp(booked.page, TEST_CARD.pays)).toBe('refused')
      const failed = await checkoutOf(checkoutId)
      expect(failed.amount).toBe(11)
      expect(failed.status).toBe('FAILED')
      await booked.context.close()
      const context = await frenchGuest(browser, baseURL)
      const page = await context.newPage()
      await page.goto(booked.manageUrl)
      await expect(paymentRegion(page)).not.toContainText('Payé')
      await context.close()
      holdMagic = { booked, checkoutId }
    } finally {
      await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    }
  })

  /* ---------------------------------------------------------------- */
  /* Cancelling                                                        */
  /* ---------------------------------------------------------------- */

  test('cancelling before the cut-off refunds the whole deposit at SumUp, against the transaction id we kept', async ({
    browser,
    baseURL,
  }) => {
    const { booked, checkoutId } = await payDeposit(browser, baseURL, 'Cancel')
    const txn = successfulOf(await checkoutOf(checkoutId))

    await booked.page.goto(booked.manageUrl)
    await booked.page
      .getByRole('button', {
        name: new RegExp(`^Annuler : l'acompte de ${MONEY} vous sera remboursé$`),
      })
      .click()
    await booked.page.getByRole('button', { name: 'Oui, annuler' }).click()
    await expect(booked.page.getByText('Vous avez annulé cette réservation.')).toBeVisible({
      timeout: 30_000,
    })

    // SumUp's own record of the transaction holds one REFUND of the whole deposit.
    await expect
      .poll(async () => (await transactionOf(txn.id)).refunds, { timeout: 60_000 })
      .toEqual([{ amount: PSP_DEPOSIT_CENTS, status: 'REFUNDED' }])
    expect((await transactionOf(txn.id)).maxRefundable, 'nothing is left to refund').toBeNull()
    // The checkout does not show it: still PAID, its transaction still SUCCESSFUL.
    const after = await checkoutOf(checkoutId)
    expect(after.status).toBe('PAID')
    expect(successfulOf(after).id).toBe(txn.id)
    if (canMoveBookingsInTime()) {
      const ours = readTable('reservationPayments').filter(
        (row) => row.kind === 'refund' && row.externalId === txn.id,
      )
      expect(ours, 'one refund row, on the transaction id').toHaveLength(1)
      expect(ours[0]!.status).toBe('succeeded')
    }

    await booked.page.reload()
    const region = paymentRegion(booked.page)
    await expect(region).toContainText('Remboursé', { timeout: 30_000 })
    await expect
      .poll(
        () => mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')).length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await booked.page.waitForTimeout(3_000)
    expect(mailsTo(booked.email).filter((body) => body.includes('vous a remboursé'))).toHaveLength(
      1,
    )
    await booked.context.close()
  })

  test('after the cut-off the guest can no longer cancel online, and SumUp is not asked for anything', async ({
    browser,
    baseURL,
  }) => {
    await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 720, holdMinutes: 5 })
    try {
      const { booked, checkoutId } = await payDeposit(browser, baseURL, 'Cutoff', {
        date: isoDateAhead(4),
      })
      await booked.page.goto(booked.manageUrl)
      await expect(
        booked.page.getByText("Le délai d'annulation gratuite est dépassé", { exact: false }),
      ).toBeVisible({ timeout: 30_000 })
      await expect(booked.page.getByRole('button', { name: /^Annuler/ })).toHaveCount(0)
      const token = new URL(booked.manageUrl).pathname.split('/').pop()!
      const cancel = makeFunctionReference<'mutation', { token: string }, unknown>(
        'reservations:cancelByToken',
      )
      await expect(guestClient().mutation(cancel, { token })).rejects.toThrow(
        /cancellation_closed|délai/i,
      )
      const txn = successfulOf(await checkoutOf(checkoutId))
      const record = await transactionOf(txn.id)
      expect(record.refunds).toEqual([])
      expect(record.maxRefundable).toBe(PSP_DEPOSIT_CENTS)
      await booked.context.close()
    } finally {
      await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    }
  })

  /* ---------------------------------------------------------------- */
  /* The host                                                          */
  /* ---------------------------------------------------------------- */

  test('the host refunds part of a deposit, then the rest; SumUp’s own limits (a minimum, what is left) are said in words and never exceeded', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    const { booked, checkoutId } = await payDeposit(browser, baseURL, 'Host refund')
    await booked.context.close()
    const txn = successfulOf(await checkoutOf(checkoutId))

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    const startRefund = async (amount: string) => {
      await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
      await dialog.getByLabel('Montant à rembourser (€)').fill(amount)
    }
    const confirm = (amount: string) =>
      dialog.getByRole('button', { name: new RegExp(`^Rembourser ${amount}\\s€$`) })

    // Below SumUp's minimum: refused before anything is sent, with SumUp's limit in the words.
    await startRefund('0,10')
    await confirm('0,10').click()
    await expect(dialog).toContainText('SumUp refuse un remboursement inférieur', {
      timeout: 60_000,
    })
    expect((await transactionOf(txn.id)).refunds, 'nothing moved').toEqual([])
    await dialog.getByRole('button', { name: 'Retour' }).click()

    await startRefund('5,00')
    await expect(dialog.getByTestId('payment-consequence')).toContainText(/Remboursement partiel/)
    await confirm('5,00').click()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Remboursement de 5,00' }),
    ).toContainText('confirmé', { timeout: 60_000 })
    expect((await transactionOf(txn.id)).refunds).toEqual([{ amount: 500, status: 'REFUNDED' }])

    // More than what is left is not offered.
    await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
    await dialog.getByLabel('Montant à rembourser (€)').fill('16,00')
    await expect(
      dialog.getByRole('button', { name: new RegExp('^Rembourser 16,00\\s€$') }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Retour' }).click()

    await startRefund('15,00')
    await expect(dialog.getByTestId('payment-consequence')).toContainText(/Remboursement total/)
    await confirm('15,00').click()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Remboursement de 15,00' }),
    ).toContainText('confirmé', { timeout: 60_000 })
    const record = await transactionOf(txn.id)
    expect(record.refunds.map((refund) => refund.amount).sort((a, b) => a - b)).toEqual([500, 1500])
    expect(record.maxRefundable).toBeNull()
    await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
    await expect(dialog.getByRole('button', { name: "Rembourser l'acompte" })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* Two payments for one booking                                      */
  /* ---------------------------------------------------------------- */

  test('a second checkout paid for a booking already paid is recorded as a double and refunded at SumUp', async ({
    browser,
    page: admin,
  }) => {
    test.setTimeout(420_000)
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    test.skip(paidFirst === null, 'the first payment did not happen')
    const { booked, checkoutId: first } = paidFirst!
    // The product closes every other page once one settles, and a SumUp checkout can be paid
    // once, so a « double » needs a second CHECKOUT for the same booking. One is made by hand:
    // a pending row, with its own real SumUp checkout carrying that row's id.
    const deposit = readTable('reservationPayments').find(
      (row) => row.kind === 'deposit' && row.status === 'succeeded' && row.checkoutRef === first,
    )
    expect(deposit, 'the first deposit row').toBeTruthy()
    const key = `e2e-double-${RUN}`
    appendRows('reservationPayments', [
      {
        ...deposit,
        status: 'pending',
        externalId: undefined,
        settledAt: undefined,
        checkoutRef: undefined,
        checkoutUrl: undefined,
        idempotencyKey: key,
        // Old enough for the sweep to take it at once.
        createdAt: Date.now() - 10 * 60_000,
        updatedAt: Date.now() - 10 * 60_000,
      },
    ])
    const row = readTable('reservationPayments').find((r) => String(r.idempotencyKey) === key)!
    const second = await checkoutForRow(String(row._id), 'double')
    updateRow('reservationPayments', String(row._id), {
      checkoutRef: second.id,
      checkoutUrl: second.url,
    })

    // The buyer pays it on SumUp's page (the page of a checkout the booking no longer needs).
    const context = await frenchGuest(browser, undefined)
    const page = await context.newPage()
    await page.goto(second.url)
    expect(await payOnSumUp(page, TEST_CARD.pays)).toBe('paid')
    await context.close()
    const landed = successfulOf(await checkoutOf(second.id))

    runInternal('reservationPaymentActions:reconcile')
    await expect
      .poll(async () => (await transactionOf(landed.id)).refunds, {
        timeout: 120_000,
        intervals: [5_000],
      })
      .toEqual([{ amount: PSP_DEPOSIT_CENTS, status: 'REFUNDED' }])
    // The first deposit is untouched.
    const firstTxn = successfulOf(await checkoutOf(first))
    expect((await transactionOf(firstTxn.id)).refunds).toEqual([])

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await expect(dialog).toContainText('Paiement en double')
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* What the adapter's requests do at SumUp, without a browser         */
  /* ---------------------------------------------------------------- */

  test('the adapter against SumUp’s real answers: create, a reference seen twice, deactivation, refunds and their refusals', async () => {
    const client = sumupClient(API_KEY)
    const rowId = `e2e-adapter-${RUN}`
    const input = {
      rowId,
      amount: 1500,
      currency: 'EUR',
      merchantCode: MERCHANT,
      description: 'Acompte — réservation RES-0000-00000',
      redirectUrl: `${BASE}/reservation/payment/none?return=success`,
      validUntil: new Date(Date.now() + 31 * 60_000).toISOString(),
    }

    // Create: the adapter's body is accepted, and the same call repeated is RESUMED (SumUp has
    // no idempotency key and answers 409 to a seen reference; the adapter looks it up).
    const created = await client.createHostedCheckout(input)
    expect(created.url).toBe(`https://${HOSTED_HOST}/pay/c-${created.id}`)
    const resumed = await client.createHostedCheckout(input)
    expect(resumed, 'the same call, repeated, hands back the same checkout').toEqual(created)
    // Another amount under the same reference is NOT resumed: it would be another payment.
    await expect(client.createHostedCheckout({ ...input, amount: 1600 })).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATED_CHECKOUT',
      kind: 'refused',
    })

    // Reading, and what an unknown id looks like.
    const read = await client.getCheckout(created.id)
    expect(readSumUpCheckout(read)).toMatchObject({
      status: 'pending',
      reference: rowId,
      amountMinor: 1500,
      currency: 'EUR',
      checkoutRef: created.id,
    })
    await expect(client.getCheckout('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      kind: 'refused',
    })

    // Deactivating an unpaid checkout closes it (200, EXPIRED).
    await client.deactivate(created.id)
    expect((await client.getCheckout(created.id)).status).toBe('EXPIRED')
    expect(readSumUpCheckout(await client.getCheckout(created.id)).status).toBe('expired')
    // Closing it again is refused (409 CHECKOUT_EXPIRED: a deactivation sets the deadline to now);
    // the actions swallow that, then read the checkout back.
    await expect(client.deactivate(created.id)).rejects.toMatchObject({
      status: 409,
      code: 'CHECKOUT_EXPIRED',
      kind: 'refused',
    })
  })

  test('a refund SumUp reads wrongly is never sent: 0 means « everything », a minimum applies, and nothing is idempotent', async ({
    browser,
  }) => {
    // One real payment of 10 EUR to refund against.
    const paid = await sumupApi('POST', '/v0.1/checkouts', {
      checkout_reference: `e2e-refunds-${RUN}`,
      amount: 10,
      currency: 'EUR',
      merchant_code: MERCHANT,
      valid_until: new Date(Date.now() + 31 * 60_000).toISOString(),
      hosted_checkout: { enabled: true },
    })
    expect(paid.status).toBe(201)
    const context = await frenchGuest(browser, undefined)
    const page = await context.newPage()
    await page.goto(String(paid.body.hosted_checkout_url))
    expect(await payOnSumUp(page, TEST_CARD.pays)).toBe('paid')
    await context.close()
    const checkout = await checkoutOf(String(paid.body.id))
    const txn = successfulOf(checkout)
    const client = sumupClient(API_KEY)
    // A paid checkout cannot be deactivated: 409 (the actions swallow it, then read it back).
    await expect(client.deactivate(String(paid.body.id))).rejects.toMatchObject({
      status: 409,
      kind: 'refused',
    })
    expect((await checkoutOf(String(paid.body.id))).status).toBe('PAID')

    // The adapter refuses what SumUp would misread, before sending it.
    for (const amount of [0, 1, SUMUP_MIN_REFUND_MINOR - 1]) {
      await expect(client.refund(txn.id, amount)).rejects.toMatchObject({
        code: 'refund_amount_too_small',
        kind: 'refused',
      })
    }
    expect((await transactionOf(txn.id)).refunds, 'nothing was sent').toEqual([])

    // The adapter's refund (the legacy endpoint it uses) answers 204 and targets `transactions[].id`.
    await client.refund(txn.id, 200)
    expect((await transactionOf(txn.id)).refunds).toEqual([{ amount: 200, status: 'REFUNDED' }])
    // Above what is left: a 409 with SumUp's generic words, which the adapter explains.
    await expect(client.refund(txn.id, 900)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      kind: 'refused',
      message: expect.stringContaining('au-dessus de ce qui reste remboursable'),
    })
    // The same refund twice is two refunds: an Idempotency-Key header is ignored (hence the
    // adapter never retries a SumUp refund blindly).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sent = await sumupApi(
        'POST',
        `/v0.1/me/refund/${txn.id}`,
        { amount: 1 },
        { 'Idempotency-Key': `e2e-${RUN}` },
      )
      expect(sent.status).toBe(204)
    }
    expect((await transactionOf(txn.id)).refunds.map((refund) => refund.amount)).toEqual([
      200, 100, 100,
    ])
    // A transaction that does not exist, or a checkout id given as one: 404, nothing moves.
    await expect(client.refund('00000000-0000-0000-0000-000000000000', 500)).rejects.toMatchObject({
      status: 404,
      kind: 'refused',
    })
    await expect(client.refund(String(paid.body.id), 500)).rejects.toMatchObject({
      status: 404,
      kind: 'refused',
    })
    // Zero, sent behind the adapter's back, refunds EVERYTHING that is left (the reason for the guard).
    const everything = await sumupApi('POST', `/v0.1/me/refund/${txn.id}`, { amount: 0 })
    expect(everything.status).toBe(204)
    expect((await transactionOf(txn.id)).maxRefundable).toBeNull()
    expect(
      (await transactionOf(txn.id)).refunds.reduce((sum, refund) => sum + refund.amount, 0),
    ).toBe(1000)
  })

  test('SumUp’s two error shapes and an unauthorised key read as the adapter expects', async () => {
    const wrongKey = sumupClient('not-a-sumup-key')
    await expect(
      wrongKey.getCheckout('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 401, kind: 'auth' })
    const client = sumupClient(API_KEY)
    // A wrong merchant code, an amount of zero: the `{ error_code, message, param }` shape.
    const wrongMerchant = await sumupApi('POST', '/v0.1/checkouts', {
      checkout_reference: `e2e-wm-${RUN}`,
      amount: 5,
      currency: 'EUR',
      merchant_code: 'MZZZZZZZ',
    })
    expect(wrongMerchant.status).toBe(400)
    expect(wrongMerchant.body).toMatchObject({ error_code: 'INVALID', param: expect.any(String) })
    const zero = await sumupApi('POST', '/v0.1/checkouts', {
      checkout_reference: `e2e-zero-${RUN}`,
      amount: 0,
      currency: 'EUR',
      merchant_code: MERCHANT,
    })
    expect(zero.status).toBe(400)
    expect(zero.body.error_code).toBe('MISSING')
    // An expiry already past is refused, so the adapter's 4-minute floor matters.
    await expect(
      client.createHostedCheckout({
        rowId: `e2e-past-${RUN}`,
        amount: 500,
        currency: 'EUR',
        merchantCode: MERCHANT,
        description: 'd',
        redirectUrl: `${BASE}/x`,
        validUntil: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'CHECKOUT_EXPIRED' })
  })

  /* ---------------------------------------------------------------- */
  /* What SumUp cannot secure                                          */
  /* ---------------------------------------------------------------- */

  test('a card guarantee stays refused with SumUp connected: the settings say why, the server refuses the same policy, and a hosted checkout cannot save a card', async ({
    page,
    browser,
  }) => {
    await openSettings(page)
    const payments = card(page, 'Paiements')
    await expect(payments).toBeVisible({ timeout: 30_000 })
    const row = payments.locator('[data-provider="sumup"]')
    await expect(row).toContainText('Acompte')
    await expect(row).toContainText('Garantie')
    await expect(
      payments.getByRole('button', { name: 'Ajouter une garantie par carte' }),
    ).toBeDisabled()
    await expect(payments).toContainText("SumUp ne documente pas le débit d'une carte enregistrée")
    await expect(
      savePolicy(bench!, { kind: 'guarantee', freeCancellationHours: 24, holdMinutes: 15 }),
    ).rejects.toThrow(/garantie/i)
    await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })

    // The reason, observed: a HOSTED checkout opened to save a card (SETUP_RECURRING_PAYMENT, a
    // customer) is accepted by the API, but the page it serves is the ordinary form and no card
    // is saved.
    const customer = `e2e-guarantee-${RUN}`
    const made = await sumupApi('POST', '/v0.1/customers', {
      customer_id: customer,
      personal_details: { email: `e2e.sumup.guarantee.${RUN}@example.com` },
    })
    expect(made.status).toBe(201)
    const setup = await sumupApi('POST', '/v0.1/checkouts', {
      checkout_reference: `e2e-setup-${RUN}`,
      amount: 5,
      currency: 'EUR',
      merchant_code: MERCHANT,
      purpose: 'SETUP_RECURRING_PAYMENT',
      customer_id: customer,
      hosted_checkout: { enabled: true },
    })
    expect(setup.status).toBe(201)
    const guest = await frenchGuest(browser, undefined)
    const hosted = await guest.newPage()
    await hosted.goto(String(setup.body.hosted_checkout_url))
    expect(await payOnSumUp(hosted, TEST_CARD.pays)).toBe('refused')
    await guest.close()
    const after = await checkoutOf(String(setup.body.id))
    expect(after.status).toBe('PENDING')
    expect(after.transactions).toEqual([])
    const instruments = await sumupApi('GET', `/v0.1/customers/${customer}/payment-instruments`)
    expect(instruments.status).toBe(200)
    expect(instruments.body ?? []).toEqual([])
  })

  /* ---------------------------------------------------------------- */
  /* The hold, judged                                                  */
  /* ---------------------------------------------------------------- */

  test('(hold) when the hold runs out the guest is told the table was released, and SumUp’s checkouts are closed so nothing can be paid late', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(12 * 60_000)
    test.skip(hold === null || holdMagic === null, 'the hold tests did not start')
    const { booked, checkoutId } = hold!
    const context = await frenchGuest(browser, baseURL)
    const page = await context.newPage()
    await expect
      .poll(
        async () => {
          await page.goto(booked.paymentUrl)
          // The page answers from the server after a skeleton: wait for a title before counting.
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
          return await page
            .getByRole('heading', { name: 'Le délai est dépassé, la table a été libérée' })
            .count()
        },
        { timeout: 9 * 60_000, intervals: [20_000] },
      )
      .toBe(1)
    await context.close()
    // Both unpaid checkouts (the untouched one, and the one a refused card left FAILED) are
    // closed at SumUp: EXPIRED, with nothing paid. (SumUp closes them at the `valid_until` we sent,
    // which is the end of the hold, and the sweep deactivates them as well: at a five-minute
    // hold the two cannot be told apart. The deactivation itself is held by the adapter case.)
    // The second booking was made minutes after the first, so its hold ends later.
    for (const id of [checkoutId, holdMagic!.checkoutId]) {
      await expect
        .poll(async () => (await checkoutOf(id)).status, { timeout: 480_000, intervals: [5_000] })
        .toBe('EXPIRED')
      const closed = await checkoutOf(id)
      expect(closed.transactions.some((txn: SumUpObject) => txn.status === 'SUCCESSFUL')).toBe(
        false,
      )
    }
    // Nobody can pay an expired checkout: its hosted page says the session is over.
    const late = await frenchGuest(browser, baseURL)
    const hostedPage = await late.newPage()
    await hostedPage.goto(`https://${HOSTED_HOST}/pay/c-${checkoutId}`)
    await expect(hostedPage.getByText('Session expirée')).toBeVisible({ timeout: 30_000 })
    await expect(hostedPage.getByRole('button', { name: /^Payer/ })).toHaveCount(0)
    await late.close()
  })
})
