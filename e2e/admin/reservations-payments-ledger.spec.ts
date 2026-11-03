import { test, expect, type Locator, type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import {
  E2E_STORE_SLUG,
  ensureBook,
  isoDateAhead,
  openDayBook,
  openPaymentBench,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  CARDS,
  NO_STAND_IN,
  NO_TIME_TRAVEL,
  PSP_FEE_CAP_CENTS,
  ageRefunds,
  canMoveBookingsInTime,
  connectProvider,
  goToProvider,
  moveBookingToThePast,
  payOnProviderPage,
  psp,
  pspReachable,
  readTable,
  runInternal,
  savePolicy,
  waitBackOnSite,
  type Psp,
} from '../helpers/psp-standin.helpers'
import {
  MONEY,
  PAY_BUTTON,
  bookForPayment,
  bookingCard,
  dateCounter,
  expectConfirmed,
  openPaymentDialog,
  payDeposit,
  refundThroughDialog,
  type Booked,
} from '../helpers/psp-booking.helpers'

/**
 * « Acomptes et garanties » on `/dashboard/payments`, read against real bookings paid on the
 * provider stand-in (`apps/reference/scripts/local-psp.mjs`).
 *
 * WHAT THIS IS FOR. The server half (what each row is, what the totals add up) is held by
 * convex-test and the screen's words by component tests. What only a browser over real data
 * shows is the screen a host reads: that the totals match the movements the providers were
 * actually asked to make, that a refund is counted once and a guarantee is a card and not
 * money, that each row opens its booking, that the attempts that did not complete are in the
 * list and in no total, and that the whole thing stays out of the orders and the invoices.
 *
 * THE DATA, made through the product with three providers: a deposit paid; one refunded in
 * part; one refunded in full; a deposit whose cardholder disputed it; a refund the provider
 * never confirmed (stalled); a deposit nobody paid; a card kept as a guarantee with a no-show
 * fee charged, one without a fee, one whose fee the bank declined; and the same on SumUp and
 * PayPal. The expected totals are written down by hand below, from what each step moved, and
 * ALSO recomputed from the table's own rows by a few lines of arithmetic that share nothing
 * with the product's, so a wrong total fails twice over.
 *
 * Nothing here is re-runnable on a used database: reset it before each run. Without the
 * stand-in (`E2E_PSP_URL`) the whole file skips and says so.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const nextDate = dateCounter(13)
const MONEY_CENTS = 2000
const FEE = '25,00'

/** What each booking is, by the role it plays in the ledger. */
const booked: Record<string, Booked> = {}
const providerOf: Record<string, Psp> = {}

let bench: PaymentBench | null = null
let skipReason: string | null = null
const restores: Array<() => Promise<void>> = []

/** « 20,00 € » as the screen writes it: a space of some kind before the euro sign. */
const money = (cents: number) => new RegExp(`^${(cents / 100).toFixed(2).replace('.', ',')}\\s€$`)

async function useProvider(provider: Psp) {
  restores.push(await connectProvider(bench!, provider))
  await savePolicy(bench!, {
    kind: 'deposit',
    freeCancellationHours: 24,
    holdMinutes: 5,
    primaryProvider: provider,
  })
}

async function paidDeposit(
  role: string,
  provider: Psp,
  browser: import('@playwright/test').Browser,
  baseURL: string | undefined,
  options: { card?: string } = {},
): Promise<Booked> {
  const guest = await bookForPayment(browser, baseURL, {
    label: `Ledger ${role}`,
    date: nextDate(),
  })
  await payDeposit(guest, provider, baseURL, options)
  await expectConfirmed(guest.page)
  await guest.context.close()
  booked[role] = guest
  providerOf[role] = provider
  return guest
}

test.beforeAll(async ({ browser }) => {
  if (!(await pspReachable())) {
    skipReason = NO_STAND_IN
    return
  }
  await psp.reset()
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.E2E_PORT ?? 3000}`,
    storageState: 'e2e/.auth/admin.json',
  })
  const page = await context.newPage()
  await ensureBook(page, { autoConfirm: true })
  bench = await openPaymentBench(page)
  await context.close()
})

test.afterAll(async () => {
  await psp.defaultScenario().catch(() => undefined)
  await bench?.restore().catch(() => undefined)
  for (const restore of restores.reverse()) await restore().catch(() => undefined)
})

test.beforeEach(async () => {
  test.skip(skipReason !== null, skipReason ?? '')
  test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
  await psp.defaultScenario()
})

/* ------------------------------------------------------------------ */
/* Stripe: every kind of movement                                       */
/* ------------------------------------------------------------------ */

test('Stripe: a deposit paid, one refunded in part, one refunded in full', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  await useProvider('stripe')
  await paidDeposit('stripe-paid', 'stripe', browser, baseURL)

  const part = await paidDeposit('stripe-part', 'stripe', browser, baseURL)
  let dialog = await openPaymentDialog(admin, part.reference, part.date)
  await refundThroughDialog(dialog, '5,00')
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  const whole = await paidDeposit('stripe-full', 'stripe', browser, baseURL)
  dialog = await openPaymentDialog(admin, whole.reference, whole.date)
  await refundThroughDialog(dialog)
  await dialog.getByRole('button', { name: 'Fermer' }).click()
})

test('Stripe: a deposit the cardholder disputed, and one nobody paid', async ({
  browser,
  baseURL,
}) => {
  const disputed = await paidDeposit('stripe-dispute', 'stripe', browser, baseURL, {
    card: CARDS.dispute,
  })
  expect(disputed.reference).toMatch(/^RES-/)

  // Sent to the provider's page and left there: the attempt exists, nothing was taken.
  const abandoned = await bookForPayment(browser, baseURL, {
    label: 'Ledger stripe-unpaid',
    date: nextDate(),
  })
  await goToProvider(abandoned.page, 'stripe', PAY_BUTTON)
  booked['stripe-unpaid'] = abandoned
  providerOf['stripe-unpaid'] = 'stripe'
  await abandoned.context.close()
})

test('Stripe: a refund the provider never confirmed, flagged for the host', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const stalled = await paidDeposit('stripe-stalled', 'stripe', browser, baseURL)
  const dialog = await openPaymentDialog(admin, stalled.reference, stalled.date)
  await psp.scenario({ stripe: { refund: 'unavailable' } })
  await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
  await expect(
    dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
  ).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await psp.defaultScenario()
  ageRefunds(stalled.reference, 30)
  runInternal('reservationPayments:flagStalled')
})

test('Stripe: a card kept as a guarantee, with a fee charged, with none, and with a fee the bank declined', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  await savePolicy(bench!, {
    kind: 'guarantee',
    freeCancellationHours: 24,
    holdMinutes: 5,
    primaryProvider: 'stripe',
  })

  const keepCard = async (role: string, card: string) => {
    const guest = await bookForPayment(browser, baseURL, {
      label: `Ledger ${role}`,
      date: nextDate(),
    })
    await expect(guest.page.getByText('Aucun débit maintenant')).toBeVisible()
    await goToProvider(guest.page, 'stripe', 'Enregistrer ma carte')
    await payOnProviderPage(guest.page, 'stripe', { card })
    await waitBackOnSite(guest.page, baseURL)
    await expect(guest.page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
      timeout: 60_000,
    })
    await guest.context.close()
    booked[role] = guest
    providerOf[role] = 'stripe'
    return guest
  }

  const noShowDialog = async (guest: Booked) => {
    moveBookingToThePast(guest.reference, 2)
    await openDayBook(admin, isoDateAhead(0))
    const row = bookingCard(admin, guest.reference)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: 'Absent', exact: true }).click()
    await expect(row.locator('[data-slot="badge"]').filter({ hasText: /^Absent$/ })).toBeVisible({
      timeout: 30_000,
    })
    await row.getByRole('button', { name: 'Paiement', exact: true }).click()
    const dialog = admin.getByRole('dialog', { name: /^Paiement de / })
    await expect(dialog).toBeVisible()
    return dialog
  }

  const charged = await keepCard('guarantee-fee', CARDS.pays)
  let dialog = await noShowDialog(charged)
  await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Débiter ${FEE}\\s€$`) }).click()
  await expect(dialog.getByRole('status').filter({ hasText: "Frais d'absence de" })).toContainText(
    'débités',
    { timeout: 30_000 },
  )
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  await keepCard('guarantee-only', CARDS.pays)

  const declined = await keepCard('guarantee-declined', CARDS.savesThenDeclined)
  dialog = await noShowDialog(declined)
  await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Débiter ${FEE}\\s€$`) }).click()
  await expect(dialog.getByRole('alert')).toContainText('refusé : generic_decline', {
    timeout: 30_000,
  })
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  await savePolicy(bench!, {
    kind: 'deposit',
    freeCancellationHours: 24,
    holdMinutes: 5,
    primaryProvider: 'stripe',
  })
})

/* ------------------------------------------------------------------ */
/* SumUp and PayPal                                                     */
/* ------------------------------------------------------------------ */

test('SumUp: a deposit refunded in part', async ({ browser, baseURL, page: admin }) => {
  await useProvider('sumup')
  const part = await paidDeposit('sumup-part', 'sumup', browser, baseURL)
  const dialog = await openPaymentDialog(admin, part.reference, part.date)
  await refundThroughDialog(dialog, '5,00')
  await dialog.getByRole('button', { name: 'Fermer' }).click()
})

test('PayPal: a deposit refunded in full', async ({ browser, baseURL, page: admin }) => {
  await useProvider('paypal')
  const whole = await paidDeposit('paypal-full', 'paypal', browser, baseURL)
  const dialog = await openPaymentDialog(admin, whole.reference, whole.date)
  await refundThroughDialog(dialog)
  await dialog.getByRole('button', { name: 'Fermer' }).click()
})

/* ------------------------------------------------------------------ */
/* What the screen says                                                 */
/* ------------------------------------------------------------------ */

/**
 * The totals the movements above add up to, by hand. Seven deposits were paid (the two
 * Stripe refunds, the dispute and the stalled refund included: a dispute is not a refund and
 * a refund nobody confirmed is not money returned), one no-show fee was charged, and the
 * refunds the providers CONFIRMED are 5 + 20 + 5 + 20 euros. The two fee attempts that did not
 * go through and the deposit nobody paid are in no total.
 */
const EXPECTED = {
  collected: 7 * MONEY_CENTS,
  fees: PSP_FEE_CAP_CENTS,
  refunded: 500 + 2000 + 500 + 2000,
  net: 7 * MONEY_CENTS + PSP_FEE_CAP_CENTS - 5000,
  guarantees: 3,
  incomplete: 2,
} as const

/** The same totals from the table's own rows, written without the product's code. */
function totalsFromTable() {
  const rows = readTable('reservationPayments')
  const sum = (kind: string, status: string) =>
    rows
      .filter((row) => row.kind === kind && row.status === status)
      .reduce((total, row) => total + Number(row.amount), 0)
  const count = (predicate: (row: Record<string, unknown>) => boolean) =>
    rows.filter(predicate).length
  const collected = sum('deposit', 'succeeded')
  const fees = sum('no_show_fee', 'succeeded')
  const refunded = sum('refund', 'succeeded')
  return {
    collected,
    fees,
    refunded,
    net: collected + fees - refunded,
    guarantees: count((row) => row.kind === 'guarantee' && row.status === 'succeeded'),
    incomplete: count((row) => ['pending', 'failed', 'cancelled'].includes(String(row.status))),
  }
}

function ledger(page: Page): Locator {
  return page.getByTestId('reservation-ledger')
}

async function openLedger(page: Page): Promise<Locator> {
  await page.goto('/dashboard/payments', { waitUntil: 'domcontentloaded' })
  const panel = ledger(page)
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByTestId('ledger-table')).toBeVisible({ timeout: 60_000 })
  return panel
}

function rowOf(panel: Locator, role: string): Locator {
  return panel.locator('[data-ledger-row]').filter({ hasText: booked[role]!.reference })
}

test('the totals are the movements the providers made, and match the table row for row', async ({
  page,
}) => {
  const panel = await openLedger(page)
  const totals = panel.getByTestId('ledger-totals-EUR')
  await expect(totals).toBeVisible()

  const expected = EXPECTED
  expect(totalsFromTable()).toEqual(expected)

  const figure = (key: string) => totals.locator(`[data-total="${key}"] dd`).first()
  await expect(figure('collected')).toHaveText(money(expected.collected))
  await expect(figure('fees')).toHaveText(money(expected.fees))
  await expect(figure('refunded')).toHaveText(money(expected.refunded))
  await expect(figure('net')).toHaveText(money(expected.net))
  await expect(figure('guarantees')).toHaveText(`${expected.guarantees} cartes`)
  await expect(figure('incomplete')).toHaveText(`${expected.incomplete} tentatives`)

  // The labels say what each figure is, in the schema's own words.
  await expect(totals.locator('[data-total="guarantees"] dt')).toHaveText(
    'Cartes en garantie (aucun montant débité)',
  )
  await expect(totals.locator('[data-total="incomplete"] dt')).toHaveText(
    'Tentatives non abouties (non comptées)',
  )
  // The notice: none of it is order revenue or an invoice.
  await expect(panel.getByTestId('ledger-notice')).toContainText(
    "Ces montants ne sont pas dans le chiffre d'affaires des commandes et ne donnent lieu à aucune facture",
  )
})

test('every row says what it is: reference, guest, kind, provider, amount, status, what was given back', async ({
  page,
}) => {
  const panel = await openLedger(page)
  const cases: Array<{
    role: string
    kind: string
    provider: string
    amount: RegExp | string
    status: string
    refunded?: string
  }> = [
    {
      role: 'stripe-paid',
      kind: 'Acompte',
      provider: 'Stripe',
      amount: /20,00\s€/,
      status: 'Confirmé',
    },
    {
      role: 'stripe-part',
      kind: 'Acompte',
      provider: 'Stripe',
      amount: /20,00\s€/,
      status: 'Confirmé',
      refunded: 'Remboursé : 5,00',
    },
    {
      role: 'stripe-full',
      kind: 'Acompte',
      provider: 'Stripe',
      amount: /20,00\s€/,
      status: 'Confirmé',
      refunded: 'Remboursé : 20,00',
    },
    {
      role: 'sumup-part',
      kind: 'Acompte',
      provider: 'SumUp',
      amount: /20,00\s€/,
      status: 'Confirmé',
      refunded: 'Remboursé : 5,00',
    },
    {
      role: 'paypal-full',
      kind: 'Acompte',
      provider: 'PayPal',
      amount: /20,00\s€/,
      status: 'Confirmé',
      refunded: 'Remboursé : 20,00',
    },
    {
      role: 'stripe-unpaid',
      kind: 'Acompte',
      provider: 'Stripe',
      amount: /20,00\s€/,
      status: 'En attente',
    },
  ]
  for (const entry of cases) {
    const row = rowOf(panel, entry.role)
    await expect(row, entry.role).toHaveCount(1)
    await expect(row).toContainText(booked[entry.role]!.guestName)
    await expect(row).toContainText(entry.kind)
    await expect(row).toContainText(entry.provider)
    await expect(row).toContainText(entry.amount)
    await expect(row).toContainText(entry.status)
    if (entry.refunded) await expect(row).toContainText(entry.refunded)
    else await expect(row).not.toContainText('Remboursé')
  }

  // A refund the provider never confirmed is not « remboursé » on the list either, and the
  // line says a person has to look at it.
  const stalled = rowOf(panel, 'stripe-stalled')
  await expect(stalled).toContainText('Confirmé')
  await expect(stalled).not.toContainText('Remboursé :')
  await expect(stalled.locator('[data-attention]')).toHaveText('Remboursement non confirmé')

  // A dispute is not a refund: the deposit still counts, and the line says « Litige ouvert ».
  const disputed = rowOf(panel, 'stripe-dispute')
  await expect(disputed.locator('[data-attention]')).toHaveText('Litige ouvert')
  await expect(disputed).not.toContainText('Remboursé :')
  await expect(panel.locator('[data-attention]')).toHaveCount(2)

  // A guarantee is a card, not money: no amount, never a figure.
  for (const role of ['guarantee-fee', 'guarantee-only', 'guarantee-declined']) {
    const guarantee = panel
      .locator('[data-ledger-row][data-kind="guarantee"]')
      .filter({ hasText: booked[role]!.reference })
    await expect(guarantee, role).toHaveCount(1)
    await expect(guarantee).toContainText('Carte enregistrée, rien de débité')
    await expect(guarantee).not.toContainText(/\d,\d{2}\s€/)
  }

  // The fee that was charged, and the one the bank declined.
  const fee = panel
    .locator('[data-ledger-row][data-kind="no_show_fee"]')
    .filter({ hasText: booked['guarantee-fee']!.reference })
  await expect(fee).toContainText(new RegExp(`${FEE}\\s€`))
  await expect(fee).toContainText('Confirmé')
  const refused = panel
    .locator('[data-ledger-row][data-kind="no_show_fee"]')
    .filter({ hasText: booked['guarantee-declined']!.reference })
  await expect(refused).toContainText('Échoué')
})

test('each reference opens the booking’s day, and the day book shows that booking', async ({
  page,
}) => {
  const panel = await openLedger(page)
  const role = 'stripe-part'
  const link = rowOf(panel, role).getByRole('link', {
    name: `Ouvrir la réservation ${booked[role]!.reference} dans le carnet`,
  })
  await expect(link).toHaveAttribute('href', `/dashboard/reservations?date=${booked[role]!.date}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/reservations\\?date=${booked[role]!.date}`))
  await expect(bookingCard(page, booked[role]!.reference)).toBeVisible({ timeout: 30_000 })
})

test('the kind filter narrows the list and leaves the totals alone', async ({ page }) => {
  const panel = await openLedger(page)
  const before = await panel.getByTestId('ledger-totals-EUR').innerText()
  const filter = panel.getByRole('group', { name: 'Type de mouvement' })

  await filter.getByRole('button', { name: 'Garanties' }).click()
  await expect(panel.locator('[data-ledger-row]')).toHaveCount(3)
  await expect(panel.locator('[data-ledger-row][data-kind="guarantee"]')).toHaveCount(3)

  await filter.getByRole('button', { name: "Frais d'absence" }).click()
  await expect(panel.locator('[data-ledger-row]')).toHaveCount(2)

  await filter.getByRole('button', { name: 'Acomptes' }).click()
  await expect(panel.locator('[data-ledger-row][data-kind="deposit"]')).toHaveCount(8)
  await expect(panel.locator('[data-ledger-row][data-kind="guarantee"]')).toHaveCount(0)

  expect(await panel.getByTestId('ledger-totals-EUR').innerText()).toBe(before)
})

test('the booking money is nowhere in the order payments, the revenue or the invoices', async ({
  page,
}) => {
  await page.goto('/dashboard/payments', { waitUntil: 'domcontentloaded' })
  const panel = ledger(page)
  await expect(panel).toBeVisible({ timeout: 60_000 })
  // The reference of a booking appears only inside the ledger card.
  const reference = booked['stripe-paid']!.reference
  await expect(page.getByText(reference)).toHaveCount(1)
  await expect(panel.getByText(reference)).toHaveCount(1)

  await page.goto('/dashboard/invoices', { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  await expect(page.getByText(reference)).toHaveCount(0)
})

test('a period with nothing in it says so, in the list and in the totals', async ({ page }) => {
  const panel = await openLedger(page)
  await panel.getByRole('button', { name: 'Personnalisé' }).click()
  await panel.locator('#ledger-from').fill('2020-01-01')
  await panel.locator('#ledger-to').fill('2020-01-07')
  await expect(panel.getByTestId('ledger-empty')).toContainText(
    "Aucun acompte, garantie ni frais d'absence du 1er au 7 janvier 2020.",
  )
  await expect(panel.getByTestId('ledger-totals-empty')).toContainText('Aucun mouvement')
  await expect(panel.locator('[data-ledger-row]')).toHaveCount(0)

  // A range that ends before it starts is explained, not shown as an empty period.
  await panel.locator('#ledger-to').fill('2019-12-01')
  await expect(panel.getByRole('alert')).toContainText('Le jour de fin doit être')
})

test('the screen can be driven from the keyboard: periods, kinds, and a reference opens its day', async ({
  page,
}) => {
  const panel = await openLedger(page)
  const week = panel.getByRole('button', { name: '7 jours' })
  await week.focus()
  await page.keyboard.press('Enter')
  await expect(week).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByTestId('ledger-totals-EUR')).toBeVisible()

  // Tab leaves the periods, goes through the four kinds, then reaches the first reference.
  const reached: string[] = []
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab')
    reached.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent?.trim() ??
          '',
      ),
    )
    if (reached.at(-1)?.startsWith('Ouvrir la réservation')) break
  }
  expect(reached.some((name) => name === 'Garanties')).toBe(true)
  const last = reached.at(-1) ?? ''
  expect(last).toMatch(/^Ouvrir la réservation RES-\d{4}-\d{5} dans le carnet$/)
  // The focus is visible: the browser's own ring or the design system's, never none.
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element)
    return `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`
  })
  expect(ring).not.toBe('none|0px|none')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/dashboard\/reservations\?date=\d{4}-\d{2}-\d{2}/)
})

test('on a phone each movement is a card with its amount and status, nothing scrolls sideways, every target is forty-four pixels', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.E2E_PORT ?? 3000}`,
    storageState: 'e2e/.auth/admin.json',
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/dashboard/payments', { waitUntil: 'domcontentloaded' })
  const panel = ledger(page)
  await expect(panel.locator('[data-ledger-row]').first()).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByTestId('ledger-table')).toHaveCount(0)
  await expect(panel.locator('[data-ledger-row]')).toHaveCount(13)

  // The two things a host came for are on the card itself.
  const card = rowOf(panel, 'stripe-part')
  await expect(card).toContainText(/20,00\s€/)
  await expect(card).toContainText('Remboursé : 5,00')
  await expect(card).toContainText('Confirmé')
  await expect(card).toContainText('Acompte · Stripe')

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBe(0)
  const tooSmall = await panel.evaluate((root) =>
    [...root.querySelectorAll('button, a, input')]
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.height < 44 - 0.5 || box.width < 44 - 0.5))
      .map(
        ({ el, box }) =>
          `${el.textContent?.trim()}:${Math.round(box.width)}x${Math.round(box.height)}`,
      ),
  )
  expect(tooSmall).toEqual([])
  await context.close()
})

