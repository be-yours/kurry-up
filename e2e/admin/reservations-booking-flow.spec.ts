import { test, expect } from '@playwright/test'
import {
  E2E_TABLES,
  bookAsGuest,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
} from '../helpers/reservations.helpers'

/**
 * A table, from the guest's first click to the host's last.
 *
 * WHAT THIS IS FOR. The reservation module is a unit-tested engine behind three
 * screens — the booking page, the guest's own link and the host's day book — and
 * nothing before this opened them together. The failures it catches are the ones
 * a fake database cannot: a screen that does not render, a button the server
 * refuses, a link that goes nowhere, a conflict the host is not shown.
 *
 * ONE BOOK, ONE STORY. The tests run in order and share what the one before left:
 * the establishment validates by hand, so the guest's request waits; the host
 * validates it; moves it to another table from the plan; the guest changes it,
 * which sends it back to the host; and cancels. Each step names the screen the
 * person is on. The guest is a second browser that is not signed in.
 *
 * The date is three days out, well past the minimum notice, and the guest's name
 * carries a run number so a booking left by an earlier failed run is never the
 * one a step finds.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const RUN = Date.now().toString(36)
const GUEST = {
  name: `E2E Dupont ${RUN}`,
  email: `e2e.${RUN}@example.com`,
  phone: '0612345678',
}
const DATE = isoDateAhead(3)

let manageUrl = ''
let reference = ''

test.describe("A table, from the guest's first click to the host's last", () => {
  test('the establishment opens its book and validates requests by hand', async ({ page }) => {
    await ensureBook(page, { autoConfirm: false })
  })

  test('a guest books a table and is told the restaurant has to answer', async ({
    browser,
    baseURL,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const page = await context.newPage()
    const result = await bookAsGuest(page, {
      date: DATE,
      time: '20:00',
      guest: GUEST,
    })
    expect(result.confirmed).toBe(false)
    expect(result.reference).toMatch(/^RES-\d{4}-\d{5}$/)
    expect(result.manageUrl).toContain('/reservation/manage/')
    reference = result.reference
    manageUrl = result.manageUrl

    // The guest's own link shows the request, and that it waits.
    await page.goto(manageUrl)
    await expect(page.getByRole('heading', { level: 1, name: 'Ma réservation' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(reference)).toBeVisible()
    await expect(page.getByText(/Le restaurant doit valider votre demande/)).toBeVisible()
    await context.close()
  })

  test('the host sees the request and validates it', async ({ page }) => {
    await openDayBook(page, DATE)

    const booking = page.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(booking).toBeVisible({ timeout: 30_000 })
    await expect(booking.getByText('À valider')).toBeVisible()

    await booking.getByRole('button', { name: 'Confirmer', exact: true }).click()
    await expect(booking.getByText('Confirmée')).toBeVisible({ timeout: 15_000 })
  })

  test('the host moves it to another table from the plan', async ({ page }) => {
    await openDayBook(page, DATE)
    await page.getByRole('button', { name: 'Plan', exact: true }).click()

    // Which table it is on now, read from the field that names it.
    const field = page.getByLabel(`Table de ${GUEST.name}`)
    await expect(field).toBeVisible({ timeout: 30_000 })
    const current = (await field.locator('option:checked').textContent()) ?? ''
    const target = E2E_TABLES.find((table) => !current.includes(table.name))!

    // The booking, then the room that holds the table, then the table.
    // The booking's own row starts with its time; the table it sits on is named by its label.
    await page
      .getByRole('button', { name: new RegExp(`^\\d{2}:\\d{2} ${GUEST.name}`), pressed: false })
      .click()
    await expect(page.getByText(/Choisissez une table pour/)).toBeVisible()
    await page.getByRole('tab', { name: new RegExp(target.room) }).click()
    await page
      .getByRole('button', {
        name: new RegExp(`^Placer .* sur ${target.name}$`),
      })
      .click()

    // Said before it is saved: where from, where to, and that the table is free.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(`vers ${target.name}`)).toBeVisible()
    await expect(dialog.getByText('La table est libre pour toute la durée')).toBeVisible()
    await dialog.getByRole('button', { name: 'Déplacer', exact: true }).click()

    await expect(page.getByText('Table changée')).toBeVisible({ timeout: 15_000 })
    await expect(field.locator('option:checked')).toContainText(target.name)
  })

  test('the guest changes the booking, and it goes back to the host', async ({
    browser,
    baseURL,
    page,
  }) => {
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto(manageUrl)
    await expect(guestPage.getByText('Votre table est réservée')).toBeVisible({
      timeout: 30_000,
    })

    await guestPage.getByRole('button', { name: 'Modifier ma réservation' }).click()
    const form = guestPage.getByRole('form', { name: 'Modifier ma réservation' })
    await expect(form).toBeVisible()
    // The house validates by hand: the guest is told before sending.
    await form.getByRole('button', { name: /^20:30/ }).click()
    await expect(form.getByText(/sera à valider de nouveau/)).toBeVisible()
    await form.getByRole('button', { name: 'Enregistrer la modification' }).click()

    await expect(
      guestPage.getByText('Modification enregistrée : le restaurant doit la valider.'),
    ).toBeVisible({ timeout: 30_000 })
    await expect(guestPage.getByText(/20:30/)).toBeVisible()
    await context.close()

    // The host's book moved with it: same booking, new hour, waiting again.
    await openDayBook(page, DATE)
    const booking = page.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(booking.getByText('20:30')).toBeVisible({ timeout: 30_000 })
    await expect(booking.getByText('À valider')).toBeVisible()
    await expect(booking.getByText(reference)).toBeVisible()
  })

  test('the guest cancels from the same link', async ({ browser, baseURL, page }) => {
    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto(manageUrl)
    await guestPage.getByRole('button', { name: 'Annuler ma réservation' }).click()
    await expect(guestPage.getByText('Annuler cette réservation ?')).toBeVisible()
    await guestPage.getByRole('button', { name: 'Oui, annuler' }).click()
    await expect(guestPage.getByText('Vous avez annulé cette réservation.')).toBeVisible({
      timeout: 30_000,
    })
    // Nothing left to change or cancel on a booking that is over.
    await expect(guestPage.getByRole('button', { name: 'Modifier ma réservation' })).toHaveCount(0)
    await context.close()

    await openDayBook(page, DATE)
    const booking = page.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(booking.getByText('Annulée par le client')).toBeVisible({
      timeout: 30_000,
    })
  })
})
