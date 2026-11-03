import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  fillBookingForm,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  paymentBox,
} from './reservations.helpers'
import {
  PSP_DEPOSIT_CENTS,
  goToProvider,
  payOnProviderPage,
  waitBackOnSite,
  type Psp,
} from './psp-standin.helpers'

/**
 * A booking that owes a deposit, taken the way a guest takes it, and the host's door onto its
 * money: shared by the specs that need MANY paid bookings on the provider stand-in (the payments
 * dashboard's ledger, the alert centre's payment lines).
 *
 * `reservations-payments-providers.spec.ts` keeps its own copies of the first three: it is the
 * oldest spec of the family and is not rewritten here.
 */

export const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
export const PAY_BUTTON = new RegExp(`^Payer ${MONEY}$`)

export interface Booked {
  email: string
  guestName: string
  context: BrowserContext
  page: Page
  paymentUrl: string
  manageUrl: string
  reference: string
  date: string
}

/** A run suffix, so a rerun on a used database never meets an earlier guest's e-mail. */
export const RUN = Date.now().toString(36)

/** A source of dates nobody else books: each booking of a spec gets its own day. */
export function dateCounter(first: number): () => string {
  let day = first - 1
  return () => {
    day += 1
    return isoDateAhead(day)
  }
}

/** Book as a guest and land on the payment page, with the hold running. */
export async function bookForPayment(
  browser: Browser,
  baseURL: string | undefined,
  options: { label: string; date: string; time?: string; partySize?: number },
): Promise<Booked> {
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')
  const context = await newGuestContext(browser, baseURL)
  const page = await context.newPage()
  const email = `e2e.${slug}.${RUN}@example.com`
  const guestName = `E2E ${options.label} ${RUN}`
  await fillBookingForm(page, {
    date: options.date,
    time: options.time ?? '19:00',
    partySize: options.partySize ?? 2,
    guest: { name: guestName, email, phone: '0612345678' },
  })
  await paymentBox(page).getByRole('checkbox').click()
  await page.getByRole('button', { name: /^Continuer vers/ }).click()
  await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
  const paymentUrl = page.url().split('?')[0]!
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  const reference =
    (await page
      .getByText(/^RES-\d{4}-\d{5}$/)
      .first()
      .textContent()) ?? ''
  return {
    email,
    guestName,
    context,
    page,
    paymentUrl,
    manageUrl: paymentUrl.replace('/reservation/payment/', '/reservation/manage/'),
    reference,
    date: options.date,
  }
}

/** Pay the deposit on the provider's page and come back to the site. */
export async function payDeposit(
  booked: Booked,
  provider: Psp,
  baseURL: string | undefined,
  options: { card?: string; funding?: 'balance' | 'declined'; button?: RegExp | string } = {},
) {
  await goToProvider(booked.page, provider, options.button ?? PAY_BUTTON)
  await payOnProviderPage(booked.page, provider, options)
  await waitBackOnSite(booked.page, baseURL)
}

export async function expectConfirmed(page: Page) {
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
    timeout: 60_000,
  })
}

/** A booking's card on the host's day book. */
export function bookingCard(page: Page, reference: string) {
  return page.locator('[data-slot="card"]').filter({ hasText: reference })
}

/** Open a booking's payment dialog from the day book, as the host does. */
export async function openPaymentDialog(page: Page, reference: string, date: string) {
  await openDayBook(page, date)
  const cardForBooking = bookingCard(page, reference)
  await expect(cardForBooking).toBeVisible({ timeout: 30_000 })
  await cardForBooking.getByRole('button', { name: 'Paiement', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^Paiement de / })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Refund through the dialog: the whole deposit when `amount` is absent, else that part
 * (« 5,00 »). Waits for the dialog to say the provider confirmed it.
 */
export async function refundThroughDialog(
  dialog: ReturnType<Page['locator']>,
  amount?: string,
): Promise<void> {
  await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
  if (amount) await dialog.getByLabel('Montant à rembourser (€)').fill(amount)
  const label = amount ? `${amount}\\s€` : MONEY
  await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${label}$`) }).click()
  await expect(
    dialog.getByRole('status').filter({ hasText: `Remboursement de ${amount ?? ''}` }),
  ).toContainText('confirmé', { timeout: 30_000 })
}
