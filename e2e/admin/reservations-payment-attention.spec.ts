import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  MAIL_LOG,
  NO_MAIL_LOG,
  alertBell,
  ensureBook,
  mailsTo,
  openDayBook,
  openPaymentBench,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  CARDS,
  NO_STAND_IN,
  NO_TIME_TRAVEL,
  ageRefunds,
  canMoveBookingsInTime,
  connectProvider,
  psp,
  pspReachable,
  readTable,
  runInternal,
  savePolicy,
} from '../helpers/psp-standin.helpers'
import {
  MONEY,
  bookForPayment,
  dateCounter,
  expectConfirmed,
  openPaymentDialog,
  payDeposit,
  refundThroughDialog,
  type Booked,
} from '../helpers/psp-booking.helpers'

/**
 * Money a person has to look at, in the alert centre and in the booking's payment dialog:
 * a dispute, a refund the provider never confirmed, and a refund the provider accepted and
 * then failed — all on the Stripe stand-in (`apps/reference/scripts/local-psp.mjs`).
 *
 * WHAT THIS IS FOR. The derivation (which row raises which alert, what each says, when it
 * goes) and the settlement (what a dispute or a failed refund writes) are held by convex-test.
 * What only a browser over real webhooks shows is the host's side: the bell and the banner
 * with their words and their link to the booking, the payment dialog that says the same thing,
 * a guest who is told nothing wrong, and a team member who closes an alert for themselves
 * alone. A dispute must write no refund row and send no mail; a refund the provider failed
 * must say so, must not be announced to the guest as made, and must be possible to ask again.
 *
 * The stand-in speaks Stripe as OUR reading of its documentation does: a refund object with
 * a `status` of `pending`, then `failed` with a `failure_reason`. It proves our handling, not
 * that Stripe sends exactly these events in this order.
 *
 * Nothing here is re-runnable on a used database. Without the stand-in (`E2E_PSP_URL`) the
 * whole file skips and says so.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const nextDate = dateCounter(13)

let bench: PaymentBench | null = null
let skipReason: string | null = null
let restoreProvider: (() => Promise<void>) | null = null
const guests: Record<string, Booked> = {}

test.beforeAll(async ({ browser }) => {
  if (!(await pspReachable())) {
    skipReason = NO_STAND_IN
    return
  }
  await psp.reset()
  const context = await browser.newContext({ baseURL: BASE, storageState: 'e2e/.auth/admin.json' })
  const page = await context.newPage()
  await ensureBook(page, { autoConfirm: true })
  bench = await openPaymentBench(page)
  restoreProvider = await connectProvider(bench, 'stripe')
  await savePolicy(bench, {
    kind: 'deposit',
    freeCancellationHours: 24,
    holdMinutes: 5,
    primaryProvider: 'stripe',
  })
  await context.close()
})

test.afterAll(async () => {
  await psp.defaultScenario().catch(() => undefined)
  await bench?.restore().catch(() => undefined)
  await restoreProvider?.().catch(() => undefined)
})

test.beforeEach(async () => {
  test.skip(skipReason !== null, skipReason ?? '')
  test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
  test.skip(!MAIL_LOG, NO_MAIL_LOG)
  await psp.defaultScenario()
})

async function paid(
  role: string,
  browser: Browser,
  baseURL: string | undefined,
  options: { card?: string } = {},
): Promise<Booked> {
  const guest = await bookForPayment(browser, baseURL, {
    label: `Attention ${role}`,
    date: nextDate(),
  })
  await payDeposit(guest, 'stripe', baseURL, options)
  await expectConfirmed(guest.page)
  await guest.context.close()
  guests[role] = guest
  return guest
}

/** The payment rows of one booking, straight from the table. */
function rowsOf(guest: Booked) {
  const booking = readTable('reservations').find((row) => row.reference === guest.reference)
  return readTable('reservationPayments').filter((row) => row.reservationId === booking?._id)
}

const refundMails = (guest: Booked) =>
  mailsTo(guest.email).filter((body) => body.includes('vous a remboursé'))

/** Open the bell on the day book and return the alert list. */
async function openAlerts(page: Page) {
  await openDayBook(page)
  await expect(alertBell(page)).toBeVisible({ timeout: 30_000 })
  await alertBell(page).click()
  const list = page.getByTestId('alert-list')
  await expect(list).toBeVisible()
  return list
}

const alertFor = (list: ReturnType<Page['locator']>, guest: Booked) =>
  list.getByRole('listitem').filter({ hasText: guest.reference })

