import { test, expect, type Page, type Response } from "@playwright/test"
import { ConvexHttpClient } from "convex/browser"
import { makeFunctionReference } from "convex/server"
import { collectConsoleErrors } from "../helpers/console.helpers"

/**
 * The payments screen, and the refund that starts on it.
 *
 * WHY THIS FILE EXISTS. `/dashboard/payments` had no end-to-end coverage at
 * all: the only proof that a refund was reachable was a unit test grepping the
 * route file for the string "PaymentsPage". `PaymentsPage` could have thrown on
 * its first render and every unit test would still have been green. The refund
 * button had already been dead once — wired to a Convex mutation that no longer
 * existed — and source-level greps are exactly what let that ship.
 *
 * WHY IT SEEDS ITS OWN DATA. A spec that walked the table it found would find
 * nothing and pass, which is the failure mode this file exists to avoid:
 * `order-detail.spec.ts` wrapped every assertion in `if (hasOrder)` and
 * reported success against an empty database. The fixture below is created
 * through the app's own Convex functions before anything is asserted, and a
 * seed that fails FAILS the test rather than skipping it.
 *
 * `seedFixture` used to create a restaurant, a catalogue and a team and no
 * orders at all, which is what left this file with nothing to build on. It
 * writes two orders now — but no PAYMENT, which is what this screen is about,
 * and its orders are inserted directly rather than placed, so they prove
 * nothing about `orders.create`. The amounts below are deliberately odd enough
 * to find in a table those seeded rows also appear in.
 *
 * WHERE THE PROOF STOPS. There are no payment-provider credentials in CI, and
 * a fake Stripe answer would only test the fake. The seeded payment carries no
 * `externalId`, so `routeRefund()` classes it "unsupported" and the action
 * refuses BEFORE it would call a provider. What is proved is the whole chain up
 * to that point — button, dialog, amounts, submit, server action, answer — and
 * that the ledger is left untouched when the provider step cannot run. Money
 * actually moving is not testable here, and nothing below pretends it is.
 */

const PAYMENTS_URL = "/dashboard/payments"
const ORDERS_URL = "/dashboard/orders"

/** The restaurant `convex/seedFixture.ts` creates. */
const STORE_SLUG = "chez-luigi-test"

/** Where `@be-yours/restaurant` persists the establishment being administered. */
const ADMIN_STORE_SELECTION_KEY = "beyours-admin-store"

/**
 * Amounts in cents, odd enough to find in a table other specs also write to.
 * 42,42 € is refundable; 13,37 € is cash, which is handed back at the counter
 * and must therefore be offered no button at all.
 */
const CARD_AMOUNT_LABEL = "42,42"
const CASH_AMOUNT_LABEL = "13,37"
const CARD_AMOUNT = 4242
const CASH_AMOUNT = 1337

/**
 * Replay keys for `orders.create`.
 *
 * CI retries a failed test twice against the same Convex deployment, so the
 * seed has to survive running three times. The order mutation dedupes on this
 * key; the payments below dedupe by looking the order's payments up first.
 */
const CARD_ORDER_KEY = "e2e-payments-refund-card"
const CASH_ORDER_KEY = "e2e-payments-refund-cash"

// ── The Convex functions this fixture drives ────────────────────────────────
//
// Declared by name rather than imported from `_generated/api`: the app wrappers
// type their handlers as `any`, and pulling that in would put `any` back into a
// file that may not have it. The shapes below are the contract this spec
// depends on — when one drifts, the seed throws with the server's own message
// instead of passing quietly.

interface StoreHour {
  day: number
  open: string
  close: string
  isClosed: boolean
}

interface StoreRow {
  _id: string
  name: string
  hours?: StoreHour[]
}

interface ProductRow {
  _id: string
  name: string
  price: number
}

interface PaymentRow {
  _id: string
  amount: number
  provider: string
  status: string
}

interface OrderLineInput {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  selectedOptions: never[]
  subtotal: number
}

const storesGetBySlug = makeFunctionReference<
  "query",
  { slug: string },
  StoreRow | null
>("stores:getBySlug")

const productsList = makeFunctionReference<
  "query",
  { storeId: string },
  ProductRow[]
>("products:list")

const ordersCreate = makeFunctionReference<
  "mutation",
  {
    storeId: string
    customerInfo: { name: string; email: string }
    items: OrderLineInput[]
    type: "pickup"
    idempotencyKey: string
  },
  string
