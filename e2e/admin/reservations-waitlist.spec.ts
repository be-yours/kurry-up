import { test, expect } from '@playwright/test'
import {
  NO_MAIL_LOG,
  MAIL_LOG,
  ensureBook,
  fillDayAsHost,
  isoDateAhead,
  mailsTo,
  newGuestContext,
  openDayBook,
  setWaitlist,
  waitForMailPath,
  waitlistPanel,
} from '../helpers/reservations.helpers'

/**
 * A day that is full, a guest who asks to be told, and the table that comes free.
 *
 * WHAT THIS IS FOR. The matching, the hold and the claim are held by convex-test
 * against a fake clock and a fake mailer; what only a browser and a real backend
 * show is the chain between three screens that never meet — the guest's form, the
 * host's panel and the guest's own page — and that the page the guest left open is
 * the one that turns into an offer when the host cancels a booking. There is no
 * mail hook in this suite, so the offer is observed where it lands: the host's panel
 * says a table is held, and the guest's page, reactive, says the same.
 *
 * ONE DAY, ONE STORY. The date is three weeks out and the names carry a run number.
 * The host fills the day through the dialog (it stops when the engine says
 * « Complet », so a rerun books nothing), the guest joins the waitlist, the host
 * cancels one booking, and the guest takes the table. The guest is a second browser
 * that is not signed in.
 *
 * NEEDS A MAIL TRANSPORT THAT ACCEPTS A SEND. The server gives an offer back (the entry
 * returns to « waiting ») when its e-mail could not leave, because a table held for
 * someone nobody told is a table held for no one. A deployment whose SES credentials
 * are placeholders therefore fails the claim steps by design. Point the Convex
 * deployment at any endpoint that answers a SESv2 send: `AWS_ENDPOINT_URL_SESV2`, with
 * `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SES_FROM_EMAIL` set.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const RUN = Date.now().toString(36)
const DATE = isoDateAhead(21)
const GUEST = {
  name: `E2E Attente ${RUN}`,
  email: `e2e.attente.${RUN}@example.com`,
  phone: '0612345678',
}

let waitlistUrl = ''
let guestContext: Awaited<ReturnType<typeof newGuestContext>> | null = null

test.describe('The waitlist', () => {
  test('the owner turns the waitlist on and fills a day', async ({ page }) => {
    await ensureBook(page, { autoConfirm: true })
    await setWaitlist(page, true, 15)
    await fillDayAsHost(page, DATE, `E2E Complet ${RUN}`)
  })

  test('on a full day a guest asks to be told, and is promised no table', async ({
    browser,
    baseURL,
  }) => {
    guestContext = await newGuestContext(browser, baseURL)
    const page = await guestContext.newPage()
    await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByLabel('Nombre de convives').selectOption('2')
    await page.getByLabel('Date', { exact: true }).fill(DATE)

    await expect(page.getByText(/Ce jour est complet/)).toBeVisible({ timeout: 30_000 })
    const section = page.getByRole('region', { name: 'Me prévenir si une table se libère' })
    await expect(section).toBeVisible()
    await expect(section.getByText("Ce n'est pas une réservation")).toBeVisible()

    await section.getByRole('button', { name: 'Demander à être prévenu' }).click()
    await section.getByLabel('Nom', { exact: true }).fill(GUEST.name)
    await section.getByLabel('E-mail', { exact: true }).fill(GUEST.email)
    await section.getByLabel('Téléphone (facultatif)').fill(GUEST.phone)
    // The notice says what happens to the request before the guest agrees to it.
    await expect(section.getByText(/un seul e-mail/)).toBeVisible()
    const submit = section.getByRole('button', { name: 'Me prévenir', exact: true })
    await expect(submit).toBeDisabled()
    await section.getByRole('checkbox', { name: /J'accepte que .* garde mon nom/ }).click()
    await submit.click()

    await expect(page.getByText("Vous êtes sur la liste d'attente")).toBeVisible({
      timeout: 30_000,
    })
    // The page hands nobody a credential: the guest's own link goes to the address they gave.
    await expect(page.getByRole('link', { name: 'Suivre ou retirer ma demande' })).toHaveCount(0)
    await expect(page.getByText(/est envoyé à l'adresse indiquée/)).toBeVisible()
    test.skip(!MAIL_LOG, NO_MAIL_LOG)
    const path = await waitForMailPath(GUEST.email, '/reservation/waitlist/')
    expect(path, 'the link mail never reached the stand-in transport').toBeTruthy()
    waitlistUrl = path!

    // Their own page: nothing is held, and an e-mail will come if a table frees up.
    await page.goto(waitlistUrl)
    await expect(page.getByRole('heading', { level: 1, name: "Ma liste d'attente" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText("Aucune table n'est gardée pour vous")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retirer ma demande' })).toBeVisible()
  })

  test('someone else typing the same address gets the same answer, no link, and changes nothing', async ({
    page: hostPage,
    browser,
    baseURL,
  }) => {
    test.skip(!MAIL_LOG, NO_MAIL_LOG)
    const attacker = await newGuestContext(browser, baseURL)
    const page = await attacker.newPage()
    await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Nombre de convives').selectOption('2')
    await page.getByLabel('Date', { exact: true }).fill(DATE)
    await expect(page.getByText(/Ce jour est complet/)).toBeVisible({ timeout: 30_000 })
    const section = page.getByRole('region', { name: 'Me prévenir si une table se libère' })
    await section.getByRole('button', { name: 'Demander à être prévenu' }).click()
    await section.getByLabel('Nom', { exact: true }).fill(`E2E Intrus ${RUN}`)
    await section.getByLabel('E-mail', { exact: true }).fill(GUEST.email.toUpperCase())
    await section.getByLabel('Téléphone (facultatif)').fill('0699999999')
    await section.getByRole('checkbox', { name: /J'accepte que .* garde mon nom/ }).click()
    await section.getByRole('button', { name: 'Me prévenir', exact: true }).click()

    // The same words as a fresh request, and still no way to reach the entry from here.
    await expect(page.getByText("Vous êtes sur la liste d'attente")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('link', { name: 'Suivre ou retirer ma demande' })).toHaveCount(0)
    await attacker.close()

    // The host's panel still names the first guest only, with their own words.
    await openDayBook(hostPage, DATE)
    const panel = waitlistPanel(hostPage)
    await expect(panel.getByRole('listitem').filter({ hasText: GUEST.name })).toBeVisible({
      timeout: 30_000,
    })
    await expect(panel.getByText(`E2E Intrus ${RUN}`)).toHaveCount(0)
    // One link mail went to the owner of the address, and nothing went to anyone else.
    expect(
      mailsTo(GUEST.email).filter((body) => body.includes('/reservation/waitlist/')),
    ).toHaveLength(1)
  })

  test('the host sees the guest waiting, with the window and how long', async ({ page }) => {
    await openDayBook(page, DATE)
    const panel = waitlistPanel(page)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    const entry = panel.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(entry).toBeVisible({ timeout: 30_000 })
    await expect(entry.getByText('En attente', { exact: true })).toBeVisible()
    await expect(entry.getByText('Toute la journée')).toBeVisible()
    await expect(entry.getByRole('button', { name: 'Proposer une table' })).toBeVisible()
  })

  test('a cancellation frees a table: it is held for the guest, on both screens', async ({
    page,
  }) => {
    await openDayBook(page, DATE)
    const booking = page
      .getByRole('listitem')
      .filter({ hasText: `E2E Complet ${RUN} 1` })
      .first()
    await expect(booking).toBeVisible({ timeout: 30_000 })
    await booking.getByRole('button', { name: 'Annuler', exact: true }).click()
    await expect(booking.getByText('Annulée par le restaurant')).toBeVisible({ timeout: 15_000 })

    // The host's panel: the table is held, until when.
    const entry = waitlistPanel(page).getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(entry.getByText('Table proposée')).toBeVisible({ timeout: 30_000 })
    await expect(entry.getByText(/Table gardée jusqu'à \d{2}:\d{2}/)).toBeVisible()

    // The guest's page, which was open the whole time and has not been reloaded.
    const guestPage = await guestContext!.newPage()
    await guestPage.goto(waitlistUrl)
    await expect(
      guestPage.getByRole('heading', { level: 1, name: /Une table s'est libérée/ }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await expect(guestPage.getByText(/vous est gardée jusqu'à/)).toBeVisible()
    await expect(guestPage.getByText(/proposée à la personne suivante/)).toBeVisible()
    await guestPage.close()
  })

  test('nobody else can take the held table, and the guest can', async ({ browser, baseURL }) => {
    // Another guest, same day: the held table is not for sale.
    const other = await newGuestContext(browser, baseURL)
    const otherPage = await other.newPage()
    await otherPage.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await otherPage.getByLabel('Nombre de convives').selectOption('2')
    await otherPage.getByLabel('Date', { exact: true }).fill(DATE)
    await expect(otherPage.getByText(/Ce jour est complet/)).toBeVisible({ timeout: 30_000 })
    await other.close()

    // The waitlisted guest takes it: the conditions, the box, one click.
    const page = await guestContext!.newPage()
    await page.goto(waitlistUrl)
    await expect(
      page.getByRole('heading', { level: 1, name: /Une table s'est libérée/ }),
    ).toBeVisible({
      timeout: 30_000,
    })
    const take = page.getByRole('button', { name: 'Réserver cette table' })
    await expect(take).toBeDisabled()
    await page.getByRole('checkbox', { name: /J'accepte les conditions de réservation/ }).click()
    // The marketing box is unchecked, and stays so: booking subscribes nobody.
    await expect(
      page.getByRole('checkbox', { name: /Je souhaite recevoir les nouvelles/ }),
    ).not.toBeChecked()
    await take.click()

    await expect(page.getByRole('heading', { name: 'Table réservée' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/^RES-\d{4}-\d{5}$/)).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Voir ou annuler ma réservation' }),
    ).toHaveAttribute('href', /\/reservation\/manage\//)
    // The offer cannot be claimed twice: the page now shows the booking, not the offer.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Table réservée' })).toBeVisible({
      timeout: 30_000,
    })
    await page.close()
  })

  test('the host sees the booking, and the waitlist is empty again', async ({ page }) => {
    await openDayBook(page, DATE)
    const booking = page.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(booking).toBeVisible({ timeout: 30_000 })
    await expect(booking.getByText('Confirmée')).toBeVisible()
    const panel = waitlistPanel(page)
    await expect(panel.getByRole('listitem').filter({ hasText: GUEST.name })).toHaveCount(0)
    await expect(panel.getByLabel('0 en attente')).toBeVisible()
  })

  test('a guest can leave the waitlist from their own page', async ({ browser, baseURL, page }) => {
    test.skip(!MAIL_LOG, NO_MAIL_LOG)
    // A second request on the same full day, withdrawn by the guest.
    const leaver = {
      name: `E2E Départ ${RUN}`,
      email: `e2e.depart.${RUN}@example.com`,
    }
    // The day is full again once the table was taken.
    await fillDayAsHost(page, DATE, `E2E Complet ${RUN}`)

    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await guestPage.getByLabel('Nombre de convives').selectOption('2')
    await guestPage.getByLabel('Date', { exact: true }).fill(DATE)
    const section = guestPage.getByRole('region', { name: 'Me prévenir si une table se libère' })
    await section.getByRole('button', { name: 'Demander à être prévenu' }).click()
    await section.getByLabel('Nom', { exact: true }).fill(leaver.name)
    await section.getByLabel('E-mail', { exact: true }).fill(leaver.email)
    await section.getByRole('checkbox', { name: /J'accepte que .* garde mon nom/ }).click()
    await section.getByRole('button', { name: 'Me prévenir', exact: true }).click()
    // The link is not on the page: it is in the mail sent to the address they gave.
    const path = await waitForMailPath(leaver.email, '/reservation/waitlist/')
    expect(path, 'the link mail never reached the stand-in transport').toBeTruthy()
    await guestPage.goto(path!)

    await guestPage.getByRole('button', { name: 'Retirer ma demande' }).click()
    await expect(guestPage.getByRole('heading', { name: 'Demande retirée' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(guestPage.getByText(/7 jours après la date souhaitée/)).toBeVisible()
    await context.close()

    // Gone from the host's list too.
    await openDayBook(page, DATE)
    await expect(
      waitlistPanel(page).getByRole('listitem').filter({ hasText: leaver.name }),
    ).toHaveCount(0, { timeout: 30_000 })
  })

  test('with the waitlist off, a full day only says it is full', async ({
    browser,
    baseURL,
    page,
  }) => {
    await setWaitlist(page, false)
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await guestPage.getByLabel('Nombre de convives').selectOption('2')
    await guestPage.getByLabel('Date', { exact: true }).fill(DATE)
    await expect(guestPage.getByText(/Ce jour est complet/)).toBeVisible({ timeout: 30_000 })
    await expect(guestPage.getByText('Me prévenir si une table se libère')).toHaveCount(0)
    await context.close()
    await guestContext?.close()
    await setWaitlist(page, true, 15)
  })
})
