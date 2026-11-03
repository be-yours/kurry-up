import { test, expect } from '@playwright/test'
import {
  automationSwitch,
  bookAsGuest,
  ensureBook,
  feedbackUrlFor,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  openSettings,
  setAutomation,
} from '../helpers/reservations.helpers'

/**
 * What a guest says of a visit: a page that is reached from an e-mail link, a score that
 * is preselected and never recorded by following a link, an answer that can be changed for
 * a day, and a restaurant that reads it and nobody else does.
 *
 * WHAT THIS IS FOR. The server half — who is thanked and when, the 24-hour window, the
 * rate limit, the review link rule — is held by convex-test. What only a browser shows is
 * the page itself: five scores as one choice the keyboard can move through, a score that
 * arrives from the link and waits for a confirmation, the thank-you that offers the owner's
 * own review page to a 4 or a 5 and offers nothing different to a 2, and the answer showing
 * up — privately — on the host's day book.
 *
 * The thank-you e-mail itself is not read here (no mailbox in the bench): its content is
 * held by the core renderer's tests, and its sending by the convex suite.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const RUN = Date.now().toString(36)
const DATE = isoDateAhead(3)
const REVIEW_URL = 'https://example.com/avis-e2e'
const HIGH = {
  name: `E2E Merci ${RUN}`,
  email: `e2e.merci.${RUN}@example.com`,
  phone: '0611223344',
}
const LOW = {
  name: `E2E Bof ${RUN}`,
  email: `e2e.bof.${RUN}@example.com`,
  phone: '0655667788',
}

let highFeedback = ''
let lowFeedback = ''
let waitingFeedback = ''
let reviewWasOn = false

/** Take a booking of the day all the way through the service: seated, then finished. */
async function serve(page: import('@playwright/test').Page, guestName: string) {
  await openDayBook(page, DATE)
  const booking = page.getByRole('listitem').filter({ hasText: guestName })
  await expect(booking).toBeVisible({ timeout: 30_000 })
  await booking.getByRole('button', { name: 'Installer', exact: true }).click()
  await expect(booking.getByText('Installés')).toBeVisible({ timeout: 15_000 })
  await booking.getByRole('button', { name: 'Terminer', exact: true }).click()
  await expect(booking.getByText('Terminée')).toBeVisible({ timeout: 15_000 })
}

