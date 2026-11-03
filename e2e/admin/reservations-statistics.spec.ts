import { test, expect } from '@playwright/test'
import { collectConsoleErrors } from '../helpers/console.helpers'
import {
  bookAsGuest,
  ensureBook,
  isoDateAhead,
  newGuestContext,
  openDayBook,
  openStats,
} from '../helpers/reservations.helpers'

/**
 * The statistics screen, opened the way an owner opens it.
 *
 * WHAT THIS IS FOR. The unit tests hold the definitions (what a no-show rate divides by,
 * what a meal measures) and the convex tests hold the rollup. What only a browser shows
 * is the screen: reached from the day book, a period that changes the question, a custom
 * range that says what is missing, a chart that has a table behind it, a file that is a
 * real download, and — the one thing that proves the whole chain — a booking that was
 * just made turning up in the figures once the sweep has run.
 *
 * It reads structure and words, not fixed numbers: the establishment may hold any
 * bookings when this runs, and an empty period is the case worth pinning anyway.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const RUN = Date.now().toString(36)
const GUEST = {
  name: `E2E Chiffres ${RUN}`,
  email: `e2e.chiffres.${RUN}@example.com`,
  phone: '0611223344',
}

const kpiValue = async (page: import('@playwright/test').Page, id: string) =>
  Number(
    ((await page.locator(`[data-kpi="${id}"] .text-2xl`).textContent()) ?? '0').replace(/\s/g, ''),
  )

test.describe('Statistiques', () => {
  test('is reached from the day book, says what it counts, and leads back', async ({ page }) => {
    const errors = collectConsoleErrors(page)
    await openDayBook(page)
    await page.getByRole('main').getByRole('link', { name: 'Statistiques' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Statistiques' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page).toHaveURL(/\/dashboard\/reservations\/stats$/)

    // What it measures, said before any number.
    await expect(
      page.getByText(/ne comptent que les réservations prises dans ce module/),
    ).toBeVisible()
    // The alert centre is on the same screens.
    await expect(page.getByRole('group', { name: 'Période affichée' })).toBeVisible()

    await page.getByRole('main').getByRole('link', { name: 'Carnet du jour', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Période' })).toBeVisible({ timeout: 30_000 })
    expect(errors.getErrors()).toEqual([])
    errors.cleanup()
  })

  test('changing the period changes the question, in words a reader can follow', async ({
    page,
  }) => {
    await openStats(page)
    const label = page.getByTestId('stats-range-label')
    const periods = page.getByRole('group', { name: 'Période affichée' })

    // Thirty days by default.
    await expect(periods.getByRole('button', { name: '30 jours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(label).toHaveText(/^Chiffres du .* au /, { timeout: 30_000 })
    const thirty = await label.textContent()

    await periods.getByRole('button', { name: '7 jours' }).click()
    await expect(periods.getByRole('button', { name: '7 jours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(label).not.toHaveText(thirty ?? '')

    await periods.getByRole('button', { name: "Aujourd'hui" }).click()
    await expect(label).toHaveText(/^Chiffres le /)

    await periods.getByRole('button', { name: '90 jours' }).click()
    await expect(label).toHaveText(/^Chiffres du .* au /)

    // Compared with the period before, and said which.
    await page.getByRole('switch', { name: 'Comparer à la période précédente' }).click()
    await expect(label).toContainText('comparés à du ')
  })

  test('a custom range says what is missing and asks nothing until it is whole', async ({
    page,
  }) => {
    await openStats(page)
    await page
      .getByRole('group', { name: 'Période affichée' })
      .getByRole('button', { name: 'Personnalisé' })
      .click()
    const from = page.getByLabel('Du', { exact: true })
    const to = page.getByLabel('Au', { exact: true })
    await expect(from).toBeVisible()

    await from.fill(isoDateAhead(-3))
    await to.fill(isoDateAhead(-10))
    await expect(page.getByRole('alert').filter({ hasText: 'jour de fin' })).toBeVisible()

    await to.fill(isoDateAhead(-1))
    await expect(page.getByRole('alert').filter({ hasText: 'jour de fin' })).toHaveCount(0)
    await expect(page.getByTestId('stats-range-label')).toContainText(' au ')

    await from.fill(isoDateAhead(-500))
    await expect(page.getByRole('alert').filter({ hasText: '366 jours' })).toBeVisible()
  })

  test('shows either an honest empty state or the figures, and a table behind every chart', async ({
    page,
  }) => {
    await openStats(page)
    const empty = page.getByTestId('stats-empty')
    const kpis = page.getByTestId('stats-kpis')
    await expect(empty.or(kpis)).toBeVisible({ timeout: 30_000 })

    if (await empty.isVisible()) {
      await expect(empty).toContainText("Rien n'est estimé")
      await expect(empty.getByRole('link', { name: 'ouvrez le carnet du jour' })).toBeVisible()
      return
    }

    await expect(kpis.getByRole('listitem')).toHaveCount(8)
    for (const name of [
      'Réservations',
      'Couverts',
      "Taux d'absence",
      "Taux d'annulation",
      "Durée d'un repas",
    ]) {
      await expect(kpis.getByText(name, { exact: true })).toBeVisible()
    }
    // Every rate says what it is a rate of — or says « — », never a bare 0 %.
    await expect(page.locator('[data-kpi="noShowRate"]')).toContainText(/réservation|—/)

    const strip = page.getByTestId('chart-strip')
    await expect(strip).toBeVisible()
    const toggle = strip.getByRole('button', { name: /Afficher le tableau/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(strip.getByRole('table')).toBeVisible()
    await expect(strip.getByRole('columnheader', { name: 'Remplissage moyen' })).toBeVisible()
  })

  test('a booking just made turns up in the figures once the sweep has run', async ({
    page,
    browser,
    baseURL,
  }) => {
    await ensureBook(page, { autoConfirm: true })

    await openStats(page)
    const range = page.getByRole('group', { name: 'Période affichée' })
    await range.getByRole('button', { name: 'Personnalisé' }).click()
    await page.getByLabel('Du', { exact: true }).fill(isoDateAhead(0))
    await page.getByLabel('Au', { exact: true }).fill(isoDateAhead(7))
    const kpis = page.getByTestId('stats-kpis')
    const empty = page.getByTestId('stats-empty')
    await expect(empty.or(kpis)).toBeVisible({ timeout: 30_000 })
    const before = (await kpis.isVisible()) ? await kpiValue(page, 'bookings') : 0

    const context = await newGuestContext(browser, baseURL)
    const guest = await context.newPage()
    const result = await bookAsGuest(guest, {
      date: isoDateAhead(4),
      time: '19:30',
      partySize: 3,
      guest: GUEST,
    })
    expect(result.confirmed).toBe(true)
    await context.close()

    // The screen is live: no reload. The day is marked in the booking's own transaction
    // and recomputed within the minute.
    await expect
      .poll(async () => ((await kpis.isVisible()) ? await kpiValue(page, 'bookings') : 0), {
        timeout: 120_000,
        intervals: [2_000, 5_000],
        message: 'the new booking never reached the statistics',
      })
      .toBeGreaterThan(before)
    await expect(page.locator('[data-kpi="covers"]')).toContainText(/\d/)
  })

  test('the figures leave as a spreadsheet file, a manager’s', async ({ page }) => {
    await openStats(page)
    const exportButton = page.getByTestId('stats-export')
    await expect(exportButton).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
    expect(download.suggestedFilename()).toMatch(
      /^statistiques-reservations-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
    )
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const bytes = Buffer.concat(chunks)
    // A byte-order mark leads the file, so a spreadsheet reads the accents.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8')
    expect(text).toContain('Réservations')
    // Figures only: nothing a guest wrote.
    expect(text).not.toContain(GUEST.email)
    expect(text).not.toContain(GUEST.name)
  })
})
