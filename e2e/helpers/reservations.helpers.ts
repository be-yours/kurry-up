import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { readFileSync } from 'node:fs'
import { waitForAdminPage } from './navigation.helpers'

/**
 * What the reservation specs share: a book that is set up through the admin's own
 * screens, a guest who is not signed in, and a date to book.
 *
 * The suite runs against ONE establishment (`seedFixture.ts` creates it), and the
 * storefront serves the first published one — which is the one the admin works on —
 * so the guest the specs open meets the book the host just set up. Everything the
 * helpers create carries an "E2E" prefix and is looked for before it is made, so
 * running the specs twice, or after one another, does not pile up rooms and tables.
 */

export const RESERVATIONS_URL = '/dashboard/reservations'
export const RESERVATION_SETTINGS_URL = '/dashboard/reservations/settings'
export const RESERVATION_GUESTS_URL = '/dashboard/reservations/guests'
export const RESERVATION_STATS_URL = '/dashboard/reservations/stats'
export const PRIVACY_URL = '/dashboard/privacy'

export const E2E_SERVICE = 'E2E Dîner'
export const E2E_ROOMS = ['E2E Salle', 'E2E Terrasse'] as const
/** Two tables of four in each room. */
export const E2E_TABLES = [
  { name: 'E2E Salle 1', room: 'E2E Salle' },
  { name: 'E2E Salle 2', room: 'E2E Salle' },
  { name: 'E2E Terrasse 1', room: 'E2E Terrasse' },
  { name: 'E2E Terrasse 2', room: 'E2E Terrasse' },
] as const

/** A calendar date `days` from now, in the restaurant's own zone (Paris by default). */
export function isoDateAhead(days: number, timeZone = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 24 * 60 * 60_000))
}

/** « mardi 3 novembre »: how the calendar names a day to a screen reader. */
export function spokenDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(year!, month! - 1, day!, 12)))
}

/** A browser that is not signed in: the guest, in the same run as the host. */
export async function newGuestContext(
  browser: Browser,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
}

/** The card of the settings screen with this title. */
export function card(page: Page, title: string): Locator {
  return page.locator('[data-slot="card"]').filter({
    has: page.locator('[data-slot="card-title"]').filter({ hasText: new RegExp(`^${title}$`) }),
  })
}

export async function openSettings(page: Page) {
  await page.goto(RESERVATION_SETTINGS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await waitForAdminPage(page)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Réglages des réservations' }),
  ).toBeVisible({ timeout: 30_000 })
}

