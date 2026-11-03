// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The confirmation a diner gets when their order is paid for.
 *
 * WHAT WAS MISSING: nothing in the product ever sent a transactional email.
 * Five SES senders shipped — team invitations, campaigns, maintenance notices,
 * game prizes, marketing automations — and not one of them was triggered by a
 * purchase. A guest paid and received nothing: no confirmation, no receipt, no
 * note of what they had ordered or where to collect it.
 *
 * These are the app-level tests for the whole path, from the seam where money
 * is recorded to the `SendEmailCommand` SES is handed. Four properties matter
 * enough to pin here rather than in the renderer's own unit tests:
 *
 *  1. exactly one email per paid order, which is the point of the
 *     `confirmationEmailAt` claim — a Stripe webhook replayed against its own
 *     success page must not post three receipts through the same letterbox;
 *  2. nothing at all for the orders that are not the restaurant's to confirm —
 *     no address, a marketplace, a hard-bouncing address;
 *  3. amounts in euros, from the cents the order stores. The template this
 *     replaced did `total.toFixed(2)` on a cents figure, which billed a diner
 *     2 890,00 € for a 28,90 € dinner on their own receipt;
 *  4. the sender is the establishment, not whatever the deployment defaults to.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/** One `SendEmailCommand` input, as far as these tests read it. */
interface CapturedEmail {
  FromEmailAddress: string
  Destination: { ToAddresses: string[] }
  ReplyToAddresses?: string[]
  Content: {
    Simple: {
      Subject: { Data: string }
      Body: { Html: { Data: string }; Text: { Data: string } }
    }
  }
}

/** Every command handed to SES during a test, in order. */
const sesSends: CapturedEmail[] = []

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: CapturedEmail }) {
      sesSends.push(command.input)
      return {}
    }
  },
  SendEmailCommand: class {
    input: CapturedEmail
    constructor(input: CapturedEmail) {
      this.input = input
    }
  },
}))

import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

/** The deployment's own sender, used when an establishment configured none. */
const DEPLOYMENT_SENDER = "no-reply@beindigital.example"
const SITE_URL = "https://chez-luigi.example"

/**
 * The renderer puts a non-breaking space before € and %, as French typography
 * requires — it is what stops "28,90" and "€" landing on separate lines in a
 * narrow mail client. Written as an escape so it stays visible in this file
 * rather than reading as an ordinary space.
 */
const NBSP = "\u00a0"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(() => {
  sesSends.length = 0
  vi.stubEnv("AWS_SES_FROM_EMAIL", DEPLOYMENT_SENDER)
  vi.stubEnv("AWS_REGION", "eu-west-3")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret")
  vi.stubEnv("SITE_URL", SITE_URL)
})

