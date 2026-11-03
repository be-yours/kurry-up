import { test, expect } from '@playwright/test'
import {
  E2E_DEPOSIT_CENTS,
  ensureBook,
  fillBookingForm,
  isoDateAhead,
  newGuestContext,
  openPaymentBench,
  paymentBox,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  PSP_PROVIDER,
  connectProvider,
  pspHost,
  pspReachable,
  waitBackOnSite,
} from '../helpers/psp-standin.helpers'

/**
 * A guest paying the deposit a booking owes, from the form to the provider's door.
 *
 * WHAT THIS IS FOR. The server half — what is owed, who may pay how, how a payment is read
 * back from a provider and settled once, the refunds — is held by convex-test. What only a
 * browser shows is the guest's side of it: the amount and the terms in front of the button
 * BEFORE anything is sent, a required box that blocks the button, a booking that lands on
 * its payment page with the table's hold counting down, a provider's « cancelled » address
 * that says nothing was debited, and — the point of the page — a « success » address that
 * confirms NOTHING by itself: the provider's redirect proves nothing, so a guest who arrives
 * on it with no payment behind it is told the truth, not shown a confirmation.
 *
 * WHAT THIS CANNOT DO. There is no payment-provider account in the bench and no secret is
 * invented here. A policy that asks for money is only accepted by a deployment with a
 * provider CONNECTED (`STRIPE_SECRET_KEY` and a saved connection, `PAYPAL_*`, …), so the
 * whole file starts by reading that from the server and skips, naming the reason, when
 * nothing is connected: faking a provider would test the fake. Two steps need the real
 * thing and are marked as such:
 *
 *   - « the provider's page » opens only with `E2E_PAYMENT_PROVIDER_ROUNDTRIP=1`, against a
 *     deployment whose provider is in TEST mode (Stripe test keys, SumUp or PayPal sandbox).
 *     It asserts the browser LEFT the site for the provider's host; it does not type a card
 *     into somebody else's page. Completing a test payment and the redirect back is a manual
 *     step against a real sandbox, written up in `tasks/reservations-spec.md` — and it is what
 *     `reservations-payments-providers.spec.ts` does against the stand-in for the providers
 *     (`E2E_PSP_URL`). Here, with the stand-in listening, the guest only leaves its page by the
 *     « back » link, which keeps this story's booking unpaid for the tests that follow;
 *   - the webhook arriving before the browser, and the sweep, are server events a browser
 *     cannot cause: they are held by the convex tests.
 *
 * ONE STORY, IN ORDER. The establishment asks a 20 € deposit on the dinner service with a
 * five-minute hold; a guest books it and is sent to the payment page; reads it, its
 * cancelled and « success » addresses and its lapse; and cancels from the manage link. The
 * policy is put back as it was found, whatever happens.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const RUN = Date.now().toString(36)
const GUEST = {
  name: `E2E Acompte ${RUN}`,
  email: `e2e.acompte.${RUN}@example.com`,
  phone: '0612345678',
}
// Nobody else books this far ahead: the specs share one book.
const DATE = isoDateAhead(9)
const DEPOSIT = new RegExp(`${E2E_DEPOSIT_CENTS / 100},00\\s€`)

let bench: PaymentBench | null = null
let restoreProvider: (() => Promise<void>) | null = null
let skipReason: string | null = null
let paymentUrl = ''
let manageUrl = ''

test.beforeEach(() => {
  test.skip(skipReason !== null, skipReason ?? '')
})

test.afterAll(async () => {
  // Whatever happened above, the other specs must not be asked for a deposit.
  await bench?.restore()
  await restoreProvider?.().catch(() => undefined)
})

test.describe('A guest pays the deposit a booking owes', () => {
  test('the establishment asks a 20 € deposit on dinner, with a five-minute hold', async ({
    page,
  }) => {
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    if (bench.connected.length === 0 && (await pspReachable())) {
      // A stand-in for the providers is listening: connect the one under test, as an owner would.
      restoreProvider = await connectProvider(bench, PSP_PROVIDER)
      bench = await openPaymentBench(page)
    }
    if (bench.connected.length === 0) {
      skipReason =
        'no payment provider is connected on this deployment (no STRIPE_SECRET_KEY with a saved connection, no PAYPAL_*): the server refuses any policy that asks for money, and a fake provider would only test the fake'
      test.skip(true, skipReason)
    }
    await bench.askDeposit({ holdMinutes: 5, freeCancellationHours: 24 })
  })

  test('the guest reads the amount and the terms before anything is sent, and the box blocks the button', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await fillBookingForm(page, { date: DATE, time: '20:00', guest: GUEST })

    const box = paymentBox(page)
    await expect(box).toBeVisible({ timeout: 30_000 })
    await expect(box.getByRole('heading', { name: 'Un acompte est demandé' })).toBeVisible()
    await expect(box).toContainText(DEPOSIT)
    await expect(box).toContainText('La table vous est gardée 5 minutes pour payer')
    await expect(box).toContainText(/Annulation gratuite/)

    // Said honestly: the table is held, not booked, until the payment is received.
    await expect(page.getByText(/confirmée dès que votre paiement est reçu/)).toBeVisible()

    const next = page.getByRole('button', { name: 'Continuer vers le paiement' })
    await expect(next).toBeDisabled()
    await box.getByRole('checkbox').click()
    await expect(next).toBeEnabled()
    // Ticking is the guest's: unticking blocks the button again.
    await box.getByRole('checkbox').click()
    await expect(next).toBeDisabled()
    await context.close()
  })

  test('the booking lands on its payment page with the hold counting down', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await fillBookingForm(page, { date: DATE, time: '20:00', guest: GUEST })
    await paymentBox(page).getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Continuer vers le paiement' }).click()

    await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
    paymentUrl = page.url().split('?')[0]!
    manageUrl = paymentUrl.replace('/reservation/payment/', '/reservation/manage/')

    await expect(page.getByRole('heading', { level: 1, name: 'Régler votre acompte' })).toBeVisible(
      {
        timeout: 30_000,
      },
    )
    await expect(page.getByText(/^RES-\d{4}-\d{5}$/)).toBeVisible()
    await expect(page.getByRole('button', { name: DEPOSIT })).toBeVisible()
    await expect(page.getByText(/Aucun numéro de carte/)).toBeVisible()

    // A clock, not a live region: it is a timer and says nothing out loud every second.
    const timer = page.getByRole('timer')
    await expect(timer).toContainText(/0[0-5]:\d\d/)
    await expect(timer).toHaveAttribute('aria-live', 'off')
    const first = (await timer.textContent()) ?? ''
    await expect
      .poll(async () => (await timer.textContent()) ?? '', { timeout: 10_000 })
      .not.toBe(first)

    // No confirmation yet, and nothing in the heading claims one.
    await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toHaveCount(0)
    await context.close()
  })

  test("the guest's own link shows the request as awaiting its payment, with the way back to pay", async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(manageUrl)
    await expect(page.getByRole('heading', { level: 1, name: 'Ma réservation' })).toBeVisible({
      timeout: 30_000,
    })
    const block = page.getByRole('region', { name: 'Paiement', exact: true })
    await expect(block).toBeVisible()
    await expect(block).toContainText('Paiement en attente')
    await expect(block).toContainText(DEPOSIT)
    await expect(block.getByRole('timer')).toBeVisible()
    await expect(block.getByRole('link', { name: 'Payer maintenant' })).toHaveAttribute(
      'href',
      new RegExp('/reservation/payment/'),
    )
    // The terms this booking agreed to, in the conditions.
    await expect(page.getByRole('region', { name: 'Conditions de réservation' })).toContainText(
      /acompte/i,
    )
    // Cancelling says what it does to the money before it is confirmed.
    await expect(
      page.getByRole('button', { name: /^Annuler : rien ne sera débité$/ }),
    ).toBeVisible()
    await context.close()
  })

  test('coming back from the provider without paying says nothing was debited, and lets the guest retry', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(`${paymentUrl}?return=cancelled`)
    await expect(page.getByText("Paiement annulé, rien n'a été débité")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('button', { name: 'Réessayer le paiement' })).toBeEnabled()
    await expect(page.getByRole('timer')).toBeVisible()
    await context.close()
  })

  test('a « success » address with no payment behind it confirms nothing, and says the e-mail will', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(`${paymentUrl}?return=success`)

    // The server is asked to read the payment back; there is none, so it stays unconfirmed.
    await expect(page.getByRole('heading', { name: 'Nous vérifions votre paiement…' })).toBeVisible(
      {
        timeout: 30_000,
      },
    )
    await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toHaveCount(0)

    // After the patience runs out the page says so plainly, and does NOT fall back to « Payer ».
    await expect(
      page.getByRole('heading', { name: "Votre paiement n'est pas encore confirmé" }),
    ).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText(/envoyée par e-mail/)).toBeVisible()
    await expect(page.getByRole('button', { name: /^Payer / })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Vérifier à nouveau' })).toBeVisible()
    await context.close()
  })

  test("PROVIDER TEST MODE — paying leaves the site for the provider's page", async ({
    browser,
    baseURL,
  }) => {
    test.skip(
      process.env.E2E_PAYMENT_PROVIDER_ROUNDTRIP !== '1',
      "needs a deployment whose payment provider is in TEST mode (Stripe test keys, or the SumUp / PayPal sandbox): set E2E_PAYMENT_PROVIDER_ROUNDTRIP=1. No card is typed on the provider's page here.",
    )
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(paymentUrl)
    await page.getByRole('button', { name: DEPOSIT }).click()
    await expect(page.getByRole('button', { name: 'Redirection vers le paiement…' })).toBeVisible()

    const ours = new URL(baseURL ?? page.url()).host
    await page.waitForURL((url) => url.host !== ours, { timeout: 60_000 })
    if (await pspReachable()) {
      expect(new URL(page.url()).host).toBe(pspHost())
      // Back by the provider's own « back » link: nothing was paid, so the booking stays
      // awaiting its payment for the next tests, and the guest is told so.
      // SumUp's hosted page has no such link (sandbox, 28 October 2026): a guest who gives up
      // presses Back, and finds our payment page again.
      const back = page.getByRole('link', {
        name: /Back to the merchant|Cancel and return to the merchant/,
      })
      if ((await back.count()) > 0) {
        await back.click()
        await waitBackOnSite(page, baseURL)
        await expect(page.getByText("Paiement annulé, rien n'a été débité")).toBeVisible({
          timeout: 30_000,
        })
      } else {
        await page.goto(paymentUrl)
        await expect(page.getByRole('button', { name: DEPOSIT })).toBeVisible({ timeout: 30_000 })
      }
    } else {
      expect(new URL(page.url()).host).toMatch(/stripe|sumup|paypal/)
    }
    await context.close()
  })

  test('when the hold runs out the page says the table was released, and stops offering to pay', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    // The page's own clock: the countdown reaches zero without waiting five real minutes.
    // The server's side of a lapse (the sweep, the refund of a late payment) is held by
    // convex-test; what is proved here is that the guest is not left looking at a button
    // the server would refuse.
    await page.clock.install({ time: new Date() })
    await page.goto(paymentUrl)
    await expect(page.getByRole('button', { name: DEPOSIT })).toBeVisible({ timeout: 30_000 })

    await page.clock.fastForward('06:00')
    await expect(
      page.getByRole('heading', { name: 'Le délai est dépassé, la table a été libérée' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: DEPOSIT })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Réserver à nouveau' })).toHaveAttribute(
      'href',
      '/reservation',
    )
    await context.close()
  })

  test('the guest cancels from the same link, and is told nothing is debited', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(manageUrl)
    await page.getByRole('button', { name: /^Annuler : rien ne sera débité$/ }).click()
    await expect(page.getByText('Annuler cette réservation ?')).toBeVisible()
    await expect(page.getByText(/En annulant, rien ne sera débité/)).toBeVisible()
    await page.getByRole('button', { name: 'Oui, annuler' }).click()
    await expect(page.getByText('Vous avez annulé cette réservation.')).toBeVisible({
      timeout: 30_000,
    })

    // The payment page of a booking that ended says so and offers nothing to pay.
    await page.goto(paymentUrl)
    await expect(page.getByRole('heading', { name: 'Cette réservation est terminée' })).toBeVisible(
      { timeout: 30_000 },
    )
    await expect(page.getByRole('button', { name: DEPOSIT })).toHaveCount(0)
    await context.close()
  })
})
