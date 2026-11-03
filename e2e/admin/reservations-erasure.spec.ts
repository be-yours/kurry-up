import { test, expect } from '@playwright/test'
import {
  PRIVACY_URL,
  bookAsGuest,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
} from '../helpers/reservations.helpers'
import { waitForAdminPage } from '../helpers/navigation.helpers'

/**
 * A guest asks the restaurant to forget them: the booking, the profile and the
 * waitlist entry all go, and the screen says what it did.
 *
 * WHAT THIS IS FOR. The traversal that finds a person across every table is held by
 * convex-test; what only the owner's screen shows is the sentence an operator
 * reads back to the guest — what was found, what would go, what was kept and why.
 * The report is part of the answer to a request made under art. 17, so it is read
 * as the operator reads it: a preview first, a retyped address to confirm, a done
 * state that names the tables.
 *
 * ONE GUEST, ONE REQUEST. The guest books, writes a note about an allergy and ticks
 * nothing optional; the owner looks them up, previews, confirms with the address
 * typed again, and finds the booking gone from the day's book. The address carries a
 * run number, so the preview can only ever find this run's guest.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const RUN = Date.now().toString(36)
const GUEST = {
  name: `E2E Oubli ${RUN}`,
  email: `e2e.oubli.${RUN}@example.com`,
  phone: '0612345678',
}
const DATE = isoDateAhead(6)

test.describe('Erasing a guest', () => {
  test('a guest books, and the booking is in the owner’s day book', async ({
    page,
    browser,
    baseURL,
  }) => {
    await ensureBook(page, { autoConfirm: true })
    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    const result = await bookAsGuest(guest, { date: DATE, time: '19:30', guest: GUEST })
    expect(result.confirmed).toBe(true)
    await context.close()

    await openDayBook(page, DATE)
    await expect(page.getByRole('listitem').filter({ hasText: GUEST.name })).toBeVisible({
      timeout: 30_000,
    })
  })

  test('the owner previews first: the booking and the profile are listed, nothing is deleted', async ({
    page,
  }) => {
    await page.goto(PRIVACY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForAdminPage(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Données personnelles' })).toBeVisible(
      {
        timeout: 30_000,
      },
    )

    await page.getByLabel('Adresse e-mail').fill(GUEST.email)
    await page.getByRole('button', { name: 'Voir ce que nous avons' }).click()

    const report = page.locator('[data-slot="card"]').filter({ hasText: 'Demande d' })
    // The tally names the table, and a note beside it explains what happens to a future booking.
    await expect(report.getByText('Réservations de table').first()).toBeVisible({ timeout: 30_000 })
    await expect(report.getByText('Fiches clients (réservations)')).toBeVisible()
    // What no erasure can reach is said, so the answer to the guest is true.
    await expect(
      report.getByText('E-mails de réservation déjà envoyés', { exact: true }),
    ).toBeVisible()

    // Looking is not erasing.
    await openDayBook(page, DATE)
    await expect(page.getByRole('listitem').filter({ hasText: GUEST.name })).toBeVisible({
      timeout: 30_000,
    })
  })

  test('erasing needs the address typed again, then removes the booking from the book', async ({
    page,
  }) => {
    await page.goto(PRIVACY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForAdminPage(page)
    await page.getByLabel('Adresse e-mail').fill(GUEST.email)
    await page.getByRole('button', { name: 'Voir ce que nous avons' }).click()

    const erase = page.getByRole('button', { name: /Effacer définitivement/ })
    await expect(erase).toBeDisabled({ timeout: 30_000 })
    await page.getByLabel(/retapez l'identifiant/).fill('someone-else@example.com')
    await expect(erase).toBeDisabled()
    await page.getByLabel(/retapez l'identifiant/).fill(GUEST.email.toUpperCase())
    await expect(erase).toBeEnabled()
    await erase.click()

    await expect(page.getByText('Effacement terminé.')).toBeVisible({ timeout: 30_000 })
    const done = page.locator('[data-slot="card"]').filter({ hasText: 'ont été' })
    await expect(done.getByText('Réservations de table').first()).toBeVisible()

    await openDayBook(page, DATE)
    await expect(page.getByRole('listitem').filter({ hasText: GUEST.name })).toHaveCount(0, {
      timeout: 30_000,
    })
  })

  test('the guest’s own link no longer opens anything', async ({ browser, baseURL }) => {
    // The link is read from a fresh booking made before the erasure above would be
    // too fragile to keep across runs; what is held here is the answer a dead link
    // gets: no name, no number, a way home.
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    await page.goto('/reservation/manage/jeton-qui-nexiste-pas', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Réservation introuvable' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('link', { name: "Retour à l'accueil" })).toBeVisible()
    await context.close()
  })
})