/**
 * Cancel whatever the test left on the scheduler.
 *
 * A job left pending fires against a transaction that has closed, and because
 * nothing awaits it that arrives as an unhandled rejection: every test green
 * and the run still exiting 1, blaming whichever file happened to be running.
 * Same guard, and the same reason, as `order-lifecycle.test.ts`.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
  vi.unstubAllEnvs()
})

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      phone: "01 42 60 00 00",
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedGlobalSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

/** The establishment's own verified SES identity. */
async function seedEmailConfig(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.run((ctx) =>
    ctx.db.insert("emailConfig", {
      storeId,
      senderName: "Chez Luigi",
      replyToEmail: "contact@luigi.example",
      fromEmail: "commandes@luigi.example",
      branding: { primaryColor: "#000000", secondaryColor: "#ffffff" },
      unsubscribeText: "Se désabonner",
      maxEmailsPerWeek: 100,
      automationSettings: {
        welcomeEnabled: true,
        postOrderEnabled: true,
        birthdayEnabled: false,
        inactiveEnabled: false,
        abandonedCartEnabled: false,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

type SubscriberStatus =
  | "pending"
  | "active"
  | "unsubscribed"
  | "bounced"
  | "complained"

/** How SES last found an address, as the marketing list records it. */
async function seedSubscriber(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  email: string,
  status: SubscriberStatus
) {
  await t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email,
      status,
      source: "storefront_form" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "test",
      bounceCount: status === "bounced" ? 3 : 0,
      metadata: {
        totalOrders: 0,
        totalSpent: 0,
        averageOrderValue: 0,
        favoriteProducts: [],
        orderTypes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/**
 * A website order awaiting payment.
 *
 * Written straight into the table rather than through `orders.create`, because
 * what is under test is the money — `total: 2_890` has to be the figure the
 * receipt is built from, not one the pricing engine recomputed.
 */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  overrides: Record<string, unknown> = {}
): Promise<Id<"orders">> {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-0042",
      customerInfo: { name: "Camille", email: "camille@example.com" },
      type: "pickup" as const,
      status: "pending" as const,
      items: [
        {
          productName: "Margherita",
          quantity: 2,
          unitPrice: 1_200,
          selectedOptions: [],
          subtotal: 2_400,
        },
        {
          productName: "Tiramisu",
          quantity: 1,
          unitPrice: 490,
          selectedOptions: [],
          subtotal: 490,
        },
      ],
      subtotal: 2_890,
      taxAmount: 263,
      taxBreakdown: [{ ratePercent: 10, grossAmount: 2_890, taxAmount: 263 }],
      total: 2_890,
      paymentMethod: "card",
      paymentStatus: "pending" as const,
      source: "website" as const,
      viewToken: "camille-view-token",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  )
}

async function seedManager(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:m1",
      role: "manager" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "user:m1" })
}

// ── Driving the scheduler ───────────────────────────────────────────────────

/**
 * Do the thing that settles the order, then let the email it queued run.
 *
 * The fake timers go in BEFORE the settlement, not after it, and that ordering
 * is load-bearing: `scheduleOrderConfirmation` calls `runAfter(0)`, which
 * convex-test turns into a `setTimeout` at the moment it is called. A timer
 * registered against the real clock is not adopted by a fake one installed
 * afterwards — the job would stay pending for ever and every assertion here
 * would read zero emails for entirely the wrong reason.
 */
async function settleAndDeliver(
  t: ReturnType<typeof convexTest>,
  settle: () => Promise<unknown>
) {
  vi.useFakeTimers()
  try {
    await settle()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  } finally {
    vi.useRealTimers()
  }
}

/** What every card path does when the money lands. */
function payByCard(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
  return t.mutation(internal.orders.internalUpdatePaymentStatus, {
    id: orderId,
    paymentStatus: "paid" as const,
  })
}

/** The one email SES was handed, and a complaint if there was not exactly one. */
function onlyEmail(): CapturedEmail {
  expect(sesSends).toHaveLength(1)
  return sesSends[0]
}

/** Both parts of the message, so an assertion cannot pass on the HTML alone. */
function bodies(mail: CapturedEmail): string[] {
  return [mail.Content.Simple.Body.Html.Data, mail.Content.Simple.Body.Text.Data]
}

/**
 * How many confirmations the settling mutation put on the scheduler.
 *
 * Counted alongside the SES commands rather than instead of them: the claim is
 * meant to stop a second email from ever being QUEUED, so a test that only
 * counted deliveries would still pass if the deduplication had quietly moved
 * into the sender.
 */
function confirmationJobs(t: ReturnType<typeof convexTest>): Promise<number> {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs.filter(
      (job) => job.name === "customerEmail:sendOrderConfirmation"
    ).length
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("a diner who has paid", () => {
  test("receives exactly one confirmation, at the address they gave", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    expect(onlyEmail().Destination.ToAddresses).toEqual(["camille@example.com"])

    // The claim the whole fix turns on, written inside the settling mutation.
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(typeof order?.confirmationEmailAt).toBe("number")
  })

  test("receives one when they pay cash at the counter too", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { paymentMethod: "cash" })
    const asManager = await seedManager(t, storeId)

    await settleAndDeliver(t, () =>
      asManager.mutation(api.orders.markCashPaid, { orderId })
    )

    expect(onlyEmail().Destination.ToAddresses).toEqual(["camille@example.com"])
  })

  test("receives no second copy when the settlement is replayed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    // A Stripe webhook and the success page racing over the same order, which
    // is the ordinary case and not the pathological one: `recordPaymentStatus`
    // deliberately has no "was it already paid" guard.
    await settleAndDeliver(t, async () => {
      await payByCard(t, orderId)
      await payByCard(t, orderId)
    })

    expect(sesSends).toHaveLength(1)
    // Not queued twice and then deduplicated somewhere downstream: the second
    // settlement read the marker the first one wrote and scheduled nothing.
    expect(await confirmationJobs(t)).toBe(1)
  })

  test("receives no second copy when two staff record the same cash payment", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, { paymentMethod: "cash" })
    const asManager = await seedManager(t, storeId)

    await settleAndDeliver(t, async () => {
      await asManager.mutation(api.orders.markCashPaid, { orderId })
      await asManager.mutation(api.orders.markCashPaid, { orderId })
    })

    expect(sesSends).toHaveLength(1)
    expect(await confirmationJobs(t)).toBe(1)
  })
})