>("orders:create")

const storesUpdateHours = makeFunctionReference<
  "mutation",
  { id: string; hours: StoreHour[] },
  null
>("stores:updateHours")

const paymentsGetByOrder = makeFunctionReference<
  "query",
  { orderId: string },
  PaymentRow[]
>("payments:getByOrder")

const paymentsCreate = makeFunctionReference<
  "mutation",
  {
    storeId: string
    orderId: string
    amount: number
    currency: string
    provider: "stripe" | "cash"
  },
  string
>("payments:create")

const paymentsUpdateStatus = makeFunctionReference<
  "mutation",
  { id: string; status: "succeeded" },
  null
>("payments:updateStatus")

interface Fixture {
  storeId: string
  /** The order whose settled card payment carries the refund button. */
  cardOrderId: string
  cardPaymentId: string
  cashPaymentId: string
}

/**
 * The Convex identity of the signed-in owner.
 *
 * `payments.create` and `payments.updateStatus` both demand `payments:write`,
 * so the fixture has to speak as somebody. Better Auth mints the Convex JWT at
 * this endpoint and the browser holds the session cookie the `setup` project
 * saved — the same exchange `ConvexBetterAuthProvider` performs on every load.
 */
async function convexToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const response = await fetch("/api/auth/convex/token")
    if (!response.ok) return null
    const body = (await response.json()) as { token?: string } | null
    return body?.token ?? null
  })

  expect(
    token,
    "no Convex token for the signed-in admin — is the session in e2e/.auth/admin.json still valid?"
  ).toBeTruthy()

  return token as string
}

/**
 * An order with a settled card payment, and a second with a settled cash one.
 *
 * Every step asserts its own result. An empty catalogue, a store that will not
 * take orders, a permission the owner turns out not to hold: each fails here,
 * loudly, rather than leaving the assertions below with nothing to look at.
 */
async function createFixture(page: Page): Promise<Fixture> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? ""
  expect(
    convexUrl,
    "NEXT_PUBLIC_CONVEX_URL is unset — the admin project should not have been declared without it"
  ).not.toBe("")

  // The token exchange is a relative fetch, so it needs a page on the origin.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded", timeout: 60_000 })

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(await convexToken(page))

  const store = await client.query(storesGetBySlug, { slug: STORE_SLUG })
  expect(
    store,
    `no store "${STORE_SLUG}" — run scripts/seed-users.mts, which runs seedFixture`
  ).toBeTruthy()
  const storeId = (store as StoreRow)._id

  /**
   * Open the restaurant for as long as this fixture needs it.
   *
   * `orders.create` refuses outside the seeded week since #361, and the
   * fixture below places real orders through it. The seed opens 09:00–22:00,
   * so every run between 22:00 and 09:00 Paris failed all seven tests on a
   * fixture error — a suite that was green only because CI had never run at
   * night. The hours are restored in `afterAll`: three other specs assert the
   * seeded week, and one of them may share this shard.
   *
   * A full open week rather than an empty one: `stores.updateHours` takes the
   * array as given, and "always open" is the precondition this file wants
   * stated, not inferred from an absence.
   */
  seededHours = (store as StoreRow).hours ?? null
  openedStoreId = storeId
  await client.mutation(storesUpdateHours, {
    id: storeId,
    hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day,
      open: "00:00",
      close: "23:59",
      isClosed: false,
    })),
  })
  restoreHours = async () => {
    if (!seededHours) return
    await client.mutation(storesUpdateHours, { id: storeId, hours: seededHours })
  }

  const products = await client.query(productsList, { storeId })
  expect(
    products.length,
    `store "${STORE_SLUG}" has an empty catalogue — seedFixture should have created five products`
  ).toBeGreaterThan(0)
  const product = products[0] as ProductRow

  const orderFor = (idempotencyKey: string): Promise<string> =>
    client.mutation(ordersCreate, {
      storeId,
      customerInfo: { name: "Cliente e2e", email: "e2e@chez-luigi.test" },
      items: [
        {
          productId: product._id,
          productName: product.name,
          quantity: 1,
          unitPrice: product.price,
          selectedOptions: [],
          subtotal: product.price,
        },
      ],
      type: "pickup",
      idempotencyKey,
    })

  /**
   * A settled payment on that order, created once and reused thereafter.
   *
   * `payments.create` always inserts at "pending", which is not refundable, so
   * the status is moved on in a second call — the same two steps the provider
   * verification actions used to take.
   */
  const settledPayment = async (
    orderId: string,
    provider: "stripe" | "cash",
    amount: number
  ): Promise<string> => {
    const existing = await client.query(paymentsGetByOrder, { orderId })
    const already = existing.find(
      (payment) => payment.provider === provider && payment.amount === amount
    )
    if (already) return already._id

    const paymentId = await client.mutation(paymentsCreate, {
      storeId,
      orderId,
      amount,
      currency: "EUR",
      provider,
    })
    await client.mutation(paymentsUpdateStatus, { id: paymentId, status: "succeeded" })
    return paymentId
  }

  const cardOrderId = await orderFor(CARD_ORDER_KEY)
  const cashOrderId = await orderFor(CASH_ORDER_KEY)

  return {
    storeId,
    cardOrderId,
    cardPaymentId: await settledPayment(cardOrderId, "stripe", CARD_AMOUNT),
    cashPaymentId: await settledPayment(cashOrderId, "cash", CASH_AMOUNT),
  }
}

