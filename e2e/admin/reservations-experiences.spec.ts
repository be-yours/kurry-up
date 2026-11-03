import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  E2E_EXPERIENCE_PRICE_CENTS,
  cleanExperiences,
  ensureBook,
  findExperience,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  openExperiences,
  openPaymentBench,
  paidSalesPossible,
  tryEditTicket,
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
 * An evening with limited seats, from the host's form to the guest's tickets and back.
 *
 * WHAT THIS IS FOR. Which seats are left, who may buy how many, the hold, the refund of a
 * cancelled event and the CSV are held by convex-test. What only a browser shows is the
 * chain across three screens: the host's form (with its live validation sentences, its
 * publishing dialog that says it HOLDS the room, its duplicate that is only a prefill), the
 * guest's section of the booking page (a plain number of seats left, never a nudge; « Complet »
 * and « Me prévenir » once the last seat is gone, with an honest word that nothing is held),
 * the guest's own ticket page, and the host's door list, file and cancellation.
 *
 * WHAT THIS CANNOT DO. There is no payment-provider account in the bench. A PAID event can
 * only be put on sale by a deployment with a provider CONNECTED, so the paid steps read that
 * from the server and skip, naming the reason, when nothing is connected; the free event
 * (price 0, confirmed on the spot) needs no provider and carries the rest of the story.
 * « The provider's page » opens only with `E2E_PAYMENT_PROVIDER_ROUNDTRIP=1`, exactly as in
 * `reservations-payments.spec.ts`: it asserts the browser LEFT the site for the provider's
 * host. With a stand-in for the providers (`E2E_PSP_URL`, see `psp-standin.helpers.ts`;
 * `E2E_PSP_PROVIDER` picks Stripe, SumUp or PayPal) the guest then pays there and comes back,
 * and the host's cancelling the paid event is seen refunding that ticket through the provider.
 *
 * ONE STORY, IN ORDER. The host drafts a 4-seat, 45 € event (a bad value says why while it is
 * typed), puts it on sale, duplicates it into a free brunch and puts that on sale too. A guest
 * buys 4 seats of the paid event up to its payment page and 4 of the free one, which are
 * confirmed at once; the free event then reads « Complet » and takes an alert request that
 * holds nothing. The host reads the door list, exports the file and cancels the event; the
 * guest's own page says so. Every E2E event is taken off the books afterwards, so no evening
 * stays held.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const RUN = Date.now().toString(36)
const TITLE_PREFIX = 'E2E '
const TITLE_PAID = `E2E Dégustation ${RUN}`
const TITLE_FREE = `E2E Brunch offert ${RUN}`
// Nobody else books these evenings: the specs share one book.
const DATE_PAID = isoDateAhead(16)
const DATE_FREE = isoDateAhead(17)
const SEATS = 4
const TOTAL = new RegExp(`${(SEATS * E2E_EXPERIENCE_PRICE_CENTS) / 100},00\\s€`)
const PRICE = new RegExp(`${E2E_EXPERIENCE_PRICE_CENTS / 100},00\\s€ par place`)
const CANCEL_REASON = `Le chef est souffrant, ${RUN}.`
const URGENCY = /plus que|dépêchez|dernières? places?/i
const BOM = String.fromCharCode(0xfeff)

const BUYER: GuestDetails & { note: string } = {
  name: `E2E Convive ${RUN}`,
  email: `e2e.convive.${RUN}@example.com`,
  phone: '0612345678',
  note: `Sans gluten pour deux personnes ${RUN}`,
}
const WATCHER = { name: `E2E Alerte ${RUN}`, email: `e2e.alerte.${RUN}@example.com` }

let bench: PaymentBench | null = null
let paid = false
let paymentUrl = ''
let ticketUrl = ''
let paidTicketUrl = ''
let restoreProvider: (() => Promise<void>) | null = null

