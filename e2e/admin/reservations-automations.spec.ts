import { test, expect } from '@playwright/test'
import { collectConsoleErrors } from '../helpers/console.helpers'
import {
  automationSwitch,
  automationsCard,
  ensureBook,
  openSettings,
  setAutomation,
} from '../helpers/reservations.helpers'

/**
 * The automations of the book: eight rows, five with a switch that writes one setting at once,
 * three that point to the rules card where their setting lives; each still there after a reload.
 *
 * WHAT THIS IS FOR. The server half — what each setting DOES — is held by convex-test,
 * one test per automation. What only a browser shows is the card an owner uses: the
 * switch that saves at once and says so, the value that goes with it and is saved by its
 * own button, the address that is refused by name before it is sent, and the state that
 * is still the state after the page is loaded again. The spec leaves every switch the
 * way it found it.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const TITLES = [
  'Confirmation automatique',
  'Rappel avant la venue',
  'Demande de reconfirmation',
  "Liste d'attente par e-mail",
  'Fermeture des demandes sans réponse',
  'E-mail après la visite',
  'Rapport quotidien',
  'Alertes',
] as const

const SET_IN_THE_RULES = new Set<string>([
  'Confirmation automatique',
  'Rappel avant la venue',
  "Liste d'attente par e-mail",
])

const RECIPIENT = `e2e.staff.${Date.now().toString(36)}@example.com`

async function state(page: import('@playwright/test').Page, title: string) {
  return (await automationSwitch(page, title).getAttribute('aria-checked')) === 'true'
}

test.describe('The automations card', () => {
  test('lists the eight, with what each does in plain words', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await ensureBook(page, { autoConfirm: true })
    await openSettings(page)

    const card = automationsCard(page)
    await card.scrollIntoViewIfNeeded()
    await expect(card.getByText('Automatisations', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    for (const title of TITLES) {
      if (SET_IN_THE_RULES.has(title)) {
        // Confirmation, reminder and waitlist are fields of the rules card: listed, not switched.
        await expect(card.getByText(title, { exact: true })).toBeVisible()
        await expect(automationSwitch(page, title)).toHaveCount(0)
      } else {
        await expect(automationSwitch(page, title)).toBeVisible()
      }
    }
    await expect(card.getByText(/Désactivée, chaque demande attend votre validation/)).toBeVisible()
    // A reminder that is off is off: nothing is sent by default.
    await expect(card.getByText(/Désactivé, aucun rappel n'est envoyé/)).toBeVisible()
    expect(errors.getErrors()).toEqual([])
    errors.cleanup()
  })

  test('a switch saves at once, says so, and is still moved after a reload', async ({ page }) => {
    await openSettings(page)
    const before = {
      reconfirmation: await state(page, 'Demande de reconfirmation'),
      expiry: await state(page, 'Fermeture des demandes sans réponse'),
      alerts: await state(page, 'Alertes'),
    }

    await setAutomation(page, 'Demande de reconfirmation', !before.reconfirmation)
    await setAutomation(page, 'Fermeture des demandes sans réponse', !before.expiry)
    await setAutomation(page, 'Alertes', !before.alerts)

    await page.reload()
    await expect(automationSwitch(page, 'Alertes')).toBeVisible({ timeout: 30_000 })
    expect(await state(page, 'Demande de reconfirmation')).toBe(!before.reconfirmation)
    expect(await state(page, 'Fermeture des demandes sans réponse')).toBe(!before.expiry)
    expect(await state(page, 'Alertes')).toBe(!before.alerts)

    // Put every one of them back, and see that too.
    await setAutomation(page, 'Demande de reconfirmation', before.reconfirmation)
    await setAutomation(page, 'Fermeture des demandes sans réponse', before.expiry)
    await setAutomation(page, 'Alertes', before.alerts)
    await page.reload()
    await expect(automationSwitch(page, 'Alertes')).toBeVisible({ timeout: 30_000 })
    expect(await state(page, 'Alertes')).toBe(before.alerts)
  })

  test('the reminder is set in the rules, and the automations card says what it is set to', async ({
    page,
  }) => {
    await openSettings(page)
    // The card holds no second switch for it: a row, its state and the way to the one place.
    const row = automationsCard(page).locator('li[data-automation="reminder"]')
    await expect(row.getByRole('switch')).toHaveCount(0)
    await expect(row.getByRole('link', { name: 'Régler dans les règles' })).toHaveAttribute(
      'href',
      '#regles',
    )

    const hours = page.getByLabel('Rappel par e-mail (heures avant, 0 = aucun)')
    const before = await hours.inputValue()
    await hours.fill('6')
    await page.getByRole('button', { name: 'Enregistrer les règles' }).click()
    await expect(page.getByText('Règles enregistrées')).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Rappel par e-mail (heures avant, 0 = aucun)')).toHaveValue('6', {
      timeout: 30_000,
    })
    await expect(row.getByText('Activée', { exact: true })).toBeVisible()
    await expect(row.getByText('Envoyé 6 h avant la réservation.')).toBeVisible()

    // Put it back as it was found.
    await page.getByLabel('Rappel par e-mail (heures avant, 0 = aucun)').fill(before)
    await page.getByRole('button', { name: 'Enregistrer les règles' }).click()
    await expect(page.getByText('Règles enregistrées')).toBeVisible({ timeout: 15_000 })
  })

  test('the daily report needs somebody to send it to, and refuses an address that is not one', async ({
    page,
  }) => {
    await openSettings(page)
    const report = automationSwitch(page, 'Rapport quotidien')
    const wasOn = await state(page, 'Rapport quotidien')
    const recipients = page.getByRole('textbox', { name: 'Destinataires' })
    const originalRecipients = await recipients.inputValue()

    if (!wasOn) {
      // Nobody to send it to: the switch says so and stays off.
      const existing = (await recipients.inputValue()).trim()
      if (existing === '') {
        await expect(report).toBeDisabled()
        await expect(
          automationsCard(page).getByText("Ajoutez d'abord au moins une adresse e-mail"),
        ).toBeVisible()
      }
    }

    const saveRecipients = page.getByRole('button', { name: 'Enregistrer les destinataires' })
    await recipients.fill('pas-une-adresse')
    await expect(page.getByText(/Adresse invalide : pas-une-adresse/)).toBeVisible()
    await expect(saveRecipients).toBeDisabled()

    await recipients.fill(RECIPIENT)
    await saveRecipients.click()
    await expect(page.getByText('Destinataires enregistrés')).toBeVisible({ timeout: 15_000 })

    await setAutomation(page, 'Rapport quotidien', true)
    const time = page.getByLabel(/Heure d'envoi/)
    await expect(time).toHaveValue(/\d{2}:\d{2}/)
    await time.fill('08:30')
    await automationsCard(page)
      .locator('li[data-automation="daily_report"]')
      .getByRole('button', { name: 'Enregistrer' })
      .click()
    await expect(page.getByText('Heure du rapport enregistrée')).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(automationSwitch(page, 'Rapport quotidien')).toHaveAttribute(
      'aria-checked',
      'true',
      {
        timeout: 30_000,
      },
    )
    await expect(page.getByLabel(/Heure d'envoi/)).toHaveValue('08:30')
    await expect(automationsCard(page).getByText(/Envoyé chaque jour à 08:30/)).toBeVisible()

    // The address cannot be taken away while the report depends on it.
    await page.getByRole('textbox', { name: 'Destinataires' }).fill('')
    await expect(page.getByText(/Gardez au moins une adresse/)).toBeVisible()

    // Leave it as it was found: the switch first, then the addresses it depended on.
    await page.reload()
    if (!wasOn) await setAutomation(page, 'Rapport quotidien', false)
    const field = page.getByRole('textbox', { name: 'Destinataires' })
    await expect(field).toBeVisible({ timeout: 30_000 })
    if ((await field.inputValue()) !== originalRecipients) {
      await field.fill(originalRecipients)
      await page.getByRole('button', { name: 'Enregistrer les destinataires' }).click()
      await expect(page.getByText('Destinataires enregistrés')).toBeVisible({ timeout: 15_000 })
    }
  })

  test('the e-mail after the visit keeps its review link private to the owner’s choice, https only', async ({
    page,
  }) => {
    await openSettings(page)
    const wasOn = await state(page, 'E-mail après la visite')
    await setAutomation(page, 'E-mail après la visite', true)

    const url = page.getByLabel(/Lien vers votre page d'avis publique/)
    const save = automationsCard(page)
      .locator('li[data-automation="post_visit"]')
      .getByRole('button', { name: 'Enregistrer' })
    await expect(page.getByText(/Une note plus basse n'est ni cachée ni détournée/)).toBeVisible()

    await url.fill('http://example.com/avis')
    await expect(page.getByText('Le lien doit commencer par https://')).toBeVisible()
    await expect(save).toBeDisabled()

    await url.fill('https://example.com/avis')
    await page.getByLabel('Heures après la fin du repas').fill('5')
    await save.click()
    await expect(page.getByText('E-mail après la visite enregistré')).toBeVisible({
      timeout: 15_000,
    })

    await page.reload()
    await expect(page.getByLabel(/Lien vers votre page d'avis publique/)).toHaveValue(
      'https://example.com/avis',
      { timeout: 30_000 },
    )
    await expect(page.getByLabel('Heures après la fin du repas')).toHaveValue('5')

    // Clear the link, and put the switch back.
    await page.getByLabel(/Lien vers votre page d'avis publique/).fill('')
    await automationsCard(page)
      .locator('li[data-automation="post_visit"]')
      .getByRole('button', { name: 'Enregistrer' })
      .click()
    await expect(page.getByText('E-mail après la visite enregistré')).toBeVisible({
      timeout: 15_000,
    })
    if (!wasOn) await setAutomation(page, 'E-mail après la visite', false)
  })

  test('the alert e-mails and their thresholds are set here, with the defaults said', async ({
    page,
  }) => {
    await openSettings(page)
    await setAutomation(page, 'Alertes', true)

    await expect(page.getByText('Par défaut : 85.')).toBeVisible()
    const largeParty = page.getByLabel('Grand groupe à partir de')
    const original = await largeParty.inputValue()
    const save = page.getByRole('button', { name: 'Enregistrer les seuils' })
    await expect(save).toBeDisabled()
    await largeParty.fill('1')
    await expect(page.getByText('Entre 2 et 100.')).toBeVisible()
    await expect(save).toBeDisabled()
    await largeParty.fill('11')
    await save.click()
    await expect(page.getByText('Seuils des alertes enregistrés')).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Grand groupe à partir de')).toHaveValue('11', { timeout: 30_000 })
    await page.getByLabel('Grand groupe à partir de').fill(original)
    await page.getByRole('button', { name: 'Enregistrer les seuils' }).click()
    await expect(page.getByText('Seuils des alertes enregistrés')).toBeVisible({ timeout: 15_000 })
  })
})
