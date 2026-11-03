import { createHmac } from 'node:crypto'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { makeFunctionReference } from 'convex/server'
import { ProviderError, stripeClient } from '@be-yours/convex-functions/reservationProviders'
import {
  MAIL_LOG,
  NO_MAIL_LOG,
  ensureBook,
  fillBookingForm,
  isoDateAhead,
  mailsTo,
  newGuestContext,
  openDayBook,
  openPaymentBench,
  paymentBox,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  NO_TIME_TRAVEL,
  PSP_DEPOSIT_CENTS,
  PSP_FEE_CAP_CENTS,
  canMoveBookingsInTime,
  connectProvider,
  guestClient,
  appendRows,
  moveBookingToThePast,
  readTable,
  reservationIdOf,
  runInternal,
  savePolicy,
  updateRow,
} from '../helpers/psp-standin.helpers'

/**
 * The Stripe payment journey of a booking against Stripe's REAL test mode: the browser pays on
 * `checkout.stripe.com` with Stripe's published test cards, the Convex actions call
 * `api.stripe.com`, and the Stripe CLI forwards the real webhooks to the bench.
 *
 * OPT-IN. This file runs only with `E2E_STRIPE_LIVE=1` and a TEST secret key in
 * `STRIPE_SECRET_KEY` (a key that does not start with `sk_test_` is refused). The key is read
 * from the environment of the test process only to READ BACK what Stripe holds (sessions,
 * intents, refunds); it is never printed or written. The deployment under test holds the same
 * key and NONE of the `RESERVATION_PSP_*` stand-in variables, so the adapters reach the real
 * host. See `tasks/reservations-sandbox-acceptance.md` for the bench and what was proved.
 *
 * Environment: `E2E_STRIPE_LIVE=1`, `STRIPE_SECRET_KEY`, `E2E_MAIL_LOG`, and for the webhook
 * replay `E2E_WEBHOOK_URL` (the bench's `/webhooks/stripe`) with `E2E_WEBHOOK_SECRET` (the
 * signing secret `stripe listen` printed for the deployment).
 *
 * If Stripe ever shows a bot check, the case stops: it is reported, never solved.
 */
test.setTimeout(300_000)

const KEY = process.env.STRIPE_SECRET_KEY ?? ''
const LIVE = process.env.E2E_STRIPE_LIVE === '1' && KEY.startsWith('sk_test_')
const SKIP_REASON =
  'run with E2E_STRIPE_LIVE=1 and a Stripe TEST secret key in STRIPE_SECRET_KEY (sk_test_…)'
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const ADMIN_STATE = 'e2e/.auth/admin.json'
const RUN = Date.now().toString(36)
const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
const PAY_BUTTON = new RegExp(`^Payer ${MONEY}$`)
const STRIPE_HOST = 'checkout.stripe.com'

const CARD = {
  pays: '4242424242424242',
  declined: '4000000000000002',
  threeDSecure: '4000002500003155',
  threeDSecureAlways: '4000002760003184',
  savesThenDeclined: '4000000000000341',
  pendingRefund: '4000000000007726',
  dispute: '4000000000000259',
} as const

let dayCounter = 30

function freshDate(): string {
  dayCounter += 1
  return isoDateAhead(dayCounter)
}

/* ------------------------------------------------------------------ */
/* What Stripe holds, read back with the test key                       */
/* ------------------------------------------------------------------ */

// Stripe's objects are read field by field for what a case asserts: a typed model would only
// restate the API reference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeObject = any

async function stripeGet(path: string): Promise<StripeObject> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  })
  return await response.json()
}

async function sessionOf(id: string): Promise<StripeObject> {
  return stripeGet(`/checkout/sessions/${id}?expand[]=payment_intent&expand[]=setup_intent`)
}

async function refundsOf(
  paymentIntent: string,
): Promise<Array<{ amount: number; status: string }>> {
  const list = await stripeGet(`/refunds?payment_intent=${paymentIntent}&limit=100`)
  return list.data
}

