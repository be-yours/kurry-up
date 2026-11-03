// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * One order, at most one payable Stripe session — and a refusal the diner can
 * read.
 *
 * THE BUG (#411, B2-F1). `createCheckoutSession` overwrote the order's stored
 * session id and told Stripe nothing about the old one, which stays payable
 * for about twenty-four hours. A diner who opened checkout twice — a stale
 * tab, a back-navigation, a retry — therefore left TWO live sessions against
 * one order, and both could be completed. Both referenced the same order at
 * the same total in the same currency, and both were `card`, so no check on
 * the settlement side could separate them: a 1 200 € order collected 2 400 €.
 *
 * `payments.settlePayment` now refuses the second row, which keeps the ledger
 * honest. It does not make the diner whole — the money has already left their
 * account, and somebody has to give it back. These cases are the other half:
 * the second charge is never TAKEN.
 *
 * Two mechanisms, and both are needed. Expiring the previous session closes
 * the window on an order still waiting to be paid; refusing to open a checkout
 * on an order already collected closes it on one that has been. `orders.create`
 * is idempotent on the diner's key, so a resubmit lands on the SAME order —
 * which is what makes the second case reachable at all.
 *
 * THE OTHER DEFECT HERE (#411, B2-F8). A key Stripe rejects is well-formed, so
 * `paymentAvailability`'s `startsWith("sk_")` armed the card tile, and the
 * `StripeAuthenticationError` thrown by `sessions.create` is a plain `Error`
 * that Convex redacts to "Server Error" — the exact screen #374 was written to
 * remove, on the exact tile it was written to stop pre-selecting. The refusal
 * is now legible, and the verdict is recorded so the tile goes down for
 * everyone behind that diner.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
/** 1 200 € in cents — the order from the issue. */
const CHARGE = 120_000

/** What our fake Stripe was asked to do, and what it should answer. */
const stripeFake = vi.hoisted(() => ({
  /** Every `checkout.sessions.create`, in order. */
  created: [] as Array<Record<string, unknown>>,
  /** Every session id `checkout.sessions.expire` was called with. */
  expired: [] as string[],
  /**
   * The sessions this fake has handed out, by id, as `retrieve` will report
   * them. `createCheckoutSession` reads the previous session before expiring
   * it — that read is what tells `already_paid` from `already expired`, which
   * Stripe reports with the same error.
   */
  sessions: new Map<string, { id: string; status: string; payment_status: string }>(),
  /** When set, `sessions.create` throws a Stripe error of this `type`. */
  createErrorType: null as string | null,
  /** When set, `sessions.retrieve` throws — a Stripe read failure. */
  retrieveFails: false,
  /** How many times the hourly probe asked Stripe anything. */
  balanceReads: 0,
  /** When set, `balance.retrieve` throws a Stripe error of this `type`. */
  balanceErrorType: null as string | null,
}))

vi.mock("stripe", () => {
  class FakeStripe {
    static createFetchHttpClient() {
      return {}
    }
    checkout = {
      sessions: {
        retrieve: async (id: string) => {
          if (stripeFake.retrieveFails) throw new Error("Stripe unreachable")
          const session = stripeFake.sessions.get(id)
          if (!session) throw new Error(`No such checkout.session: ${id}`)
          return session
        },
        create: async (params: Record<string, unknown>) => {
          if (stripeFake.createErrorType) {
            // Shaped like the SDK's own errors, which carry `type`.
            const err = new Error("Invalid API Key provided") as Error & {
              type?: string
            }
            err.type = stripeFake.createErrorType
            throw err
          }
          stripeFake.created.push(params)
          const id = `cs_test_${stripeFake.created.length}`
          stripeFake.sessions.set(id, {
            id,
            status: "open",
            payment_status: "unpaid",
          })
          return { id, url: `https://checkout.stripe.test/${id}` }
        },
        expire: async (id: string) => {
          stripeFake.expired.push(id)
          const session = stripeFake.sessions.get(id)
          if (session) session.status = "expired"
          return { id, status: "expired" }
        },
      },
    }
    balance = {
      retrieve: async () => {
        stripeFake.balanceReads += 1
        if (stripeFake.balanceErrorType) {
          const err = new Error("Invalid API Key provided") as Error & {
            type?: string
          }
          err.type = stripeFake.balanceErrorType
          throw err
        }
        return { object: "balance", available: [] }
      },
    }
  }
  return { default: FakeStripe }
})

const savedKey = { value: undefined as string | undefined }

beforeAll(() => {
  // `getSiteEnv()` caches on first parse, so the key is set once for the file
  // rather than per case. Every case here uses the same key, and it is
  // WELL-FORMED — it passes `startsWith("sk_")`, which is the whole point of
  // B2-F8: passing the shape check proves nothing about whether Stripe will
  // accept it.
  //
  // Kept short and dull on purpose. A more "realistic" literal is a finding
  // for the secret scan (rule `stripe-access-token`) for no added coverage —
  // `apps/site/tests/convex/planAvailability.test.ts` says the same thing, and
  // `sk_test_fake` is the fixture the rest of the repository already uses.
  savedKey.value = process.env.STRIPE_SECRET_KEY
  process.env.STRIPE_SECRET_KEY = "sk_test_fake"
  return () => {
    if (savedKey.value === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = savedKey.value
  }
})

beforeEach(() => {
  stripeFake.created.length = 0
  stripeFake.expired.length = 0
  stripeFake.sessions.clear()
  stripeFake.createErrorType = null
  stripeFake.retrieveFails = false
  stripeFake.balanceReads = 0
  stripeFake.balanceErrorType = null
})

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  // Same block as the other convex suites: catalogue and payment paths queue
  // scheduled work, and a job cancelled mid-run arrives as an unhandled
  // rejection that turns a green run red on whichever file is executing.
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Probe",
      slug: "chez-probe",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedCardOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  orderNumber: string
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber,
      customerInfo: { name: "Camille" },
      items: [],
      type: "pickup" as const,
      status: "pending" as const,
      subtotal: CHARGE,
      taxAmount: 0,
      total: CHARGE,
      paymentStatus: "pending" as const,
      paymentMethod: "card",
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

function openCheckout(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
  return t.action(api.stripe.createCheckoutSession, {
    orderId,
    successUrl: "https://chez-probe.fr/checkout/success",
    cancelUrl: "https://chez-probe.fr/checkout",
  })
}

describe("a second checkout on the same order", () => {
  test("expires the session the first one left payable", async () => {
    // THE BUG, replayed. Before this, `stripeFake.expired` was empty and two
    // sessions stood against one order, either of which could be completed.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-C1")

    const first = await openCheckout(t, orderId)
    expect(stripeFake.expired).toEqual([])

    const second = await openCheckout(t, orderId)

    expect(stripeFake.expired).toEqual([first.sessionId])
    expect(second.sessionId).not.toBe(first.sessionId)
    // And the order points at the live one, which is what the reconciliation
    // sweep will ask Stripe about.
    expect(
      (await t.run((ctx) => ctx.db.get(orderId)))?.stripeCheckoutSessionId
    ).toBe(second.sessionId)
  })

  test("expires it BEFORE the replacement is payable", async () => {
    // Ordering is the whole point: scheduling the expiry would leave a window
    // in which both sessions are live, which is the window being closed.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-C2")

    const first = await openCheckout(t, orderId)
    stripeFake.created.length = 0
    stripeFake.expired.length = 0

    await openCheckout(t, orderId)

    expect(stripeFake.expired).toEqual([first.sessionId])
    expect(stripeFake.created).toHaveLength(1)
  })

  test("expires nothing on a first checkout", async () => {
    // A rule satisfied by expiring everything would break the ordinary path.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-C3")

    await openCheckout(t, orderId)

    expect(stripeFake.expired).toEqual([])
    expect(stripeFake.created).toHaveLength(1)
  })

  test("refuses a replacement when the previous session has been PAID", async () => {
    // The window nothing could see. The diner completed the first session and
    // its settlement has not reached us — the webhook is in flight, or they
    // closed the tab before the return page — so the order still reads
    // `pending` and every status gate waves it through. Stripe refuses to
    // expire a completed session and reports that with the same error as an
    // already-expired one, so the outcome had to be READ rather than ignored.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-C4")

    const first = await openCheckout(t, orderId)
    const session = stripeFake.sessions.get(first.sessionId)!
    session.status = "complete"
    session.payment_status = "paid"

    await expect(openCheckout(t, orderId)).rejects.toThrow(/déjà été réglée/)
    expect(stripeFake.created).toHaveLength(1)
  })

  test("does not refuse over a session that merely expired", async () => {
    // The other half: an expired session is the outcome we wanted, and
    // treating it like a completed one would block every legitimate retry.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-C5")

    const first = await openCheckout(t, orderId)
    stripeFake.sessions.get(first.sessionId)!.status = "expired"

    await expect(openCheckout(t, orderId)).resolves.toBeDefined()
    expect(stripeFake.created).toHaveLength(2)
  })
})

describe("an order the ledger has collected but the status has not caught up with", () => {
  test("gets no second checkout", async () => {
    // A settlement writes the payment row and the order status in two
    // transactions. Between them the order reads `pending` with a `succeeded`
    // row already against it, and a gate that trusts the status alone sends
    // the diner to pay a second time in exactly the window where a payment is
    // being recorded.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-L1")

    await t.mutation(internal.payments.internalSettle, {
      storeId,
      orderId,
      amount: CHARGE,
      currency: "EUR",
      provider: "stripe" as const,
      externalId: "pi_landed",
    })
    // The status write has not happened.
    expect((await t.run((ctx) => ctx.db.get(orderId)))?.paymentStatus).toBe(
      "pending"
    )

    await expect(openCheckout(t, orderId)).rejects.toThrow(/déjà été réglée/)
    expect(stripeFake.created).toEqual([])
  })

  test("refuses a checkout on a REFUNDED order, as the cash button does", async () => {
    // One rule, one answer, whatever the tender. `orders.markCashPaid` has
    // refused a refunded order since it was written — a refunded order is
    // closed business — and the card path used to disagree.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-L2")
    await t.run((ctx) => ctx.db.patch(orderId, { paymentStatus: "refunded" }))

    await expect(openCheckout(t, orderId)).rejects.toThrow(/déjà été réglée/)
  })
})

describe("a checkout on an order that has already been collected", () => {
  /**
   * Every status in which money has been taken and the business is closed.
   *
   * `refunded` is on the list on purpose: `orders.markCashPaid` has refused a
   * refunded order since it was written, and the card path used to disagree.
   * One rule, one answer, whatever the tender.
   */
  const COLLECTED = [
    "paid",
    "refund_pending",
    "partially_refunded",
    "refunded",
  ] as const

  test.each(COLLECTED)(
    "is refused rather than charging the diner again (%s)",
    async (paymentStatus) => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedCardOrder(t, storeId, `A-411-D-${paymentStatus}`)
      await t.run((ctx) => ctx.db.patch(orderId, { paymentStatus }))

      await expect(openCheckout(t, orderId)).rejects.toThrow(
        /déjà été réglée/
      )
      expect(stripeFake.created).toEqual([])
    }
  )

  test("refuses with a sentence that survives the wire", async () => {
    // Convex redacts a thrown `Error` to "Server Error". Telling a diner to
    // retry a payment they have already made is the worst thing this screen
    // could say, so the refusal is a `ConvexError` carrying its own code.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-D2")
    await t.run((ctx) => ctx.db.patch(orderId, { paymentStatus: "paid" }))

    const error = await openCheckout(t, orderId).then(
      () => null,
      (e: unknown) => e as { data?: unknown }
    )
    const data =
      typeof error?.data === "string" ? JSON.parse(error.data) : error?.data
    expect(data).toMatchObject({ code: "order_already_paid" })
    expect(String((data as { message?: string }).message)).toContain(
      "déjà été réglée"
    )
  })

  test("still opens a checkout on an order nothing has collected", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-D3")

    await expect(openCheckout(t, orderId)).resolves.toMatchObject({
      sessionId: expect.stringContaining("cs_test_"),
    })
  })

  test("still opens one on an order whose previous attempt failed", async () => {
    // A retry after a declined card is a legitimate second session, and the
    // rule must not read it as a second collection.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-D4")
    await t.run((ctx) => ctx.db.patch(orderId, { paymentStatus: "failed" }))

    await expect(openCheckout(t, orderId)).resolves.toBeDefined()
  })
})

describe("a key Stripe refuses", () => {
  async function seedSettings(t: ReturnType<typeof convexTest>) {
    return t.run((ctx) =>
      ctx.db.insert("globalSettings", {
        currency: "EUR",
        timezone: "Europe/Paris",
        taxRate: 10,
        services: {
          dineIn: true,
          takeaway: true,
          delivery: false,
          clickAndCollect: true,
        },
        hours: [],
        delivery: {},
        payments: { cardProvider: "stripe" as const, paypal: false, cash: true },
        integrations: {},
        updatedAt: NOW,
      })
    )
  }

  test("reaches the diner as a sentence, not as « Server Error »", async () => {
    // THE BUG. `sessions.create` throws a plain `StripeAuthenticationError`;
    // Convex redacts a plain `Error` in production, so the diner met the
    // generic retry toast on the tile the checkout had pre-selected for them.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K1")
    stripeFake.createErrorType = "StripeAuthenticationError"

    const error = await openCheckout(t, orderId).then(
      () => null,
      (e: unknown) => e as { data?: unknown }
    )
    const data =
      typeof error?.data === "string" ? JSON.parse(error.data) : error?.data
    expect(data).toMatchObject({ code: "card_payment_unavailable" })
  })

  test("takes the card tile down for everyone behind that diner", async () => {
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K2")

    // A well-formed key arms the tile: that is all the shape check can see.
    expect(await t.query(api.paymentAvailability.get)).toEqual({
      card: true,
      cardOffered: true,
    })

    stripeFake.createErrorType = "StripeAuthenticationError"
    await expect(openCheckout(t, orderId)).rejects.toThrow()

    // The tile is greyed, not removed: this establishment does take cards, and
    // a key can be fixed.
    expect(await t.query(api.paymentAvailability.get)).toEqual({
      card: false,
      cardOffered: true,
    })
  })

  test("does not blame the key for a failure that is not about it", async () => {
    // A declined card, a rate limit or an outage say nothing about our
    // credentials, and disarming the tile over one would take card payments
    // away from a working establishment.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K3")

    stripeFake.createErrorType = "StripeAPIError"
    await expect(openCheckout(t, orderId)).rejects.toThrow(/Invalid API Key/)

    expect(await t.query(api.paymentAvailability.get)).toEqual({
      card: true,
      cardOffered: true,
    })
  })

  test("records that the key works when it does", async () => {
    // Written on every success, not only on a change: `checkedAt` is what
    // tells an operator how fresh the verdict is.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K4")

    await openCheckout(t, orderId)

    const verdicts = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").collect()
    )
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ provider: "stripe", usable: true })
  })

  test("records the verdict even when the owner has never saved Réglages", async () => {
    // The first shape of this fix hung the verdict on the `globalSettings`
    // document, which is written by exactly one thing: the owner pressing
    // Enregistrer. No seed, no migration and no bootstrap creates one — so on
    // a fresh deployment, which is precisely what #374 is about, there was
    // nothing to write the verdict onto and every diner discovered the broken
    // key in turn, for ever.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K6")
    // No `seedSettings` here, deliberately.
    stripeFake.createErrorType = "StripeAuthenticationError"

    await expect(openCheckout(t, orderId)).rejects.toThrow()

    const verdicts = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").collect()
    )
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ provider: "stripe", usable: false })
    expect((await t.query(api.paymentAvailability.get)).card).toBe(false)
  })

  test("does not rewrite the row when the verdict has not moved", async () => {
    // This row is read on the order path, and Convex conflicts a write with
    // every concurrent transaction that read the document. Rewriting it on
    // every successful checkout would make a busy service lose OCC rounds over
    // bookkeeping, so a verdict that says what the row already says writes
    // nothing.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K7")

    await openCheckout(t, orderId)
    const first = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").first()
    )

    await t.action(internal.stripe.verifyStripeKey, {})
    await t.action(internal.stripe.verifyStripeKey, {})

    const after = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").first()
    )
    expect(after?._id).toBe(first?._id)
    expect(after?.checkedAt).toBe(first?.checkedAt)
  })

  test("a later success re-arms the tile", async () => {
    // The verdict is a measurement, not a latch: a key put right must bring
    // the tile back without anyone clearing a flag by hand.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K5")

    stripeFake.createErrorType = "StripeAuthenticationError"
    await expect(openCheckout(t, orderId)).rejects.toThrow()
    expect((await t.query(api.paymentAvailability.get)).card).toBe(false)

    stripeFake.createErrorType = null
    await openCheckout(t, orderId)
    expect((await t.query(api.paymentAvailability.get)).card).toBe(true)
  })

  test("the hourly check asks Stripe on its own", async () => {
    // Left to the checkout alone, the first diner of the day is the one who
    // finds out. `verifyStripeKey` runs on the scheduler so the tile is
    // already down when the restaurant opens.
    const t = newHarness()
    await seedSettings(t)

    const answer = await t.action(internal.stripe.verifyStripeKey, {})
    expect(answer).toEqual({ checked: true, usable: true })
    expect(stripeFake.balanceReads).toBe(1)
  })

  test("the hourly check disarms the tile before any diner sees it", async () => {
    const t = newHarness()
    await seedSettings(t)
    stripeFake.balanceErrorType = "StripeAuthenticationError"

    expect((await t.query(api.paymentAvailability.get)).card).toBe(true)
    expect(await t.action(internal.stripe.verifyStripeKey, {})).toEqual({
      checked: true,
      usable: false,
    })
    expect((await t.query(api.paymentAvailability.get)).card).toBe(false)
  })

  test("the hourly check leaves the last verdict standing on an outage", async () => {
    // A Stripe outage is not a verdict about our key, and overwriting one with
    // a guess would take card payments away from a working establishment for
    // as long as the outage lasted.
    const t = newHarness()
    await seedSettings(t)

    await t.action(internal.stripe.verifyStripeKey, {})
    stripeFake.balanceErrorType = "StripeConnectionError"

    expect(await t.action(internal.stripe.verifyStripeKey, {})).toEqual({
      checked: false,
      usable: false,
    })
    const verdict = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").first()
    )
    expect(verdict?.usable).toBe(true)
    expect((await t.query(api.paymentAvailability.get)).card).toBe(true)
  })

  test("keeps the provider's own words out of the storefront's reach", async () => {
    // The verdict's `detail` is Stripe's refusal message, which names the
    // key's mode and its last four characters and sometimes the account id.
    // The first shape of this fix put it on `globalSettings`, whose `get` is
    // public and read by the checkout before any sign-in — so all of that was
    // served to anonymous visitors. Its own table has no public reader, and
    // `paymentAvailability.get` answers two booleans and nothing else.
    const t = newHarness()
    await seedSettings(t)
    const storeId = await seedStore(t)
    const orderId = await seedCardOrder(t, storeId, "A-411-K8")
    stripeFake.createErrorType = "StripeAuthenticationError"
    await expect(openCheckout(t, orderId)).rejects.toThrow()

    const verdict = await t.run((ctx) =>
      ctx.db.query("cardProviderHealth").first()
    )
    expect(verdict?.detail).toContain("Invalid API Key")

    expect(await t.query(api.paymentAvailability.get)).toEqual({
      card: false,
      cardOffered: true,
    })
    const publicSettings = await t.query(api.globalSettings.get, {})
    expect(JSON.stringify(publicSettings ?? {})).not.toContain("Invalid API Key")
  })
})
