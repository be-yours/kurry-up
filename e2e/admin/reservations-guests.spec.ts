import { test, expect } from '@playwright/test'
import {
  RESERVATION_GUESTS_URL,
  bookAsGuest,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
} from '../helpers/reservations.helpers'
import { waitForAdminPage } from '../helpers/navigation.helpers'

/**
 * The guest book: a booking opens a profile, the host annotates it, finds it again,
 * merges a duplicate and takes the whole book away as a file.
 *
 * WHAT THIS IS FOR. The server half — counters, the redirect a merge leaves, the
 * manager-only export — is held by convex-test. What only a browser shows is the
 * screen a host actually works in: the search that narrows as it is typed, a filter
 * that is pressed, a drawer that opens on a click, a merge that says what it will do
 * before it does it, and a download that is a real file a spreadsheet can read.
 *
 * It also holds the one promise a guest is made on the booking form: the marketing
 * box is optional, and ticking it only STARTS a confirmation.
 *
 * The names carry a run number, so a profile left by an earlier run is never the one
 * a step finds. The establishment confirms bookings on its own.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const RUN = Date.now().toString(36)
const FIRST = {
  name: `E2E Fiche ${RUN}`,
  email: `e2e.fiche.${RUN}@example.com`,
  phone: '0611223344',
}
const SECOND = {
  name: `E2E Doublon ${RUN}`,
  email: `e2e.doublon.${RUN}@work.example`,
  phone: '0655667788',
}

async function openGuests(page: import('@playwright/test').Page) {
  await page.goto(RESERVATION_GUESTS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitForAdminPage(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Fiches clients' })).toBeVisible({
    timeout: 30_000,
  })
}

test.describe('The guest book', () => {
  test('a booking opens a profile, and the marketing box only starts a confirmation', async ({
    page,
    browser,
    baseURL,
  }) => {
    await ensureBook(page, { autoConfirm: true })

    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    // The first guest ticks the box; the second does not.
    const first = await bookAsGuest(guest, {
      date: isoDateAhead(4),
      time: '19:30',
      guest: FIRST,
      marketing: true,
    })
    expect(first.confirmed).toBe(true)
    await expect(guest.getByText(/confirmer votre inscription/)).toBeVisible()
    await expect(guest.getByText(/Sans confirmation, rien ne vous sera envoyé/)).toBeVisible()

    const second = await bookAsGuest(guest, {
      date: isoDateAhead(5),
      time: '19:30',
      guest: SECOND,
    })
    expect(second.confirmed).toBe(true)
    await expect(guest.getByText(/confirmer votre inscription/)).toHaveCount(0)
    await context.close()
  })

  test('the host finds the guest, with what the book knows of them', async ({ page }) => {
    await openDayBook(page, isoDateAhead(4))
    // The sidebar has the same entry; the day book's own button is the one a host clicks.
    await page.getByRole('main').getByRole('link', { name: 'Fiches clients' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Fiches clients' })).toBeVisible({
      timeout: 30_000,
    })
    // The screen says what it never keeps.
    await expect(page.getByText(/Les allergies n'y sont jamais gardées/)).toBeVisible()

    await page.getByLabel('Rechercher un client').fill(`Fiche ${RUN}`)
    const card = page.getByRole('button', { name: `Ouvrir la fiche de ${FIRST.name}` })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('Pas encore venu')).toBeVisible()
    // The agreement is shown, as a fact about this guest.
    await expect(card.getByText('Accord marketing')).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Ouvrir la fiche de ${SECOND.name}` }),
    ).toHaveCount(0)

    // Searching by the address works too, and a miss says so.
    await page.getByLabel('Rechercher un client').fill(FIRST.email.slice(0, 14))
    await expect(card).toBeVisible()
    await page.getByLabel('Rechercher un client').fill('personne-ne-porte-ce-nom')
    await expect(page.getByText('Aucun client ne correspond')).toBeVisible({ timeout: 15_000 })
  })

  test('the host annotates the guest, and the note and the tag are still there after a reload', async ({
    page,
  }) => {
    await openGuests(page)
    await page.getByLabel('Rechercher un client').fill(`Fiche ${RUN}`)
    await page.getByRole('button', { name: `Ouvrir la fiche de ${FIRST.name}` }).click()

    const drawer = page.getByRole('dialog')
    await expect(drawer.getByText(/Réservations \(1\)/)).toBeVisible({ timeout: 30_000 })
    await expect(drawer.getByText(/^RES-\d{4}-\d{5}$/)).toBeVisible()
    // The warning about health data is on the field it is about.
    await expect(drawer.getByText(/N'y notez ni allergie ni information de santé/)).toBeVisible()

    await drawer.getByLabel('Vos notes').fill('Table près de la fenêtre')
    const vip = drawer.getByRole('button', { name: 'VIP', exact: true })
    await vip.click()
    await expect(vip).toHaveAttribute('aria-pressed', 'true')
    await drawer.getByRole('button', { name: 'Enregistrer la fiche' }).click()
    await expect(page.getByText('Fiche enregistrée')).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await waitForAdminPage(page)
    await page.getByLabel('Rechercher un client').fill(`Fiche ${RUN}`)
    const card = page.getByRole('button', { name: `Ouvrir la fiche de ${FIRST.name}` })
    await expect(card.getByText('VIP', { exact: true })).toBeVisible({ timeout: 30_000 })
    await card.click()
    await expect(page.getByRole('dialog').getByLabel('Vos notes')).toHaveValue(
      'Table près de la fenêtre',
    )
  })

  test('the VIP filter keeps this guest and drops the other', async ({ page }) => {
    await openGuests(page)
    await page.getByLabel('Rechercher un client').fill(`E2E`)
    await page.getByRole('button', { name: 'VIP', exact: true }).click()
    await expect(page.getByRole('button', { name: 'VIP', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      page.getByRole('button', { name: `Ouvrir la fiche de ${FIRST.name}` }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      page.getByRole('button', { name: `Ouvrir la fiche de ${SECOND.name}` }),
    ).toHaveCount(0)

    // « Réservation à venir »: both booked days ahead.
    await page.getByRole('button', { name: 'Tous', exact: true }).click()
    await page.getByRole('button', { name: 'Réservation à venir', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `Ouvrir la fiche de ${SECOND.name}` }),
    ).toBeVisible({
      timeout: 30_000,
    })
  })

  test('a duplicate is merged only after the host is told what happens', async ({ page }) => {
    await openGuests(page)
    await page.getByLabel('Rechercher un client').fill(`Fiche ${RUN}`)
    await page.getByRole('button', { name: `Ouvrir la fiche de ${FIRST.name}` }).click()
    await page.getByRole('button', { name: 'Fusionner avec une autre fiche' }).click()

    const dialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Fusionner avec une autre fiche' })
      .last()
    await dialog.getByLabel('Chercher le doublon').fill(`Doublon ${RUN}`)
    const choice = dialog.getByRole('button', { name: new RegExp(SECOND.email) })
    await expect(choice).toBeVisible({ timeout: 30_000 })
    await choice.click()

    // Said before it is done: who goes into whom, and that the address now arrives here.
    await expect(dialog.getByText(/sera fusionné dans/)).toBeVisible()
    await expect(dialog.getByText(/Son adresse ne crée plus de nouvelle fiche/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Fusionner', exact: true }).click()

    await expect(page.getByText(/Fiches fusionnées/)).toBeVisible({ timeout: 15_000 })

    // One row left in the list for the two of them. The kept profile keeps its address;
    // its name and phone are those of whoever was seen most recently (the second guest).
    await page.keyboard.press('Escape')
    await page.getByLabel('Rechercher un client').fill(RUN)
    const rows = page.getByRole('button', { name: /^Ouvrir la fiche de / })
    await expect(rows).toHaveCount(1, { timeout: 30_000 })
    await expect(rows.first()).toContainText(FIRST.email)
    await expect(rows.first()).not.toContainText(SECOND.email)
  })

  test('the manager takes the book away as a file a spreadsheet can read', async ({ page }) => {
    await openGuests(page)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByRole('button', { name: 'Exporter en CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^fiches-clients-\d{4}-\d{2}-\d{2}\.csv$/)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const bytes = Buffer.concat(chunks)
    // A byte-order mark first, so the accents survive a spreadsheet.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8')
    expect(text).toContain('Nom,E-mail,Téléphone')
    expect(text).toContain(FIRST.email)
    // Never the host's notes, never anything a guest wrote about their health.
    expect(text).not.toContain('Table près de la fenêtre')
  })
})