/** Built once per worker; CI runs one worker, and retries reuse it. */
let pending: Promise<Fixture> | null = null

/** The seeded week, put back after this file's last test. See `createFixture`. */
let seededHours: StoreHour[] | null = null
let openedStoreId: string | null = null
let restoreHours: (() => Promise<void>) | null = null

test.afterAll(async () => {
  if (!restoreHours || !openedStoreId) return
  await restoreHours()
  restoreHours = null
  openedStoreId = null
  seededHours = null
})

function fixture(page: Page): Promise<Fixture> {
  // A rejected promise is NOT memoised. Caching one would turn a single
  // transient seed failure into three identical failures, and the two retries
  // CI grants would report a defect they never re-tested.
  pending ??= createFixture(page).catch((error: unknown) => {
    pending = null
    throw error
  })
  return pending
}

/**
 * Pin the dashboard to the seeded restaurant before the first render.
 *
 * Other specs create establishments of their own and `StoreGuard` keeps
 * whichever id it finds persisted. Writing the selection up front is how the
 * storefront specs seed their cart, and it is the difference between asserting
 * on this fixture and asserting on whatever the previous spec left selected.
 */
async function openAdmin(
  page: Page,
  url: string,
  storeId: string
): Promise<Response | null> {
  await page.addInitScript(
    ({ key, id }: { key: string; id: string }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ state: { storeId: id }, version: 0 })
      )
    },
    { key: ADMIN_STORE_SELECTION_KEY, id: storeId }
  )

  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
}

/** The seeded card payment's row, asserted to be there before it is read. */
async function cardRow(page: Page) {
  const row = page.getByRole("row").filter({ hasText: CARD_AMOUNT_LABEL })
  await expect(
    row,
    "the seeded card payment is not in the table — the fixture or the store selection is wrong"
  ).toHaveCount(1, { timeout: 30_000 })
  return row
}