test('a role that does not read payments gets no ledger and no data over the wire', async ({
  browser,
}) => {
  const password = process.env.SEED_PASSWORD ?? ''
  test.skip(password === '', 'SEED_PASSWORD is not set: the seeded team accounts cannot sign in')
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.E2E_PORT ?? 3000}`,
  })
  const page = await context.newPage()
  await page.goto('/sign-in', { waitUntil: 'networkidle' })
  await page.locator('#email').fill('test.cuisine@beindigital.fr')
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /se connecter/i }).click()
  await expect(page).toHaveURL(/\/(dashboard|menu)/, { timeout: 90_000 })

  await page.goto('/dashboard/payments', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText("Votre rôle ne vous permet pas d'ouvrir cette page.")).toBeVisible({
    timeout: 60_000,
  })
  await expect(ledger(page)).toHaveCount(0)
  await expect(page.locator('[data-ledger-row]')).toHaveCount(0)

  // The server refuses on its own, for a client that skips the screen altogether.
  const token = await page.evaluate(async () => {
    const response = await fetch('/api/auth/convex/token')
    return ((await response.json()) as { token?: string } | null)?.token ?? null
  })
  expect(token).toBeTruthy()
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL ?? '')
  client.setAuth(token as string)
  const store = (await client.query(
    makeFunctionReference<'query', { slug: string }, { _id: string } | null>('stores:getBySlug'),
    { slug: E2E_STORE_SLUG },
  )) as { _id: string }
  for (const name of ['reservationPayments:listLedger', 'reservationPayments:ledgerTotals']) {
    await expect(
      client.query(makeFunctionReference<'query', { storeId: string }, unknown>(name), {
        storeId: store._id,
      }),
    ).rejects.toThrow()
  }
  await context.close()
})