/** `cs_test_…` out of the address of a Checkout page. */
function sessionIdIn(url: string): string {
  const found = url.match(/(cs_test_[A-Za-z0-9]+)/)
  expect(found, 'the address of the Stripe page names its session').toBeTruthy()
  return found![1]!
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
  options: { label: string; date?: string; time?: string; partySize?: number },
): Promise<Booked> {
  const date = options.date ?? freshDate()
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')
  const context = await newGuestContext(browser, baseURL)
  const page = await context.newPage()
  const email = `e2e.live.${slug}.${RUN}@example.com`
  await fillBookingForm(page, {
    date,
    time: options.time ?? '19:00',
    partySize: options.partySize ?? 2,
    guest: { name: `E2E Live ${options.label} ${RUN}`, email, phone: '0612345678' },
  })
  // The box states the amount and the terms in words before anything is asked of the guest.
  await expect(paymentBox(page)).toContainText(new RegExp(MONEY))
  await paymentBox(page).getByRole('checkbox').click()
  await page.getByRole('button', { name: /^Continuer vers/ }).click()
  await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
  const paymentUrl = page.url().split('?')[0]!
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  // Stripe is the only connected provider: no chooser is offered.
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

/** Press the button that leaves for Stripe and wait for its page. Returns the session id. */
async function goToStripe(page: Page, button: RegExp | string = PAY_BUTTON): Promise<string> {
  const leave = page.getByRole('button', { name: button })
  await expect(leave).toBeVisible({ timeout: 30_000 })
  await leave.click()
  await expect.poll(() => new URL(page.url()).host, { timeout: 60_000 }).toBe(STRIPE_HOST)
  return sessionIdIn(page.url())
}

/** Fill the card form of Stripe's own page and submit it. Stops there. */
async function submitCard(page: Page, card: string) {
  await expect.poll(() => new URL(page.url()).host, { timeout: 60_000 }).toBe(STRIPE_HOST)
  // Stripe's own bot check is never solved here: say so and stop.
  const botCheck = page.getByText(/verify you are human|I am human|captcha/i)
  if ((await botCheck.count()) > 0) throw new Error('Stripe shows a bot check: case stopped')
  await page.locator('#cardNumber').fill(card)
  await page.locator('#cardExpiry').fill('1234')
  await page.locator('#cardCvc').fill('123')
  await page.locator('#billingName').fill('E2E Guest')
  const postal = page.locator('#billingPostalCode')
  if (await postal.isVisible().catch(() => false)) await postal.fill('75001')
  const email = page.locator('#email')
  if ((await email.isVisible().catch(() => false)) && (await email.inputValue()) === '') {
    await email.fill('e2e.live.guest@example.com')
  }
  await page.locator('button[type="submit"]').click()
}

/** Complete (or fail) the 3-D Secure test page, which Stripe serves in a nested frame. */
async function authenticate(page: Page, outcome: 'Complete' | 'Fail' = 'Complete') {
  const find = async () => {
    for (const frame of page.frames()) {
      const button = frame.getByRole('button', { name: new RegExp(`^${outcome}$`, 'i') })
      if ((await button.count().catch(() => 0)) > 0) return button.first()
    }
    return null
  }
  await expect.poll(async () => (await find()) !== null, { timeout: 60_000 }).toBe(true)
  // The challenge frame answers a click only once it has finished loading.
  await page.waitForTimeout(4_000)
  const button = await find()
  expect(button, 'the 3-D Secure test page is still there').not.toBeNull()
  await button!.click()
}

async function waitBackOnSite(page: Page, baseURL: string | undefined) {
  const ours = new URL(baseURL ?? page.url()).host
  await page.waitForURL((url) => url.host === ours, { timeout: 90_000 })
}

/** Pay on Stripe's page with `card` and come back to the site. Returns the session id. */
async function pay(
  booked: Booked,
  baseURL: string | undefined,
  options: { card?: string; button?: RegExp | string; threeDSecure?: boolean } = {},
): Promise<string> {
  const id = await goToStripe(booked.page, options.button)
  await submitCard(booked.page, options.card ?? CARD.pays)
  if (options.threeDSecure) await authenticate(booked.page)
  await waitBackOnSite(booked.page, baseURL)
  return id
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

test.describe('Stripe test mode, end to end', () => {
  test.describe.configure({ mode: 'serial' })

  let bench: PaymentBench | null = null
  let restoreProvider: (() => Promise<void>) | null = null
  /** A booking whose deposit the later tests refund, cancel or replay. */
  let paidFirst: { booked: Booked; sessionId: string } | null = null
  let hold: { booked: Booked; sessionId: string } | null = null

  test.beforeAll(async ({ browser }) => {
    if (!LIVE) return
    const context = await browser.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
    const page = await context.newPage()
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    restoreProvider = await connectProvider(bench, 'stripe')
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
  /* The hold: started now, judged at the end                          */
  /* ---------------------------------------------------------------- */

  test('(hold) a guest leaves Stripe’s page without paying: the booking is held, then the hold runs out', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Hold', partySize: 2 })
    const sessionId = await goToStripe(booked.page)
    const session = await sessionOf(sessionId)
    expect(session).toMatchObject({ mode: 'payment', status: 'open', payment_status: 'unpaid' })
    hold = { booked, sessionId }
    await booked.context.close()
  })

  /* ---------------------------------------------------------------- */
  /* Paying                                                            */
  /* ---------------------------------------------------------------- */

  test('the guest pays the deposit on Stripe, and the booking is confirmed after Stripe says so', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Paid' })
    // Before Stripe has anything: the booking is not confirmed and no mail has gone out.
    expect(mailsTo(booked.email)).toHaveLength(0)
    const sessionId = await pay(booked, baseURL)
    await expectConfirmed(booked.page)
    await expect(
      booked.page.getByText(new RegExp(`Votre acompte de ${MONEY} est payé`)),
    ).toBeVisible()

    const session = await sessionOf(sessionId)
    expect(session).toMatchObject({
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      amount_total: PSP_DEPOSIT_CENTS,
      currency: 'eur',
    })
    expect(session.metadata.reservationPaymentId).toBeTruthy()
    expect(session.client_reference_id).toBe(session.metadata.reservationPaymentId)
    expect(session.payment_intent).toMatchObject({
      status: 'succeeded',
      amount_received: PSP_DEPOSIT_CENTS,
    })
    expect(session.payment_intent.metadata.reservationPaymentId).toBe(
      session.metadata.reservationPaymentId,
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
    paidFirst = { booked, sessionId }
    await booked.context.close()
  })

  test('a webhook alone confirms a guest who paid and was never sent back to the site', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Webhook only' })
    // The guest's browser may not reach the site again: Stripe's return is cut.
    await booked.context.route(`${BASE}/**`, (route) =>
      route.request().url().includes('return=') ? route.abort() : route.continue(),
    )
    const sessionId = await goToStripe(booked.page)
    await submitCard(booked.page, CARD.pays)
    await expect
      .poll(async () => (await sessionOf(sessionId)).payment_status, { timeout: 60_000 })
      .toBe('paid')
    await booked.context.close()

    // Nobody came back and nobody ran a sweep: only the forwarded event can have said it.
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).toContainText('Payé', { timeout: 60_000 })
    await context.close()
  })

  test('closing the tab on Stripe keeps the booking held, and the same link pays later', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Closed tab' })
    const firstSession = await goToStripe(booked.page)
    await booked.context.close()

    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(booked.manageUrl)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await page.goto(booked.paymentUrl)
    const again = await goToStripe(page, 'Réessayer le paiement').catch(() => goToStripe(page))
    expect(again, 'the live Stripe page is handed back, not remade').toBe(firstSession)
    await submitCard(page, CARD.pays)
    await waitBackOnSite(page, baseURL)
    await expectConfirmed(page)
    await context.close()
  })

  test('a declined card keeps the guest on Stripe’s page, and a good card then pays the same session', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Declined' })
    const sessionId = await goToStripe(booked.page)
    await submitCard(booked.page, CARD.declined)
    await expect(booked.page.getByText(/card was declined/i).first()).toBeVisible({
      timeout: 60_000,
    })
    expect(new URL(booked.page.url()).host).toBe(STRIPE_HOST)
    await submitCard(booked.page, CARD.pays)
    await waitBackOnSite(booked.page, baseURL)
    await expectConfirmed(booked.page)
    const session = await sessionOf(sessionId)
    expect(session).toMatchObject({ status: 'complete', payment_status: 'paid' })
    await booked.context.close()
  })

  test('a guest who never comes back is confirmed by the sweep (run with the forwarder stopped)', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(420_000)
    test.skip(
      process.env.E2E_STRIPE_NO_FORWARDER !== '1',
      'stop `stripe listen` and set E2E_STRIPE_NO_FORWARDER=1 so that only the sweep can confirm',
    )
    const booked = await bookForPayment(browser, baseURL, { label: 'Sweep' })
    await booked.context.route(`${BASE}/**`, (route) =>
      route.request().url().includes('return=') ? route.abort() : route.continue(),
    )
    const sessionId = await goToStripe(booked.page)
    await submitCard(booked.page, CARD.pays)
    await expect
      .poll(async () => (await sessionOf(sessionId)).payment_status, { timeout: 60_000 })
      .toBe('paid')
    await booked.context.close()

    // No webhook reached the deployment, so the booking still waits.
    let context = await newGuestContext(browser, baseURL)
    let page = await context.newPage()
    await page.goto(booked.manageUrl)
    await page.waitForTimeout(3_000)
    await expect(paymentRegion(page)).not.toContainText('Payé')
    await context.close()

    // The sweep leaves an attempt alone for its first three minutes (the guest may still be on
    // the page): run it as the clock would, until it has read Stripe and settled.
    context = await newGuestContext(browser, baseURL)
    page = await context.newPage()
    await expect
      .poll(
        async () => {
          runInternal('reservationPaymentActions:reconcile')
          await page.goto(booked.manageUrl)
          return await paymentRegion(page).innerText()
        },
        { timeout: 280_000, intervals: [20_000] },
      )
      .toContain('Payé')
    await context.close()
  })

  test('a webhook delivered again, signed by Stripe’s own secret, settles nothing twice', async ({
    page: admin,
  }) => {
    test.skip(!process.env.E2E_WEBHOOK_URL || !process.env.E2E_WEBHOOK_SECRET, 'no webhook bench')
    test.skip(paidFirst === null, 'the first payment did not happen')
    const { booked, sessionId } = paidFirst!
    const events = await stripeGet('/events?type=checkout.session.completed&limit=100')
    const event = events.data.find(
      (candidate: StripeObject) => candidate.data.object.id === sessionId,
    )
    expect(event, 'Stripe holds the completed event of the paid session').toBeTruthy()
    const payload = JSON.stringify(event)
    const send = async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = createHmac('sha256', process.env.E2E_WEBHOOK_SECRET!)
        .update(`${timestamp}.${payload}`)
        .digest('hex')
      const response = await fetch(process.env.E2E_WEBHOOK_URL!, {
        method: 'POST',
        headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
        body: payload,
      })
      return { status: response.status, body: await response.text() }
    }
    const first = await send()
    const second = await send()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toContain('duplicate')

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await expect(dialog.locator('[data-payment-row="deposit"]')).toHaveCount(1)
    await expect(dialog.locator('[data-payment-row="refund"]')).toHaveCount(0)
    const session = await sessionOf(sessionId)
    expect(await refundsOf(session.payment_intent.id)).toHaveLength(0)
  })

  test('two tabs on one Stripe page: the second payment is refused by Stripe, one charge only', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Two tabs' })
    const sessionId = await goToStripe(booked.page)
    const second = await booked.context.newPage()
    await second.goto(booked.page.url())
    await expect.poll(() => new URL(second.url()).host, { timeout: 60_000 }).toBe(STRIPE_HOST)
    // The first tab pays; the second still shows the form it loaded.
    await submitCard(booked.page, CARD.pays)
    await waitBackOnSite(booked.page, baseURL)
    await expectConfirmed(booked.page)
    await second.locator('#cardNumber').fill(CARD.pays)
    await second.locator('#cardExpiry').fill('1234')
    await second.locator('#cardCvc').fill('123')
    await second.locator('#billingName').fill('E2E Guest')
    await second.locator('button[type="submit"]').click()
    await second.waitForTimeout(8_000)
    const session = await sessionOf(sessionId)
    expect(session.status).toBe('complete')
    const charges = await stripeGet(`/charges?payment_intent=${session.payment_intent.id}`)
    expect(charges.data, 'Stripe took one charge for the session').toHaveLength(1)
    await booked.context.close()
  })

  test('a second deposit landing on a booking already paid is recorded, refunded at Stripe and the booking keeps one deposit', async ({
    browser,
    page: admin,
  }) => {
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    test.skip(paidFirst === null, 'the first payment did not happen')
    // Stripe will not take two payments on one page, and the product closes every other page
    // once one settles, so the « double » can only come from a second page that was opened
    // for the same booking. One is made here by hand: a second pending row with its own real
    // Checkout Session, paid in the browser.
    const { booked } = paidFirst!
    const rows = readTable('reservationPayments')
    const deposit = rows.find(
      (row) =>
        row.kind === 'deposit' &&
        row.status === 'succeeded' &&
        row.checkoutRef === paidFirst!.sessionId,
    )
    expect(deposit, 'the first deposit row').toBeTruthy()
    const nextOrdinal = rows.length + 1
    appendRows('reservationPayments', [
      {
        ...deposit,
        status: 'pending',
        externalId: undefined,
        settledAt: undefined,
        checkoutRef: undefined,
        checkoutUrl: undefined,
        idempotencyKey: `e2e-double-${RUN}-${nextOrdinal}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])
    const doubled = readTable('reservationPayments').find(
      (row) => String(row.idempotencyKey) === `e2e-double-${RUN}-${nextOrdinal}`,
    )!
    const session = await (
      await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          mode: 'payment',
          'payment_method_types[0]': 'card',
          'line_items[0][price_data][currency]': 'eur',
          'line_items[0][price_data][unit_amount]': String(PSP_DEPOSIT_CENTS),
          'line_items[0][price_data][product_data][name]': `Acompte — double ${RUN}`,
          'line_items[0][quantity]': '1',
          success_url: `${BASE}/reservation/payment/none?return=success`,
          cancel_url: `${BASE}/reservation/payment/none?return=cancelled`,
          client_reference_id: String(doubled._id),
          'metadata[reservationPaymentId]': String(doubled._id),
          'payment_intent_data[metadata][reservationPaymentId]': String(doubled._id),
        }),
      })
    ).json()
    expect(session.url).toContain(STRIPE_HOST)
    // Attach the live page to the row, as `attachSession` does.
    updateRow('reservationPayments', String(doubled._id), {
      checkoutRef: session.id,
      checkoutUrl: session.url,
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(session.url)
    await submitCard(page, CARD.pays)
    await expect
      .poll(async () => (await sessionOf(session.id)).payment_status, { timeout: 60_000 })
      .toBe('paid')
    await context.close()
    // Without the guest and without the row knowing its page, the event or the sweep settles it.
    const intent = (await sessionOf(session.id)).payment_intent.id as string
    await expect
      .poll(async () => (await refundsOf(intent)).map((r) => `${r.amount}:${r.status}`), {
        timeout: 120_000,
      })
      .toEqual([`${PSP_DEPOSIT_CENTS}:succeeded`])
    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await expect(dialog).toContainText('Paiement en double')
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* Cancelling                                                        */
  /* ---------------------------------------------------------------- */

  test('cancelling before the cut-off refunds the whole deposit at Stripe', async ({
    browser,
    baseURL,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Cancel' })
    const sessionId = await pay(booked, baseURL)
    await expectConfirmed(booked.page)
    const intent = (await sessionOf(sessionId)).payment_intent.id as string

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
      .poll(async () => (await refundsOf(intent)).map((r) => `${r.amount}:${r.status}`), {
        timeout: 60_000,
      })
      .toEqual([`${PSP_DEPOSIT_CENTS}:succeeded`])

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

  test('after the cut-off the guest can no longer cancel online, and Stripe is not asked for anything', async ({
    browser,
    baseURL,
  }) => {
    await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 720, holdMinutes: 5 })
    try {
      const booked = await bookForPayment(browser, baseURL, {
        label: 'Cutoff',
        date: isoDateAhead(4),
      })
      const sessionId = await pay(booked, baseURL)
      await expectConfirmed(booked.page)
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
      const intent = (await sessionOf(sessionId)).payment_intent.id as string
      expect(await refundsOf(intent)).toHaveLength(0)
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
    const booked = await bookForPayment(browser, baseURL, { label: 'Host refund' })
    const sessionId = await pay(booked, baseURL)
    await expectConfirmed(booked.page)
    await booked.context.close()
    const intent = (await sessionOf(sessionId)).payment_intent.id as string

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
    expect((await refundsOf(intent)).map((r) => `${r.amount}:${r.status}`)).toEqual([
      '500:succeeded',
    ])

    // More than what is left is refused before Stripe is asked.
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
    const refunds = await refundsOf(intent)
    expect(refunds.map((r) => r.amount).sort((a, b) => a - b)).toEqual([500, 1500])
    expect(refunds.every((r) => r.status === 'succeeded')).toBe(true)
    await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
    await expect(dialog.getByRole('button', { name: "Rembourser l'acompte" })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  test('a refund Stripe answers « pending » stays « en attente » until Stripe says otherwise, and the guest is not mailed first', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Pending refund' })
    const sessionId = await pay(booked, baseURL, { card: CARD.pendingRefund })
    await expectConfirmed(booked.page)
    await booked.context.close()
    const intent = (await sessionOf(sessionId)).payment_intent.id as string

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
    await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
    await expect.poll(async () => (await refundsOf(intent)).length, { timeout: 60_000 }).toBe(1)
    const [refund] = await refundsOf(intent)
    test.info().annotations.push({ type: 'stripe-refund-status', description: refund!.status })
    if (refund!.status === 'pending') {
      await expect(
        dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
      ).toBeVisible({ timeout: 30_000 })
      expect(
        mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')),
      ).toHaveLength(0)
    }
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  test('a charge Stripe disputes is shown as « Litige ouvert », no refund row is written and the guest is not mailed', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    const booked = await bookForPayment(browser, baseURL, { label: 'Dispute' })
    const sessionId = await pay(booked, baseURL, { card: CARD.dispute })
    await expectConfirmed(booked.page)
    await booked.context.close()
    const intent = (await sessionOf(sessionId)).payment_intent.id as string
    await expect
      .poll(async () => (await stripeGet(`/disputes?payment_intent=${intent}`)).data.length, {
        timeout: 90_000,
      })
      .toBe(1)

    const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
    await expect(dialog).toContainText('Litige ouvert', { timeout: 60_000 })
    await expect(dialog.locator('[data-payment-row="refund"]')).toHaveCount(0)
    expect(mailsTo(booked.email).filter((body) => body.includes('vous a remboursé'))).toHaveLength(
      0,
    )
    await dialog.getByRole('button', { name: 'Fermer' }).click()
  })

  /* ---------------------------------------------------------------- */
  /* A card saved for a guarantee                                      */
  /* ---------------------------------------------------------------- */

  test('a guarantee saves the card without charging, a no-show fee is charged off-session inside the cap, a second beyond it is refused', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    await savePolicy(bench!, { kind: 'guarantee', freeCancellationHours: 24, holdMinutes: 5 })
    try {
      const booked = await bookForPayment(browser, baseURL, { label: 'Guarantee good' })
      await expect(booked.page.getByText('Aucun débit maintenant')).toBeVisible()
      const sessionId = await pay(booked, baseURL, { button: 'Enregistrer ma carte' })
      await expectConfirmed(booked.page)
      await expect(booked.page.getByText(/Votre carte est enregistrée/)).toBeVisible()
      await booked.context.close()

      const session = await sessionOf(sessionId)
      expect(session).toMatchObject({ mode: 'setup', status: 'complete', payment_intent: null })
      expect(session.setup_intent.status).toBe('succeeded')
      const customer = session.customer as string
      expect(customer).toBeTruthy()
      // Nothing was charged to that customer.
      expect((await stripeGet(`/payment_intents?customer=${customer}`)).data).toHaveLength(0)
      expect(
        (await stripeGet(`/payment_methods?customer=${customer}&type=card`)).data,
      ).toHaveLength(1)

      moveBookingToThePast(booked.reference, 2)
      await openDayBook(admin, isoDateAhead(0))
      const row = bookingCard(admin, booked.reference)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row.getByRole('button', { name: 'Absent', exact: true }).click()
      await expect(row.locator('[data-slot="badge"]').filter({ hasText: /^Absent$/ })).toBeVisible({
        timeout: 30_000,
      })
      await row.getByRole('button', { name: 'Paiement', exact: true }).click()
      const dialog = admin.getByRole('dialog', { name: /^Paiement de / })
      await expect(dialog).toBeVisible()

      const fee = '25,00'
      await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
      await dialog.getByRole('button', { name: new RegExp(`^Débiter ${fee}\\s€$`) }).click()
      await expect(
        dialog.getByRole('status').filter({ hasText: "Frais d'absence de" }),
      ).toContainText('débités', { timeout: 60_000 })
      const intents = (await stripeGet(`/payment_intents?customer=${customer}`)).data
      expect(intents).toHaveLength(1)
      expect(intents[0]).toMatchObject({ amount: PSP_FEE_CAP_CENTS, status: 'succeeded' })
      expect(intents[0].metadata.reservationPaymentId).toBeTruthy()

      // A second fee: the cap the guest was shown is spent. The screen offers nothing more, and
      // the server refuses the call made anyway, before Stripe is reached.
      await expect(dialog).toContainText('Encore débitable')
      await expect(dialog.getByRole('button', { name: "Débiter les frais d'absence" })).toHaveCount(
        0,
      )
      const chargeFee = makeFunctionReference<
        'action',
        { reservationId: string; amount?: number },
        unknown
      >('reservationPaymentActions:chargeNoShowFee')
      await expect(
        bench!.client.action(chargeFee, {
          reservationId: reservationIdOf(booked.reference),
          amount: 100,
        }),
      ).rejects.toThrow()
      expect((await stripeGet(`/payment_intents?customer=${customer}`)).data).toHaveLength(1)
      await dialog.getByRole('button', { name: 'Fermer' }).click()
    } finally {
      await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    }
  })

  test('a card that saves and is declined when charged later: the fee fails cleanly, the host and the guest are told, nothing loops', async ({
    browser,
    baseURL,
    page: admin,
  }) => {
    test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
    await savePolicy(bench!, { kind: 'guarantee', freeCancellationHours: 24, holdMinutes: 5 })
    try {
      const booked = await bookForPayment(browser, baseURL, { label: 'Guarantee declined' })
      const sessionId = await pay(booked, baseURL, {
        button: 'Enregistrer ma carte',
        card: CARD.savesThenDeclined,
      })
      await expectConfirmed(booked.page)
      await booked.context.close()
      const customer = (await sessionOf(sessionId)).customer as string

      moveBookingToThePast(booked.reference, 2)
      await openDayBook(admin, isoDateAhead(0))
      const row = bookingCard(admin, booked.reference)
      await row.getByRole('button', { name: 'Absent', exact: true }).click()
      await expect(row.locator('[data-slot="badge"]').filter({ hasText: /^Absent$/ })).toBeVisible({
        timeout: 30_000,
      })
      await row.getByRole('button', { name: 'Paiement', exact: true }).click()
      const dialog = admin.getByRole('dialog', { name: /^Paiement de / })
      await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
      await dialog.getByRole('button', { name: new RegExp('^Débiter 25,00\\s€$') }).click()
      await expect(dialog.getByRole('alert')).toContainText(/refusé/i, { timeout: 60_000 })
      test.info().annotations.push({
        type: 'host-sees',
        description: (await dialog.getByRole('alert').first().innerText()).slice(0, 160),
      })

      await expect
        .poll(
          () => mailsTo(booked.email).filter((body) => /paiement|carte|frais/i.test(body)).length,
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(1)
      // No retry loop: after two sweeps there is still exactly one attempt at Stripe.
      runInternal('reservationPaymentActions:reconcile')
      await admin.waitForTimeout(5_000)
      runInternal('reservationPaymentActions:reconcile')
      const attempts = (await stripeGet(`/payment_intents?customer=${customer}`)).data
      expect(attempts).toHaveLength(1)
      expect(attempts[0].status).not.toBe('succeeded')
      await dialog.getByRole('button', { name: 'Fermer' }).click()
    } finally {
      await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
    }
  })

  /**
   * Stripe's own documentation of its test cards: 3155 asks for 3-D Secure on one-off payments
   * but needs nothing more once it was set up (the authentication done when the card was
   * saved carries the later charge); 3184 asks for it on every transaction, so a charge made
   * with the guest absent cannot succeed whatever was done when the card was saved.
   */
  for (const scenario of [
    {
      label: 'Guarantee secure once',
      card: CARD.threeDSecure,
      outcome: 'charged',
      title:
        'a card that needs 3-D Secure to be saved: authenticated up front, the later fee goes through without the guest',
    },
    {
      label: 'Guarantee secure always',
      card: CARD.threeDSecureAlways,
      outcome: 'authentication_required',
      title:
        'a card that needs 3-D Secure on every payment: authenticated up front, and the later fee ends in the « authentification requise » state',
    },
  ] as const) {
    test(scenario.title, async ({ browser, baseURL, page: admin }) => {
      test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
      await savePolicy(bench!, { kind: 'guarantee', freeCancellationHours: 24, holdMinutes: 5 })
      try {
        const booked = await bookForPayment(browser, baseURL, { label: scenario.label })
        const sessionId = await pay(booked, baseURL, {
          button: 'Enregistrer ma carte',
          card: scenario.card,
          threeDSecure: true,
        })
        await expectConfirmed(booked.page)
        await booked.context.close()
        const customer = (await sessionOf(sessionId)).customer as string

        moveBookingToThePast(booked.reference, 2)
        await openDayBook(admin, isoDateAhead(0))
        const row = bookingCard(admin, booked.reference)
        await row.getByRole('button', { name: 'Absent', exact: true }).click()
        await expect(
          row.locator('[data-slot="badge"]').filter({ hasText: /^Absent$/ }),
        ).toBeVisible({ timeout: 30_000 })
        await row.getByRole('button', { name: 'Paiement', exact: true }).click()
        const dialog = admin.getByRole('dialog', { name: /^Paiement de / })
        await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
        await dialog.getByRole('button', { name: new RegExp('^Débiter 25,00\\s€$') }).click()
        const attempts = async () => (await stripeGet(`/payment_intents?customer=${customer}`)).data
        if (scenario.outcome === 'charged') {
          await expect(
            dialog.getByRole('status').filter({ hasText: "Frais d'absence de" }),
          ).toContainText('débités', { timeout: 60_000 })
          expect(await attempts()).toHaveLength(1)
          expect((await attempts())[0]).toMatchObject({
            amount: PSP_FEE_CAP_CENTS,
            status: 'succeeded',
          })
        } else {
          await expect(dialog.getByRole('alert')).toContainText(/authenti/i, { timeout: 60_000 })
          test.info().annotations.push({
            type: 'host-sees',
            description: (await dialog.getByRole('alert').first().innerText()).slice(0, 200),
          })
          expect(await attempts()).toHaveLength(1)
          expect((await attempts())[0].status).not.toBe('succeeded')
          // The host gives the saved card up: the Stripe customer is deleted.
          await dialog.getByRole('button', { name: /^Abandonner/ }).click()
          await dialog
            .getByRole('button', { name: /^Abandonner|Confirmer/ })
            .last()
            .click()
          await expect(dialog.getByRole('status')).toContainText('abandonn', { timeout: 30_000 })
          await expect
            .poll(async () => (await stripeGet(`/customers/${customer}`)).deleted, {
              timeout: 60_000,
            })
            .toBe(true)
        }
        await dialog.getByRole('button', { name: 'Fermer' }).click()
      } finally {
        await savePolicy(bench!, { kind: 'deposit', freeCancellationHours: 24, holdMinutes: 5 })
      }
    })
  }

  /* ---------------------------------------------------------------- */
  /* What the adapters' requests do at Stripe, without a browser        */
  /* ---------------------------------------------------------------- */

  test('the adapter’s idempotency keys: a repeat replays, a changed request is refused, an amount above what is left is refused', async () => {
    const stripe = stripeClient(KEY)
    const form = async (path: string, params: Record<string, string>) =>
      (
        await fetch(`https://api.stripe.com/v1${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(params),
        })
      ).json()
    const intent = await form('/payment_intents', {
      amount: '2000',
      currency: 'eur',
      payment_method: 'pm_card_visa',
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
    })
    const key = `e2e-live-refund-${RUN}`
    const first = await stripe.refund({
      paymentIntent: intent.id,
      amount: 500,
      idempotencyKey: key,
    })
    const again = await stripe.refund({
      paymentIntent: intent.id,
      amount: 500,
      idempotencyKey: key,
    })
    expect(again.id, 'the same key and the same request give the first answer back').toBe(first.id)
    expect(await refundsOf(intent.id)).toHaveLength(1)

    const changed = await stripe
      .refund({ paymentIntent: intent.id, amount: 600, idempotencyKey: key })
      .catch((error: unknown) => error)
    expect(changed).toBeInstanceOf(ProviderError)
    expect((changed as ProviderError).status).toBe(400)
    expect((changed as ProviderError).code).toBe('idempotency_error')
    expect((changed as ProviderError).kind).toBe('refused')

    const tooMuch = await stripe
      .refund({ paymentIntent: intent.id, amount: 1600, idempotencyKey: `${key}-b` })
      .catch((error: unknown) => error)
    expect(tooMuch).toBeInstanceOf(ProviderError)
    expect((tooMuch as ProviderError).status).toBe(400)
    expect(await refundsOf(intent.id)).toHaveLength(1)

    // A Checkout Session in setup mode takes `currency` next to `payment_method_types`.
    const customer = await stripe.createCustomer({
      reservationId: 'e2e-live',
      storeId: 'e2e-live',
      idempotencyKey: `${key}-customer`,
    })
    const guarantee = await stripe.createGuaranteeSession({
      rowId: 'e2e-live-row',
      reservationId: 'e2e-live',
      storeId: 'e2e-live',
      reference: 'RES-0000-00000',
      currency: 'EUR',
      successUrl: `${BASE}/ok`,
      cancelUrl: `${BASE}/ko`,
      expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
      idempotencyKey: `${key}-setup`,
      customerId: customer,
    })
    expect(guarantee.url).toContain(STRIPE_HOST)
    expect((await sessionOf(guarantee.id)).mode).toBe('setup')
    await stripe.expireSession(guarantee.id)
    // Closing a page that is already closed is a refusal the actions swallow.
    const closedTwice = await stripe.expireSession(guarantee.id).catch((error: unknown) => error)
    expect(closedTwice).toBeInstanceOf(ProviderError)
    await stripe.deleteCustomer(customer)
    const gone = await stripe.deleteCustomer(customer).catch((error: unknown) => error)
    expect(
      (gone as ProviderError).status,
      'forgetting a card twice is a 404 the action accepts',
    ).toBe(404)
  })

  /* ---------------------------------------------------------------- */
  /* The hold, judged                                                  */
  /* ---------------------------------------------------------------- */

  test('(hold) when the hold runs out Stripe’s page is closed and the guest is told the table was released', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(12 * 60_000)
    test.skip(hold === null, 'the hold test did not start')
    const { booked, sessionId } = hold!
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await expect
      .poll(async () => (await sessionOf(sessionId)).status, {
        timeout: 9 * 60_000,
        intervals: [15_000],
      })
      .toBe('expired')
    await page.goto(booked.paymentUrl)
    await expect(
      page.getByRole('heading', { name: 'Le délai est dépassé, la table a été libérée' }),
    ).toBeVisible({ timeout: 30_000 })
    await context.close()
  })
})