test.afterAll(async () => {
  // Whatever happened above, no E2E evening stays on sale, and no table stays held.
  try {
    if (bench) await cleanExperiences(bench, TITLE_PREFIX)
  } catch {
    // The next run's set-up takes them off the books.
  }
  await restoreProvider?.().catch(() => undefined)
})

const NO_PROVIDER =
  'no payment provider is connected on this deployment: the server refuses to put a paid event on sale, and a fake provider would only test the fake'

/** The host's row of one event, found by its title. */
function eventRow(page: Page, title: string): Locator {
  return page.locator('[data-experience-state]').filter({ hasText: title })
}

/** The guest's card of one event, in the « Événements » section of the booking page. */
function eventCard(page: Page, title: string): Locator {
  return page.getByRole('article', { name: title, exact: true })
}

async function openEventsSection(page: Page): Promise<Locator> {
  await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
    timeout: 30_000,
  })
  const section = page.getByRole('region', { name: 'Événements' })
  await expect(section).toBeVisible({ timeout: 30_000 })
  return section
}

/** Open the « Réserver » form of a card and fill who is coming, up to — not including — the agreement. */
async function fillPurchase(page: Page, title: string, seats: number): Promise<Locator> {
  await eventCard(page, title)
    .getByRole('button', { name: /^Réserver/ })
    .click()
  const form = page.getByRole('form', { name: `Réserver des places : ${title}` })
  await expect(form).toBeVisible()
  await form.getByLabel('Nombre de places', { exact: true }).selectOption(String(seats))
  await form.getByLabel('Nom', { exact: true }).fill(BUYER.name)
  await form.getByLabel('E-mail', { exact: true }).fill(BUYER.email)
  await form.getByLabel('Téléphone', { exact: true }).fill(BUYER.phone)
  await form.getByLabel('Allergies et régimes alimentaires (facultatif)').fill(BUYER.note)
  await form.getByRole('checkbox', { name: /J'accepte les conditions de réservation/ }).click()
  return form
}

test.describe('An event with limited seats', () => {
  test('the owner opens the book, and earlier E2E events are taken off the books', async ({
    page,
  }) => {
    await ensureBook(page, { autoConfirm: true })
    bench = await openPaymentBench(page)
    if (await pspReachable()) {
      // A stand-in for the providers is listening: connect the one under test, as an owner would.
      await psp.reset()
      restoreProvider = await connectProvider(bench, PSP_PROVIDER)
    }
    paid = await paidSalesPossible(bench)
    await cleanExperiences(bench, TITLE_PREFIX)
  })

  test('the host drafts a paid event; a bad value says why while it is typed', async ({ page }) => {
    await openExperiences(page)
    await page.getByRole('button', { name: 'Nouvel événement' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Nouvel événement' })
    await expect(dialog).toBeVisible()

    await dialog.getByLabel("Nom de l'événement").fill(TITLE_PAID)
    await dialog
      .getByLabel('Description (facultative)')
      .fill('Cinq plats, cinq vins, à la table du chef.')

    // Live validation: the sentence appears under the field as soon as it is touched.
    await dialog.getByLabel("Prix d'une place (€)").fill('abc')
    await expect(
      dialog.getByText("Indiquez un prix en euros, avec deux décimales au plus (0 pour l'offrir)."),
    ).toBeVisible()
    await dialog.getByLabel('Nombre de places', { exact: true }).fill('x')
    await expect(dialog.getByText('Indiquez le nombre de places.')).toBeVisible()

    // Saving with no date says so and keeps the form open: nothing reaches the server.
    await dialog.getByRole('button', { name: 'Enregistrer le brouillon' }).click()
    await expect(dialog.getByText("Indiquez la date et l'heure de l'événement.")).toBeVisible()
    await expect(dialog).toBeVisible()

    // Fixing a value takes its sentence away.
    await dialog.getByLabel("Prix d'une place (€)").fill(String(E2E_EXPERIENCE_PRICE_CENTS / 100))
    await expect(dialog.getByText(/Indiquez un prix en euros/)).toHaveCount(0)
    await dialog.getByLabel('Nombre de places', { exact: true }).fill(String(SEATS))
    await expect(dialog.getByText('Indiquez le nombre de places.')).toHaveCount(0)
    await dialog.getByLabel('Places max par réservation').fill(String(SEATS))
    await dialog.getByLabel('Annulation gratuite, en heures avant le début').fill('24')
    await dialog.getByLabel('Date', { exact: true }).fill(DATE_PAID)

    // A paid seat can only be sold with a provider connected: the form says so before saving.
    const note = dialog.getByTestId('experience-payment-note')
    if (paid) await expect(note).toHaveCount(0)
    else await expect(note).toBeVisible()

    await dialog.getByRole('button', { name: 'Enregistrer le brouillon' }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })

    const row = eventRow(page, TITLE_PAID)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute('data-experience-state', 'draft')
    await expect(row).toContainText('Brouillon')
    await expect(row).toContainText(PRICE)
    // A draft is invisible to guests: it has no place on the booking page.
    await expect(row.getByRole('button', { name: `Mettre en vente : ${TITLE_PAID}` })).toBeVisible()
  })

  test('the host puts the paid event on sale: the dialog says the room is held, and guests see 4 seats left', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openExperiences(page)
    await eventRow(page, TITLE_PAID)
      .getByRole('button', { name: `Mettre en vente : ${TITLE_PAID}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Mettre « ${TITLE_PAID} » en vente` })
    await expect(dialog).toBeVisible()
    // Publishing is not a switch: it holds the room, and the dialog says so before it does.
    await expect(dialog.getByTestId('experience-publish-hold')).toContainText(/réserve/)

    const publish = dialog.getByRole('button', { name: 'Mettre en vente', exact: true })
    if (!paid) {
      // Without a provider the dialog refuses to sell a paid seat and points to the settings.
      await expect(dialog.getByTestId('experience-publish-payment')).toBeVisible()
      await expect(publish).toBeDisabled()
      await dialog.getByRole('button', { name: 'Fermer', exact: true }).click()
      test.skip(true, NO_PROVIDER)
    }
    await publish.click()
    await expect(eventRow(page, TITLE_PAID)).toHaveAttribute('data-experience-state', 'on_sale', {
      timeout: 15_000,
    })

    // The guest's booking page lists it, with the seats left as a plain number.
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    const section = await openEventsSection(guestPage)
    const cardOfEvent = eventCard(guestPage, TITLE_PAID)
    await expect(cardOfEvent).toBeVisible()
    await expect(cardOfEvent).toContainText(`${SEATS} places restantes`)
    await expect(cardOfEvent).toContainText(PRICE)
    await expect(section).not.toContainText(URGENCY)
    await context.close()
  })

  test('the host duplicates it into a free brunch: a prefill, with the date left to choose', async ({
    page,
  }) => {
    await openExperiences(page)
    await eventRow(page, TITLE_PAID)
      .getByRole('button', { name: `Dupliquer : ${TITLE_PAID}` })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Dupliquer un événement' })
    await expect(dialog).toBeVisible()
    // Everything is copied but the date, which belongs to the host.
    await expect(dialog.getByLabel("Nom de l'événement")).toHaveValue(TITLE_PAID)
    await expect(dialog.getByLabel('Nombre de places', { exact: true })).toHaveValue(String(SEATS))
    await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue('')

    await dialog.getByLabel("Nom de l'événement").fill(TITLE_FREE)
    await dialog.getByLabel("Prix d'une place (€)").fill('0')
    await expect(dialog.getByText(/Gratuit : la place est confirmée tout de suite/)).toBeVisible()
    await dialog.getByLabel('Date', { exact: true }).fill(DATE_FREE)
    await dialog.getByRole('button', { name: 'Enregistrer le brouillon' }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })

    const row = eventRow(page, TITLE_FREE)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute('data-experience-state', 'draft')
    await expect(row).toContainText('Gratuit')
    // Nothing happened to the original.
    await expect(eventRow(page, TITLE_PAID)).toBeVisible()
  })

  test('the host puts the free event on sale, and guests see it with 4 places restantes', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openExperiences(page)
    await eventRow(page, TITLE_FREE)
      .getByRole('button', { name: `Mettre en vente : ${TITLE_FREE}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Mettre « ${TITLE_FREE} » en vente` })
    await expect(dialog.getByTestId('experience-publish-hold')).toBeVisible()
    // A free event needs no provider: nothing blocks the button.
    await expect(dialog.getByTestId('experience-publish-payment')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Mettre en vente', exact: true }).click()
    await expect(eventRow(page, TITLE_FREE)).toHaveAttribute('data-experience-state', 'on_sale', {
      timeout: 15_000,
    })

    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    const section = await openEventsSection(guestPage)
    const cardOfEvent = eventCard(guestPage, TITLE_FREE)
    await expect(cardOfEvent).toBeVisible()
    await expect(cardOfEvent).toContainText(`${SEATS} places restantes`)
    await expect(cardOfEvent.getByText('Gratuit', { exact: true })).toBeVisible()
    await expect(cardOfEvent.getByRole('button', { name: /^Réserver/ })).toBeVisible()
    // The tone is neutral: a plain number, no pressure of any kind.
    await expect(section).not.toContainText(URGENCY)
    await context.close()
  })

  test('a guest buys 4 seats of the paid event, reads the price and the terms, and reaches its payment page', async ({
    browser,
    baseURL,
  }) => {
    test.skip(!paid, NO_PROVIDER)
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await openEventsSection(page)
    const form = await fillPurchase(page, TITLE_PAID, SEATS)

    // What is owed and the terms are in front of the button BEFORE anything is sent.
    const box = page.getByTestId('experience-payment-box')
    await expect(box).toBeVisible({ timeout: 30_000 })
    await expect(box.getByRole('heading', { name: 'Règlement des places' })).toBeVisible()
    await expect(box).toContainText(TOTAL)
    await expect(box).toContainText(/Vos places vous sont gardées \d+ minutes pour payer/)

    const next = form.getByRole('button', { name: 'Continuer vers le paiement' })
    await expect(next).toBeDisabled()
    const agreement = box.getByRole('checkbox', {
      name: /le prix de mes places, .* est payé maintenant/,
    })
    await agreement.click()
    await expect(next).toBeEnabled()
    // Ticking is the guest's: unticking blocks the button again.
    await agreement.click()
    await expect(next).toBeDisabled()
    await agreement.click()
    await next.click()

    await page.waitForURL(/\/reservation\/payment\/[^/?]+/, { timeout: 30_000 })
    paymentUrl = page.url().split('?')[0]!
    await expect(page.getByRole('heading', { level: 1, name: 'Régler vos places' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      page.getByRole('button', { name: new RegExp(`^Payer ${TOTAL.source}$`) }),
    ).toBeVisible()
    await expect(page.getByRole('timer')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Places confirmées' })).toHaveCount(0)
    await context.close()
  })

  test("PROVIDER TEST MODE — paying for the seats leaves the site for the provider's page", async ({
    browser,
    baseURL,
  }) => {
    test.skip(
      process.env.E2E_PAYMENT_PROVIDER_ROUNDTRIP !== '1',
      "needs a deployment whose payment provider is in TEST mode (Stripe test keys, or the SumUp / PayPal sandbox): set E2E_PAYMENT_PROVIDER_ROUNDTRIP=1. No card is typed on the provider's page here.",
    )
    test.skip(!paid || paymentUrl === '', NO_PROVIDER)
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto(paymentUrl)
    const standIn = await pspReachable()
    if (standIn) {
      await goToProvider(page, PSP_PROVIDER, new RegExp(`^Payer ${TOTAL.source}$`))
    } else {
      await page.getByRole('button', { name: new RegExp(`^Payer ${TOTAL.source}$`) }).click()
      await expect(
        page.getByRole('button', { name: 'Redirection vers le paiement…' }),
      ).toBeVisible()
      const ours = new URL(baseURL ?? page.url()).host
      await page.waitForURL((url) => url.host !== ours, { timeout: 60_000 })
      expect(new URL(page.url()).host).toMatch(/stripe|sumup|paypal/)
    }
    if (standIn) {
      expect(new URL(page.url()).host).toBe(pspHost())
      // The seats are paid on the provider's own page, and the guest comes back to them.
      await payOnProviderPage(page, PSP_PROVIDER)
      await waitBackOnSite(page, baseURL)
      await expect(page.getByRole('heading', { name: 'Places confirmées' })).toBeVisible({
        timeout: 60_000,
      })
      await expect(
        page.getByText(new RegExp(`Vos places sont payées : ${TOTAL.source}`)),
      ).toBeVisible()
      paidTicketUrl = paymentUrl.replace('/reservation/payment/', '/reservation/manage/')
    }
    await context.close()
  })

  test('a guest buys 4 seats of the free event: confirmed on the spot, and the page shows the places', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await openEventsSection(page)
    const form = await fillPurchase(page, TITLE_FREE, SEATS)

    await expect(
      form.getByText(`Cet événement est gratuit : vos ${SEATS} places sont confirmées`),
    ).toBeVisible({ timeout: 30_000 })
    // Free: there is no payment box and no payment box to tick.
    await expect(page.getByTestId('experience-payment-box')).toHaveCount(0)
    const submit = form.getByRole('button', { name: 'Confirmer mes places' })
    await expect(submit).toBeEnabled()
    await submit.click()

    await page.waitForURL(/\/reservation\/manage\/[^/?]+/, { timeout: 30_000 })
    ticketUrl = page.url().split('?')[0]!
    await expect(page.getByRole('heading', { level: 1, name: 'Mes places' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText('Vos places sont réservées. À bientôt !')).toBeVisible()
    await expect(page.locator('dl').getByText(`${SEATS} places`, { exact: true })).toBeVisible()
    await expect(page.locator('dl').getByText(TITLE_FREE, { exact: true })).toBeVisible()
    await expect(page.getByText(/^RES-\d{4}-\d{5}$/)).toBeVisible()
    // Nothing is owed, so there is no payment block at all.
    await expect(page.getByRole('region', { name: 'Paiement', exact: true })).toHaveCount(0)
    await context.close()
  })

  test('once the last seat is gone the card reads « Complet », and « Me prévenir » holds nothing', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    const section = await openEventsSection(page)
    const cardOfEvent = eventCard(page, TITLE_FREE)
    await expect(cardOfEvent.getByText('Complet', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(cardOfEvent.getByText(/places restantes/)).toHaveCount(0)
    await expect(cardOfEvent.getByRole('button', { name: /^Réserver/ })).toHaveCount(0)
    await expect(section).not.toContainText(URGENCY)

    await cardOfEvent.getByRole('button', { name: /^Me prévenir/ }).click()
    const form = page.getByRole('form', { name: `Me prévenir : ${TITLE_FREE}` })
    await expect(form).toBeVisible()
    // Said before anything is typed: this is not a booking.
    await expect(
      form.getByText("Ce n'est pas une réservation : aucune place n'est gardée."),
    ).toBeVisible()

    const submit = form.getByRole('button', { name: 'Me prévenir', exact: true })
    await expect(submit).toBeDisabled()
    await form.getByLabel('Nom', { exact: true }).fill(WATCHER.name)
    await form.getByLabel('E-mail', { exact: true }).fill(WATCHER.email)
    await form.getByLabel('Nombre de places souhaité').selectOption('2')
    await form
      .getByRole('checkbox', {
        name: /J'accepte que .* garde mon nom et mon e-mail pour me prévenir si des places se libèrent/,
      })
      .click()
    await expect(submit).toBeEnabled()
    await submit.click()

    // The confirmation says what it is NOT before it says what it is.
    await expect(page.getByText("C'est noté, vous serez prévenu(e)")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/Aucune place n'est gardée pour vous/)).toBeVisible()
    await expect(page.getByText(/rien ne garantit qu'il y en aura/)).toBeVisible()
    await context.close()
  })

  test('the host opens the door list: names, seats, the dietary note and how each is paid', async ({
    page,
  }) => {
    await openExperiences(page)
    const row = eventRow(page, TITLE_FREE)
    await expect(row).toHaveAttribute('data-experience-state', 'sold_out', { timeout: 30_000 })
    await expect(row).toContainText('Complet')
    // The people waiting for a seat are counted for the host, with no promise to them.
    await expect(row).toContainText(/attend qu'une place se libère/)

    await row.getByRole('button', { name: `Invités : ${TITLE_FREE}` }).click()
    const sheet = page.getByRole('dialog', { name: `Invités · ${TITLE_FREE}` })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId('experience-attendees-seats')).toContainText(
      `${SEATS} places vendues`,
    )
    await expect(sheet.getByTestId('experience-attendees-seats')).toContainText(`sur ${SEATS}`)
    await expect(sheet.getByRole('list', { name: 'Places par statut' })).toContainText(
      `Confirmé · ${SEATS} places`,
    )

    const attendee = sheet.getByRole('listitem').filter({ hasText: BUYER.name }).first()
    await expect(attendee).toBeVisible({ timeout: 30_000 })
    await expect(attendee).toContainText(BUYER.email)
    await expect(attendee.getByText(`${SEATS} places`, { exact: true })).toBeVisible()
    await expect(attendee.getByTestId('attendee-payment')).toHaveText('Gratuit')
    // The kitchen cannot miss it: allergies and diets are drawn apart.
    await expect(attendee.getByRole('note')).toContainText(BUYER.note)
  })

  test('the host exports the door list as a CSV file', async ({ page }) => {
    await openExperiences(page)
    await eventRow(page, TITLE_FREE)
      .getByRole('button', { name: `Invités : ${TITLE_FREE}` })
      .click()
    const sheet = page.getByRole('dialog', { name: `Invités · ${TITLE_FREE}` })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('listitem').filter({ hasText: BUYER.name }).first()).toBeVisible({
      timeout: 30_000,
    })

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      sheet.getByRole('button', { name: 'Exporter en CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toBe(`event-e2e-brunch-offert-${RUN}-${DATE_FREE}.csv`)
    const path = await download.path()
    const csv = await readFile(path, 'utf8')
    // A byte-order mark so a spreadsheet reads the accents, then the header, then the guest.
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv.slice(1)).toMatch(
      /^Référence,Nom,E-mail,Téléphone,Places,Statut,Paiement,Payé \(€\),Remboursé \(€\),Demande du client,Réservé le\r?\n/,
    )
    expect(csv).toContain(
      `${BUYER.name},${BUYER.email},${BUYER.phone},${SEATS},Confirmé,Gratuit,0.00,0.00,${BUYER.note}`,
    )
  })

  test('a ticket is edited from its event only: no « Modifier » in the day book, and the server refuses', async ({
    page,
  }) => {
    await openDayBook(page, DATE_FREE)
    const ticket = page.getByRole('listitem').filter({ hasText: BUYER.name }).first()
    await expect(ticket).toBeVisible({ timeout: 30_000 })
    await expect(ticket.getByRole('button', { name: 'Modifier' })).toHaveCount(0)

    // Whatever a screen offers, the server will not raise a ticket past the seats on sale.
    const refusal = await tryEditTicket(
      bench!,
      await findExperience(bench!, TITLE_FREE),
      BUYER.name,
      DATE_FREE,
    )
    expect(refusal, 'the server accepted an edit of a ticket').toContain('ticket_not_editable')
  })

  test('the host cancels the whole event after reading what it will do, and the guest page says so', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openExperiences(page)
    await eventRow(page, TITLE_FREE)
      .getByRole('button', { name: `Annuler l'événement : ${TITLE_FREE}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Annuler « ${TITLE_FREE} » ?` })
    await expect(dialog).toBeVisible()

    // What will happen, from the door list, before anything does.
    const warning = dialog.getByTestId('experience-cancel-warning')
    await expect(warning).toContainText('Cette annulation est définitive')
    await expect(warning).toContainText(`1 client est annulé par l'établissement (${SEATS} places)`)
    await expect(warning).toContainText('Chaque client est prévenu par e-mail.')

    // It cannot be undone: the button waits for a box the host ticks.
    const confirm = dialog.getByRole('button', { name: "Annuler l'événement", exact: true })
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel('Message aux clients (facultatif)').fill(CANCEL_REASON)
    await dialog.getByRole('checkbox', { name: /J'ai compris/ }).check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    const row = eventRow(page, TITLE_FREE)
    await expect(row).toHaveAttribute('data-experience-state', 'cancelled', { timeout: 30_000 })
    await expect(row).toContainText('Annulée')
    await expect(row).toContainText(CANCEL_REASON)

    // The guest's own page: the event is cancelled, with the host's message.
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto(ticketUrl)
    await expect(guestPage.getByRole('heading', { level: 1, name: 'Mes places' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(guestPage.getByRole('heading', { name: 'Cet événement est annulé' })).toBeVisible()
    await expect(guestPage.getByText(/a annulé cet événement\./)).toBeVisible()
    await expect(guestPage.getByText(`Son message : « ${CANCEL_REASON} »`)).toBeVisible()
    await expect(guestPage.getByText("L'établissement a dû annuler ces places.")).toBeVisible()
    await expect(guestPage.getByTestId('contact-card')).toBeVisible()

    // And it no longer has a card on the booking page.
    await guestPage.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Réserver une table' }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(eventCard(guestPage, TITLE_FREE)).toHaveCount(0)
    await context.close()
  })

  test('cancelling the paid event refunds every ticket in full through the provider', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.skip(paidTicketUrl === '', 'no ticket of the paid event was paid on the provider stand-in')
    await openExperiences(page)
    await eventRow(page, TITLE_PAID)
      .getByRole('button', { name: `Annuler l'événement : ${TITLE_PAID}` })
      .click()
    const dialog = page.getByRole('dialog', { name: `Annuler « ${TITLE_PAID} » ?` })
    await expect(dialog).toBeVisible()
    // The host reads the money before it moves.
    await expect(dialog.getByTestId('experience-cancel-warning')).toContainText(
      new RegExp(`remboursées en totalité, automatiquement : ${TOTAL.source}`),
    )
    await dialog.getByLabel('Message aux clients (facultatif)').fill(CANCEL_REASON)
    await dialog.getByRole('checkbox', { name: /J'ai compris/ }).check()
    await dialog.getByRole('button', { name: "Annuler l'événement", exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(eventRow(page, TITLE_PAID)).toHaveAttribute('data-experience-state', 'cancelled', {
      timeout: 30_000,
    })

    // The provider was asked for the whole price, once.
    const cents = SEATS * E2E_EXPERIENCE_PRICE_CENTS
    await expect
      .poll(
        async () => {
          const state = await psp.state()
          if (PSP_PROVIDER === 'stripe') return state.stripe.refunds.map((refund) => refund.amount)
          if (PSP_PROVIDER === 'sumup') {
            return state.sumup.transactions
              .filter((txn) => txn.refunded > 0)
              .map((txn) => Math.round(txn.refunded * 100))
          }
          return state.paypal.refunds.map((refund) => Math.round(Number(refund.amount.value) * 100))
        },
        { timeout: 60_000 },
      )
      .toEqual([cents])

    // And the guest's own page says so.
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto(paidTicketUrl)
    await expect(guestPage.getByRole('heading', { name: 'Cet événement est annulé' })).toBeVisible({
      timeout: 30_000,
    })
    const money = guestPage.getByRole('region', { name: 'Paiement', exact: true })
    await expect(money).toContainText('Remboursé', { timeout: 30_000 })
    await expect(money).toContainText(TOTAL)
    await context.close()
  })
})