async function signInAs(browser: Browser, email: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE })
  const page = await context.newPage()
  await page.goto('/sign-in', { waitUntil: 'networkidle' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(process.env.SEED_PASSWORD ?? '')
  await page.getByRole('button', { name: /se connecter/i }).click()
  await expect(page).toHaveURL(/\/(dashboard|menu)/, { timeout: 90_000 })
  return context
}

/* ------------------------------------------------------------------ */
/* A dispute                                                            */
/* ------------------------------------------------------------------ */

test('a dispute opened by the bank is an urgent alert with its words and a link to the booking, and writes no refund and no mail', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const guest = await paid('dispute', browser, baseURL)
  const mailsBefore = mailsTo(guest.email).length
  const intent = (await psp.state()).stripe.intents.at(-1)!

  // The ordinary path: the payment settled long ago, the cardholder disputes it weeks later.
  const delivered = await psp.event({ type: 'charge.dispute.created', intent: intent.id })
  expect(delivered.delivered.status).toBe(200)

  const list = await openAlerts(admin)
  const alert = alertFor(list, guest)
  await expect(alert).toHaveCount(1, { timeout: 30_000 })
  await expect(alert).toContainText('Urgent : ')
  await expect(alert).toContainText('Litige ouvert sur 20,00')
  await expect(alert).toContainText(guest.guestName)
  await expect(alert).toContainText(
    "le client conteste ce paiement auprès de sa banque, qui a repris la somme. Répondez au litige dans l'espace du fournisseur de paiement.",
  )
  await expect(alertBell(admin)).toHaveAttribute(
    'aria-label',
    /^Alertes de réservation : \d+ à lire$/,
  )
  // The banner above the book says it too, for whoever has not opened the bell.
  await expect(admin.getByTestId('alert-banner')).toContainText('Litige ouvert sur 20,00')

  // The alert is a sentence; the booking it names is one click away, on its own day.
  const link = alert.getByRole('link', { name: /^Voir dans le carnet : Litige ouvert/ })
  await expect(link).toHaveAttribute('href', `/dashboard/reservations?date=${guest.date}`)
  await link.click()
  await expect(admin.getByLabel('Date', { exact: true })).toHaveValue(guest.date)
  const dialog = await openPaymentDialog(admin, guest.reference, guest.date)

  // The dialog says the same, above everything else, and holds no refund.
  await expect(dialog).toContainText('Litige ouvert', { timeout: 30_000 })
  await expect(dialog.locator('[data-payment-row="refund"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  // Nothing was refunded and nobody was written to: a dispute is the bank's, not the host's.
  expect(rowsOf(guest).filter((row) => row.kind === 'refund')).toHaveLength(0)
  await admin.waitForTimeout(3_000)
  expect(mailsTo(guest.email)).toHaveLength(mailsBefore)
  expect(refundMails(guest)).toHaveLength(0)

  // A replay of the same event changes nothing.
  await psp.event({ type: 'charge.dispute.created', intent: intent.id })
  await admin.waitForTimeout(2_000)
  expect(rowsOf(guest).filter((row) => row.kind === 'refund')).toHaveLength(0)
  expect(mailsTo(guest.email)).toHaveLength(mailsBefore)
})

test('a dispute that arrives before the payment event raises the same alert', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const guest = await paid('dispute-early', browser, baseURL, { card: CARDS.dispute })
  const list = await openAlerts(admin)
  await expect(alertFor(list, guest)).toContainText('Litige ouvert sur 20,00', { timeout: 30_000 })
  expect(rowsOf(guest).filter((row) => row.kind === 'refund')).toHaveLength(0)
  expect(refundMails(guest)).toHaveLength(0)
})

test('closing an alert is one person’s own: the owner closes it, the manager still sees it, and the owner can bring it back', async ({
  browser,
  page: admin,
}) => {
  const guest = guests.dispute!
  const manager = await signInAs(browser, 'test.manager@beindigital.fr')
  const managerPage = await manager.newPage()

  let list = await openAlerts(admin)
  await list
    .getByRole('button', { name: /^Marquer comme lue : Litige ouvert sur 20,00/ })
    .first()
    .click()
  await expect(admin.getByText('Alerte marquée comme lue')).toBeVisible({ timeout: 15_000 })
  await expect(alertFor(list, guest)).toHaveCount(0, { timeout: 15_000 })

  // The manager has not closed it: the bell shows it to them still.
  const managerList = await openAlerts(managerPage)
  await expect(alertFor(managerList, guest)).toHaveCount(1, { timeout: 30_000 })

  // Undone from the toast, it is the owner's again.
  await admin.getByRole('button', { name: 'Annuler', exact: true }).click()
  list = admin.getByTestId('alert-list')
  await expect(alertFor(list, guest)).toHaveCount(1, { timeout: 15_000 })

  // Closed once more and brought back from the bell itself.
  await list
    .getByRole('button', { name: /^Marquer comme lue : Litige ouvert sur 20,00/ })
    .first()
    .click()
  await expect(alertFor(list, guest)).toHaveCount(0, { timeout: 15_000 })
  await list.getByRole('button', { name: /^Réafficher les alertes lues \(\d+\)$/ }).click()
  await expect(alertFor(list, guest)).toHaveCount(1, { timeout: 15_000 })
  await manager.close()
})

/* ------------------------------------------------------------------ */
/* A refund the provider never confirmed                                */
/* ------------------------------------------------------------------ */

test('a refund nobody confirmed is an alert, and « Marquer comme remboursé » closes it, clears the alert and tells the guest once', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const guest = await paid('stalled', browser, baseURL)
  let dialog = await openPaymentDialog(admin, guest.reference, guest.date)
  await psp.scenario({ stripe: { refund: 'unavailable' } })
  await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
  await expect(
    dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
  ).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await psp.defaultScenario()
  ageRefunds(guest.reference, 30)
  runInternal('reservationPayments:flagStalled')
  expect(refundMails(guest)).toHaveLength(0)

  const list = await openAlerts(admin)
  const alert = alertFor(list, guest)
  await expect(alert).toContainText('Remboursement de 20,00', { timeout: 30_000 })
  await expect(alert).toContainText('non confirmé')
  await expect(alert).toContainText("le fournisseur n'a jamais confirmé ce remboursement")
  await expect(alert.getByRole('link', { name: /^Voir dans le carnet/ })).toBeVisible()
  await admin.keyboard.press('Escape')

  dialog = await openPaymentDialog(admin, guest.reference, guest.date)
  await expect(dialog.locator('[data-payment-row="refund"]')).toContainText(
    'sans confirmation du fournisseur',
    { timeout: 30_000 },
  )
  await dialog.getByRole('button', { name: 'Marquer comme remboursé', exact: true }).click()
  await dialog
    .getByRole('button', { name: new RegExp(`^Marquer ${MONEY} comme remboursé$`) })
    .click()
  await expect(dialog.getByRole('status').filter({ hasText: 'marqué comme effectué' })).toBeVisible(
    { timeout: 30_000 },
  )
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  // The alert is gone: nothing waits for anybody any more.
  const after = await openAlerts(admin)
  await expect(alertFor(after, guest)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => refundMails(guest).length, { timeout: 30_000 }).toBe(1)
})