export async function openDayBook(page: Page, isoDate?: string) {
  await page.goto(RESERVATIONS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await waitForAdminPage(page)
  await expect(page.getByRole('group', { name: 'Période' })).toBeVisible({
    timeout: 30_000,
  })
  if (isoDate) {
    await page.getByLabel('Date', { exact: true }).fill(isoDate)
  }
}

/** Save the rules as they stand, with the confirmation mode asked for. */
export async function setAutoConfirm(page: Page, wanted: boolean) {
  const toggle = page.getByRole('switch', { name: 'Confirmer automatiquement' })
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  const on = (await toggle.getAttribute('aria-checked')) === 'true'
  if (on !== wanted) await toggle.click()
  await page.getByRole('button', { name: 'Enregistrer les règles' }).click()
  await expect(page.getByText('Règles enregistrées')).toBeVisible({
    timeout: 15_000,
  })
}

async function addRoom(page: Page, name: string) {
  const rooms = card(page, 'Salles')
  if ((await rooms.getByText(name, { exact: true }).count()) > 0) return
  await rooms.getByRole('button', { name: 'Ajouter une salle' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nom').fill(name)
  await dialog.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(rooms.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  })
}

async function addTable(page: Page, name: string, room: string) {
  const tables = card(page, 'Tables')
  if ((await tables.getByText(name, { exact: true }).count()) > 0) return
  await tables.getByRole('button', { name: 'Ajouter', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nom').fill(name)
  await dialog.getByRole('combobox', { name: 'Salle' }).click()
  await page.getByRole('option', { name: room }).click()
  await dialog.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(tables.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  })
}

async function addService(page: Page) {
  const services = card(page, 'Services')
  if ((await services.getByText(E2E_SERVICE, { exact: true }).count()) > 0) {
    return
  }
  await services.getByRole('button', { name: 'Ajouter', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nom').fill(E2E_SERVICE)
  // Every day, 19:00 to 22:30, 90 minutes a meal: the form's own defaults.
  await dialog.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(services.getByText(E2E_SERVICE, { exact: true })).toBeVisible({
    timeout: 15_000,
  })
}

/**
 * Leave the establishment with a bookable book: a dinner service, two rooms with
 * two tables each, the rules saved, and online booking switched on.
 *
 * Idempotent, and driven through the screens an owner uses — which is the point:
 * these are the screens the specs after it are about. `autoConfirm` is the
 * confirmation mode the next spec needs.
 */
export async function ensureBook(page: Page, options: { autoConfirm: boolean }) {
  await openSettings(page)
  await setAutoConfirm(page, options.autoConfirm)
  await addService(page)
  for (const room of E2E_ROOMS) await addRoom(page, room)
  for (const table of E2E_TABLES) await addTable(page, table.name, table.room)
  await drawPlan(page)

  const switchLabel = page.getByRole('switch', {
    name: /Réservations (ouvertes|fermées)/,
  })
  await expect(switchLabel).toBeEnabled({ timeout: 15_000 })
  if ((await switchLabel.getAttribute('aria-checked')) !== 'true') {
    await switchLabel.click()
    await expect(page.getByText('Les réservations en ligne sont ouvertes')).toBeVisible({
      timeout: 15_000,
    })
  }
}

/**
 * Draw every table on the plan of its room, and save it. The plan is a drawing
 * aid, so a table can book without a position — but the host's plan is the screen
 * several specs click on, and it needs something to click.
 */
async function drawPlan(page: Page) {
  const plan = card(page, 'Plan de salle')
  await expect(plan).toBeVisible({ timeout: 15_000 })
  for (const room of E2E_ROOMS) {
    await plan.getByRole('tab', { name: new RegExp(room) }).click()
    const place = plan.getByRole('button', { name: 'Placer les tables' })
    if (await place.isVisible()) await place.click()
  }
  const save = plan.getByRole('button', { name: 'Enregistrer le plan' })
  if (await save.isEnabled()) {
    await save.click()
    await expect(page.getByText('Plan de salle enregistré')).toBeVisible({ timeout: 15_000 })
  }
}

/** What the guest of the booking page types, and where. */
export interface GuestDetails {
  name: string
  email: string
  phone: string
}

/**
 * Book a table as a guest: party, date, an area when one is offered, a time, who
 * is coming, the agreement. Returns the reference and the guest's own link.
 */
export async function bookAsGuest(
  page: Page,
  options: {
    date: string
    time: string
    partySize?: number
    area?: string
    guest: GuestDetails
    /** Tick the optional marketing box: it starts a double opt-in and nothing more. */
    marketing?: boolean
  },
): Promise<{ reference: string; manageUrl: string; confirmed: boolean }> {
  await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
    timeout: 30_000,
  })

  await page.getByLabel('Nombre de convives').selectOption(String(options.partySize ?? 2))
  await page.getByLabel('Date', { exact: true }).fill(options.date)

  if (options.area) {
    // The choice only exists when more than one room can seat an online booking.
    await page.getByText(options.area, { exact: true }).click()
  }

  await page.getByRole('button', { name: new RegExp(`^${options.time}`) }).click()

  await page.getByLabel('Nom', { exact: true }).fill(options.guest.name)
  await page.getByLabel('E-mail', { exact: true }).fill(options.guest.email)
  await page.getByLabel('Téléphone', { exact: true }).fill(options.guest.phone)
  // One required box: the conditions and the notice on the use of the guest's data.
  await page.getByRole('checkbox', { name: /J'accepte les conditions de réservation/ }).click()
  if (options.marketing) {
    await page.getByRole('checkbox', { name: /Je souhaite recevoir les nouvelles/ }).click()
  }
  await page.getByRole('button', { name: /Confirmer la réservation|Envoyer la demande/ }).click()

  // `isVisible` does not wait, whatever timeout it is given: wait for either outcome first.
  const confirmedHeading = page.getByRole('heading', { name: 'Réservation confirmée' })
  const requestedHeading = page.getByRole('heading', { name: 'Demande envoyée' })
  await expect(confirmedHeading.or(requestedHeading)).toBeVisible({ timeout: 30_000 })
  const confirmed = await confirmedHeading.isVisible()

  const reference = (await page.getByText(/^RES-\d{4}-\d{5}$/).textContent()) ?? ''
  const link = page.getByRole('link', { name: 'Voir ou annuler ma réservation' })
  const href = (await link.getAttribute('href')) ?? ''
  return { reference, manageUrl: href, confirmed }
}

/**
 * Turn the waitlist on (or off) from the rules, with the table held for `minutes`.
 * Idempotent: it saves only what differs.
 */
export async function setWaitlist(page: Page, wanted: boolean, minutes?: number) {
  await openSettings(page)
  const toggle = page.getByRole('switch', { name: "Liste d'attente", exact: true })
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  const on = (await toggle.getAttribute('aria-checked')) === 'true'
  if (on !== wanted) await toggle.click()
  if (wanted && minutes !== undefined) {
    await page.getByLabel('Table gardée pendant (minutes)').fill(String(minutes))
  }
  await page.getByRole('button', { name: 'Enregistrer les règles' }).click()
  await expect(page.getByText('Règles enregistrées')).toBeVisible({ timeout: 15_000 })
}

/**
 * Book the host's way, again and again, until the day has no table left for two.
 *
 * The dialog is the ground truth: it lists the slots the engine would still sell
 * and says « Complet » when there are none, so the loop stops when the day is full
 * whatever the book holds — a rerun finds it full already and books nothing.
 * Returns how many bookings it made.
 */
export async function fillDayAsHost(page: Page, isoDate: string, label: string): Promise<number> {
  await openDayBook(page, isoDate)
  let made = 0
  for (let attempt = 0; attempt < 14; attempt++) {
    await page.getByRole('button', { name: 'Nouvelle réservation' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Date', { exact: true }).fill(isoDate)

    const full = dialog.getByText(/^Complet pour/)
    const firstSlot = dialog.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first()
    await expect(full.or(firstSlot)).toBeVisible({ timeout: 20_000 })
    if (await full.isVisible()) {
      await dialog.getByRole('button', { name: 'Annuler' }).click()
      return made
    }
    await firstSlot.click()
    await dialog.getByLabel('Nom', { exact: true }).fill(`${label} ${made + 1}`)
    await dialog.getByLabel('Téléphone', { exact: true }).fill('0600000000')
    await dialog
      .getByLabel('E-mail', { exact: true })
      .fill(`${label.replace(/\s+/g, '.')}.${made + 1}@example.com`)
    await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click()
    // The previous booking's toast may still be on screen: one of them is enough.
    await expect(page.getByText('Réservation enregistrée').first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    made += 1
  }
  throw new Error(`the day of ${isoDate} never filled up`)
}

/** The waitlist panel of the day's book. */
export function waitlistPanel(page: Page): Locator {
  return page.locator('[data-slot="card"]').filter({
    has: page.locator('#waitlist-title'),
  })
}

/* ------------------------------------------------------------------ */
/* Phase 4: statistics, automations, alerts                            */
/* ------------------------------------------------------------------ */

export async function openStats(page: Page) {
  await page.goto(RESERVATION_STATS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitForAdminPage(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Statistiques' })).toBeVisible({
    timeout: 30_000,
  })
}

/** The « Automatisations » card of the settings screen. */
export function automationsCard(page: Page): Locator {
  return page.locator('[data-testid="automations-card"]')
}

/** The switch of one automation, by the title the card gives it. */
export function automationSwitch(page: Page, title: string): Locator {
  return automationsCard(page).getByRole('switch', { name: title, exact: true })
}

/**
 * Put one automation in the state asked for, and wait for the card to say it was
 * saved. Idempotent. Returns whether it had to change anything.
 */
export async function setAutomation(page: Page, title: string, wanted: boolean): Promise<boolean> {
  const toggle = automationSwitch(page, title)
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  await expect(toggle).toBeEnabled()
  const on = (await toggle.getAttribute('aria-checked')) === 'true'
  if (on === wanted) return false
  await toggle.click()
  await expect(page.getByText(`${title} : ${wanted ? 'activée' : 'désactivée'}`)).toBeVisible({
    timeout: 15_000,
  })
  await expect(toggle).toHaveAttribute('aria-checked', String(wanted))
  return true
}

/** The bell of the alert centre on the reservation screens. */
export function alertBell(page: Page): Locator {
  return page.locator('[data-testid="alert-bell"]')
}

/** A guest's own feedback page: the manage link, one route over. */
export function feedbackUrlFor(manageUrl: string): string {
  return manageUrl.replace('/reservation/manage/', '/reservation/feedback/')
}

/* ------------------------------------------------------------------ */
/* Phase 5: paying for a booking                                       */
/* ------------------------------------------------------------------ */

/** The establishment `convex/seedFixture.ts` creates. */
export const E2E_STORE_SLUG = 'chez-luigi-test'

/** The deposit the specs ask for: 20 €, a flat figure for the table. */
export const E2E_DEPOSIT_CENTS = 2000

/** A guest's own payment page: the manage link, one route over. */
export function paymentUrlFor(manageUrl: string): string {
  return manageUrl.replace('/reservation/manage/', '/reservation/payment/')
}

type PaymentRule = {
  id: string
  kind: 'deposit' | 'guarantee'
  deposit?: { mode: 'per_cover' | 'flat'; cents: number }
  noShowFee?: { mode: 'per_cover' | 'flat'; cents: number }
  minPartySize?: number
  serviceIds?: string[]
  weekdays?: number[]
}

type PaymentPolicy = {
  enabled: boolean
  rules: PaymentRule[]
  freeCancellationHours: number
  holdMinutes: number
  primaryProvider?: 'stripe' | 'sumup' | 'paypal'
}

interface PaymentConfig {
  policy: PaymentPolicy
  saved: boolean
  connected: string[]
  services: Array<{ id: string; name: string }>
  refusals: Array<{ rule: string | null; message: string }>
}

const getBySlug = makeFunctionReference<'query', { slug: string }, { _id: string } | null>(
  'stores:getBySlug',
)
const getPaymentConfig = makeFunctionReference<'query', { storeId: string }, PaymentConfig>(
  'reservationPayments:getPaymentConfig',
)
const savePaymentPolicy = makeFunctionReference<
  'mutation',
  { storeId: string } & PaymentPolicy,
  unknown
>('reservationPayments:savePaymentPolicy')

/**
 * What a spec needs to make the establishment ask for a deposit: a Convex client that
 * speaks as the signed-in owner, the establishment, its dinner service, and which
 * payment providers the DEPLOYMENT has connected.
 *
 * `connected` is empty on a bench with no provider key (no `STRIPE_SECRET_KEY`, no
 * connection saved, `cardProvider: none`): the server then refuses every policy that asks
 * for money, and a spec has nothing to book against. It reads that and skips with the
 * reason — it does not fake a provider.
 */
export interface PaymentBench {
  client: ConvexHttpClient
  storeId: string
  serviceId: string
  connected: string[]
  /** Put the policy back as it was found (or switch payments off if there was none). */
  restore: () => Promise<void>
  /** Ask for a flat deposit on the dinner service. */
  askDeposit: (options: { holdMinutes: number; freeCancellationHours: number }) => Promise<void>
}

export async function openPaymentBench(page: Page): Promise<PaymentBench> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? ''
  expect(convexUrl, 'NEXT_PUBLIC_CONVEX_URL is unset').not.toBe('')

  // The token exchange is a relative fetch, so it needs a page on the origin.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const token = await page.evaluate(async () => {
    const response = await fetch('/api/auth/convex/token')
    if (!response.ok) return null
    const body = (await response.json()) as { token?: string } | null
    return body?.token ?? null
  })
  expect(token, 'no Convex token for the signed-in admin').toBeTruthy()

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(token as string)

  const store = await client.query(getBySlug, { slug: E2E_STORE_SLUG })
  expect(store, `no store "${E2E_STORE_SLUG}" — run scripts/seed-users.mts`).toBeTruthy()
  const storeId = (store as { _id: string })._id

  const before = await client.query(getPaymentConfig, { storeId })
  const service = before.services.find((candidate) => candidate.name === E2E_SERVICE)
  expect(service, `no service "${E2E_SERVICE}": ensureBook must run first`).toBeTruthy()

  return {
    client,
    storeId,
    serviceId: service!.id,
    connected: before.connected,
    restore: async () => {
      const policy: PaymentPolicy = before.saved
        ? before.policy
        : { enabled: false, rules: [], freeCancellationHours: 48, holdMinutes: 15 }
      await client.mutation(savePaymentPolicy, { storeId, ...policy })
    },
    askDeposit: async ({ holdMinutes, freeCancellationHours }) => {
      await client.mutation(savePaymentPolicy, {
        storeId,
        enabled: true,
        rules: [
          {
            id: 'e2e-deposit',
            kind: 'deposit',
            deposit: { mode: 'flat', cents: E2E_DEPOSIT_CENTS },
            serviceIds: [service!.id],
          },
        ],
        freeCancellationHours,
        holdMinutes,
        ...(before.connected[0]
          ? { primaryProvider: before.connected[0] as 'stripe' | 'sumup' | 'paypal' }
          : {}),
      })
    },
  }
}

/**
 * Fill the booking form up to — and including — the conditions box, and stop before the
 * payment box and the button: what happens there is what the spec is about.
 */
export async function fillBookingForm(
  page: Page,
  options: { date: string; time: string; partySize?: number; guest: GuestDetails },
) {
  await page.goto('/reservation', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Réserver une table' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByLabel('Nombre de convives').selectOption(String(options.partySize ?? 2))
  await page.getByLabel('Date', { exact: true }).fill(options.date)
  await page.getByRole('button', { name: new RegExp(`^${options.time}`) }).click()
  await page.getByLabel('Nom', { exact: true }).fill(options.guest.name)
  await page.getByLabel('E-mail', { exact: true }).fill(options.guest.email)
  await page.getByLabel('Téléphone', { exact: true }).fill(options.guest.phone)
  await page.getByRole('checkbox', { name: /J'accepte les conditions de réservation/ }).click()
}

/** The box the booking form shows when something is owed. */
export function paymentBox(page: Page): Locator {
  return page.getByTestId('payment-box')
}

/* ------------------------------------------------------------------ */
/* Phase D2: groups with approval, and experiences                      */
/* ------------------------------------------------------------------ */

export const RESERVATION_GROUPS_URL = '/dashboard/reservations/groups'
export const RESERVATION_EXPERIENCES_URL = '/dashboard/reservations/experiences'

/** The deposit a spec asks of an accepted group: 200 €, a flat figure for the whole table. */
export const E2E_GROUP_DEPOSIT_CENTS = 20_000
/** What one seat of the paid E2E event costs: 45 €. */
export const E2E_EXPERIENCE_PRICE_CENTS = 4_500

/** « Demandes de groupe »: the host's list of large parties waiting for an answer. */
export async function openGroups(page: Page) {
  await page.goto(RESERVATION_GROUPS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitForAdminPage(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes de groupe' })).toBeVisible({
    timeout: 30_000,
  })
}

/** « Expériences »: the host's list of events with a limited number of seats. */
export async function openExperiences(page: Page) {
  await page.goto(RESERVATION_EXPERIENCES_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await waitForAdminPage(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Expériences' })).toBeVisible({
    timeout: 30_000,
  })
}

/** What the « Groupes » card of the settings takes. */
export type GroupPolicyDraft = {
  threshold: number
  maxSize: number
  reviewHours: number
  proposalHours: number
}

/**
 * Switch group requests on from Réservations → Réglages → Groupes, with these figures.
 * Idempotent: the card is saved only when something differs from what it holds.
 */
export async function setGroupPolicy(page: Page, policy: GroupPolicyDraft) {
  await openSettings(page)
  const groups = card(page, 'Groupes')
  await expect(groups).toBeVisible({ timeout: 15_000 })
  const toggle = groups.getByRole('switch', { name: 'Accepter les demandes de groupe' })
  await expect(toggle).toBeEnabled({ timeout: 20_000 })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await groups.getByLabel('À partir de (personnes)').fill(String(policy.threshold))
  await groups.getByLabel("Taille maximale d'une demande (personnes)").fill(String(policy.maxSize))
  await groups.getByLabel('Délai de réponse (heures)').fill(String(policy.reviewHours))
  await groups
    .getByLabel("Durée d'une contre-proposition (heures)")
    .fill(String(policy.proposalHours))

  const save = groups.getByRole('button', { name: 'Enregistrer les groupes' })
  if (await save.isEnabled()) {
    await save.click()
    await expect(groups.getByTestId('groups-saved')).toBeVisible({ timeout: 15_000 })
  }
}

interface GroupPolicyAnswer {
  policy: GroupPolicyDraft & { enabled: boolean }
}

interface GroupRequestRow {
  id: string
  guestName: string
  state: string
}

interface ExperienceRow {
  id: string
  title: string
  status: string
}

const getGroupPolicy = makeFunctionReference<'query', { storeId: string }, GroupPolicyAnswer>(
  'reservationGroups:getGroupPolicy',
)
const saveGroupPolicy = makeFunctionReference<
  'mutation',
  { storeId: string } & GroupPolicyDraft & { enabled: boolean },
  unknown
>('reservationGroups:saveGroupPolicy')
const listGroupRequests = makeFunctionReference<
  'query',
  { storeId: string },
  { requests: GroupRequestRow[] }
>('reservationGroups:listGroupRequests')
const declineGroup = makeFunctionReference<'mutation', { id: string }, unknown>(
  'reservationGroups:declineGroup',
)
const setStatus = makeFunctionReference<'mutation', { id: string; to: string }, unknown>(
  'reservations:setStatus',
)
const listExperiences = makeFunctionReference<
  'query',
  { storeId: string },
  { experiences: ExperienceRow[] }
>('reservationExperiences:listExperiences')
const getExperienceOptions = makeFunctionReference<
  'query',
  { storeId: string },
  { paidSalesPossible: boolean }
>('reservationExperiences:getExperienceOptions')
const cancelExperience = makeFunctionReference<'mutation', { id: string }, unknown>(
  'reservationExperiences:cancelExperience',
)
const removeExperience = makeFunctionReference<'mutation', { id: string }, unknown>(
  'reservationExperiences:removeExperience',
)

/** The group policy as the deployment holds it now, to put it back when a spec is done. */
export async function readGroupPolicy(bench: PaymentBench): Promise<GroupPolicyAnswer['policy']> {
  const answer = await bench.client.query(getGroupPolicy, { storeId: bench.storeId })
  return answer.policy
}

export async function restoreGroupPolicy(
  bench: PaymentBench,
  policy: GroupPolicyAnswer['policy'],
): Promise<void> {
  await bench.client.mutation(saveGroupPolicy, { storeId: bench.storeId, ...policy })
}

/**
 * Release what earlier runs of a group spec left behind: a request that is still open is
 * declined, a confirmed or unpaid one is cancelled by the establishment. The group tables
 * stay held otherwise, and the next run's request finds the evening full.
 *
 * Only guests whose name starts with `namePrefix` are touched. Best effort: a row the
 * server refuses to move is left alone.
 */
export async function cleanGroupBookings(bench: PaymentBench, namePrefix: string): Promise<void> {
  const { requests } = await bench.client.query(listGroupRequests, { storeId: bench.storeId })
  const finished = ['declined', 'expired', 'cancelled', 'closed']
  for (const request of requests) {
    if (!request.guestName.startsWith(namePrefix) || finished.includes(request.state)) continue
    try {
      await bench.client.mutation(setStatus, { id: request.id, to: 'cancelled_by_restaurant' })
    } catch {
      try {
        await bench.client.mutation(declineGroup, { id: request.id })
      } catch {
        // Left as it is: the next run's set-up looks again.
      }
    }
  }
}

/** Can the deployment sell a PAID seat now (a provider is connected and cards are accepted)? */
export async function paidSalesPossible(bench: PaymentBench): Promise<boolean> {
  const options = await bench.client.query(getExperienceOptions, { storeId: bench.storeId })
  return options.paidSalesPossible
}

/**
 * Take earlier E2E events off the books: a draft is deleted, a published one is cancelled
 * (every ticket refunded in full). Only titles starting with `titlePrefix` are touched.
 * Without it a published event keeps its tables held on that evening for every later run.
 */
export async function cleanExperiences(bench: PaymentBench, titlePrefix: string): Promise<void> {
  const { experiences } = await bench.client.query(listExperiences, { storeId: bench.storeId })
  for (const event of experiences) {
    if (!event.title.startsWith(titlePrefix)) continue
    try {
      if (event.status === 'draft') {
        await bench.client.mutation(removeExperience, { id: event.id })
      } else if (event.status === 'published') {
        await bench.client.mutation(cancelExperience, { id: event.id })
      }
    } catch {
      // Left as it is: the next run's set-up looks again.
    }
  }
}

/* ------------------------------------------------------------------ */
/* The mail the stand-in transport kept                                 */
/* ------------------------------------------------------------------ */

/** Where the stand-in SES appends every message it accepted (JSON lines). Unset: no mail can be read. */
export const MAIL_LOG = process.env.E2E_MAIL_LOG ?? ''

export const NO_MAIL_LOG =
  'no mail log is readable: point E2E_MAIL_LOG at the file the stand-in SES appends to (the Convex deployment sends to it through AWS_ENDPOINT_URL_SESV2)'

/** The plain-text bodies of the messages sent to one address, oldest first. */
export function mailsTo(address: string): string[] {
  if (!MAIL_LOG) return []
  let raw = ''
  try {
    raw = readFileSync(MAIL_LOG, 'utf8')
  } catch {
    return []
  }
  const bodies: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as {
        body?: {
          Destination?: { ToAddresses?: string[] }
          Content?: { Simple?: { Body?: { Text?: { Data?: string } } } }
        }
      }
      const to = entry.body?.Destination?.ToAddresses ?? []
      if (to.some((item) => item.toLowerCase() === address.toLowerCase())) {
        bodies.push(entry.body?.Content?.Simple?.Body?.Text?.Data ?? '')
      }
    } catch {
      // A line that is not JSON is not a message.
    }
  }
  return bodies
}

/**
 * The first link containing `pathFragment` in a message sent to `address`, as a path on the
 * site (the host is the deployment's own `SITE_URL`, not the bench's port), waiting for the
 * mail to arrive. `null` when none comes in time.
 */
export async function waitForMailPath(
  address: string,
  pathFragment: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  const pattern = new RegExp(`https?://[^\\s/]+((?:/[^\\s"<]*)?${pathFragment}[^\\s"<]*)`)
  while (Date.now() < deadline) {
    for (const body of mailsTo(address)) {
      const found = body.match(pattern)
      if (found) return found[1]!
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

/* ------------------------------------------------------------------ */
/* What the server answers when a screen would never ask                */
/* ------------------------------------------------------------------ */

const updateByStaff = makeFunctionReference<
  'mutation',
  {
    id: string
    date: string
    serviceId: string
    startsAt: number
    partySize: number
  },
  unknown
>('reservations:updateByStaff')
const listAttendees = makeFunctionReference<
  'query',
  { id: string },
  { attendees: Array<{ id: string; guestName: string; seats: number }> }
>('reservationExperiences:listAttendees')

/** The refusal a call ends with, as text (its code and message), or `null` when it went through. */
async function refusalText(call: Promise<unknown>): Promise<string | null> {
  try {
    await call
    return null
  } catch (error) {
    const failure = error as { data?: unknown; message?: string }
    return typeof failure.data === 'string'
      ? failure.data
      : JSON.stringify(failure.data ?? failure.message ?? String(error))
  }
}

/** Try to raise a ticket's party from outside the event's own screen: the server must refuse. */
export async function tryEditTicket(
  bench: PaymentBench,
  event: { id: string; startsAt: number },
  guestName: string,
  date: string,
): Promise<string | null> {
  const { attendees } = await bench.client.query(listAttendees, { id: event.id })
  const ticket = attendees.find((attendee) => attendee.guestName === guestName)
  expect(ticket, `no ticket for ${guestName}`).toBeTruthy()
  return refusalText(
    bench.client.mutation(updateByStaff, {
      id: ticket!.id,
      date,
      serviceId: bench.serviceId,
      startsAt: event.startsAt,
      partySize: ticket!.seats + 4,
    }),
  )
}

/** Try to confirm a group request with a plain status move: the server must refuse. */
export async function tryConfirmGroupRequest(
  bench: PaymentBench,
  guestName: string,
): Promise<string | null> {
  const { requests } = await bench.client.query(listGroupRequests, { storeId: bench.storeId })
  const request = requests.find((candidate) => candidate.guestName === guestName)
  expect(request, `no group request from ${guestName}`).toBeTruthy()
  return refusalText(bench.client.mutation(setStatus, { id: request!.id, to: 'confirmed' }))
}

/** An event of the host's list, by title, with what a call about it needs. */
export async function findExperience(
  bench: PaymentBench,
  title: string,
): Promise<{ id: string; startsAt: number }> {
  const { experiences } = await bench.client.query(listExperiences, { storeId: bench.storeId })
  const event = experiences.find((candidate) => candidate.title === title) as
    | { id: string; startsAt: number }
    | undefined
  expect(event, `no event titled ${title}`).toBeTruthy()
  return event!
}
