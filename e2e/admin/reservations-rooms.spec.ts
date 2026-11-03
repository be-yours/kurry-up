import { test, expect } from '@playwright/test'
import {
  E2E_ROOMS,
  bookAsGuest,
  card,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openSettings,
} from '../helpers/reservations.helpers'

/**
 * Rooms: the owner draws several plans, and the guest may say which area they
 * would like.
 *
 * Two promises are held here that no unit test can see on a screen. The settings
 * screen manages rooms the way an owner would — add, rename, reorder, archive and
 * bring back — and each room has a plan of its own. And the booking page offers the
 * choice of area only to a diner who has one, and a booking made with it goes
 * through.
 */
test.setTimeout(120_000)

const RUN = Date.now().toString(36)

test.describe('Rooms', () => {
  test('an owner adds, renames, reorders, archives and restores a room', async ({ page }) => {
    await ensureBook(page, { autoConfirm: true })
    await openSettings(page)
    const rooms = card(page, 'Salles')

    // The two rooms the book needs are there, in the order they were made.
    for (const name of E2E_ROOMS) {
      await expect(rooms.getByText(name, { exact: true })).toBeVisible()
    }

    const temporary = `E2E Bar ${RUN}`
    const renamed = `E2E Mezzanine ${RUN}`
    await rooms.getByRole('button', { name: 'Ajouter une salle' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nom').fill(temporary)
    await dialog.getByRole('button', { name: 'Enregistrer' }).click()
    await expect(rooms.getByText(temporary, { exact: true })).toBeVisible({
      timeout: 15_000,
    })

    // A name already taken is said before it is sent.
    await rooms.getByRole('button', { name: 'Ajouter une salle' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nom').fill(temporary.toLowerCase())
    await expect(dialog.getByText('Une salle porte déjà ce nom.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Annuler' }).click()

    await rooms.getByRole('button', { name: `Renommer ${temporary}` }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nom').fill(renamed)
    await dialog.getByRole('button', { name: 'Enregistrer' }).click()
    await expect(rooms.getByText(renamed, { exact: true })).toBeVisible({
      timeout: 15_000,
    })

    // Last in the list at first; one step up puts it above the room before it.
    const order = async () => {
      const items = await rooms.getByRole('listitem').allTextContents()
      return items.findIndex((text) => text.includes(renamed))
    }
    const before = await order()
    await rooms.getByRole('button', { name: `Monter ${renamed}` }).click()
    await expect.poll(order).toBe(before - 1)

    // Archiving says what happens to the tables first, then does it.
    await rooms.getByRole('button', { name: `Archiver ${renamed}` }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByText('La salle disparaît des onglets')).toBeVisible()
    await dialog.getByRole('button', { name: 'Archiver', exact: true }).click()
    await expect(rooms.getByRole('heading', { name: 'Salles archivées' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(rooms.getByRole('button', { name: `Renommer ${renamed}` })).toHaveCount(0)

    await rooms.getByRole('button', { name: `Restaurer ${renamed}` }).click()
    await expect(rooms.getByRole('button', { name: `Renommer ${renamed}` })).toBeVisible({
      timeout: 15_000,
    })

    // Left archived: the next run starts without it in the guest's way.
    await rooms.getByRole('button', { name: `Archiver ${renamed}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Archiver', exact: true }).click()
    await expect(rooms.getByRole('button', { name: `Restaurer ${renamed}` })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('each room has its own plan, in its own tab', async ({ page }) => {
    await ensureBook(page, { autoConfirm: true })
    await openSettings(page)
    const plan = card(page, 'Plan de salle')

    const salle = plan.getByRole('tab', { name: /E2E Salle/ })
    const terrasse = plan.getByRole('tab', { name: /E2E Terrasse/ })
    await expect(salle).toBeVisible()
    await expect(terrasse).toBeVisible()

    // Only that room's tables are on its plan and in its list.
    await salle.click()
    await expect(plan.getByText('E2E Salle 1').first()).toBeVisible()
    await expect(plan.getByText('E2E Terrasse 1')).toHaveCount(0)
    await terrasse.click()
    await expect(plan.getByText('E2E Terrasse 1').first()).toBeVisible()
    await expect(plan.getByText('E2E Salle 1')).toHaveCount(0)

    // And the arrow keys move between tabs, as a tab list does.
    await terrasse.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(salle).toHaveAttribute('aria-selected', 'true')
  })

  test('a table is put in a room from its form', async ({ page }) => {
    await ensureBook(page, { autoConfirm: true })
    await openSettings(page)
    const tables = card(page, 'Tables')
    await tables.getByRole('button', { name: 'Modifier E2E Salle 1' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('combobox', { name: 'Salle' })).toContainText('E2E Salle')
    await dialog.getByRole('button', { name: 'Annuler' }).click()
  })

  test('the booking page offers the area, and a booking made with it goes through', async ({
    browser,
    baseURL,
    page,
  }) => {
    await ensureBook(page, { autoConfirm: true })

    const context = await newGuestContext(browser, baseURL)
    const guestPage = await context.newPage()
    await guestPage.goto('/reservation', { waitUntil: 'domcontentloaded' })
    await expect(guestPage.getByText('Zone souhaitée')).toBeVisible({ timeout: 30_000 })
    // « Peu importe » first and chosen, then each room.
    await expect(guestPage.getByRole('radio', { name: 'Peu importe' })).toBeChecked()
    for (const name of E2E_ROOMS) {
      await expect(guestPage.getByRole('radio', { name })).toHaveCount(1)
    }

    const result = await bookAsGuest(guestPage, {
      date: isoDateAhead(4),
      time: '19:00',
      area: 'E2E Terrasse',
      guest: {
        name: `E2E Zone ${RUN}`,
        email: `e2e.zone.${RUN}@example.com`,
        phone: '0612345678',
      },
    })
    expect(result.confirmed).toBe(true)

    // Cancelled so the table is free for the next run.
    await guestPage.goto(result.manageUrl)
    await expect(guestPage.getByText('Zone souhaitée')).toBeVisible({ timeout: 30_000 })
    await expect(guestPage.getByText('E2E Terrasse').first()).toBeVisible()
    await guestPage.getByRole('button', { name: 'Annuler ma réservation' }).click()
    await guestPage.getByRole('button', { name: 'Oui, annuler' }).click()
    await expect(guestPage.getByText('Vous avez annulé cette réservation.')).toBeVisible({
      timeout: 30_000,
    })
    await context.close()
  })
})
