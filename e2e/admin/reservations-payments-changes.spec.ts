import { test, expect, type Page } from '@playwright/test'
import { makeFunctionReference } from 'convex/server'
import {
  bookAsGuest,
  ensureBook,
  fillBookingForm,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  openPaymentBench,
  paymentBox,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  NO_STAND_IN,
  NO_TIME_TRAVEL,
  PSP_DEPOSIT_CENTS,
  canMoveBookingsInTime,
  connectProvider,
  goToProvider,
  guestClient,
  moveBookingStart,
  payOnProviderPage,
  psp,
  pspReachable,
  savePolicy,
  slotsFor,
  waitBackOnSite,
} from '../helpers/psp-standin.helpers'

/**
 * A guest cannot get round the deposit by editing the booking — from the guest's link, and
 * not silently from the host's screen either.
 *
 * WHAT THIS IS FOR. Two holes an independent review found, closed on the server and proved
 * there by convex-test (`reservation-payments-review.test.ts`). What only a browser shows is
 * what each person SEES:
 *
 *   1. A booking that holds a paid deposit and is now inside its free-cancellation cut-off can
 *      no longer be cancelled online. It must not be movable online either, or the guest moves
 *      it two weeks out and cancels from there for a full refund. The manage page must stop
 *      offering the change, say why, and the server must refuse the call made without the page.
 *   2. A booking that owed nothing (one person, no deposit rule) must not grow into a party the
 *      establishment asks a deposit for by being edited: the guest is told, in plain words, to
 *      book again; a change the policy does not reach still goes through; and when the HOST makes
 *      the same edit it is not refused — it is flagged, with what the policy would have asked.
 *
 * Against the stand-in for the payment providers (`E2E_PSP_URL`) and a local backend that lets
 * the spec move a booking in time, like `reservations-payments-providers.spec.ts`. Skips, naming
 * the reason, without them. Not re-runnable on a used database: reset it before each run.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`
const ADMIN_STATE = 'e2e/.auth/admin.json'
const RUN = Date.now().toString(36)
const MONEY = `${PSP_DEPOSIT_CENTS / 100},00\\s€`
const HOUR = 3_600_000

const modifyByTokenRef = makeFunctionReference<'mutation', Record<string, unknown>, unknown>(
  'reservations:modifyByToken',
)
const savePolicyRef = makeFunctionReference<'mutation', Record<string, unknown>, unknown>(
  'reservationPayments:savePaymentPolicy',
)

let bench: PaymentBench | null = null
let restoreProvider: (() => Promise<void>) | null = null
let skipReason: string | null = null

/** The code a refusal carried, as the guest's own client reads it. */
async function refusalOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call
  } catch (error) {
    const data = (error as { data?: unknown }).data
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    return (parsed as { code?: string } | undefined)?.code ?? String(error)
  }
  return null
}

