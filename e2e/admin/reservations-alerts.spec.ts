import { test, expect } from '@playwright/test'
import {
  alertBell,
  automationSwitch,
  bookAsGuest,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  openSettings,
  setAutomation,
} from '../helpers/reservations.helpers'

/**
 * The alert centre: a bell on the reservation screens, alerts that come from the book,
 * and a tidy-up that is one person's own.
 *
 * WHAT THIS IS FOR. The server half — each kind, each threshold, derived-never-stored, a
 * mark per team member, the e-mail once per alert — is held by convex-test. What only a
 * browser shows is the bell a host actually looks at: a count that is also a sentence, a
 * popover whose buttons say which alert they close, a dismissal that can be undone from the
 * toast that announces it, one that is still there after a reload, and a centre that
 * disappears altogether when the owner turns it off.
 *
 * To get an alert without a party of eight (the test tables seat four), the owner lowers the
 * « grand groupe » threshold to two and a table for two raises it — which also proves the
 * threshold is the owner's, not a constant. The spec puts the threshold back.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const RUN = Date.now().toString(36)
const DATE = isoDateAhead(2)
const GUEST = {
  name: `E2E Alerte ${RUN}`,
  email: `e2e.alerte.${RUN}@example.com`,
  phone: '0611223344',
}
const ALERT_TITLE = 'Groupe de 2 personnes'

let originalThreshold = '8'
let centreWasOn = true

async function openAlerts(page: import('@playwright/test').Page) {
  await alertBell(page).click()
  await expect(page.getByTestId('alert-list')).toBeVisible()
}

test.describe("L'alerte, de la réservation à la cloche", () => {
  test('the owner lowers the threshold, and a table for two raises an alert', async ({
    page,
    browser,
    baseURL,
  }) => {
    await ensureBook(page, { autoConfirm: true })
    await openSettings(page)
    centreWasOn = (await automationSwitch(page, 'Alertes').getAttribute('aria-checked')) === 'true'
    await setAutomation(page, 'Alertes', true)

    const largeParty = page.getByLabel('Grand groupe à partir de')
    originalThreshold = await largeParty.inputValue()
    await largeParty.fill('2')
    await page.getByRole('button', { name: 'Enregistrer les seuils' }).click()
    await expect(page.getByText('Seuils des alertes enregistrés')).toBeVisible({ timeout: 15_000 })

    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    const result = await bookAsGuest(guest, {
      date: DATE,
      time: '19:30',
      partySize: 2,
      guest: GUEST,
    })
    expect(result.confirmed).toBe(true)
    await context.close()
  })

  test('the bell says how many alerts wait, in a sentence, and lists them with their weight', async ({
    page,
  }) => {
    await openDayBook(page)
    const bell = alertBell(page)
    await expect(bell).toBeVisible({ timeout: 30_000 })
    await expect(bell).toHaveAttribute('aria-label', /^Alertes de réservation : \d+ à lire$/)

    await openAlerts(page)
    const list = page.getByTestId('alert-list')
    const alert = list.getByRole('listitem').filter({ hasText: ALERT_TITLE }).first()
    await expect(alert).toBeVisible({ timeout: 30_000 })
    // The weight is words as well as an icon.
    await expect(alert).toContainText('Pour information : ')
    await expect(alert).toContainText(GUEST.name)
    await expect(list.getByRole('link', { name: 'Régler les alertes' })).toBeVisible()
  })

  test('closing an alert is mine alone, can be undone from the toast, and survives a reload', async ({
    page,
  }) => {
    await openDayBook(page)
    await openAlerts(page)
    const list = page.getByTestId('alert-list')
    const row = list.getByRole('listitem').filter({ hasText: GUEST.name })
    await expect(row).toBeVisible({ timeout: 30_000 })

    await list
      .getByRole('button', { name: `Marquer comme lue : ${ALERT_TITLE}` })
      .first()
      .click()
    await expect(page.getByText('Alerte marquée comme lue')).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveCount(0)

    // Undone from the toast that announced it.
    await page.getByRole('button', { name: 'Annuler', exact: true }).click()
    await expect(list.getByRole('listitem').filter({ hasText: GUEST.name })).toBeVisible({
      timeout: 15_000,
    })

    // Closed again, and still closed once the page is loaded afresh.
    await list
      .getByRole('button', { name: `Marquer comme lue : ${ALERT_TITLE}` })
      .first()
      .click()
    await expect(list.getByRole('listitem').filter({ hasText: GUEST.name })).toHaveCount(0)
    await page.reload()
    await expect(alertBell(page)).toBeVisible({ timeout: 30_000 })
    await openAlerts(page)
    await expect(
      page.getByTestId('alert-list').getByRole('listitem').filter({ hasText: GUEST.name }),
    ).toHaveCount(0)

    // What one closed can be brought back, from the same place.
    await page.getByRole('button', { name: /^Réafficher les alertes lues \(\d+\)$/ }).click()
    await expect(
      page.getByTestId('alert-list').getByRole('listitem').filter({ hasText: GUEST.name }),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('the bell is on the other reservation screens too, and the alert settings are one link away', async ({
    page,
  }) => {
    await page.goto('/dashboard/reservations/stats', { waitUntil: 'domcontentloaded' })
    await expect(alertBell(page)).toBeVisible({ timeout: 30_000 })
    await alertBell(page).click()
    await page.getByRole('link', { name: 'Régler les alertes' }).click()
    await expect(page).toHaveURL(/\/dashboard\/reservations\/settings#automatisations$/)
    await expect(page.getByTestId('automations-card')).toBeVisible({ timeout: 30_000 })
  })

  test('turned off, the centre is gone from the screen — not an empty bell — and comes back', async ({
    page,
  }) => {
    await openSettings(page)
    await setAutomation(page, 'Alertes', false)
    await openDayBook(page)
    await expect(alertBell(page)).toHaveCount(0)
    await expect(page.getByTestId('alert-banner')).toHaveCount(0)

    await openSettings(page)
    await setAutomation(page, 'Alertes', true)
    await openDayBook(page)
    await expect(alertBell(page)).toBeVisible({ timeout: 30_000 })
  })

  test('the owner’s settings are put back as they were', async ({ page }) => {
    await openSettings(page)
    const largeParty = page.getByLabel('Grand groupe à partir de')
    await expect(largeParty).toBeVisible({ timeout: 30_000 })
    await largeParty.fill(originalThreshold)
    await page.getByRole('button', { name: 'Enregistrer les seuils' }).click()
    await expect(page.getByText('Seuils des alertes enregistrés')).toBeVisible({ timeout: 15_000 })
    if (!centreWasOn) await setAutomation(page, 'Alertes', false)
  })
})