test.describe("Payments and refunds", () => {
  test("renders /dashboard/payments without crashing", async ({ page }) => {
    const { storeId } = await fixture(page)

    const { getErrors, cleanup } = collectConsoleErrors(page)
    const response = await openAdmin(page, PAYMENTS_URL, storeId)

    expect(response?.status()).toBeLessThan(500)
    await expect(page.getByRole("heading", { name: "Paiements" })).toBeVisible({
      timeout: 30_000,
    })
    // The filters are the page's own chrome; the loading skeleton has neither.
    await expect(page.getByText("Fournisseur :")).toBeVisible({ timeout: 15_000 })

    await page.waitForTimeout(2_000)
    cleanup()
    expect(getErrors()).toEqual([])
  })

  test("lists the store's settled payments in the table", async ({ page }) => {
    const { storeId } = await fixture(page)
    await openAdmin(page, PAYMENTS_URL, storeId)

    // Not "some row exists": THIS payment, the one the fixture settled. An
    // empty table fails here instead of reading as "nothing to check".
    const row = await cardRow(page)
    await expect(row).toContainText("Stripe")
    await expect(row).toContainText("Réussi")
  })

  test("offers the refund control on a refundable payment", async ({ page }) => {
    const { storeId } = await fixture(page)
    await openAdmin(page, PAYMENTS_URL, storeId)

    const refund = (await cardRow(page)).getByRole("button", { name: "Rembourser" })
    await expect(refund).toBeVisible()
    // The suite signs in as the owner (`client_admin`), who holds
    // `payments:refund`. A role that does not gets this same button disabled
    // with a reason — that matrix is covered exhaustively in
    // `packages/admin/src/__tests__/refund-eligibility.test.ts`, which can try
    // all seven roles without seven logins.
    await expect(refund).toBeEnabled()
  })

  test("offers no refund on a cash payment", async ({ page }) => {
    const { storeId } = await fixture(page)
    await openAdmin(page, PAYMENTS_URL, storeId)

    // Cash goes back over the counter, so the screen must not imply the system
    // will send it. Proving a button ABSENT needs the row present first, or
    // this passes on an empty table.
    const row = page.getByRole("row").filter({ hasText: CASH_AMOUNT_LABEL })
    await expect(row).toHaveCount(1, { timeout: 30_000 })
    await expect(row).toContainText("Espèces")
    await expect(row.getByRole("button", { name: "Rembourser" })).toHaveCount(0)
  })

  test("opens the refund dialog on the payment's real amounts", async ({ page }) => {
    const { storeId } = await fixture(page)
    await openAdmin(page, PAYMENTS_URL, storeId)

    await (await cardRow(page)).getByRole("button", { name: "Rembourser" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText("Remboursement max :")).toBeVisible()
    await expect(dialog).toContainText(CARD_AMOUNT_LABEL)

    // The two shortcuts are how a partial refund is actually entered.
    await dialog.getByRole("button", { name: "50%", exact: true }).click()
    await expect(dialog.getByRole("button", { name: /^Rembourser 21,21/ })).toBeVisible()

    await dialog.getByRole("button", { name: "Total", exact: true }).click()
    await expect(
      dialog.getByRole("button", { name: new RegExp(`^Rembourser ${CARD_AMOUNT_LABEL}`) })
    ).toBeVisible()
  })

  test("submits a partial refund and reports what the server answered", async ({
    page,
  }) => {
    const { storeId } = await fixture(page)
    await openAdmin(page, PAYMENTS_URL, storeId)

    await (await cardRow(page)).getByRole("button", { name: "Rembourser" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "50%", exact: true }).click()
    await dialog.getByRole("button", { name: /^Rembourser 21,21/ }).click()

    /**
     * This is the end of what can be proved without a provider.
     *
     * The click reaches `payments.refundPayment`, which authorises against
     * `payments:refund`, plans the refund, and then routes it: the fixture has
     * no `externalId`, so `routeRefund()` answers "unsupported" and the action
     * throws before any provider is called. The dialog reports that failure —
     * the whole chain except its last link.
     *
     * A refund that actually moves money needs a real Stripe, SumUp or PayPal
     * transaction to refund against, and there are no such credentials here.
     * `refund-eligibility.test.ts` covers the decision, and
     * `packages/convex-functions` covers the reserve/confirm/release ledger.
     */
    await expect(page.getByText(/Échec du remboursement/)).toBeVisible({
      timeout: 30_000,
    })

    // And the money is untouched: a refund that never left is never recorded.
    // This is the assertion that would catch a repeat of `payments.refund`, the
    // deleted mutation that reported success while nobody was paid back.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
    const after = await cardRow(page)
    await expect(after).toContainText("Réussi")
    await expect(after).not.toContainText("Partiellement remboursé")
  })

  test("offers the same refund from the order the payment belongs to", async ({
    page,
  }) => {
    const { storeId, cardOrderId } = await fixture(page)
    // The second call site. It used to carry its own copy of the eligibility
    // rule, and the two copies disagreed.
    await openAdmin(page, `${ORDERS_URL}/${cardOrderId}`, storeId)

    await expect(page.getByRole("heading", { name: /Commande/ })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText("Informations de paiement")).toBeVisible({
      timeout: 15_000,
    })

    const refund = page.getByRole("button", { name: "Rembourser", exact: true })
    await expect(refund).toBeVisible({ timeout: 15_000 })
    await expect(refund).toBeEnabled()

    await refund.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText(CARD_AMOUNT_LABEL)
  })
})