test.beforeAll(async ({ browser }) => {
  if (!(await pspReachable())) {
    skipReason = NO_STAND_IN
    return
  }
  if (!canMoveBookingsInTime()) {
    skipReason = NO_TIME_TRAVEL
    return
  }
  await psp.reset()
  const context = await browser.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
  const page = await context.newPage()
  await ensureBook(page, { autoConfirm: true })
  bench = await openPaymentBench(page)
  restoreProvider = await connectProvider(bench, 'stripe')
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

/** « Réserver » as a guest who owes the deposit, pay it on the stand-in, land confirmed. */
async function bookAndPay(
  page: Page,
  baseURL: string | undefined,
  date: string,
): Promise<{ reference: string; manageUrl: string }> {
  await fillBookingForm(page, {
    date,
    time: '19:00',
    guest: {
      name: `E2E Changement ${RUN}`,
      email: `e2e.changement.${RUN}@example.com`,
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
  await goToProvider(page, 'stripe', new RegExp(`^Payer ${MONEY}$`))
  await payOnProviderPage(page, 'stripe')
  await waitBackOnSite(page, baseURL)
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
    timeout: 60_000,
  })
  return {
    reference,
    manageUrl: paymentUrl.replace('/reservation/payment/', '/reservation/manage/'),
  }
}

test.describe('The cut-off binds a change as well as a cancellation', () => {
  test('a paid booking inside its cut-off can be neither cancelled nor moved by the guest', async ({
    browser,
    baseURL,
  }) => {
    await savePolicy(bench!, {
      kind: 'deposit',
      freeCancellationHours: 24,
      holdMinutes: 15,
      primaryProvider: 'stripe',
    })
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    const { reference, manageUrl } = await bookAndPay(page, baseURL, isoDateAhead(14))

    // The clock reaches the cut-off: ten hours before the meal, inside the 24 the guest was shown.
    moveBookingStart(reference, Date.now() + 10 * HOUR)

    await page.goto(manageUrl)
    await expect(page.getByRole('heading', { level: 1, name: 'Ma réservation' })).toBeVisible({
      timeout: 30_000,
    })
    // Nothing to press, and the page says why — for the change as for the cancellation.
    await expect(page.getByRole('button', { name: 'Modifier ma réservation' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Annuler/ })).toHaveCount(0)
    await expect(
      page.getByText(/ne pouvez plus annuler ni modifier cette réservation en ligne/),
    ).toBeVisible()

    // The same call made without the page — the way a guest gets round a hidden button.
    const token = manageUrl.split('/').pop()!
    const later = isoDateAhead(16)
    const slot = (await slotsFor(bench!, later, 2)).find((candidate) => candidate.available)!
    const refused = await refusalOf(
      guestClient().mutation(modifyByTokenRef, {
        token,
        date: later,
        serviceId: bench!.serviceId,
        startsAt: slot.startsAt,
        partySize: 2,
      }),
    )
    expect(refused).toBe('change_closed')
    await context.close()
  })
})

test.describe('A booking that owed nothing cannot grow into a deposit by editing it', () => {
  const NAME = `E2E Grandir ${RUN}`
  let reference = ''
  let manageUrl = ''
  let date = ''

  test('booked for two with no deposit rule in the way, then a rule from four people', async ({
    browser,
    baseURL,
  }) => {
    date = isoDateAhead(17)
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    // The deposit applies from four people: a table of two owes nothing.
    await bench!.client.mutation(savePolicyRef, {
      storeId: bench!.storeId,
      enabled: true,
      rules: [
        {
          id: 'e2e-from-four',
          kind: 'deposit',
          deposit: { mode: 'flat', cents: PSP_DEPOSIT_CENTS },
          minPartySize: 4,
          serviceIds: [bench!.serviceId],
        },
      ],
      freeCancellationHours: 24,
      holdMinutes: 15,
      primaryProvider: 'stripe',
    })
    const booked = await bookAsGuest(page, {
      date,
      time: '19:00',
      partySize: 2,
      guest: { name: NAME, email: `e2e.grandir.${RUN}@example.com`, phone: '0612345678' },
    })
    expect(booked.confirmed).toBe(true)
    reference = booked.reference
    manageUrl = booked.manageUrl
    await context.close()
  })

  test('the guest asks for four: told in plain words to book again, and nothing changes', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(manageUrl)
    await page.getByRole('button', { name: 'Modifier ma réservation' }).click()
    const form = page.getByRole('form', { name: 'Modifier ma réservation' })
    await expect(form).toBeVisible({ timeout: 30_000 })
    await form.getByLabel('Nombre de convives').selectOption('4')
    await form.getByRole('button', { name: /^19:00/ }).click()
    await form.getByRole('button', { name: 'Enregistrer la modification' }).click()

    const alert = form.getByRole('alert')
    await expect(alert).toContainText(/demande un acompte ou une garantie par carte/, {
      timeout: 30_000,
    })
    await expect(alert).toContainText(/Annulez-la et réservez de nouveau/)

    // Still two, still confirmed: refused, not half done.
    await page.goto(manageUrl)
    await expect(page.getByText('Votre table est réservée')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/2 personnes/).first()).toBeVisible()
    await context.close()
  })

  test('a change the policy does not reach still goes through: three people', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(manageUrl)
    await page.getByRole('button', { name: 'Modifier ma réservation' }).click()
    const form = page.getByRole('form', { name: 'Modifier ma réservation' })
    await form.getByLabel('Nombre de convives').selectOption('3')
    await form.getByRole('button', { name: /^19:00/ }).click()
    await form.getByRole('button', { name: 'Enregistrer la modification' }).click()
    await expect(page.getByText(/Modification enregistrée/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/3 personnes/).first()).toBeVisible()
    await context.close()
  })

  test('the host makes the same edit: it goes through, and the screen says what was skipped', async ({
    page,
  }) => {
    await openDayBook(page, date)
    const booking = page.locator('[data-slot="card"]').filter({ hasText: reference })
    await expect(booking).toBeVisible({ timeout: 30_000 })
    await booking.getByRole('button', { name: 'Modifier', exact: true }).click()
    const dialog = page.getByRole('dialog', {
      name: new RegExp(`^Modifier la réservation de ${NAME}`),
    })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Couverts').fill('4')
    await dialog.getByRole('button', { name: /^19:00/ }).click()
    await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click()

    await expect(page.getByText('Réservation modifiée')).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText(new RegExp(`une réservation en ligne demanderait un acompte de ${MONEY}`)),
    ).toBeVisible()
    await expect(page.getByText(/Cette réservation n'en demande pas/)).toBeVisible()
  })
})
