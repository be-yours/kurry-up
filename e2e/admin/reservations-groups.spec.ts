import { test, expect } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import {
  E2E_GROUP_DEPOSIT_CENTS,
  card,
  cleanGroupBookings,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  tryConfirmGroupRequest,
  openGroups,
  openPaymentBench,
  openSettings,
  paymentUrlFor,
  readGroupPolicy,
  restoreGroupPolicy,
  setGroupPolicy,
  type GuestDetails,
  type PaymentBench,
} from '../helpers/reservations.helpers'
import {
  PSP_PROVIDER,
  connectProvider,
  goToProvider,
  payOnProviderPage,
  psp,
  pspHost,
  pspReachable,
  waitBackOnSite,
} from '../helpers/psp-standin.helpers'

/**
 * A large party asks for a table, and the host decides.
 *
 * WHAT THIS IS FOR. The rules — which party goes where, what a request holds and for how
 * long, what an acceptance may attach, what a lapsed proposal does — are held by convex-test.
 * What only a browser and a real backend show is the chain between three screens that never
 * meet: the guest's form, the host's list and the guest's own link. The guest is told, before
 * and after sending, that nothing is confirmed and until when the room is held; a party above
 * the maximum meets a way to reach the establishment and no form; each answer of the host
 * (accept, refuse with a reason, propose another time) lands on the guest's page in the
 * guest's own words; and an acceptance that carries a deposit sends the guest to a payment
 * page where the terms are a required box before any provider is offered.
 *
 * WHAT THIS CANNOT DO. There is no payment-provider account in the bench. An acceptance with a
 * deposit is only offered when a provider is CONNECTED, so scenario (d) reads that from the
 * server and skips, naming the reason, when nothing is connected. « The provider's page »
 * opens only with `E2E_PAYMENT_PROVIDER_ROUNDTRIP=1`, exactly as in
 * `reservations-payments.spec.ts`: it asserts the browser LEFT the site for the provider's
 * host. With a stand-in for the providers (`E2E_PSP_URL`, see `psp-standin.helpers.ts`;
 * `E2E_PSP_PROVIDER` picks Stripe, SumUp or PayPal) the guest then pays the deposit there, comes
 * back to a confirmed group, and the host's list shows it accepted.
 *
 * ONE STORY, IN ORDER. The owner asks for groups from 9 to 20 people with a two-day review
 * window. Four guests of nine send a request, each for a different evening: a request holds
 * the tables it needs, and the E2E book has only four tables of four. The host answers them:
 * (a) accept on chosen tables, (b) refuse with a reason, (c) propose another time, which the
 * guest accepts, (d) accept with a 200 € deposit. Whatever a run leaves, the next one
 * releases first, and the group policy is put back as it was found.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const RUN = Date.now().toString(36)
const PARTY = 9
const NAME_PREFIX = 'E2E Groupe'
const POLICY = { threshold: 9, maxSize: 20, reviewHours: 48, proposalHours: 24 }
const DEPOSIT = new RegExp(`${E2E_GROUP_DEPOSIT_CENTS / 100},00\\s€`)
const DECLINE_REASON = `Nous sommes complets ce soir-là, ${RUN}.`
const PROPOSAL_NOTE = `Nous pouvons vous recevoir un jour plus tard, ${RUN}.`

/** What the guest writes besides who they are: the four things a large table needs the host to know. */
const DETAILS = {
  occasion: `Anniversaire ${RUN}`,
  note: 'Sans gluten pour deux personnes, une allergie aux arachides',
  budget: 'Menu unique, environ 35 € par personne',
  message: 'Nous arriverons tous ensemble.',
}

interface Scenario {
  label: string
  date: string
  guest: GuestDetails
}

function scenario(key: string, label: string, days: number): Scenario {
  return {
    label,
    // Nobody else books these evenings: the specs share one book.
    date: isoDateAhead(days),
    guest: {
      name: `${NAME_PREFIX} ${label} ${RUN}`,
      email: `e2e.groupe.${key}.${RUN}@example.com`,
      phone: '0612345678',
    },
  }
}