describe("the orders nobody is written to", () => {
  test("a guest who left no address, and the settlement still succeeds", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    // Guest checkout does not require an email. There is simply nothing to
    // send to, and that is not an error on a payment that has been taken.
    const orderId = await seedOrder(t, storeId, {
      customerInfo: { name: "Camille" },
    })

    await expect(
      settleAndDeliver(t, () => payByCard(t, orderId))
    ).resolves.toBeUndefined()

    expect(sesSends).toHaveLength(0)
    expect(await confirmationJobs(t)).toBe(0)
    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.paymentStatus).toBe("paid")
    expect(order?.confirmationEmailAt).toBeUndefined()
  })

  test("a marketplace order, whose diner Uber Eats has already told", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    // The platform holds the diner's address, sends its own confirmation, and
    // accounts for the tax itself — `taxAmount: 0` is why a receipt built from
    // these figures would not balance.
    const orderId = await seedOrder(t, storeId, {
      source: "uber_eats",
      taxAmount: 0,
      customerInfo: { name: "Camille", email: "camille@example.com" },
    })

    await settleAndDeliver(t, () => payByCard(t, orderId))

    expect(sesSends).toHaveLength(0)
    expect(await confirmationJobs(t)).toBe(0)
  })

  test("an address SES has told us hard-bounces", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    await seedSubscriber(t, storeId, "camille@example.com", "bounced")
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    // Writing again costs the establishment its sending reputation, and the
    // mail does not arrive anyway.
    expect(sesSends).toHaveLength(0)
    expect(await confirmationJobs(t)).toBe(0)
  })

  test("a suppressed address written in another case is still suppressed", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    await seedSubscriber(t, storeId, "camille@example.com", "bounced")
    const orderId = await seedOrder(t, storeId, {
      customerInfo: { name: "Camille", email: "Camille@Example.com" },
    })

    await settleAndDeliver(t, () => payByCard(t, orderId))

    // Otherwise a suppressed address becomes reachable again by shifting the
    // case of a letter, which is not a decision anyone made.
    expect(sesSends).toHaveLength(0)
  })

  test("but someone who unsubscribed from marketing still gets their receipt", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    await seedSubscriber(t, storeId, "camille@example.com", "unsubscribed")
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    // Unsubscribing withdraws consent to be *marketed to*. It does not cancel
    // the confirmation for something the person paid for.
    expect(sesSends).toHaveLength(1)
  })
})

describe("what the confirmation says", () => {
  test("names the establishment and the order in its subject", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    expect(onlyEmail().Content.Simple.Subject.Data).toBe(
      "Chez Luigi : votre commande ORD-2026-0042 est confirmée"
    )
  })

  test("prices the order in euros, from the cents the order stores", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    for (const body of bodies(onlyEmail())) {
      expect(body).toContain(`28,90${NBSP}€`)
      // The defect the renderer exists to close: `toFixed(2)` on a cents
      // figure billed the diner a hundred times what they paid.
      expect(body).not.toContain("2890,00")
      expect(body).not.toContain(`2${NBSP}890,00`)
      // The VAT is contained in the total, so it is declared under it.
      expect(body).toContain(`dont TVA 10${NBSP}%`)
      expect(body).toContain(`2,63${NBSP}€`)
    }
  })

  test("says what was ordered, where to collect it and how to follow it", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    const mail = onlyEmail()
    for (const body of bodies(mail)) {
      expect(body).toContain("Chez Luigi")
      expect(body).toContain("ORD-2026-0042")
      expect(body).toContain("2 × Margherita")
      expect(body).toContain("1 × Tiramisu")
      // A pickup order says where the food is, not "Adresse de livraison" over
      // an address the diner never gave. The heading is upper-cased in the
      // plain-text part and title case in the HTML, hence the loose match.
      expect(body).toMatch(/à récupérer sur place/i)
      expect(body).toContain("1 rue de la Paix, 75002 Paris")
      expect(body).not.toMatch(/livraison/i)
    }
    // The live order page, composed from `SITE_URL` and the order's own token.
    // Both halves are percent-encoded: real Convex ids are URL-safe so it is a
    // no-op in production, but the id must not be able to carry a `?` or a `#`
    // into the query string.
    expect(mail.Content.Simple.Body.Html.Data).toContain(
      `${SITE_URL}/order/${encodeURIComponent(orderId)}?token=camille-view-token`
    )
  })
})

/**
 * The timing row, which had never printed for any order.
 *
 * These go through `api.orders.create` rather than `seedOrder`, and that is the
 * whole point: every other test in this file inserts an order document
 * directly, so they exercise the RENDERER and can say nothing about whether an
 * order the checkout builds carries the field the renderer reads.
 * `packages/core`'s unit tests had the same shape — they call `timingLine`
 * with an `estimatedPrepTime` they supply themselves — and all of them were
 * green while `orders.create` wrote the computed prep time onto the kitchen
 * ticket and not onto the order, so « Prête dans environ … » was never once
 * sent to a diner (#413).
 */