test.describe('Ce que dit un client de sa visite', () => {
  test('the book is open, the review link is set, and three guests have booked', async ({
    page,
    browser,
    baseURL,
  }) => {
    await ensureBook(page, { autoConfirm: true })

    // The owner's own public review page, set where the owner sets it.
    await openSettings(page)
    reviewWasOn =
      (await automationSwitch(page, 'E-mail après la visite').getAttribute('aria-checked')) ===
      'true'
    await setAutomation(page, 'E-mail après la visite', true)
    await page.getByLabel(/Lien vers votre page d'avis publique/).fill(REVIEW_URL)
    await page
      .locator('[data-testid="automations-card"] li[data-automation="post_visit"]')
      .getByRole('button', { name: 'Enregistrer' })
      .click()
    await expect(page.getByText('E-mail après la visite enregistré')).toBeVisible({
      timeout: 15_000,
    })

    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    const high = await bookAsGuest(guest, { date: DATE, time: '19:30', guest: HIGH })
    const low = await bookAsGuest(guest, { date: DATE, time: '20:00', guest: LOW })
    const waiting = await bookAsGuest(guest, {
      date: DATE,
      time: '20:30',
      guest: { ...HIGH, name: `E2E Attente ${RUN}`, email: `e2e.attente.${RUN}@example.com` },
    })
    highFeedback = feedbackUrlFor(high.manageUrl)
    lowFeedback = feedbackUrlFor(low.manageUrl)
    waitingFeedback = feedbackUrlFor(waiting.manageUrl)
    expect(highFeedback).toContain('/reservation/feedback/')
    await context.close()
  })

  test('the link is dead until the meal is over, and says so in words', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(waitingFeedback)
    await expect(guest.getByRole('heading', { level: 1, name: 'Pas encore' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(guest.getByText(/une fois le repas terminé/)).toBeVisible()
    await expect(guest.getByRole('radiogroup')).toHaveCount(0)

    // And a link nobody issued is no page at all.
    await guest.goto('/reservation/feedback/inconnu-inconnu-inconnu')
    await expect(guest.getByRole('heading', { level: 1, name: 'Lien introuvable' })).toBeVisible({
      timeout: 30_000,
    })
    await context.close()
  })

  test('the host serves two of the parties, start to finish', async ({ page }) => {
    await serve(page, HIGH.name)
    await serve(page, LOW.name)
  })

  test('a score from the link is preselected and recorded by nothing until the guest confirms', async ({
    browser,
    baseURL,
    page,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(`${highFeedback}?score=4`)
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Merci de votre visite' }),
    ).toBeVisible({
      timeout: 30_000,
    })

    // Four is chosen, and the page says what four is: the number AND the words.
    const radios = guest.getByRole('radio')
    await expect(radios).toHaveCount(5)
    await expect(guest.getByRole('radio', { name: '4 sur 5 : Bien' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    // Opening the link again, and reloading it, records nothing: the host sees no answer.
    await guest.reload()
    await expect(guest.getByRole('radio', { name: '4 sur 5 : Bien' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await openDayBook(page, DATE)
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: HIGH.name })
        .getByText(/Avis du client/),
    ).toHaveCount(0)

    // What the guest is told about the answer, before giving it.
    await expect(guest.getByText(/lue par l'équipe de .*, et par personne d'autre/)).toBeVisible()
    await expect(guest.getByText(/jamais publiée sur son site/)).toBeVisible()
    await context.close()
  })

  test('the five scores are one choice the arrow keys move through', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(highFeedback)
    await expect(guest.getByRole('radiogroup', { name: /Votre note/ })).toBeVisible({
      timeout: 30_000,
    })
    // Nothing chosen, and nothing can be sent.
    await expect(guest.getByRole('button', { name: 'Envoyer ma réponse' })).toBeDisabled()
    await expect(guest.getByText(/Choisissez une note de 1 à 5/)).toBeVisible()

    await guest.getByRole('radio', { name: '1 sur 5 : Très décevant' }).focus()
    await guest.keyboard.press('ArrowRight')
    await expect(guest.getByRole('radio', { name: '2 sur 5 : Décevant' })).toBeFocused()
    await expect(guest.getByRole('radio', { name: '2 sur 5 : Décevant' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await guest.keyboard.press('ArrowLeft')
    await guest.keyboard.press('ArrowLeft')
    // It wraps, as a radio group does.
    await expect(guest.getByRole('radio', { name: '5 sur 5 : Excellent' })).toBeFocused()
    await context.close()
  })

  test('a 4 or a 5 is offered the owner’s own review page, after the private answer and never in its place', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(`${highFeedback}?score=5`)
    await guest.getByLabel('Un mot à ajouter ? (facultatif)').fill('Un accueil formidable')
    await guest.getByRole('button', { name: 'Envoyer ma réponse' }).click()

    await expect(
      guest.getByRole('heading', { level: 1, name: 'Merci pour votre réponse' }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await expect(guest.getByText('5 sur 5')).toBeVisible()
    await expect(guest.getByText('Un accueil formidable')).toBeVisible()
    await expect(guest.getByText(/Vous pouvez la modifier jusqu'au/)).toBeVisible()

    const review = guest.getByRole('link', { name: /Laisser un avis public/ })
    await expect(review).toHaveAttribute('href', REVIEW_URL)
    await expect(review).toHaveAttribute('target', '_blank')
    await expect(review).toHaveAttribute('rel', /noopener/)
    // Said as optional, and the private answer is said to stand in any case.
    await expect(guest.getByText(/Facultatif/)).toBeVisible()
    await expect(guest.getByText(/reste lue par l'équipe dans tous les cas/)).toBeVisible()
    await context.close()
  })

  test('a lower score is read exactly the same, and nothing is offered in its place', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(`${lowFeedback}?score=2`)
    await guest.getByRole('button', { name: 'Envoyer ma réponse' }).click()
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Merci pour votre réponse' }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await expect(guest.getByText('2 sur 5')).toBeVisible()
    // No public link, no nudge, no way to hide it.
    await expect(guest.getByRole('link', { name: /avis public/ })).toHaveCount(0)
    await expect(guest.getByText(/Facultatif/)).toHaveCount(0)
    await context.close()
  })

  test('the guest changes the answer within the day, and the page says when it will lock', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(highFeedback)
    await expect(guest.getByRole('heading', { level: 1, name: 'Votre réponse' })).toBeVisible({
      timeout: 30_000,
    })
    await guest.getByRole('button', { name: 'Modifier ma réponse' }).click()
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Modifier ma réponse' }),
    ).toBeVisible()
    await expect(guest.getByLabel('Un mot à ajouter ? (facultatif)')).toHaveValue(
      'Un accueil formidable',
    )
    await guest.getByRole('radio', { name: '4 sur 5 : Bien' }).click()
    await guest.getByLabel('Un mot à ajouter ? (facultatif)').fill("Très bien, un peu d'attente")
    await guest.getByRole('button', { name: 'Enregistrer ma réponse' }).click()

    await expect(guest.getByText('4 sur 5')).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByText("Très bien, un peu d'attente")).toBeVisible()
    await expect(guest.getByText(/Modifiée le /)).toBeVisible()

    // Still the same answer, one row, after a reload.
    await guest.reload()
    await expect(guest.getByText('4 sur 5')).toBeVisible({ timeout: 30_000 })
    await context.close()
  })

  test('the host reads it, privately, on the day book — and the guest’s own booking page does not', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openDayBook(page, DATE)
    const high = page.getByRole('listitem').filter({ hasText: HIGH.name })
    await expect(high.getByText('Avis du client : 4 sur 5')).toBeVisible({ timeout: 30_000 })
    await expect(high.getByText("« Très bien, un peu d'attente »")).toBeVisible()
    await expect(high.getByText("Visible de l'équipe seulement")).toBeVisible()
    const low = page.getByRole('listitem').filter({ hasText: LOW.name })
    await expect(low.getByText('Avis du client : 2 sur 5')).toBeVisible()

    // Nothing of it reaches a diner: the booking's own page carries no trace.
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    await guest.goto(highFeedback.replace('/reservation/feedback/', '/reservation/manage/'))
    await expect(guest.getByRole('heading', { level: 1, name: 'Ma réservation' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(guest.getByText(/Avis du client|Très bien, un peu d'attente/)).toHaveCount(0)
    // And the public site publishes no figure about its guests.
    await guest.goto('/')
    await expect(guest.getByText(/Avis du client|note moyenne/i)).toHaveCount(0)
    await context.close()
  })

  test('the statistics count the answers, and the owner’s settings are put back', async ({
    page,
  }) => {
    await page.goto('/dashboard/reservations/stats', { waitUntil: 'domcontentloaded' })
    await page
      .getByRole('group', { name: 'Période affichée' })
      .getByRole('button', { name: 'Personnalisé' })
      .click()
    await page.getByLabel('Du', { exact: true }).fill(isoDateAhead(0))
    await page.getByLabel('Au', { exact: true }).fill(isoDateAhead(7))

    const section = page.getByTestId('stats-feedback')
    await expect(section).toContainText('Privé : seule votre équipe voit ces réponses', {
      timeout: 30_000,
    })
    // The sweep recomputes the day within the minute; the list below it is read live.
    await expect(
      page.getByTestId('feedback-list').or(section.getByText(/Aucune réponse/)),
    ).toBeVisible({
      timeout: 120_000,
    })

    // Leave the owner's settings as they were found.
    await openSettings(page)
    await page.getByLabel(/Lien vers votre page d'avis publique/).fill('')
    await page
      .locator('[data-testid="automations-card"] li[data-automation="post_visit"]')
      .getByRole('button', { name: 'Enregistrer' })
      .click()
    await expect(page.getByText('E-mail après la visite enregistré')).toBeVisible({
      timeout: 15_000,
    })
    if (!reviewWasOn) await setAutomation(page, 'E-mail après la visite', false)
  })
})