const ACCEPT = scenario('accord', 'Accord', 10)
const DECLINE = scenario('refus', 'Refus', 11)
const PROPOSE = scenario('proposition', 'Proposition', 12)
const DEPOSIT_CASE = scenario('acompte', 'Acompte', 14)
/** The evening a counter-proposal moves the request to. */
const PROPOSED_DATE = isoDateAhead(13)

interface Sent {
  reference: string
  manageUrl: string
}
const sent: Record<string, Sent> = {}

let bench: PaymentBench | null = null
let previousPolicy: Awaited<ReturnType<typeof readGroupPolicy>> | null = null
let restoreProvider: (() => Promise<void>) | null = null

test.afterAll(async () => {
  // Whatever happened above: free the tables and put the policy back as it was found.
  try {
    if (bench) await cleanGroupBookings(bench, NAME_PREFIX)
    if (bench && previousPolicy) await restoreGroupPolicy(bench, previousPolicy)
  } catch {
    // The next run's set-up releases what is left.
  }
  await restoreProvider?.().catch(() => undefined)
})

/** The host's card of one request, found by the guest's name. */
function requestCard(page: Page, name: string): Locator {
  return page.locator('[data-request]').filter({ hasText: name })
}

/**
 * A guest of nine asks for a table, from the booking page: party, date, a time, who is coming
 * and what they want. Checks what the guest is told before and after sending, and returns the
 * reference and the guest's own link.
 */
