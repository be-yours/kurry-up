import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { makeFunctionReference } from 'convex/server'
import {
  ProviderError,
  paypalClient,
  readPayPalOrder,
} from '@be-yours/convex-functions/reservationProviders'
import {
  MAIL_LOG,
  NO_MAIL_LOG,
  card,
  ensureBook,
  fillBookingForm,
  isoDateAhead,
  mailsTo,
  newGuestContext,
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
 * The PayPal payment journey of a booking against PayPal's REAL SANDBOX: the Convex actions
 * call `api-m.sandbox.paypal.com`, the browser is sent to `www.sandbox.paypal.com/checkoutnow`.
 *
 * OPT-IN. This file runs only with `E2E_PAYPAL_LIVE=1`, `PAYPAL_CLIENT_ID`,
 * `PAYPAL_CLIENT_SECRET` and `PAYPAL_SANDBOX_MODE=true`. The credentials are read here only to
 * READ BACK what PayPal holds (orders, captures, refunds) and to make the BUYER's approval;
 * they are never printed or written, and every request of this file goes to the sandbox host
 * (`SANDBOX_API`, a constant: there is no way to point it at the live one). The deployment
 * under test holds the same credentials and NONE of the `RESERVATION_PSP_*` stand-in variables,
 * so the adapters reach the real sandbox host. See `tasks/reservations-sandbox-acceptance.md`.
 *
 * THE BUYER. A PayPal order is captured only after a buyer approved it, and approving on
 * paypal.com needs a sandbox buyer login this run does not have (and would not script past a
 * bot check). The sandbox business account does process cards, and PayPal's REST API lets the
 * server confirm an order with `payment_source.card` and PayPal's published test card numbers:
 * `buyerApproves` does that, on the order OUR adapter created. Everything after the approval is
 * ours and real: the return page, the capture, the sweep, the refunds. What this does NOT
 * cover is the approval screen itself (the page is opened and its address checked, nothing
 * more) and a login-based approval with a PayPal balance.
 *
 * If PayPal ever shows a bot check, the case stops: it is reported, never solved.
 */
test.setTimeout(300_000)

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? ''
const LIVE =
  process.env.E2E_PAYPAL_LIVE === '1' &&
  process.env.PAYPAL_SANDBOX_MODE === 'true' &&
  CLIENT_ID !== '' &&
  CLIENT_SECRET !== ''
const SKIP_REASON =
  'run with E2E_PAYPAL_LIVE=1, PAYPAL_SANDBOX_MODE=true and the SANDBOX app credentials in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'

/** The one host this file talks to. Not read from the environment. */
const SANDBOX_API = 'https://api-m.sandbox.paypal.com'
const PAYPAL_PAGES_HOST = 'www.sandbox.paypal.com'
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const ADMIN_STATE = 'e2e/.auth/admin.json'
const RUN = Date.now().toString(36)
const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
const PAY_BUTTON = new RegExp(`^Payer ${MONEY}$`)

/** PayPal's published sandbox test cards; `refused` is turned down when the buyer approves. */
const TEST_CARD = { pays: '4111111111111111', refused: '4000000000000002' } as const

let dayCounter = 30

function freshDate(): string {
  dayCounter += 1
  return isoDateAhead(dayCounter)
}

/* ------------------------------------------------------------------ */
/* What PayPal holds, read back with the sandbox credentials            */
/* ------------------------------------------------------------------ */

// PayPal's objects are read field by field for what a case asserts: a typed model would only
// restate the API reference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PayPalObject = any

let accessToken: string | null = null

async function bearer(): Promise<string> {
  if (accessToken) return accessToken
  const response = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  expect(response.status, 'the sandbox accepts the credentials').toBe(200)
  accessToken = ((await response.json()) as { access_token: string }).access_token
  return accessToken
}

async function paypalApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: PayPalObject }> {
  const response = await fetch(`${SANDBOX_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await bearer()}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: PayPalObject = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // an empty or non-JSON body is returned as text
  }
  return { status: response.status, body: parsed }
}

async function orderOf(id: string): Promise<PayPalObject> {
  // A read right after a write can answer 5xx for a moment on the sandbox (seen: a 503 on an order
  // created a second earlier); it is a read, so it is asked again.
  let last = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { status, body } = await paypalApi('GET', `/v2/checkout/orders/${id}`)
    if (status === 200) return body
    last = status
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  expect(last, `PayPal knows order ${id}`).toBe(200)
  return null
}

function capturesOf(order: PayPalObject): PayPalObject[] {
  return order.purchase_units?.[0]?.payments?.captures ?? []
}

function refundsOf(order: PayPalObject): Array<{ id: string; amount: number; status: string }> {
  const list: PayPalObject[] = order.purchase_units?.[0]?.payments?.refunds ?? []
  return list.map((refund) => ({
    id: refund.id,
    amount: Math.round(Number(refund.amount.value) * 100),
    status: refund.status,
  }))
}

let buyerCounter = 0

/**
 * The buyer's approval, made server-side with a published test card (see the header): the order
 * moves from `CREATED` to `APPROVED` and nothing is captured. A card PayPal turns down answers
 * 422 `PAYER_CANNOT_PAY` and leaves the order `CREATED`.
 */
async function buyerApproves(orderId: string, number: string = TEST_CARD.pays) {
  buyerCounter += 1
  return paypalApi(
    'POST',
    `/v2/checkout/orders/${orderId}/confirm-payment-source`,
    {
      payment_source: {
        card: { number, expiry: '2030-12', security_code: '123', name: 'E2E Sandbox Buyer' },
      },
    },
    { 'PayPal-Request-Id': `e2e-buyer-${RUN}-${buyerCounter}` },
  )
}

/** An order created straight at PayPal for one of OUR payment rows, outside the adapter. */
async function orderForRow(rowId: string, label: string): Promise<string> {
  const { status, body } = await paypalApi(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: rowId,
          custom_id: rowId,
          description: `Acompte — ${label}`,
          amount: { currency_code: 'EUR', value: (PSP_DEPOSIT_CENTS / 100).toFixed(2) },
        },
      ],
      application_context: {
        return_url: `${BASE}/reservation/payment/none?return=success`,
        cancel_url: `${BASE}/reservation/payment/none?return=cancelled`,
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    },
    { 'PayPal-Request-Id': `e2e-order-${RUN}-${label}` },
  )
  expect(status).toBe(201)
  return String(body.id)
}

/* ------------------------------------------------------------------ */
/* The guest's side                                                     */
/* ------------------------------------------------------------------ */

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
  options: {
    label: string
    date?: string
    time?: string
    partySize?: number
    /** Let the browser really load PayPal's approval page (one case does; the rest stop at its address). */
    loadPayPalPage?: boolean
  },
): Promise<Booked> {
  const date = options.date ?? freshDate()
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')
  const context = await newGuestContext(browser, baseURL)
  if (!options.loadPayPalPage) {
    // The address the site sends the guest to is what is asserted; the page itself is not needed.
    await context.route(`https://${PAYPAL_PAGES_HOST}/**`, (route) => route.abort())
  }
  const page = await context.newPage()
  const email = `e2e.paypal.${slug}.${RUN}@example.com`
  await fillBookingForm(page, {
    date,
    time: options.time ?? '19:00',
    partySize: options.partySize ?? 2,
    guest: { name: `E2E PayPal ${options.label} ${RUN}`, email, phone: '0612345678' },
  })
  // The box states the amount and the terms in words before anything is asked of the guest.
  await expect(paymentBox(page)).toContainText(new RegExp(MONEY))
  await paymentBox(page).getByRole('checkbox').click()
  await page.getByRole('button', { name: /^Continuer vers/ }).click()
  await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
  const paymentUrl = page.url().split('?')[0]!
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  // PayPal is the only connected provider: no chooser is offered.
  await expect(page.getByRole('button', { name: PAY_BUTTON })).toBeVisible({ timeout: 30_000 })
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
 * Press the button that leaves for PayPal and read where the site sent the browser: it has to be
 * PayPal's own approval page, over https, on the sandbox host, naming an order. Returns that order.
 */
async function goToPayPal(page: Page, button: RegExp | string = PAY_BUTTON): Promise<string> {
  const leave = page.getByRole('button', { name: button })
  await expect(leave).toBeVisible({ timeout: 30_000 })
  const sent = page.waitForRequest(
    (request) => request.url().startsWith(`https://${PAYPAL_PAGES_HOST}/checkoutnow`),
    { timeout: 60_000 },
  )
  await leave.click()
  const url = new URL((await sent).url())
  expect(url.protocol).toBe('https:')
  expect(url.host).toBe(PAYPAL_PAGES_HOST)
  expect(url.pathname).toBe('/checkoutnow')
  const token = url.searchParams.get('token')
  expect(token, 'the approval address names the order').toMatch(/^[A-Z0-9]{17}$/)
  return token!
}

/** PayPal's own bot check is never solved here: say so and stop. */
async function refuseBotCheck(page: Page) {
  const botCheck = page.getByText(/verify you are human|I am human|captcha|security challenge/i)
  if ((await botCheck.count()) > 0) throw new Error('PayPal shows a bot check: case stopped')
}

/**
 * Come back from PayPal the way PayPal sends the buyer: to the `return_url` the order carries,
 * with the order in `token`. (PayPal also adds a `PayerID`, which nothing here reads.)
 */
async function returnFromPayPal(
  page: Page,
  booked: Booked,
  orderId: string,
  outcome: 'success' | 'cancelled' = 'success',
) {
  await page.goto(`${booked.paymentUrl}?return=${outcome}&token=${orderId}`)
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

/** Book, go to PayPal, have the buyer approve, come back: the booking is confirmed. */
async function payDeposit(
  browser: Browser,
  baseURL: string | undefined,
  label: string,
  options: { date?: string } = {},
): Promise<{ booked: Booked; orderId: string }> {
  const booked = await bookForPayment(browser, baseURL, { label, ...options })
  const orderId = await goToPayPal(booked.page)
  expect((await buyerApproves(orderId)).body.status).toBe('APPROVED')
  await returnFromPayPal(booked.page, booked, orderId)
  await expectConfirmed(booked.page)
  return { booked, orderId }
}

test.describe('PayPal sandbox, end to end', () => {
  test.describe.configure({ mode: 'serial' })

  let bench: PaymentBench | null = null
  let restoreProvider: (() => Promise<void>) | null = null
  /** A booking whose deposit the later tests refund, cancel or replay. */
  let paidFirst: { booked: Booked; orderId: string } | null = null
  let hold: { booked: Booked; orderId: string } | null = null

  test.beforeAll(async ({ browser }) => {
    if (!LIVE) return
    const context = await browser.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
    const page = await context.newPage()
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    // The way the product holds « connected to PayPal »: the deployment's credentials, plus the
    // owner's switch `globalSettings.payments.paypal`. A card provider has to be chosen beside it
    // (`none` refuses every deposit); SumUp is chosen here because nothing is connected to it, so
    // PayPal is the only way to pay.
    restoreProvider = await connectProvider(bench, 'paypal')
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
  /* The page our adapter opens, and the hold                          */
  /* ---------------------------------------------------------------- */

  test('(hold) the booking page sends the guest to a real PayPal approval page; leaving it without approving keeps the table held', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, {
      label: 'Hold',
      partySize: 2,
      loadPayPalPage: true,
    })
    const orderId = await goToPayPal(booked.page)
    // The browser really arrives on PayPal's page (it may redirect inside paypal.com, to its own
    // login for one); its words are PayPal's and are not asserted, a bot check stops us.
    await booked.page.waitForURL((url) => url.host.endsWith('paypal.com'), { timeout: 60_000 })
    await booked.page.waitForLoadState('domcontentloaded', { timeout: 60_000 })
    await booked.page.waitForTimeout(3_000)
    await refuseBotCheck(booked.page)
    test.info().annotations.push({
      type: 'paypal-page',
      description: `${new URL(booked.page.url()).host}${new URL(booked.page.url()).pathname} — « ${(await booked.page.title()).slice(0, 80)} »`,
    })

    // What our adapter asked PayPal for.
    const order = await orderOf(orderId)
    expect(order).toMatchObject({ status: 'CREATED', intent: 'CAPTURE' })
    const unit = order.purchase_units[0]
    expect(unit.custom_id, 'our payment row id is echoed back').toBeTruthy()
    expect(unit.reference_id).toBe(unit.custom_id)
    expect(unit.amount).toMatchObject({
      currency_code: 'EUR',
      value: (PSP_DEPOSIT_CENTS / 100).toFixed(2),
    })
    expect(unit.description).toContain('Acompte')
    // `application_context` makes PayPal answer an `approve` link, not `payer-action`.
    const links: Array<{ rel: string; href: string }> = order.links
    expect(links.map((link) => link.rel)).toContain('approve')
    expect(links.map((link) => link.rel)).not.toContain('payer-action')
    expect(links.find((link) => link.rel === 'approve')!.href).toBe(
      `https://${PAYPAL_PAGES_HOST}/checkoutnow?token=${orderId}`,
    )
    expect(capturesOf(order)).toHaveLength(0)
    if (canMoveBookingsInTime()) {
      const row = readTable('reservationPayments').find(
        (candidate) => candidate.checkoutRef === orderId,
      )
      expect(row, 'the row remembers the order').toBeTruthy()
      expect(String(row!._id)).toBe(unit.custom_id)
      expect(row!.status).toBe('pending')
    }

    // The booking is not paid, and the guest's link says so.
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()
    hold = { booked, orderId }
    await booked.context.close()
  })

  test('the sweep over an order nobody approved reads it back, captures nothing and leaves the row pending', async () => {
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    test.skip(hold === null, 'the hold test did not start')
    const { orderId } = hold!
    runInternal('reservationPaymentActions:reconcile')
    const order = await orderOf(orderId)
    expect(order.status, 'the sweep did not approve or capture anything').toBe('CREATED')
    expect(capturesOf(order)).toHaveLength(0)
    const row = readTable('reservationPayments').find(
      (candidate) => candidate.checkoutRef === orderId,
    )
    expect(row!.status).toBe('pending')
  })

  /* ---------------------------------------------------------------- */
  /* Paying                                                            */
  /* ---------------------------------------------------------------- */

  test('the booking is confirmed only after OUR capture: approved at PayPal is not yet paid', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Paid' })
    expect(mailsTo(booked.email)).toHaveLength(0)
    const orderId = await goToPayPal(booked.page)
    expect((await buyerApproves(orderId)).body.status).toBe('APPROVED')

    // Approved and not captured: PayPal holds no money for us yet, and the booking is not
    // confirmed whatever the guest's browser does.
    expect(capturesOf(await orderOf(orderId))).toHaveLength(0)
    const wait = await newGuestContext(browser, baseURL)
    const waiting = await wait.newPage()
    await waiting.goto(booked.manageUrl)
    await expect(paymentRegion(waiting)).not.toContainText('Payé')
    await wait.close()
    expect(mailsTo(booked.email)).toHaveLength(0)

    await returnFromPayPal(booked.page, booked, orderId)
    await expectConfirmed(booked.page)
    await expect(
      booked.page.getByText(new RegExp(`Votre acompte de ${MONEY} est payé`)),
    ).toBeVisible()

    const order = await orderOf(orderId)
    expect(order.status).toBe('COMPLETED')
    const [capture] = capturesOf(order)
    expect(capture).toMatchObject({
      status: 'COMPLETED',
      amount: { currency_code: 'EUR', value: (PSP_DEPOSIT_CENTS / 100).toFixed(2) },
    })
    expect(capture.custom_id, 'the capture carries our row id').toBe(
      order.purchase_units[0].custom_id,
    )

    // One confirmation mail, with the receipt.
    await expect
      .poll(() => mailsTo(booked.email).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1)
    await booked.page.waitForTimeout(3_000)
    expect(mailsTo(booked.email)).toHaveLength(1)

    await booked.page.goto(booked.manageUrl)
    const region = paymentRegion(booked.page)
    await expect(region).toContainText('Payé')
    await expect(region).toContainText(new RegExp(MONEY))
    paidFirst = { booked, orderId }
    await booked.context.close()
  })

  test('a guest who approved and was never sent back is confirmed by the sweep, which captures (there is no PayPal webhook)', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(420_000)
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    const booked = await bookForPayment(browser, baseURL, { label: 'Sweep' })
    const orderId = await goToPayPal(booked.page)
    expect((await buyerApproves(orderId)).body.status).toBe('APPROVED')
    await booked.context.close()

    // Nobody came back: the booking still waits.
    let context = await newGuestContext(browser, baseURL)
    let page = await context.newPage()
    await page.goto(booked.manageUrl)
    await page.waitForTimeout(3_000)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()

    // The sweep leaves an attempt alone for its first three minutes (the guest may still be on
    // the page): run it as the clock would, until it has read PayPal, captured and settled.
    context = await newGuestContext(browser, baseURL)
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
    const order = await orderOf(orderId)
    expect(order.status).toBe('COMPLETED')
    expect(capturesOf(order), 'one capture, not one per sweep').toHaveLength(1)
  })

  test('closing the PayPal page without paying keeps the booking held, and the same link pays later on the same order', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Closed tab' })
    const first = await goToPayPal(booked.page)
    await booked.context.close()

    const context = await newGuestContext(browser, baseURL)
    await context.route(`https://${PAYPAL_PAGES_HOST}/**`, (route) => route.abort())
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await page.goto(booked.paymentUrl)
    const again = await goToPayPal(page, /^(Payer|Réessayer le paiement)/)
    expect(again, 'the live PayPal order is handed back, not remade').toBe(first)
    expect((await buyerApproves(again)).body.status).toBe('APPROVED')
    await returnFromPayPal(page, booked, again)
    await expectConfirmed(page)
    expect(capturesOf(await orderOf(first))).toHaveLength(1)
    await context.close()
  })

  test('a funding source PayPal turns down keeps the order unpaid; cancelling says nothing was debited; a good source then pays the SAME order', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Declined' })
    const orderId = await goToPayPal(booked.page)
    // The buyer's card is refused when approving: PayPal's own words, order still `CREATED`.
    const refused = await buyerApproves(orderId, TEST_CARD.refused)
    expect(refused.status).toBe(422)
    expect(refused.body.details[0].issue).toBe('PAYER_CANNOT_PAY')
    expect((await orderOf(orderId)).status).toBe('CREATED')

    // The buyer gives up on PayPal's page: the cancel link.
    await returnFromPayPal(booked.page, booked, orderId, 'cancelled')
    await expect(booked.page.getByText("Paiement annulé, rien n'a été débité.")).toBeVisible({
      timeout: 30_000,
    })
    expect(capturesOf(await orderOf(orderId))).toHaveLength(0)
    await booked.page.goto(booked.manageUrl)
    await expect(paymentRegion(booked.page)).not.toContainText('Payé')

    // Try again: the same order is handed back, and another source pays it.
    await booked.page.goto(booked.paymentUrl)
    const again = await goToPayPal(booked.page, /^(Payer|Réessayer le paiement)/)
    expect(again).toBe(orderId)
    expect((await buyerApproves(orderId)).body.status).toBe('APPROVED')
    await returnFromPayPal(booked.page, booked, orderId)
    await expectConfirmed(booked.page)
    expect(capturesOf(await orderOf(orderId))).toHaveLength(1)
    await booked.context.close()
  })

  /* ---------------------------------------------------------------- */
  /* Cancelling                                                        */
  /* ---------------------------------------------------------------- */

  test('cancelling before the cut-off refunds the whole deposit at PayPal, and the row keeps PayPal’s refund id', async ({
    browser,
    baseURL,
  }) => {
    const { booked, orderId } = await payDeposit(browser, baseURL, 'Cancel')
    const [capture] = capturesOf(await orderOf(orderId))

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

    await expect
      .poll(async () => refundsOf(await orderOf(orderId)).map((r) => `${r.amount}:${r.status}`), {
        timeout: 60_000,
      })
      .toEqual([`${PSP_DEPOSIT_CENTS}:COMPLETED`])
    const refund = refundsOf(await orderOf(orderId))[0]!
    // PayPal's `id` is the refund resource's id; the row of ours keeps exactly it.
    const resource = await paypalApi('GET', `/v2/payments/refunds/${refund.id}`)
    expect(resource.status).toBe(200)
    expect(resource.body).toMatchObject({ id: refund.id, status: 'COMPLETED' })
    expect((await paypalApi('GET', `/v2/payments/captures/${capture.id}`)).body.status).toBe(
      'REFUNDED',
    )
    if (canMoveBookingsInTime()) {
      const ours = readTable('reservationPayments').filter(
        (row) => row.kind === 'refund' && row.externalId === refund.id,
      )
      expect(ours, 'one refund row holds PayPal’s refund id').toHaveLength(1)
      expect(ours[0]!.status).toBe('succeeded')
    }

    await booked.page.reload()
    const region = paymentRegion(booked.page)
    await expect(region).toContainText('Remboursé', { timeout: 30_000 })
    await expect(region).toContainText('Le remboursement a été effectué')
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

  test('after the cut-off the guest can no longer cancel online, and PayPal is not asked for anything', async ({
    browser,
    baseURL,
  }) => {
    await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 720, holdMinutes: 5 })
    try {
      const { booked, orderId } = await payDeposit(browser, baseURL, 'Cutoff', {
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
      const order = await orderOf(orderId)
      expect(refundsOf(order)).toHaveLength(0)
      expect(capturesOf(order)[0].status).toBe('COMPLETED')
      await booked.context.close()
    } finally {
      await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    }
  })

  /* ---------------------------------------------------------------- */
  /* The host                                                          */
  /* ---------------------------------------------------------------- */

  test('the host refunds part of a deposit, then the rest, and never more than was captured', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    const { booked, orderId } = await payDeposit(browser, baseURL, 'Host refund')
    await booked.context.close()
    const [capture] = capturesOf(await orderOf(orderId))

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    const startRefund = async (amount: string, expectLine: RegExp) => {
      await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
      await dialog.getByLabel('Montant à rembourser (€)').fill(amount)
      await expect(dialog.getByTestId('payment-consequence')).toContainText(expectLine)
    }
    const confirm = (amount: string) =>
      dialog.getByRole('button', { name: new RegExp(`^Rembourser ${amount}\\s€$`) })

    await startRefund('5,00', /Remboursement partiel/)
    await confirm('5,00').click()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Remboursement de 5,00' }),
    ).toContainText('confirmé', { timeout: 60_000 })
    expect(refundsOf(await orderOf(orderId)).map((r) => `${r.amount}:${r.status}`)).toEqual([
      '500:COMPLETED',
    ])
    expect((await paypalApi('GET', `/v2/payments/captures/${capture.id}`)).body.status).toBe(
      'PARTIALLY_REFUNDED',
    )

    // More than what is left is refused before PayPal is asked.
    await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
    await dialog.getByLabel('Montant à rembourser (€)').fill('16,00')
    await expect(
      dialog.getByRole('button', { name: new RegExp('^Rembourser 16,00\\s€$') }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Retour' }).click()

    await startRefund('15,00', /Remboursement total/)
    await confirm('15,00').click()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Remboursement de 15,00' }),
    ).toContainText('confirmé', { timeout: 60_000 })
    const refunds = refundsOf(await orderOf(orderId))
    expect(refunds.map((r) => r.amount).sort((a, b) => a - b)).toEqual([500, 1500])
    expect(refunds.every((r) => r.status === 'COMPLETED')).toBe(true)
    expect((await paypalApi('GET', `/v2/payments/captures/${capture.id}`)).body.status).toBe(
      'REFUNDED',
    )
    await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
    await expect(dialog.getByRole('button', { name: "Rembourser l'acompte" })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* Two payments for one booking                                      */
  /* ---------------------------------------------------------------- */

  test('a second order for a booking already paid: approved but never captured by the sweep; one captured elsewhere is recorded as a double and refunded at PayPal', async ({
    browser,
    page: admin,
  }) => {
    test.setTimeout(420_000)
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    test.skip(paidFirst === null, 'the first payment did not happen')
    const { booked, orderId: firstOrder } = paidFirst!
    // The product closes every other page once one settles, and PayPal takes one capture per
    // order, so a « double » needs a second ORDER for the same booking. Two are made by hand: a
    // pending row each, with its own real PayPal order carrying that row's id.
    const deposit = readTable('reservationPayments').find(
      (row) =>
        row.kind === 'deposit' && row.status === 'succeeded' && row.checkoutRef === firstOrder,
    )
    expect(deposit, 'the first deposit row').toBeTruthy()

    const addRow = async (label: string) => {
      const key = `e2e-double-${RUN}-${label}`
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
      const order = await orderForRow(String(row._id), label)
      updateRow('reservationPayments', String(row._id), {
        checkoutRef: order,
        checkoutUrl: `https://${PAYPAL_PAGES_HOST}/checkoutnow?token=${order}`,
      })
      return { rowId: String(row._id), order }
    }

    // (a) Approved at PayPal, booking already paid: capturing would take money for nothing.
    const approvedOnly = await addRow('approved')
    expect((await buyerApproves(approvedOnly.order)).body.status).toBe('APPROVED')
    // (b) Captured outside the product (a capture that landed anyway).
    const landed = await addRow('landed')
    expect((await buyerApproves(landed.order)).body.status).toBe('APPROVED')
    const captured = await paypalApi(
      'POST',
      `/v2/checkout/orders/${landed.order}/capture`,
      undefined,
      { 'PayPal-Request-Id': `e2e-landed-${RUN}` },
    )
    expect(captured.status).toBe(201)

    runInternal('reservationPaymentActions:reconcile')
    await expect
      .poll(
        async () => refundsOf(await orderOf(landed.order)).map((r) => `${r.amount}:${r.status}`),
        {
          timeout: 120_000,
          intervals: [5_000],
        },
      )
      .toEqual([`${PSP_DEPOSIT_CENTS}:COMPLETED`])

    const left = await orderOf(approvedOnly.order)
    expect(left.status, 'the sweep did not capture a payment the booking no longer needs').toBe(
      'APPROVED',
    )
    expect(capturesOf(left)).toHaveLength(0)
    // The first deposit is untouched.
    const first = await orderOf(firstOrder)
    expect(refundsOf(first)).toHaveLength(0)
    expect(capturesOf(first)[0].status).toBe('COMPLETED')

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await expect(dialog).toContainText('Paiement en double')
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* What the adapter's requests do at PayPal, without a browser        */
  /* ---------------------------------------------------------------- */

  test('the adapter against PayPal’s real answers: create, capture of an unapproved order, replays, a declined capture, refunds', async () => {
    const credentials = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, sandbox: true }
    const client = paypalClient(credentials)
    const input = (rowId: string, amount: number) => ({
      rowId,
      amount,
      currency: 'EUR',
      description: 'Acompte — réservation RES-0000-00000',
      brandName: 'E2E Restaurant',
      returnUrl: `${BASE}/reservation/payment/none?return=success`,
      cancelUrl: `${BASE}/reservation/payment/none?return=cancelled`,
    })

    // Create: the approval link, the replay under the same key and a changed body under it.
    const row = `e2e-live-${RUN}-a`
    const created = await client.createOrder(input(row, 2000))
    expect(created.approveUrl).toBe(`https://${PAYPAL_PAGES_HOST}/checkoutnow?token=${created.id}`)
    const replayed = await client.createOrder(input(row, 2000))
    expect(replayed.id, 'the same PayPal-Request-Id returns the same order').toBe(created.id)
    const changed = await client.createOrder(input(row, 3000))
    expect(
      changed.id,
      'a changed body under the same id is NOT made: the first order comes back',
    ).toBe(created.id)
    expect((await orderOf(created.id)).purchase_units[0].amount.value).toBe('20.00')

    // Capture of an order nobody approved: PayPal refuses, the adapter reads the order back.
    const raw = await paypalApi('POST', `/v2/checkout/orders/${created.id}/capture`, undefined, {
      'PayPal-Request-Id': `e2e-raw-${RUN}`,
    })
    expect(raw.status).toBe(422)
    expect(raw.body.details[0].issue).toBe('ORDER_NOT_APPROVED')
    const unapproved = await client.captureOrder(created.id, row)
    expect(readPayPalOrder(unapproved)).toMatchObject({ status: 'pending', reference: row })
    expect(capturesOf(await orderOf(created.id))).toHaveLength(0)

    // A failed capture is not replayed under its PayPal-Request-Id: once the buyer approved, the
    // SAME id (`capture-<row>`) captures.
    expect((await buyerApproves(created.id)).body.status).toBe('APPROVED')
    const captured = readPayPalOrder(await client.captureOrder(created.id, row))
    expect(captured).toMatchObject({
      status: 'completed',
      amountMinor: 2000,
      currency: 'EUR',
      reference: row,
    })
    const again = readPayPalOrder(await client.captureOrder(created.id, row))
    expect(again.externalId, 'a replayed capture answers the same capture').toBe(
      captured.externalId,
    )
    const captureId = captured.externalId!

    // A capture PayPal declines (its mock INSTRUMENT_DECLINED, the way PayPal documents testing
    // an error): the adapter reads the order back, it stays APPROVED and nothing moved.
    const declinedRow = `e2e-live-${RUN}-b`
    const declinedOrder = await client.createOrder(input(declinedRow, 2000))
    expect((await buyerApproves(declinedOrder.id)).body.status).toBe('APPROVED')
    const mocking = paypalClient(credentials, (url, init) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          ...(String(url).endsWith('/capture')
            ? {
                'PayPal-Mock-Response': JSON.stringify({
                  mock_application_codes: 'INSTRUMENT_DECLINED',
                }),
              }
            : {}),
        },
      }),
    )
    const declined = await mocking.captureOrder(declinedOrder.id, declinedRow)
    expect(readPayPalOrder(declined)).toMatchObject({ status: 'approved' })
    expect(capturesOf(await orderOf(declinedOrder.id))).toHaveLength(0)

    // Refunds: the id is the refund resource's, a replay returns it, a changed amount under the
    // same key is not made, and PayPal's own refusals carry their issue.
    const key = `e2e-live-refund-${RUN}`
    const first = await client.refund({
      captureId,
      amount: 500,
      currency: 'EUR',
      idempotencyKey: key,
    })
    expect(first.status).toBe('COMPLETED')
    const replay = await client.refund({
      captureId,
      amount: 500,
      currency: 'EUR',
      idempotencyKey: key,
    })
    expect(replay.id).toBe(first.id)
    const changedAmount = await client.refund({
      captureId,
      amount: 600,
      currency: 'EUR',
      idempotencyKey: key,
    })
    expect(changedAmount.id, 'a changed amount under the same key is not made').toBe(first.id)
    expect(refundsOf(await orderOf(created.id))).toEqual([
      { id: first.id, amount: 500, status: 'COMPLETED' },
    ])
    expect(await client.getRefund(first.id)).toEqual({ id: first.id, status: 'COMPLETED' })

    const tooMuch = await client
      .refund({ captureId, amount: 1600, currency: 'EUR', idempotencyKey: `${key}-b` })
      .catch((error: unknown) => error)
    expect(tooMuch).toBeInstanceOf(ProviderError)
    expect(tooMuch).toMatchObject({ status: 422, code: 'REFUND_AMOUNT_EXCEEDED', kind: 'refused' })
    await client.refund({ captureId, amount: 1500, currency: 'EUR', idempotencyKey: `${key}-c` })
    const fully = await client
      .refund({ captureId, amount: 100, currency: 'EUR', idempotencyKey: `${key}-d` })
      .catch((error: unknown) => error)
    expect(fully).toMatchObject({ status: 422, code: 'CAPTURE_FULLY_REFUNDED', kind: 'refused' })
    // PayPal lists the refunds of one order in no promised order (two made in the same second
    // came back newest first): the amounts are compared as a set.
    expect(
      refundsOf(await orderOf(created.id))
        .map((r) => r.amount)
        .sort((a, b) => a - b),
    ).toEqual([500, 1500])
    expect(
      readPayPalOrder(await orderOf(created.id)).status,
      'a refunded capture was still paid',
    ).toBe('completed')

    // A refund asked for something that was never captured: an order id, or nothing at all.
    for (const target of [declinedOrder.id, 'NOSUCHCAPTURE0000']) {
      const missing = await client
        .refund({
          captureId: target,
          amount: 100,
          currency: 'EUR',
          idempotencyKey: `${key}-${target}`,
        })
        .catch((error: unknown) => error)
      expect(missing).toMatchObject({ status: 404, code: 'INVALID_RESOURCE_ID', kind: 'refused' })
    }
    expect(refundsOf(await orderOf(declinedOrder.id))).toHaveLength(0)
  })

  test('PayPal’s experience_context answers a payer-action link and PAYER_ACTION_REQUIRED, which the adapter reads as pending', async () => {
    // What the adapter does NOT send: `payment_source.paypal.experience_context`, the newer
    // spelling of `application_context`. Both are accepted by the sandbox; the adapter reads
    // either link, so moving to the newer one would not change what the guest sees.
    const row = `e2e-live-${RUN}-xp`
    const { status, body } = await paypalApi(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: row,
            custom_id: row,
            amount: { currency_code: 'EUR', value: '20.00' },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: `${BASE}/reservation/payment/none?return=success`,
              cancel_url: `${BASE}/reservation/payment/none?return=cancelled`,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
      { 'PayPal-Request-Id': `e2e-xp-${RUN}` },
    )
    expect([200, 201]).toContain(status)
    expect(body.status).toBe('PAYER_ACTION_REQUIRED')
    const link = (body.links as Array<{ rel: string; href: string }>).find(
      (candidate) => candidate.rel === 'payer-action',
    )
    expect(link?.href).toBe(`https://${PAYPAL_PAGES_HOST}/checkoutnow?token=${body.id}`)
    expect(readPayPalOrder(await orderOf(body.id)).status).toBe('pending')
  })

  /* ---------------------------------------------------------------- */
  /* What PayPal cannot secure                                         */
  /* ---------------------------------------------------------------- */

  test('a card guarantee stays refused with PayPal connected: the settings say why and the server refuses the same policy', async ({
    page,
  }) => {
    await openSettings(page)
    const payments = card(page, 'Paiements')
    await expect(payments).toBeVisible({ timeout: 30_000 })
    const row = payments.locator('[data-provider="paypal"]')
    await expect(row).toContainText('Acompte')
    await expect(row).toContainText('Garantie')
    await expect(
      payments.getByRole('button', { name: 'Ajouter une garantie par carte' }),
    ).toBeDisabled()
    await expect(payments).toContainText("Une autorisation PayPal n'est garantie que 3 jours")
    await expect(
      savePolicy(bench!, { kind: 'guarantee', freeCancellationHours: 24, holdMinutes: 15 }),
    ).rejects.toThrow(/garantie/i)
    // The deposit rule the other cases rely on is still the saved one.
    await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
  })

  /* ---------------------------------------------------------------- */
  /* The hold, judged                                                  */
  /* ---------------------------------------------------------------- */

  test('(hold) when the hold runs out the guest is told the table was released, and the order was never captured', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(12 * 60_000)
    test.skip(hold === null, 'the hold test did not start')
    const { booked, orderId } = hold!
    const context = await newGuestContext(browser, baseURL)
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
    const order = await orderOf(orderId)
    // PayPal has no call to close an order nobody approved: it is left to expire on its own,
    // and nothing was ever captured for it.
    expect(['CREATED', 'VOIDED']).toContain(order.status)
    expect(capturesOf(order)).toHaveLength(0)
    await context.close()
  })

  test('a guest payment page still refuses a booking nobody paid for after the hold (no capture can land late)', async ({
    browser,
    baseURL,
  }) => {
    test.skip(hold === null, 'the hold test did not start')
    const { booked, orderId } = hold!
    // The buyer approves the old order AFTER the table was released: the sweep must not capture it.
    const approved = await buyerApproves(orderId)
    test.info().annotations.push({
      type: 'late-approval',
      description: `HTTP ${approved.status} ${approved.body?.status ?? approved.body?.details?.[0]?.issue ?? ''}`,
    })
    if (canMoveBookingsInTime()) runInternal('reservationPaymentActions:reconcile')
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()
    expect(capturesOf(await orderOf(orderId)), 'a released table takes no money').toHaveLength(0)
  })
})