/* ------------------------------------------------------------------ */
/* A refund the provider accepted and then failed                       */
/* ------------------------------------------------------------------ */

test('a refund Stripe accepted and then failed is handed to the host, never announced to the guest, and can be asked again', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const guest = await paid('failed', browser, baseURL)
  let dialog = await openPaymentDialog(admin, guest.reference, guest.date)

  // Stripe accepts the refund and says it is pending: « en attente », nobody is told it was made.
  await psp.scenario({ stripe: { refund: 'pending' } })
  await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
  await expect(
    dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
  ).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await admin.waitForTimeout(2_000)
  expect(refundMails(guest)).toHaveLength(0)

  // Then Stripe fails it, with the object it really sends: a refund with its failure reason.
  const state = await psp.state()
  const refund = state.stripe.refunds.at(-1)!
  expect(refund.status).toBe('pending')
  await psp.defaultScenario()
  const failed = await psp.settleRefund({ status: 'failed', reason: 'expired_or_canceled_card' })
  expect(failed).toMatchObject({
    id: refund.id,
    status: 'failed',
    failure_reason: 'expired_or_canceled_card',
  })

  // The host is told, in the centre and in the dialog.
  const list = await openAlerts(admin)
  const alert = alertFor(list, guest)
  await expect(alert).toContainText('Remboursement de 20,00', { timeout: 30_000 })
  await expect(alert).toContainText('échoué')
  await expect(alert).toContainText(
    "Le client n'a pas été remboursé : refaites-le depuis la réservation.",
  )
  await admin.keyboard.press('Escape')

  dialog = await openPaymentDialog(admin, guest.reference, guest.date)
  await expect(dialog.locator('[data-payment-row="refund"]')).toContainText('échoué', {
    timeout: 30_000,
  })
  await expect(dialog).toContainText("le client n'a pas été remboursé")
  // The guest was never told « remboursé », and the amount is the deposit's again.
  expect(refundMails(guest)).toHaveLength(0)
  await expect(dialog.locator('[data-figure="refunded"]')).not.toContainText(/20,00/)

  // A later retry is possible, and this time it goes through and the guest is told once.
  await refundThroughDialog(dialog)
  await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
  await expect.poll(() => refundMails(guest).length, { timeout: 30_000 }).toBe(1)
  await dialog.getByRole('button', { name: 'Fermer' }).click()

  // The retry settled it: nothing waits for the host any more.
  const after = await openAlerts(admin)
  await expect(alertFor(after, guest)).toHaveCount(0, { timeout: 30_000 })
})

test('a refund failed behind the host’s back is found by the sweep reading the refund back', async ({
  browser,
  baseURL,
  page: admin,
}) => {
  const guest = await paid('failed-read', browser, baseURL)
  const dialog = await openPaymentDialog(admin, guest.reference, guest.date)
  await psp.scenario({ stripe: { refund: 'pending' } })
  await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
  await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
  await expect(
    dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
  ).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await psp.defaultScenario()

  // No webhook arrives: only a read of the refund can find out.
  await psp.settleRefund({ status: 'failed', reason: 'declined', webhook: false })
  await admin.waitForTimeout(125_000)
  runInternal('reservationPaymentActions:reconcile')

  const list = await openAlerts(admin)
  await expect(alertFor(list, guest)).toContainText('Remboursement de 20,00', { timeout: 60_000 })
  await expect(alertFor(list, guest)).toContainText('échoué')
  expect(refundMails(guest)).toHaveLength(0)
  expect((await psp.state()).violations).toEqual([])
})
