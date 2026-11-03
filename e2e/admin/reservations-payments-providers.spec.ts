import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { makeFunctionReference } from 'convex/server'
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
  openSettings,
  paymentBox,
  card,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  CARDS,
  NO_STAND_IN,
  NO_TIME_TRAVEL,
  PSP_DEPOSIT_CENTS,
  PSP_FEE_CAP_CENTS,
  ageRefunds,
  canMoveBookingsInTime,
  connectProvider,
  goToProvider,
  guestClient,
  moveBookingToThePast,
  payOnProviderPage,
  providerAlert,
  psp,
  pspReachable,
  runInternal,
  savePolicy,
  slotsFor,
  staffBooking,
  waitBackOnSite,
  type Psp,
} from '../helpers/psp-standin.helpers'

/**
 * The whole payment journey of a booking, in a real browser, once per provider — against the
 * stand-in for Stripe, SumUp and PayPal (`apps/reference/scripts/local-psp.mjs`).
 *
 * WHAT THIS IS FOR. `reservations-payments.spec.ts` covers the guest's side up to the door of
 * the provider's page and skips when no provider is connected. The provider calls themselves
 * had only ever met a mocked `fetch`. Here the real Convex actions make their real requests
 * to a server that validates them the way the vendors document it, and a real browser pays
 * on a provider-looking page and comes back — so the deposit, the decline and the retry, the
 * hold that lapses, the refunds, the card that is saved and the fee charged to it are all
 * seen end to end.
 *
 * WHAT THIS CANNOT DO. The stand-in encodes OUR reading of the vendors' documentation: where
 * we misread, the adapters and the stand-in agree and both are wrong. Nothing here proves a
 * vendor accepts these requests, how a real bank or 3-D Secure behaves, or the exact words of
 * a real error. It does not replace one run against Stripe's test mode, the SumUp sandbox and
 * the PayPal sandbox. Without `E2E_PSP_URL` the whole file skips and says so.
 *
 * ONE STORY PER PROVIDER, IN ORDER (a failure in one provider does not stop the others). The
 * hold test starts first and ends last, so its five minutes are spent while the others run.
 * A booking that needs a day of its own gets its own date: nothing here is re-runnable on a
 * used database, so reset it before each run.
 */
test.setTimeout(300_000)

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const ADMIN_STATE = 'e2e/.auth/admin.json'
const RUN = Date.now().toString(36)
const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
const PAY_BUTTON = new RegExp(`^Payer ${MONEY}$`)
const ALL: Psp[] = ['stripe', 'sumup', 'paypal']
const PROVIDERS: Psp[] = process.env.E2E_PSP_ONLY
  ? ALL.filter((provider) => provider === process.env.E2E_PSP_ONLY)
  : ALL
const LABEL: Record<Psp, string> = { stripe: 'Stripe', sumup: 'SumUp', paypal: 'PayPal' }

let dayCounter = 12

/** A date nobody else books: every test of the file gets its own. */
function freshDate(): string {
  dayCounter += 1
  return isoDateAhead(dayCounter)
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

/** Book as a guest and land on the payment page, with the hold running. */
async function bookForPayment(
  browser: Browser,
  baseURL: string | undefined,
  options: { label: string; date?: string; time?: string; partySize?: number },
): Promise<Booked> {
  const date = options.date ?? freshDate()
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')
  const context = await newGuestContext(browser, baseURL)
  const page = await context.newPage()
  const email = `e2e.${slug}.${RUN}@example.com`
  await fillBookingForm(page, {
    date,
    time: options.time ?? '19:00',
    partySize: options.partySize ?? 2,
    guest: {
      name: `E2E ${options.label} ${RUN}`,
      email,
      phone: '0612345678',
    },
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
    context,
    page,
    paymentUrl,
    manageUrl: paymentUrl.replace('/reservation/payment/', '/reservation/manage/'),
    reference,
    date,
  }
}

async function pay(
  booked: Booked,
  provider: Psp,
  baseURL: string | undefined,
  options: { card?: string; funding?: 'balance' | 'declined'; button?: RegExp | string } = {},
) {
  await goToProvider(booked.page, provider, options.button ?? PAY_BUTTON)
  await payOnProviderPage(booked.page, provider, options)
  await waitBackOnSite(booked.page, baseURL)
}

async function expectConfirmed(page: Page) {
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
    timeout: 60_000,
  })
}

/** The money region of the guest's own link. */
function paymentRegion(page: Page) {
  return page.getByRole('region', { name: 'Paiement', exact: true })
}

/** A booking's card on the host's day book. */
function bookingCard(page: Page, reference: string) {
  return page.locator('[data-slot="card"]').filter({ hasText: reference })
}