describe("what the confirmation says about timing", () => {
  /** A dish with a preparation time, in its own category. */
  async function seedDish(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    dish: { name: string; price: number; preparationTime?: number }
  ) {
    return t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        storeId,
        name: "Pizzas",
        slug: `pizzas-${dish.name.toLowerCase()}`,
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      return ctx.db.insert("products", {
        storeId,
        categoryId,
        name: dish.name,
        slug: dish.name.toLowerCase(),
        price: dish.price,
        taxRate: 10,
        preparationTime: dish.preparationTime,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        source: "manual",
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
  }

  /** The checkout mutation, with one line per dish. */
  function checkout(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    lines: Array<{ productId: Id<"products">; name: string; price: number }>
  ) {
    return t.mutation(api.orders.create, {
      storeId,
      customerInfo: { name: "Camille", email: "camille@example.com" },
      items: lines.map((line) => ({
        productId: line.productId,
        productName: line.name,
        quantity: 1,
        unitPrice: line.price,
        selectedOptions: [],
        subtotal: line.price,
      })),
      type: "pickup" as const,
    })
  }

  test("tells the diner how long their food will take", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedDish(t, storeId, {
      name: "Margherita",
      price: 1_200,
      preparationTime: 15,
    })

    const orderId = (await checkout(t, storeId, [
      { productId, name: "Margherita", price: 1_200 },
    ])) as Id<"orders">

    await settleAndDeliver(t, () => payByCard(t, orderId))

    for (const body of bodies(onlyEmail())) {
      expect(body).toContain("Prête dans environ 15 minutes")
    }
  })

  test("quotes the longest dish, because a kitchen cooks in parallel", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const quick = await seedDish(t, storeId, {
      name: "Tiramisu",
      price: 490,
      preparationTime: 5,
    })
    const slow = await seedDish(t, storeId, {
      name: "Margherita",
      price: 1_200,
      preparationTime: 20,
    })

    const orderId = (await checkout(t, storeId, [
      { productId: quick, name: "Tiramisu", price: 490 },
      { productId: slow, name: "Margherita", price: 1_200 },
    ])) as Id<"orders">

    await settleAndDeliver(t, () => payByCard(t, orderId))

    for (const body of bodies(onlyEmail())) {
      // 20, not 25: the same rule `summariseOrderLines` applies to a slip.
      expect(body).toContain("Prête dans environ 20 minutes")
      expect(body).not.toContain("25 minutes")
    }
  })

  test("stores the figure on the order, not only on the kitchen ticket", async () => {
    // The seam itself. The ticket is a different document, created later and
    // per station, and it is where the prep time used to go and stop.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedDish(t, storeId, {
      name: "Margherita",
      price: 1_200,
      preparationTime: 15,
    })

    const orderId = (await checkout(t, storeId, [
      { productId, name: "Margherita", price: 1_200 },
    ])) as Id<"orders">

    const order = await t.run((ctx) => ctx.db.get(orderId as Id<"orders">))
    expect(order?.estimatedPrepTime).toBe(15)
  })

  test("says nothing at all when no dish declares a preparation time", async () => {
    // No row is honest; « Prête dans environ 0 minutes » is not.
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedDish(t, storeId, {
      name: "Margherita",
      price: 1_200,
    })

    const orderId = (await checkout(t, storeId, [
      { productId, name: "Margherita", price: 1_200 },
    ])) as Id<"orders">

    await settleAndDeliver(t, () => payByCard(t, orderId))

    for (const body of bodies(onlyEmail())) {
      expect(body).not.toMatch(/Prête dans environ/i)
    }
  })
})

describe("who the confirmation comes from", () => {
  test("the establishment's own address when it has configured one", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    await seedEmailConfig(t, storeId)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    const mail = onlyEmail()
    // The establishment's verified identity, under its own name — never the
    // deployment default, which on a client account is a domain SES has never
    // heard of.
    expect(mail.FromEmailAddress).toBe("Chez Luigi <commandes@luigi.example>")
    expect(mail.FromEmailAddress).not.toContain(DEPLOYMENT_SENDER)
    expect(mail.ReplyToAddresses).toEqual(["contact@luigi.example"])
  })

  test("the deployment's sender when it has not", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await settleAndDeliver(t, () => payByCard(t, orderId))

    const mail = onlyEmail()
    expect(mail.FromEmailAddress).toContain(DEPLOYMENT_SENDER)
    // Still signed by the restaurant: a confirmation that does not say who it
    // is from is spam.
    expect(mail.FromEmailAddress).toBe(`Chez Luigi <${DEPLOYMENT_SENDER}>`)
    expect(mail.ReplyToAddresses).toBeUndefined()
  })
})