async function sendGroupRequest(
  browser: Browser,
  baseURL: string | undefined,
  options: Scenario,
): Promise<Sent> {
  const context = await newGuestContext(browser, baseURL)
  const page = await context.newPage()
  await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByLabel('Nombre de convives').selectOption(String(PARTY))
  await page.getByLabel('Date', { exact: true }).fill(options.date)

  // Said as soon as the party is known: this is a request, not a booking.
  await expect(page.getByText(/c'est une demande/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /^19:00/ }).click()

  const panel = page.locator('form[aria-labelledby="group-request-title"]')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByRole('heading', { name: 'Demande de groupe' })).toBeVisible()
  // The plain words, BEFORE anything is sent: nothing is confirmed, nothing is owed, the room
  // is held for the window the owner set.
  await expect(panel.getByText(/Rien n'est confirmé quand vous l'envoyez/)).toBeVisible()
  await expect(panel.getByText(/gardée 2 jours/)).toBeVisible()

  await panel.getByLabel('Nom', { exact: true }).fill(options.guest.name)
  await panel.getByLabel('E-mail', { exact: true }).fill(options.guest.email)
  await panel.getByLabel('Téléphone', { exact: true }).fill(options.guest.phone)
  await panel.getByLabel('Occasion (facultatif)').fill(DETAILS.occasion)
  await panel.getByLabel('Allergies et régimes alimentaires (facultatif)').fill(DETAILS.note)
  await panel.getByLabel('Menu ou budget souhaité (facultatif)').fill(DETAILS.budget)
  await panel.getByLabel('Un message pour le restaurant (facultatif)').fill(DETAILS.message)

  const submit = panel.getByRole('button', { name: 'Envoyer ma demande' })
  await expect(submit).toBeDisabled()
  await panel.getByRole('checkbox', { name: /J'accepte les conditions de réservation/ }).click()
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByRole('heading', { level: 1, name: 'Demande envoyée' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText("Votre réservation n'est pas encore confirmée.")).toBeVisible()
  // The held-until deadline: the request stops holding the room at a stated moment.
  await expect(page.getByText(/La place est gardée pour votre groupe jusqu'au /)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toHaveCount(0)

  const reference = (await page.getByText(/^RES-\d{4}-\d{5}$/).textContent()) ?? ''
  const link = page.getByRole('link', { name: 'Suivre ou retirer ma demande' })
  const manageUrl = (await link.getAttribute('href')) ?? ''
  expect(manageUrl).toContain('/reservation/manage/')
  await context.close()
  return { reference, manageUrl }
}

/** A guest's own page, opened signed out. Returns the page; the caller closes its context. */
async function openGuestPage(browser: Browser, baseURL: string | undefined, url: string) {
  const context = await newGuestContext(browser, baseURL)
  const page = await context.newPage()
  await page.goto(url)
  await expect(page.getByRole('heading', { level: 1, name: 'Ma demande de groupe' })).toBeVisible({
    timeout: 30_000,
  })
  return { page, close: () => context.close() }
}

test.describe('Large parties ask, the host decides', () => {
  test('the owner asks for groups from 9 to 20 people, and releases what earlier runs left', async ({
    page,
  }) => {
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    if (await pspReachable()) {
      // A stand-in for the providers is listening: connect the one under test, as an owner would.
      await psp.reset()
      restoreProvider = await connectProvider(bench, PSP_PROVIDER)
      // The bench read what was connected before: read it again.
      bench = await openPaymentBench(page)
    }
    previousPolicy = await readGroupPolicy(bench)
    await cleanGroupBookings(bench, NAME_PREFIX)

    await setGroupPolicy(page, POLICY)

    // The card prints what a guest of each size will meet, before anything is saved.
    await openSettings(page)
    const bands = card(page, 'Groupes').getByTestId('groups-bands-list').locator('li')
    await expect(bands).toHaveCount(3, { timeout: 20_000 })
  })

  test('a party of 9 sends a group request, and is told in plain words that nothing is confirmed', async ({
    browser,
    baseURL,
  }) => {
    sent.accept = await sendGroupRequest(browser, baseURL, ACCEPT)
    expect(sent.accept.reference).toMatch(/^RES-\d{4}-\d{5}$/)
  })

  test("the guest's own link shows the request as waiting, with the way to withdraw it", async ({
    browser,
    baseURL,
  }) => {
    const guest = await openGuestPage(browser, baseURL, sent.accept!.manageUrl)
    const { page } = guest
    await expect(
      page.getByRole('heading', { name: 'Demande envoyée : pas encore confirmée' }),
    ).toBeVisible()
    await expect(page.getByText(/Votre demande n'est pas confirmée/)).toBeVisible()
    // What the guest wrote is read back to them.
    await expect(page.getByText(DETAILS.occasion)).toBeVisible()
    await expect(page.getByText(DETAILS.budget)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retirer ma demande' })).toBeVisible()
    await guest.close()
  })

  test('a party above the maximum meets the contact card and no form', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
      timeout: 30_000,
    })
    // The selector ends on « Plus de N personnes »: the last option leads to the contact card.
    const overflow = await page.locator('#party option').last().getAttribute('value')
    expect(Number(overflow)).toBeGreaterThan(POLICY.maxSize)
    await page.getByLabel('Nombre de convives').selectOption(overflow!)

    const contact = page.getByTestId('contact-card')
    await expect(contact).toBeVisible({ timeout: 30_000 })
    await expect(contact).toContainText(`plus de ${POLICY.maxSize} personnes`)
    // Never a dead end: the establishment's phone and e-mail, or the way to its contact page.
    expect(await contact.locator('a').count()).toBeGreaterThan(0)

    await expect(page.locator('form[aria-labelledby="group-request-title"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Envoyer ma demande' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Confirmer la réservation/ })).toHaveCount(0)
    await context.close()
  })

  test('three more guests of nine send a request, each for another evening', async ({
    browser,
    baseURL,
  }) => {
    sent.decline = await sendGroupRequest(browser, baseURL, DECLINE)
    sent.propose = await sendGroupRequest(browser, baseURL, PROPOSE)
    sent.deposit = await sendGroupRequest(browser, baseURL, DEPOSIT_CASE)
  })

  test('the day book gathers the requests in a « Demandes de groupe » stage', async ({ page }) => {
    await openDayBook(page, ACCEPT.date)
    const stage = page.getByRole('heading', { level: 2, name: /^Demandes de groupe · \d+$/ })
    await expect(stage).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: 'Toutes les demandes de groupe' })).toBeVisible()
    await expect(
      page.getByRole('listitem').filter({ hasText: ACCEPT.guest.name }).first(),
    ).toBeVisible()
  })

  test('the host sees each request with everything the guest wrote, and until when to answer', async ({
    page,
  }) => {
    await openGroups(page)
    const request = requestCard(page, ACCEPT.guest.name)
    await expect(request).toBeVisible({ timeout: 30_000 })
    await expect(request).toHaveAttribute('data-state', 'review')

    const words = request.getByTestId('group-words')
    await expect(words).toContainText(DETAILS.occasion)
    await expect(words).toContainText(DETAILS.budget)
    await expect(words).toContainText(DETAILS.message)
    await expect(words).toContainText(DETAILS.note)
    await expect(request.getByTestId('group-deadline')).toContainText(/^À traiter avant/)
    await expect(request).toContainText(ACCEPT.guest.email)

    // Three answers, and a note for the team.
    await expect(
      request.getByRole('button', { name: `Accepter la demande de ${ACCEPT.guest.name}` }),
    ).toBeVisible()
    await expect(
      request.getByRole('button', { name: `Proposer un autre horaire à ${ACCEPT.guest.name}` }),
    ).toBeVisible()
    await expect(
      request.getByRole('button', { name: `Refuser la demande de ${ACCEPT.guest.name}` }),
    ).toBeVisible()
    for (const other of [DECLINE, PROPOSE, DEPOSIT_CASE]) {
      await expect(requestCard(page, other.guest.name)).toBeVisible()
    }
  })

  test('(a) the host accepts, choosing the tables, and the guest sees the party confirmed', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openGroups(page)
    const request = requestCard(page, ACCEPT.guest.name)
    await request
      .getByRole('button', { name: `Accepter la demande de ${ACCEPT.guest.name}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Accepter la demande de ${ACCEPT.guest.name}` })
    await expect(dialog).toBeVisible()

    await dialog.getByRole('radio', { name: 'Choisir les tables moi-même' }).check({
      timeout: 30_000,
    })
    // The tables held for the request are ticked: nine people need at least three of four.
    const chosen = dialog.getByTestId('approve-tables').getByRole('checkbox', { checked: true })
    await expect.poll(() => chosen.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
    await expect(dialog.getByTestId('group-consequence')).toContainText('Tables : ')
    await dialog.getByRole('button', { name: 'Accepter la demande', exact: true }).click()

    await expect(page.getByTestId('groups-notice')).toContainText(
      `Demande acceptée : ${ACCEPT.guest.name} reçoit un e-mail de confirmation.`,
      { timeout: 30_000 },
    )
    await expect(request).toHaveAttribute('data-state', 'approved')

    const guest = await openGuestPage(browser, baseURL, sent.accept!.manageUrl)
    await expect(
      guest.page.getByRole('heading', { name: 'Votre groupe est confirmé' }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(guest.page.getByText(/a confirmé votre réservation/)).toBeVisible()
    await guest.close()
  })

  test('(b) the host refuses with a reason, and the guest reads the reason and the way to reach the restaurant', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openGroups(page)
    const request = requestCard(page, DECLINE.guest.name)
    await request
      .getByRole('button', { name: `Refuser la demande de ${DECLINE.guest.name}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Refuser la demande de ${DECLINE.guest.name}` })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Motif (facultatif)').fill(DECLINE_REASON)
    await expect(dialog.getByTestId('group-consequence')).toContainText('avec votre motif')
    await dialog.getByRole('button', { name: 'Refuser la demande', exact: true }).click()
    await expect(page.getByTestId('groups-notice')).toContainText(
      `Demande refusée : ${DECLINE.guest.name} en est informé par e-mail.`,
      { timeout: 30_000 },
    )

    const guest = await openGuestPage(browser, baseURL, sent.decline!.manageUrl)
    const { page: guestPage } = guest
    await expect(
      guestPage.getByRole('heading', { name: "Le restaurant n'a pas pu accepter votre demande" }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(guestPage.getByText(DECLINE_REASON)).toBeVisible()
    // Never a bare refusal: the contact card, and a way to ask again.
    await expect(guestPage.getByTestId('contact-card')).toBeVisible()
    await expect(
      guestPage.getByRole('link', { name: 'Faire une nouvelle demande' }),
    ).toHaveAttribute('href', '/reservation')
    await guest.close()
  })

  test('(c) the host proposes another evening; the guest sees asked beside proposed, and accepts', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openGroups(page)
    const request = requestCard(page, PROPOSE.guest.name)
    await request
      .getByRole('button', { name: `Proposer un autre horaire à ${PROPOSE.guest.name}` })
      .click()
    const dialog = page.getByRole('dialog', {
      name: `Proposer un autre horaire à ${PROPOSE.guest.name}`,
    })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Jour', { exact: true }).fill(PROPOSED_DATE)

    // The slots come from the group engine under the team's own rules.
    const free = dialog.getByTestId('group-slots').locator('input[type="radio"]:not([disabled])')
    await expect(free.first()).toBeVisible({ timeout: 30_000 })
    await free.first().check()
    await dialog.getByLabel('Message au client (facultatif)').fill(PROPOSAL_NOTE)
    await dialog.getByRole('button', { name: 'Envoyer la proposition', exact: true }).click()
    await expect(page.getByTestId('groups-notice')).toContainText(
      `Proposition envoyée : ${PROPOSE.guest.name} peut accepter ou refuser`,
      { timeout: 30_000 },
    )
    await expect(request).toHaveAttribute('data-state', 'proposal')
    await expect(request).toContainText('Horaire proposé')

    // While the offer stands the guest answers: a plain status move cannot confirm it for them.
    const refusal = await tryConfirmGroupRequest(bench!, PROPOSE.guest.name)
    expect(refusal, 'the server confirmed a request over an open counter-proposal').toContain(
      'group_request_closed',
    )
    await expect(request).toHaveAttribute('data-state', 'proposal')

    const guest = await openGuestPage(browser, baseURL, sent.propose!.manageUrl)
    const { page: guestPage } = guest
    await expect(
      guestPage.getByRole('heading', { name: 'Le restaurant propose un autre horaire' }),
    ).toBeVisible({ timeout: 30_000 })
    const proposal = guestPage.getByTestId('group-proposal')
    await expect(proposal).toContainText(PROPOSAL_NOTE)
    const asked = proposal
      .locator('dt', { hasText: 'Ce que vous aviez demandé' })
      .locator('xpath=following-sibling::dd')
    const proposed = proposal
      .locator('dt', { hasText: 'Ce qui est proposé' })
      .locator('xpath=following-sibling::dd')
    await expect(asked).toBeVisible()
    await expect(proposed).toBeVisible()
    expect(await asked.textContent()).not.toBe(await proposed.textContent())
    await expect(proposal).toContainText("Aucun paiement n'est demandé")

    await proposal.getByRole('button', { name: 'Accepter cette proposition' }).click()
    await expect(guestPage.getByRole('heading', { name: 'Votre groupe est confirmé' })).toBeVisible(
      { timeout: 30_000 },
    )
    await guest.close()

    await expect(request).toHaveAttribute('data-state', 'approved', { timeout: 30_000 })
  })

  test('(d) the host accepts with a deposit, and the guest must tick the terms before any provider', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.skip(
      bench === null || bench.connected.length === 0,
      'no payment provider is connected on this deployment: the server refuses any acceptance that asks for money, and a fake provider would only test the fake',
    )
    await openGroups(page)
    const request = requestCard(page, DEPOSIT_CASE.guest.name)
    await request
      .getByRole('button', { name: `Accepter la demande de ${DEPOSIT_CASE.guest.name}` })
      .click()
    const dialog = page.getByRole('dialog', {
      name: `Accepter la demande de ${DEPOSIT_CASE.guest.name}`,
    })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio', { name: 'Choisir les tables moi-même' })).toBeVisible({
      timeout: 30_000,
    })
    // Money is a manager's decision: the fields exist only when the role holds it and a
    // provider takes cards.
    const deposit = dialog.getByRole('radio', { name: /^Acompte/ })
    test.skip(
      !(await deposit.isVisible()),
      'the deployment offers no deposit to this account (cards refused, no provider, or a role without reservations:manage)',
    )
    await deposit.check()
    await dialog.getByLabel('Acompte demandé (€)').fill(String(E2E_GROUP_DEPOSIT_CENTS / 100))
    await expect(dialog.getByTestId('group-consequence')).toContainText(DEPOSIT)
    await dialog
      .getByRole('button', {
        name: new RegExp(
          `^Accepter et demander ${E2E_GROUP_DEPOSIT_CENTS / 100},00\\s€ d'acompte$`,
        ),
      })
      .click()

    await expect(page.getByTestId('groups-notice')).toContainText(
      `Demande acceptée : ${DEPOSIT_CASE.guest.name} reçoit le lien pour régler.`,
      { timeout: 30_000 },
    )
    await expect(request).toHaveAttribute('data-state', 'awaiting_payment')
    await expect(request.getByTestId('group-payment')).toContainText(DEPOSIT)

    // The guest's own link: accepted, awaiting its payment, with the way to pay.
    const guest = await openGuestPage(browser, baseURL, sent.deposit!.manageUrl)
    const { page: guestPage } = guest
    await expect(
      guestPage.getByRole('heading', { name: 'Demande acceptée : il reste à régler' }),
    ).toBeVisible({ timeout: 30_000 })
    const block = guestPage.getByRole('region', { name: 'Paiement', exact: true })
    await expect(block).toContainText(DEPOSIT)
    await expect(block.getByRole('link', { name: 'Payer maintenant' })).toHaveAttribute(
      'href',
      /\/reservation\/payment\//,
    )
    await guest.close()
  })

  test('(d) the payment page asks for the terms in a required box, and the button waits for it', async ({
    browser,
    baseURL,
  }) => {
    test.skip(
      bench === null || bench.connected.length === 0,
      'no payment provider is connected on this deployment',
    )
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(paymentUrlFor(sent.deposit!.manageUrl))
    await expect(
      page.getByRole('heading', { level: 1, name: "Régler l'acompte de votre groupe" }),
    ).toBeVisible({ timeout: 30_000 })

    // The terms were set AFTER the guest's request: they are agreed to here, before any provider.
    const agreement = page.getByRole('checkbox', {
      name: /un acompte de .* est demandé pour confirmer la réservation de mon groupe/,
    })
    await expect(agreement).toBeVisible()
    await expect(agreement).not.toBeChecked()
    const pay = page.getByRole('button', { name: new RegExp(`^Payer ${DEPOSIT.source}$`) })
    await expect(pay).toBeDisabled()
    await agreement.click()
    await expect(pay).toBeEnabled()
    // Ticking is the guest's: unticking blocks the button again.
    await agreement.click()
    await expect(pay).toBeDisabled()
    await context.close()
  })

  test("PROVIDER TEST MODE — paying a group's deposit leaves the site for the provider's page", async ({
    browser,
    baseURL,
    page: host,
  }) => {
    test.skip(
      process.env.E2E_PAYMENT_PROVIDER_ROUNDTRIP !== '1',
      "needs a deployment whose payment provider is in TEST mode (Stripe test keys, or the SumUp / PayPal sandbox): set E2E_PAYMENT_PROVIDER_ROUNDTRIP=1. No card is typed on the provider's page here.",
    )
    test.skip(
      bench === null || bench.connected.length === 0,
      'no payment provider is connected on this deployment',
    )
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(paymentUrlFor(sent.deposit!.manageUrl))
    await page
      .getByRole('checkbox', {
        name: /un acompte de .* est demandé pour confirmer la réservation de mon groupe/,
      })
      .click()
    const payButton = new RegExp(`^Payer ${DEPOSIT.source}$`)
    const standIn = await pspReachable()
    if (standIn) {
      await goToProvider(page, PSP_PROVIDER, payButton)
      expect(new URL(page.url()).host).toBe(pspHost())
      // The group's deposit is paid on the provider's own page, and the guest comes back to a
      // confirmed group: whatever the house's usual confirmation mode, the payment confirms it.
      await payOnProviderPage(page, PSP_PROVIDER)
      await waitBackOnSite(page, baseURL)
      await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
        timeout: 60_000,
      })
      await expect(
        page.getByText(new RegExp(`Votre acompte de ${DEPOSIT.source} est payé`)),
      ).toBeVisible()

      await openGroups(host)
      await expect(requestCard(host, DEPOSIT_CASE.guest.name)).toHaveAttribute(
        'data-state',
        'approved',
        { timeout: 30_000 },
      )
    } else {
      await page.getByRole('button', { name: payButton }).click()
      await expect(
        page.getByRole('button', { name: 'Redirection vers le paiement…' }),
      ).toBeVisible()

      const ours = new URL(baseURL ?? page.url()).host
      await page.waitForURL((url) => url.host !== ours, { timeout: 60_000 })
      expect(new URL(page.url()).host).toMatch(/stripe|sumup|paypal/)
    }
    await context.close()
  })
})
