import { test, expect } from '@playwright/test'
import { collectConsoleErrors } from '../helpers/console.helpers'
import { isoDateAhead, openDayBook, spokenDay } from '../helpers/reservations.helpers'

/**
 * The week and the month, opened the way a host opens them.
 *
 * WHAT THIS IS FOR. The unit tests hold the counting and the heat; this holds what
 * only a browser shows — the period switch, the date navigator, the keyboard
 * moving through the month grid and the click that goes back to a day. It reads
 * structure and words, not numbers: the establishment may hold any bookings when
 * this runs, and an empty week is the case worth pinning anyway.
 */
test.setTimeout(90_000)

test.describe('Week and month views', () => {
  test('the week lists seven days, says how full they are, and has a navigator', async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page)
    await openDayBook(page)
    await page.getByRole('button', { name: 'Semaine', exact: true }).click()

    await expect(page.getByRole('button', { name: 'Semaine', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const heading = page.getByRole('heading', { level: 1 })
    await expect(heading).toHaveText(/^Semaine du /i, { timeout: 30_000 })

    // Seven days, each a button that names its day and its bookings.
    const dayButtons = page.getByRole('button', {
      name: /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) \d{1,2}(er)? \S+(, aujourd'hui)? : /,
    })
    await expect(dayButtons).toHaveCount(7, { timeout: 30_000 })

    // The way the heat is explained: in words, so a colour is never the only clue.
    const legend = page.getByRole('region', { name: 'Remplissage des jours' })
    await expect(legend).toContainText('moment le plus chargé')
    for (const word of ['Calme', 'Animé', 'Chargé', 'Complet']) {
      await expect(legend).toContainText(word)
    }

    // « Aujourd'hui » is off where we are, on once we leave, and brings us back.
    const today = page.getByRole('button', { name: "Aujourd'hui", exact: true })
    await expect(today).toBeDisabled()
    const here = await heading.textContent()
    await page.getByRole('button', { name: 'Semaine suivante' }).click()
    await expect(heading).not.toHaveText(here ?? '')
    await expect(today).toBeEnabled()
    await today.click()
    await expect(heading).toHaveText(here ?? '')
    expect(errors.getErrors()).toEqual([])
    errors.cleanup()
  })

  test('the month is a grid of days the arrow keys move through', async ({ page }) => {
    await openDayBook(page)
    await page.getByRole('button', { name: 'Mois', exact: true }).click()

    const grid = page.getByRole('grid', { name: /^Calendrier, / })
    await expect(grid).toBeVisible({ timeout: 30_000 })
    await expect(grid.getByRole('columnheader')).toHaveCount(7)

    // Today is named as such, and is the one stop in the grid for the Tab key.
    const todayCell = grid.getByRole('button', { name: /aujourd'hui/ })
    await expect(todayCell).toHaveCount(1)
    await todayCell.focus()

    // One day on, one week down, with the focus following the key.
    const tomorrow = isoDateAhead(1)
    await page.keyboard.press('ArrowRight')
    await expect(
      grid.getByRole('button', { name: new RegExp(`^${spokenDay(tomorrow)}`) }),
    ).toBeFocused()

    const nextWeek = isoDateAhead(8)
    await page.keyboard.press('ArrowDown')
    await expect(
      page.getByRole('button', { name: new RegExp(`^${spokenDay(nextWeek)}`) }),
    ).toBeFocused({ timeout: 15_000 })
  })

  test('Page Down goes to the next month and the heading says so', async ({ page }) => {
    await openDayBook(page)
    await page.getByRole('button', { name: 'Mois', exact: true }).click()
    const heading = page.getByRole('heading', { level: 1 })
    const here = (await heading.textContent()) ?? ''
    const grid = page.getByRole('grid', { name: /^Calendrier, / })
    await grid.getByRole('button', { name: /aujourd'hui/ }).focus()
    await page.keyboard.press('PageDown')
    await expect(heading).not.toHaveText(here, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Mois précédent' }).click()
    await expect(heading).toHaveText(here)
  })

  test('a day opens the day screen, and the period switch comes back to the month', async ({
    page,
  }) => {
    await openDayBook(page)
    await page.getByRole('button', { name: 'Mois', exact: true }).click()
    const grid = page.getByRole('grid', { name: /^Calendrier, / })
    const tomorrow = isoDateAhead(1)
    await grid.getByRole('button', { name: new RegExp(`^${spokenDay(tomorrow)}`) }).click()

    // Back on the day: the switch says so and the heading is the long date.
    await expect(page.getByRole('button', { name: 'Jour', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 15_000 },
    )
    await expect(page.getByRole('heading', { level: 1 })).toContainText(spokenDay(tomorrow), {
      ignoreCase: true,
    })
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(tomorrow)

    await page.getByRole('button', { name: 'Mois', exact: true }).click()
    await expect(page.getByRole('grid', { name: /^Calendrier, / })).toBeVisible()
  })

  test('the date field jumps to any day, in any view', async ({ page }) => {
    await openDayBook(page)
    await page.getByRole('button', { name: 'Semaine', exact: true }).click()
    const far = isoDateAhead(40)
    await page.getByLabel('Date', { exact: true }).fill(far)
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(far)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Semaine du /i)
  })
})