/** How many refunds the stand-in has made for a provider, since it was last reset. */
function refundsMade(state: Awaited<ReturnType<typeof psp.state>>, provider: Psp): number {
  if (provider === 'stripe') return state.stripe.refunds.length
  if (provider === 'paypal') return state.paypal.refunds.length
  return state.sumup.transactions.filter((txn) => txn.refunded > 0).length
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

for (const provider of PROVIDERS) {
  test.describe(`Deposit and refunds through ${LABEL[provider]}`, () => {
    test.describe.configure({ mode: 'serial' })

    let bench: PaymentBench | null = null
    let skipReason: string | null = null
    let restoreProvider: (() => Promise<void>) | null = null
    let hold: { booked: Booked; startsAt: number; startedAt: number; providerId: string } | null =
      null

    test.beforeAll(async ({ browser }) => {
      if (!(await pspReachable())) {
        skipReason = NO_STAND_IN
        return
      }
      await psp.reset()
      const context = await browser.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
      const page = await context.newPage()
      await ensureBook(page, { autoConfirm: true })
      bench = await openPaymentBench(page)
      restoreProvider = await connectProvider(bench, provider)
      await context.close()
    })

    test.afterAll(async () => {
      await psp.defaultScenario().catch(() => undefined)
      await bench?.restore().catch(() => undefined)
      await restoreProvider?.().catch(() => undefined)
    })

    test.beforeEach(async () => {
      test.skip(skipReason !== null, skipReason ?? '')
      await psp.defaultScenario()
    })

    /* ---------------------------------------------------------------- */
    /* What this provider can secure                                     */
    /* ---------------------------------------------------------------- */

    test('the settings say what this provider can secure, and the server refuses what it cannot', async ({
      page,
    }) => {
      await openSettings(page)
      const payments = card(page, 'Paiements')
      await expect(payments).toBeVisible({ timeout: 30_000 })
      const row = payments.locator(`[data-provider="${provider}"]`)
      await expect(row).toContainText('Acompte')
      await expect(row).toContainText('Garantie')

      const addGuarantee = payments.getByRole('button', {
        name: 'Ajouter une garantie par carte',
      })
      const refusal = bench!.client.mutation(
        // The same mutation the screen saves through.
        makeFunctionReference<'mutation', Record<string, unknown>, unknown>(
          'reservationPayments:savePaymentPolicy',
        ),
        {
          storeId: bench!.storeId,
          enabled: true,
          rules: [
            {
              id: 'e2e-refused-guarantee',
              kind: 'guarantee',
              noShowFee: { mode: 'flat', cents: PSP_FEE_CAP_CENTS },
              serviceIds: [bench!.serviceId],
            },
          ],
          freeCancellationHours: 24,
          holdMinutes: 15,
          primaryProvider: provider,
        },
      )
      if (provider === 'stripe') {
        // Stripe documents saving a card and charging it later: the guarantee is offered.
        await expect(addGuarantee).toBeEnabled()
        await expect(refusal).resolves.toBeDefined()
      } else {
        // SumUp and PayPal are NOT faked: the button says why it is off, and the server
        // refuses the same policy in the same words.
        await expect(addGuarantee).toBeDisabled()
        await expect(payments).toContainText(
          provider === 'sumup'
            ? "SumUp ne documente pas le débit d'une carte enregistrée en l'absence du client"
            : "Une autorisation PayPal n'est garantie que 3 jours",
        )
        await expect(refusal).rejects.toThrow(/garantie/i)
      }
    })

    test('the establishment asks a 20 € deposit with a five-minute hold and a 24-hour cut-off', async () => {
      await savePolicy(bench!, {
        kind: 'deposit',
        freeCancellationHours: 24,
        holdMinutes: 5,
        primaryProvider: provider,
      })
    })

    /* ---------------------------------------------------------------- */
    /* The hold: started now, judged at the end                          */
    /* ---------------------------------------------------------------- */

    test('(hold) a guest leaves the provider’s page without paying, holding the last table of the slot', async ({
      browser,
      baseURL,
    }) => {
      const date = freshDate()
      const slot = (await slotsFor(bench!, date, 4)).find((candidate) => candidate.time === '19:00')
      expect(slot, 'the dinner service has no 19:00 slot').toBeTruthy()
      // Three of the four tables of four are the team's: the guest's hold is the last one.
      for (const n of [1, 2, 3]) {
        await staffBooking(bench!, {
          date,
          startsAt: slot!.startsAt,
          partySize: 4,
          name: `E2E Hold staff ${n} ${RUN}`,
          email: `e2e.hold.staff.${n}.${RUN}@example.com`,
        })
      }
      const before = (await slotsFor(bench!, date, 4)).find(
        (candidate) => candidate.time === '19:00',
      )
      expect(before!.available, 'one table of four is still free').toBe(true)

      const booked = await bookForPayment(browser, baseURL, {
        label: `Hold ${provider}`,
        date,
        partySize: 4,
      })
      await goToProvider(booked.page, provider, PAY_BUTTON)
      const state = await psp.state()
      const providerId =
        provider === 'stripe'
          ? state.stripe.sessions.at(-1)!.id
          : provider === 'sumup'
            ? state.sumup.checkouts.at(-1)!.id
            : state.paypal.orders.at(-1)!.id

      // The table is the guest's while the clock runs: nobody else can book the slot.
      const during = (await slotsFor(bench!, date, 4)).find(
        (candidate) => candidate.time === '19:00',
      )
      expect(during!.available, 'the held table makes the slot full').toBe(false)
      hold = { booked, startsAt: slot!.startsAt, startedAt: Date.now(), providerId }
      await booked.context.close()
    })

    /* ---------------------------------------------------------------- */
    /* Paying                                                            */
    /* ---------------------------------------------------------------- */

    test('the guest pays the deposit on the provider’s page and the booking is confirmed', async ({
      browser,
      baseURL,
    }) => {
      const booked = await bookForPayment(browser, baseURL, { label: `Paid ${provider}` })
      await pay(booked, provider, baseURL)
      await expectConfirmed(booked.page)
      await expect(
        booked.page.getByText(new RegExp(`Votre acompte de ${MONEY} est payé`)),
      ).toBeVisible()

      // What the provider was actually asked and told.
      const state = await psp.state()
      if (provider === 'stripe') {
        const session = state.stripe.sessions.at(-1)!
        expect(session).toMatchObject({
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          amount_total: PSP_DEPOSIT_CENTS,
          currency: 'eur',
        })
        expect(session.metadata.reservationPaymentId).toBeTruthy()
        expect(session.client_reference_id).toBe(session.metadata.reservationPaymentId)
        const intent = state.stripe.intents.find(
          (candidate) => candidate.id === session.payment_intent,
        )
        expect(intent).toMatchObject({ amount_received: PSP_DEPOSIT_CENTS, status: 'succeeded' })
        // The webhook arrived BEFORE the guest was redirected back (the default order).
        expect(
          state.webhooks.filter((hook) => hook.status === 200).map((hook) => hook.type),
        ).toEqual(
          expect.arrayContaining(['checkout.session.completed', 'payment_intent.succeeded']),
        )
      } else if (provider === 'sumup') {
        const checkout = state.sumup.checkouts.at(-1)!
        expect(checkout).toMatchObject({
          status: 'PAID',
          amount: PSP_DEPOSIT_CENTS / 100,
          currency: 'EUR',
        })
        expect(state.sumup.transactions.at(-1)).toMatchObject({ status: 'SUCCESSFUL' })
      } else {
        const order = state.paypal.orders.at(-1)!
        expect(order.status).toBe('COMPLETED')
        expect(order.purchase_units[0]!.custom_id).toBeTruthy()
        expect(state.paypal.captures.at(-1)).toMatchObject({ status: 'COMPLETED' })
      }

      // The guest's own link shows the money, and the cut-off they agreed to.
      await booked.page.goto(booked.manageUrl)
      const region = paymentRegion(booked.page)
      await expect(region).toContainText('Payé')
      await expect(region).toContainText(new RegExp(MONEY))
      await booked.context.close()
    })

    test('a declined payment keeps the guest on a page that can be retried, and a second try pays', async ({
      browser,
      baseURL,
    }) => {
      const booked = await bookForPayment(browser, baseURL, { label: `Declined ${provider}` })
      const { page } = booked
      const sessionsBefore = (await psp.state()).stripe.sessions.length
      await goToProvider(page, provider, PAY_BUTTON)

      if (provider === 'stripe') {
        // Stripe keeps the guest on its page, which offers another card.
        await payOnProviderPage(page, 'stripe', { card: CARDS.declined })
        await expect(providerAlert(page)).toContainText('Your credit card was declined')
        await payOnProviderPage(page, 'stripe', { card: CARDS.pays })
        await waitBackOnSite(page, baseURL)
        await expectConfirmed(page)
        expect((await psp.state()).stripe.sessions, 'one session served both tries').toHaveLength(
          sessionsBefore + 1,
        )
      } else if (provider === 'sumup') {
        // Seen on the SumUp sandbox (28 October 2026): a refused card leaves the checkout FAILED
        // but OPEN. The guest stays on the hosted page, which takes another card on the same
        // address, and nothing on our side is closed, so the one checkout pays in the end.
        const checkoutsBefore = (await psp.state()).sumup.checkouts.length
        await payOnProviderPage(page, 'sumup', { card: CARDS.declined })
        await expect(providerAlert(page)).toContainText('declined')
        expect((await psp.state()).sumup.checkouts.at(-1)!.status).toBe('FAILED')
        // (Nothing on our side was closed by it: the unit tests hold FAILED as « pending » for the sweep.)
        await payOnProviderPage(page, 'sumup', { card: CARDS.pays })
        await waitBackOnSite(page, baseURL)
        await expectConfirmed(page)
        const after = await psp.state()
        // One checkout served both tries, and it carries both transactions.
        expect(after.sumup.checkouts.length).toBe(checkoutsBefore)
        expect(after.sumup.checkouts.at(-1)).toMatchObject({ status: 'PAID' })
        expect(after.sumup.checkouts.at(-1)!.transactions.map((txn) => txn.status)).toEqual([
          'FAILED',
          'SUCCESSFUL',
        ])
      } else {
        // PayPal declines at capture, after the guest approved: the order stays APPROVED (seen on
        // the sandbox with its mock decline) and the guest must approve again with another source.
        const capturesBefore = (await psp.state()).paypal.captures.length
        await payOnProviderPage(page, 'paypal', { funding: 'declined' })
        await waitBackOnSite(page, baseURL)
        await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toHaveCount(0)
        await expect(
          page.getByRole('heading', { name: "Votre paiement n'est pas encore confirmé" }),
        ).toBeVisible({ timeout: 60_000 })
        await expect
          .poll(async () => (await psp.state()).paypal.orders.at(-1)!.status, { timeout: 20_000 })
          .toBe('APPROVED')
        expect(
          (await psp.state()).paypal.captures,
          'a declined capture moves no money',
        ).toHaveLength(capturesBefore)
        // The way back is the same link: the live approval page is handed back, not remade.
        await page.goto(booked.manageUrl)
        await paymentRegion(page).getByRole('link', { name: 'Payer maintenant' }).click()
        const ordersBefore = (await psp.state()).paypal.orders.length
        await goToProvider(page, 'paypal', PAY_BUTTON)
        await payOnProviderPage(page, 'paypal', { funding: 'balance' })
        await waitBackOnSite(page, baseURL)
        await expectConfirmed(page)
        const after = await psp.state()
        expect(after.paypal.orders).toHaveLength(ordersBefore)
        expect(after.paypal.orders.at(-1)!.status).toBe('COMPLETED')
      }
      await booked.context.close()
    })

    test('leaving the provider’s page says nothing was debited, and retrying returns to the same page', async ({
      browser,
      baseURL,
    }) => {
      const booked = await bookForPayment(browser, baseURL, { label: `Abandoned ${provider}` })
      const { page } = booked
      await goToProvider(page, provider, PAY_BUTTON)
      const providerUrl = page.url()
      if (provider === 'sumup') {
        // SumUp's hosted page has no « cancel » link and no way back before a payment (sandbox,
        // 28 October 2026): a guest who gives up closes the tab or presses Back, and finds our
        // payment page again, which still offers the same live checkout.
        await page.goto(booked.paymentUrl)
        await expect(page.getByRole('button', { name: PAY_BUTTON })).toBeVisible({
          timeout: 30_000,
        })
        await goToProvider(page, 'sumup', PAY_BUTTON)
      } else {
        const backLink =
          provider === 'stripe' ? 'Back to the merchant' : 'Cancel and return to the merchant'
        await page.getByRole('link', { name: backLink }).click()
        await waitBackOnSite(page, baseURL)
        await expect(page.getByText("Paiement annulé, rien n'a été débité")).toBeVisible({
          timeout: 30_000,
        })
        await goToProvider(page, provider, 'Réessayer le paiement')
      }
      expect(page.url(), 'the live page is handed back, not remade').toBe(providerUrl)
      await booked.context.close()
    })

    test('a payment the provider confirms late is read back when the guest asks, and settles once', async ({
      browser,
      baseURL,
    }) => {
      await psp.scenario({ [provider]: { settle: 'manual' } })
      const booked = await bookForPayment(browser, baseURL, { label: `Late ${provider}` })
      const { page } = booked
      await pay(booked, provider, baseURL)

      // The provider still says unpaid: the page never confirms on the redirect alone.
      await expect(
        page.getByRole('heading', { name: 'Nous vérifions votre paiement…' }),
      ).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toHaveCount(0)
      await expect(
        page.getByRole('heading', { name: "Votre paiement n'est pas encore confirmé" }),
      ).toBeVisible({ timeout: 60_000 })

      const state = await psp.state()
      const id =
        provider === 'stripe'
          ? state.stripe.sessions.at(-1)!.id
          : provider === 'sumup'
            ? state.sumup.checkouts.at(-1)!.id
            : state.paypal.orders.at(-1)!.id
      await psp.settle(provider, id)
      if (provider === 'stripe') {
        // Stripe's webhook (still the default order) settles it with nobody pressing anything.
        await expectConfirmed(page)
      } else {
        await page.getByRole('button', { name: 'Vérifier à nouveau' }).click()
        await expectConfirmed(page)
      }
      await booked.context.close()
    })

    test('a guest who never comes back is confirmed by the sweep that reads the provider', async ({
      browser,
      baseURL,
    }) => {
      await psp.scenario({
        [provider]: { settle: 'manual', ...(provider === 'stripe' ? { webhook: 'none' } : {}) },
      })
      const booked = await bookForPayment(browser, baseURL, { label: `Sweep ${provider}` })
      await pay(booked, provider, baseURL)
      // The guest closes the tab. SumUp and PayPal have no webhook here: the sweep IS the
      // confirmation, and PayPal's sweep captures an approved order the booking still awaits.
      await booked.context.close()

      const state = await psp.state()
      const id =
        provider === 'stripe'
          ? state.stripe.sessions.at(-1)!.id
          : provider === 'sumup'
            ? state.sumup.checkouts.at(-1)!.id
            : state.paypal.orders.at(-1)!.id
      await psp.settle(provider, id)
      runInternal('reservationPaymentActions:reconcile')

      const context = await newGuestContext(browser, baseURL)
      const page = await context.newPage()
      await page.goto(booked.manageUrl)
      await expect(paymentRegion(page)).toContainText('Payé', { timeout: 30_000 })
      await context.close()
    })

    if (provider === 'stripe') {
      test('the webhook arriving after the guest’s return settles nothing twice, and a replay is ignored', async ({
        browser,
        baseURL,
        page: admin,
      }) => {
        await psp.scenario({ stripe: { webhook: 'after', webhookDelayMs: 6000 } })
        const seen = (await psp.state()).webhooks.length
        const delivered = async () =>
          (await psp.state()).webhooks.slice(seen).filter((hook) => hook.status === 200)
        const booked = await bookForPayment(browser, baseURL, { label: 'Webhook after stripe' })
        await pay(booked, 'stripe', baseURL)
        // The return page read the checkout back: confirmed before any event came.
        await expectConfirmed(booked.page)
        expect(await delivered()).toHaveLength(0)

        await expect
          .poll(async () => (await delivered()).map((hook) => hook.type), { timeout: 30_000 })
          .toEqual(
            expect.arrayContaining(['checkout.session.completed', 'payment_intent.succeeded']),
          )

        // The same event delivered again is answered as a duplicate and does nothing.
        const first = (await psp.state()).webhooks.find(
          (hook) => hook.type === 'checkout.session.completed',
        )!
        const replay = await psp.event({ replayId: first.id })
        expect(replay.delivered.status).toBe(200)
        expect(replay.delivered.body).toContain('duplicate')

        // One deposit on the ledger, whatever the order and the number of deliveries.
        const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
        await expect(dialog.locator('[data-payment-row="deposit"]')).toHaveCount(1)
        await booked.context.close()
      })
    }

    if (provider === 'stripe') {
      test('a dispute that reaches us before the payment event still opens « Litige ouvert », with no refund and no mail', async ({
        browser,
        baseURL,
        page: admin,
      }) => {
        // Against Stripe's test mode the dispute card opens a dispute the instant it is paid and
        // `charge.dispute.created` arrived BEFORE `checkout.session.completed`: no row held the
        // payment intent yet, so the dispute found nothing and was lost.
        const booked = await bookForPayment(browser, baseURL, { label: 'Dispute stripe' })
        await pay(booked, 'stripe', baseURL, { card: CARDS.dispute })
        await expectConfirmed(booked.page)
        await booked.context.close()
        const state = await psp.state()
        const types = state.webhooks.map((hook) => hook.type)
        expect(types.lastIndexOf('charge.dispute.created')).toBeLessThan(
          types.lastIndexOf('checkout.session.completed'),
        )

        const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
        await expect(dialog).toContainText('Litige ouvert', { timeout: 30_000 })
        await expect(dialog.locator('[data-payment-row="refund"]')).toHaveCount(0)
        expect(
          mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')),
        ).toHaveLength(0)
        await dialog.getByRole('button', { name: 'Fermer' }).click()
      })
    }

    /* ---------------------------------------------------------------- */
    /* Cancelling                                                        */
    /* ---------------------------------------------------------------- */

    test('cancelling before the cut-off refunds the deposit through the provider', async ({
      browser,
      baseURL,
    }) => {
      const booked = await bookForPayment(browser, baseURL, { label: `Cancel ${provider}` })
      await pay(booked, provider, baseURL)
      await expectConfirmed(booked.page)

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

      // The refund is asked of the provider once the cancellation is committed.
      await expect
        .poll(
          async () => {
            const state = await psp.state()
            if (provider === 'stripe') {
              return state.stripe.refunds.map((refund) => refund.amount)
            }
            if (provider === 'sumup') {
              return state.sumup.transactions
                .filter((txn) => txn.refunded > 0)
                .map((txn) => Math.round(txn.refunded * 100))
            }
            return state.paypal.refunds.map((refund) =>
              Math.round(Number(refund.amount.value) * 100),
            )
          },
          { timeout: 45_000 },
        )
        .toContain(PSP_DEPOSIT_CENTS)

      await booked.page.reload()
      const region = paymentRegion(booked.page)
      await expect(region).toContainText('Remboursé', { timeout: 30_000 })
      await expect(region).toContainText(new RegExp(MONEY))
      await expect(region).toContainText('Le remboursement a été effectué')
      await booked.context.close()
    })

    test('after the cut-off the guest can no longer cancel online, and the server says the same', async ({
      browser,
      baseURL,
    }) => {
      // 720 hours: every booking made this month is already inside the free window's end.
      await savePolicy(bench!, {
        kind: 'deposit',
        freeCancellationHours: 720,
        holdMinutes: 5,
        primaryProvider: provider,
      })
      try {
        const booked = await bookForPayment(browser, baseURL, {
          label: `Cutoff ${provider}`,
          // Under thirty days away, so under 720 hours: inside the window by construction.
          date: isoDateAhead(4 + PROVIDERS.indexOf(provider)),
        })
        await pay(booked, provider, baseURL)
        await expectConfirmed(booked.page)

        await booked.page.goto(booked.manageUrl)
        await expect(
          booked.page.getByText("Le délai d'annulation gratuite est dépassé", { exact: false }),
        ).toBeVisible({ timeout: 30_000 })
        await expect(
          booked.page.getByText("l'acompte reste acquis à l'établissement"),
        ).toBeVisible()
        await expect(booked.page.getByRole('button', { name: /^Annuler/ })).toHaveCount(0)

        // A guest who calls the server anyway is refused, and no money moves.
        const token = new URL(booked.manageUrl).pathname.split('/').pop()!
        const cancel = makeFunctionReference<'mutation', { token: string }, unknown>(
          'reservations:cancelByToken',
        )
        await expect(guestClient().mutation(cancel, { token })).rejects.toThrow(
          /cancellation_closed|délai/i,
        )
        await booked.page.reload()
        await expect(paymentRegion(booked.page)).not.toContainText('Remboursé')
        await booked.context.close()
      } finally {
        await savePolicy(bench!, {
          kind: 'deposit',
          freeCancellationHours: 24,
          holdMinutes: 5,
          primaryProvider: provider,
        })
      }
    })

    /* ---------------------------------------------------------------- */
    /* The host                                                          */
    /* ---------------------------------------------------------------- */

    test('the host refunds part of a deposit, then the rest, and a refusal or an outage is shown as it is', async ({
      browser,
      baseURL,
      page: admin,
    }) => {
      test.setTimeout(420_000)
      const booked = await bookForPayment(browser, baseURL, { label: `Host refund ${provider}` })
      await pay(booked, provider, baseURL)
      await expectConfirmed(booked.page)
      await booked.context.close()

      const dialog = await openPaymentDialog(admin, booked.reference, booked.date)
      await expect(dialog.locator('[data-figure="held"]')).toContainText(new RegExp(MONEY))

      const startRefund = async (amount: string, expectLine: RegExp) => {
        await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
        await dialog.getByLabel('Montant à rembourser (€)').fill(amount)
        await expect(dialog.getByTestId('payment-consequence')).toContainText(expectLine)
      }
      const confirm = (amount: string) =>
        dialog.getByRole('button', { name: new RegExp(`^Rembourser ${amount}\\s€$`) })

      // Refunds the provider has made so far (the cancellation above made one): only what this
      // test asks for is counted.
      const refundsBefore = refundsMade(await psp.state(), provider)

      // The provider refuses: nothing moved, the amount is still refundable, the words are shown.
      await psp.scenario({ [provider]: { refund: 'refused' } })
      await startRefund('5,00', /Remboursement partiel/)
      await confirm('5,00').click()
      await expect(dialog.getByRole('alert')).toContainText(
        'Le fournisseur de paiement a refusé le remboursement',
      )
      await dialog.getByRole('button', { name: 'Retour' }).click()
      await expect(dialog.locator('[data-figure="held"]')).toContainText(new RegExp(MONEY))

      // The provider is down: the refund is asked and stays « en attente », never lost nor doubled.
      await psp.scenario({ [provider]: { refund: 'unavailable' } })
      await startRefund('5,00', /Remboursement partiel/)
      await confirm('5,00').click()
      await expect(
        dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
      ).toBeVisible({
        timeout: 30_000,
      })

      // The provider is back. Stripe and PayPal take the same request again under the same key;
      // SumUp documents no key, so its refund is never repeated blindly and stays for a person.
      await psp.defaultScenario()
      // A refund is asked again by the sweep once it is two minutes old (`refundsToRetry`), not
      // before: wait for that, as the clock would.
      await admin.waitForTimeout(125_000)
      runInternal('reservationPaymentActions:reconcile')
      await expect
        .poll(async () => refundsMade(await psp.state(), provider) - refundsBefore, {
          timeout: 30_000,
        })
        .toBe(provider === 'sumup' ? 0 : 1)

      if (provider !== 'sumup') {
        // The rest of the deposit: the host reads that nothing stays with the house, and the
        // provider has then been asked for the whole 20 €, in two refunds that add up.
        await startRefund('15,00', /Remboursement total/)
        await confirm('15,00').click()
        await expect(
          dialog.getByRole('status').filter({ hasText: 'Remboursement de 15,00' }),
        ).toContainText('confirmé', { timeout: 30_000 })
        await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
        const state = await psp.state()
        const amounts =
          provider === 'stripe'
            ? state.stripe.refunds.map((refund) => refund.amount)
            : state.paypal.refunds.map((refund) => Math.round(Number(refund.amount.value) * 100))
        expect(amounts.slice(-2).sort((a, b) => a - b)).toEqual([500, 1500])
      }
      await dialog.getByRole('button', { name: 'Fermer' }).click()
    })

    /* ---------------------------------------------------------------- */
    /* A refund whose outcome is unknown, closed by the host              */
    /* ---------------------------------------------------------------- */

    if (provider === 'sumup') {
      test('a SumUp refund of unknown outcome is closed by the host once they have checked: marked as made, the guest told once, nothing sent again', async ({
        browser,
        baseURL,
        page: admin,
      }) => {
        test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
        test.skip(!MAIL_LOG, NO_MAIL_LOG)
        test.setTimeout(240_000)
        const booked = await bookForPayment(browser, baseURL, {
          label: `Marked refund ${provider}`,
        })
        await pay(booked, provider, baseURL)
        await expectConfirmed(booked.page)
        await booked.context.close()

        // SumUp is down when the host refunds: the refund is committed and stays « en attente ».
        let dialog = await openPaymentDialog(admin, booked.reference, booked.date)
        await psp.scenario({ sumup: { refund: 'unavailable' } })
        await dialog.getByRole('button', { name: "Rembourser l'acompte" }).click()
        await dialog.getByRole('button', { name: new RegExp(`^Rembourser ${MONEY}$`) }).click()
        await expect(
          dialog.getByRole('status').filter({ hasText: 'en attente de confirmation' }),
        ).toBeVisible({ timeout: 30_000 })
        await psp.defaultScenario()
        await dialog.getByRole('button', { name: 'Fermer' }).click()
        const refundsAtTheProvider = refundsMade(await psp.state(), 'sumup')

        // A day later the engine has stopped asking (SumUp has no key to repeat it under): the
        // refund is flagged for a person, and nobody has been told it was made.
        ageRefunds(booked.reference, 30)
        runInternal('reservationPayments:flagStalled')
        expect(
          mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')),
        ).toHaveLength(0)

        dialog = await openPaymentDialog(admin, booked.reference, booked.date)
        const refundRow = dialog.locator('[data-payment-row="refund"]')
        await expect(refundRow).toContainText('sans confirmation du fournisseur', {
          timeout: 30_000,
        })
        // « Réessayer » is never offered for SumUp, and says why; marking stays open.
        const retry = dialog.getByRole('button', { name: 'Réessayer', exact: true })
        await expect(retry).toBeDisabled()
        await expect(dialog).toContainText('SumUp ne permet pas de redemander un remboursement')
        const mark = dialog.getByRole('button', { name: 'Marquer comme remboursé', exact: true })
        await expect(mark).toBeEnabled()

        // The confirmation states the exact amount, the provider and that the host checked.
        await mark.click()
        const consequence = dialog.getByTestId('payment-consequence')
        await expect(consequence).toContainText(new RegExp(MONEY))
        await expect(consequence).toContainText('SumUp')
        await expect(consequence).toContainText("avoir vérifié dans l'espace de SumUp")
        await dialog
          .getByRole('button', { name: new RegExp(`^Marquer ${MONEY} comme remboursé$`) })
          .click()
        await expect(
          dialog.getByRole('status').filter({ hasText: 'marqué comme effectué' }),
        ).toBeVisible({ timeout: 30_000 })
        await expect(dialog.locator('[data-figure="refunded"]')).toContainText(new RegExp(MONEY))
        await expect(dialog.getByRole('button', { name: 'Marquer comme remboursé' })).toHaveCount(0)

        // The guest is told once, now, and SumUp was asked for nothing more.
        await expect
          .poll(
            () => mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')).length,
            { timeout: 30_000 },
          )
          .toBe(1)
        await admin.waitForTimeout(3_000)
        expect(
          mailsTo(booked.email).filter((body) => body.includes('vous a remboursé')),
        ).toHaveLength(1)
        expect(refundsMade(await psp.state(), 'sumup')).toBe(refundsAtTheProvider)
        await dialog.getByRole('button', { name: 'Fermer' }).click()
      })
    }

    /* ---------------------------------------------------------------- */
    /* A card saved for a guarantee (Stripe only)                        */
    /* ---------------------------------------------------------------- */

    if (provider === 'stripe') {
      test('a guarantee saves the card, a no-show is charged off-session, a declined fee is shown, and the card can be given up', async ({
        browser,
        baseURL,
        page: admin,
      }) => {
        test.skip(!canMoveBookingsInTime(), NO_TIME_TRAVEL)
        await savePolicy(bench!, {
          kind: 'guarantee',
          freeCancellationHours: 24,
          holdMinutes: 5,
          primaryProvider: 'stripe',
        })

        const guarantee = async (
          label: string,
          options: { card: string; threeDSecure?: boolean },
        ) => {
          const booked = await bookForPayment(browser, baseURL, { label })
          await expect(booked.page.getByText('Aucun débit maintenant')).toBeVisible()
          await goToProvider(booked.page, 'stripe', 'Enregistrer ma carte')
          await payOnProviderPage(booked.page, 'stripe', { card: options.card })
          if (options.threeDSecure) {
            await booked.page.getByRole('button', { name: 'Complete authentication' }).click()
          }
          await waitBackOnSite(booked.page, baseURL)
          await expect(
            booked.page.getByRole('heading', { name: 'Réservation confirmée' }),
          ).toBeVisible({
            timeout: 60_000,
          })
          await expect(booked.page.getByText(/Votre carte est enregistrée/)).toBeVisible()
          await booked.context.close()
          return booked
        }

        const today = isoDateAhead(0)
        const recordNoShow = async (booked: Booked) => {
          // A booking cannot be made in the past and a no-show cannot be recorded before the
          // booking was due: the row is moved back, as a night's absence would have done.
          moveBookingToThePast(booked.reference, 2)
          await openDayBook(admin, today)
          const row = bookingCard(admin, booked.reference)
          await expect(row).toBeVisible({ timeout: 30_000 })
          await row.getByRole('button', { name: 'Absent', exact: true }).click()
          // The badge, not the word: the button that was just pressed says « Absent » too.
          await expect(
            row.locator('[data-slot="badge"]').filter({ hasText: /^Absent$/ }),
          ).toBeVisible({
            timeout: 30_000,
          })
          await row.getByRole('button', { name: 'Paiement', exact: true }).click()
          const dialog = admin.getByRole('dialog', { name: /^Paiement de / })
          await expect(dialog).toBeVisible()
          return dialog
        }
        const fee = '25,00'

        // (1) A card that works: the fee is charged with the guest absent.
        const good = await guarantee('Guarantee good', { card: CARDS.pays })
        let state = await psp.state()
        expect(state.stripe.sessions.at(-1)).toMatchObject({ mode: 'setup', status: 'complete' })
        expect(state.stripe.sessions.at(-1)!.amount_total).toBeNull()
        expect(state.stripe.setupIntents.at(-1)).toMatchObject({ status: 'succeeded' })
        let dialog = await recordNoShow(good)
        await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
        await expect(dialog.getByTestId('payment-consequence')).toContainText(
          new RegExp(`${fee}\\s€`),
        )
        await dialog.getByRole('button', { name: new RegExp(`^Débiter ${fee}\\s€$`) }).click()
        await expect(
          dialog.getByRole('status').filter({ hasText: "Frais d'absence de" }),
        ).toContainText('débités', { timeout: 30_000 })
        state = await psp.state()
        const charged = state.stripe.intents.at(-1)!
        expect(charged).toMatchObject({ amount: PSP_FEE_CAP_CENTS, status: 'succeeded' })
        expect(charged.customer).toBeTruthy()
        expect(charged.metadata.reservationPaymentId).toBeTruthy()
        await dialog.getByRole('button', { name: 'Fermer' }).click()

        // (2) A card that saves and is declined when charged: the bank's code is shown.
        const declined = await guarantee('Guarantee declined', { card: CARDS.savesThenDeclined })
        dialog = await recordNoShow(declined)
        await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
        await dialog.getByRole('button', { name: new RegExp(`^Débiter ${fee}\\s€$`) }).click()
        await expect(dialog.getByRole('alert')).toContainText('refusé : generic_decline', {
          timeout: 30_000,
        })
        await dialog.getByRole('button', { name: 'Fermer' }).click()

        // (3a) A card that asks for 3-D Secure once: it is done up front, and that carries the later
        // charge (Stripe's documentation of its 3155 test card, confirmed against its test mode).
        const secureOnce = await guarantee('Guarantee secure once', {
          card: CARDS.threeDSecure,
          threeDSecure: true,
        })
        dialog = await recordNoShow(secureOnce)
        await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
        await dialog.getByRole('button', { name: new RegExp(`^Débiter ${fee}\\s€$`) }).click()
        await expect(
          dialog.getByRole('status').filter({ hasText: "Frais d'absence de" }),
        ).toContainText('débités', { timeout: 30_000 })
        await dialog.getByRole('button', { name: 'Fermer' }).click()

        // (3b) A card that asks for 3-D Secure on every transaction: the later charge, which the
        // cardholder cannot answer, fails and says so. The host then gives the card up.
        const secure = await guarantee('Guarantee secure', {
          card: CARDS.threeDSecureAlways,
          threeDSecure: true,
        })
        dialog = await recordNoShow(secure)
        await dialog.getByRole('button', { name: "Débiter les frais d'absence" }).click()
        await dialog.getByRole('button', { name: new RegExp(`^Débiter ${fee}\\s€$`) }).click()
        await expect(dialog.getByRole('alert')).toContainText('authentication_required', {
          timeout: 30_000,
        })
        const customersBefore = (await psp.state()).stripe.customers.length
        await dialog.getByRole('button', { name: /^Abandonner/ }).click()
        await dialog
          .getByRole('button', { name: /^Abandonner|Confirmer/ })
          .last()
          .click()
        await expect(dialog.getByRole('status')).toContainText('abandonn', { timeout: 30_000 })
        await expect
          .poll(async () => (await psp.state()).stripe.customers.length, { timeout: 30_000 })
          .toBeLessThan(customersBefore)

        // Put the policy back for the tests after this one.
        await savePolicy(bench!, {
          kind: 'deposit',
          freeCancellationHours: 24,
          holdMinutes: 5,
          primaryProvider: 'stripe',
        })
      })
    }

    /* ---------------------------------------------------------------- */
    /* The hold, judged                                                  */
    /* ---------------------------------------------------------------- */

    test('(hold) when the hold runs out the table is released and the provider’s page is closed', async ({
      browser,
      baseURL,
    }) => {
      test.setTimeout(12 * 60_000)
      test.skip(hold === null, 'the hold test did not start')
      const { booked, startsAt, providerId } = hold!
      const context = await newGuestContext(browser, baseURL)
      const page = await context.newPage()

      // The cron `release unpaid reservation holds` runs every two minutes: the slot is open
      // again within a hold and one sweep of the clock running out.
      await expect
        .poll(
          async () => {
            const slot = (await slotsFor(bench!, booked.date, 4)).find(
              (candidate) => candidate.startsAt === startsAt,
            )
            return slot?.available
          },
          { timeout: 9 * 60_000, intervals: [15_000] },
        )
        .toBe(true)

      await page.goto(booked.paymentUrl)
      await expect(
        page.getByRole('heading', { name: 'Le délai est dépassé, la table a été libérée' }),
      ).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: PAY_BUTTON })).toHaveCount(0)

      // The provider's page is closed so it can no longer be paid. PayPal has nothing to close:
      // an order nobody approved lapses by itself, and the sweep only captures what a booking
      // still awaits — so nothing could have been taken.
      const state = await psp.state()
      if (provider === 'stripe') {
        expect(state.stripe.sessions.find((session) => session.id === providerId)!.status).toBe(
          'expired',
        )
      } else if (provider === 'sumup') {
        expect(state.sumup.checkouts.find((checkout) => checkout.id === providerId)!.status).toBe(
          'EXPIRED',
        )
      } else {
        expect(state.paypal.orders.find((order) => order.id === providerId)!.status).toBe('CREATED')
        expect(state.paypal.captures.filter((capture) => capture.refunded >= 0)).toHaveLength(
          state.paypal.captures.length,
        )
      }
      await context.close()
    })

    test('the adapters sent nothing this provider would refuse', async () => {
      const { violations } = await psp.state()
      expect(
        violations.filter((violation) => violation.provider === provider),
        'every request the actions made passed the stand-in’s validation of the vendor’s rules',
      ).toEqual([])
    })
  })
}
