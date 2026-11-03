// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A diner asks to be forgotten, and is (RGPD art. 15, 17, 20).
 *
 * WHAT THIS GUARDS: before `convex/privacy.ts` there was no per-subject delete
 * at any layer of this product — not a mutation, not a screen, not a route.
 * The only way to erase one diner was to delete the whole establishment.
 *
 * The last test in this file is the one that matters. It does not check a list
 * of tables somebody remembered to write down: it reads EVERY table in the
 * schema and looks for the diner's address, phone number and street anywhere
 * in any document. A hand-written list of places to check is exactly how an
 * erasure path misses the copy nobody thought about — this order alone writes
 * the same address into four other tables.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_760_000_000_000
const EMAIL = "marie.dupont@example.fr"
/** The same address, as the storefront actually stored it: unfolded. */
const EMAIL_AS_TYPED = "Marie.Dupont@Example.FR"
const PHONE = "+33612345678"
const STREET = "8 rue de Charonne"
const FINGERPRINT = "fp-9f3c2a"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
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
})

/**
 * One diner, spread across the deployment exactly as the product spreads them.
 *
 * The address is written UNFOLDED into `orders` and `gamePlays` — which is what
 * the storefront does — and folded into `emailSubscribers` and
 * `promotionUsages`, which is what those write paths do. An erasure that seeks
 * an index instead of comparing folded finds one pair and misses the other.
 */
async function seedDiner(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
      address: {
        street: "12 rue Oberkampf",
        city: "Paris",
        postalCode: "75011",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })

    await ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })

    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-0001",
      customerId: "auth|marie",
      customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED, phone: PHONE },
      type: "delivery" as const,
      status: "completed" as const,
      items: [
        {
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1200,
          selectedOptions: [],
          subtotal: 1200,
          notes: "allergique aux fruits de mer",
        },
      ],
      subtotal: 1200,
      taxAmount: 120,
      total: 1320,
      deliveryAddress: {
        street: STREET,
        city: "Paris",
        postalCode: "75011",
        country: "France",
        instructions: "code porte 1234B",
      },
      paymentStatus: "paid" as const,
      source: "website" as const,
      notes: "sonner chez la voisine",
      viewToken: "tok-marie",
      uberDirectEstimateId: "est-42",
      uberDirectTrackingUrl: "https://uber.example/track/marie",
      createdAt: NOW,
      updatedAt: NOW,
    })

    await ctx.db.insert("kitchenTickets", {
      storeId,
      orderId,
      orderNumber: "ORD-2026-0001",
      items: [{ productName: "Margherita", quantity: 1, options: [], notes: "sans olives" }],
      status: "completed" as const,
      priority: "normal" as const,
      source: "website" as const,
      orderType: "delivery" as const,
      printStatus: "printed" as const,
      printAttempts: 1,
      customerName: "Marie Dupont",
      customerPhone: PHONE,
      deliveryNotes: STREET,
      allergens: ["fruits de mer"],
      trackingToken: "trk-marie",
      createdAt: NOW,
      updatedAt: NOW,
    })

    await ctx.db.insert("payments", {
      orderId,
      storeId,
      amount: 1320,
      currency: "EUR",
      provider: "stripe" as const,
      status: "succeeded" as const,
      externalId: "pi_marie",
      metadata: {
        last4: "4242",
        brand: "visa",
        receiptUrl: `https://stripe.example/receipt?email=${EMAIL}`,
      },
      refundReason: "Marie Dupont s'est plainte du délai",
      createdAt: NOW,
      updatedAt: NOW,
    })

    await ctx.db.insert("deliveryQuotes", {
      estimateId: "est-42",
      storeId,
      fee: 300,
      currency: "EUR",
      dropoffLatitude: 48.8542,
      dropoffLongitude: 2.3766,
      expiresAt: NOW + 600_000,
      consumedByOrderId: orderId,
      createdAt: NOW,
    })

    const promotionId = await ctx.db.insert("promotions", {
      storeId,
      name: "Bienvenue",
      triggerMode: "coupon" as const,
      discountType: "percentage" as const,
      scope: "order" as const,
      startDate: NOW,
      endDate: NOW + 30 * 86_400_000,
      usageCount: 1,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("promotionUsages", {
      storeId,
      promotionId,
      customerEmail: EMAIL,
      orderId,
      usedAt: NOW,
    })

    await ctx.db.insert("contactMessages", {
      storeId,
      name: "Marie Dupont",
      email: EMAIL,
      phone: PHONE,
      subject: "Une question",
      message: "Bonjour, je suis au 8 rue de Charonne",
      status: "new" as const,
      createdAt: NOW,
    })

    const subscriberId = await ctx.db.insert("emailSubscribers", {
      storeId,
      email: EMAIL,
      firstName: "Marie",
      lastName: "Dupont",
      status: "active" as const,
      source: "order" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "commande",
      bounceCount: 0,
      metadata: {
        totalOrders: 1,
        totalSpent: 1320,
        averageOrderValue: 1320,
        favoriteProducts: [],
        orderTypes: ["delivery"],
        city: "Paris",
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("emailEvents", {
      storeId,
      subscriberId,
      type: "opened" as const,
      occurredAt: NOW,
      metadata: { userAgent: "Mozilla/5.0" },
    })

    const gameId = await ctx.db.insert("games", {
      storeId,
      type: "wheel" as const,
      name: "Roue",
      winRatio: 100,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const prizeId = await ctx.db.insert("prizes", {
      storeId,
      name: "Pizza offerte",
      type: "free_product" as const,
      validityDays: 7,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const playId = await ctx.db.insert("gamePlays", {
      storeId,
      gameId,
      playerEmail: EMAIL_AS_TYPED,
      playerName: "Marie Dupont",
      playerPhone: PHONE,
      fingerprint: FINGERPRINT,
      consent: { acceptedAt: NOW, noticeVersion: "fr-2026-09" },
      completedActions: [],
      didWin: true,
      prizeId,
      userAgent: "Mozilla/5.0",
      playedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("prizeRedemptions", {
      storeId,
      gamePlayId: playId,
      prizeId,
      playerEmail: EMAIL_AS_TYPED,
      playerName: "Marie Dupont",
      redemptionCode: "ABCD2345",
      status: "pending" as const,
      expiresAt: NOW + 7 * 86_400_000,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("gameReferrals", {
      storeId,
      code: "REF-MARIE",
      referrerFingerprint: FINGERPRINT,
      conversions: 0,
      pendingBonuses: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })

    // The copy that looks like infrastructure and is the one most often missed.
    await ctx.db.insert("rateLimits", {
      key: `contactPerEmail:${EMAIL}`,
      windowStart: NOW,
      count: 1,
    })

    await ctx.db.insert("customerAddresses", {
      userId: "auth|marie",
      street: STREET,
      city: "Paris",
      postalCode: "75011",
      country: "France",
      isDefault: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const productId = await ctx.db.insert("products", {
      storeId,
      categoryId: await ctx.db.insert("categories", {
        storeId,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      name: "Margherita",
      slug: "margherita",
      price: 1200,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ctx.db.insert("favorites", {
      userId: "auth|marie",
      productId,
      storeId,
      createdAt: NOW,
    })
    await ctx.db.insert("userProfiles", {
      userId: "auth|marie",
      role: "customer" as const,
      storeIds: [],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      phones: [{ label: "mobile", number: PHONE }],
      createdAt: NOW,
      updatedAt: NOW,
    })

    /*
     * THE CUSTOMER BOOK ROW (#481, seeded here since #532).
     *
     * `customers` is on the erasure set and nothing in this file created one,
     * so removing it from `DINER_TABLES` left every case green — the
     * adversarial sweep included, because a needle that is never planted is
     * never found. That is the shape of a guard that guards nothing.
     *
     * It is the row that matters most to art. 17 after the order itself: the
     * establishment's own address book, keyed on the lower-cased e-mail, and an
     * erasure that reached the orders and left this behind would leave the
     * person in the book they asked to be removed from.
     */
    await ctx.db.insert("customers", {
      storeId,
      email: EMAIL,
      name: "Marie Dupont",
      phone: PHONE,
      totalOrders: 1,
      totalSpent: 1320,
      averageOrderValue: 1320,
      firstOrderAt: NOW,
      lastOrderAt: NOW,
      orderTypes: ["delivery"],
      favoriteProducts: [],
      createdAt: NOW,
      updatedAt: NOW,
    })

    return { storeId, orderId, playId }
  })
}

/** An owner who may answer a data-subject request. */
async function seedOwner(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner" })
}

/** Run the erasure to completion, passes and all. */
async function eraseFully(
  t: ReturnType<typeof convexTest>,
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  subject: { email?: string; fingerprint?: string }
) {
  let result = await owner.mutation(api.privacy.eraseDataSubject, subject)
  let guard = 0
  while (!result.complete) {
    if (guard++ > 50) throw new Error("erasure never completed")
    result = await t.mutation(internal.privacy.continueErasure, {
      ...subject,
      storeIds: result.storeIds as Id<"stores">[],
      everyStore: result.everyStore,
      actor: result.actor,
      state: result.state,
    })
  }
  return result
}

describe("erasing one diner", () => {
  test("keeps the accounting record and takes the person out of it", async () => {
    const t = newHarness()
    const { storeId, orderId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const result = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    // Kept: it is the establishment's pièce justificative.
    expect(order).not.toBeNull()
    expect(order?.orderNumber).toBe("ORD-2026-0001")
    expect(order?.total).toBe(1320)
    expect(order?.taxAmount).toBe(120)
    expect(order?.items[0]?.productName).toBe("Margherita")
    expect(order?.anonymisedAt).toBeGreaterThan(0)
    // Gone: everything that names, reaches or locates her.
    expect(order?.customerInfo.email).toBeUndefined()
    expect(order?.customerInfo.phone).toBeUndefined()
    expect(order?.customerInfo.name).toBe("Client anonymisé")
    expect(order?.deliveryAddress).toBeUndefined()
    expect(order?.notes).toBeUndefined()
    expect(order?.items[0]?.notes).toBeUndefined()
    expect(order?.customerId).toBeUndefined()
    // The live pointers, which are not identifiers but resolve to them.
    expect(order?.viewToken).toBeUndefined()
    expect(order?.uberDirectTrackingUrl).toBeUndefined()
  })

  test("matches an address however it was capitalised", async () => {
    // `orders` stores what the diner typed and `emailSubscribers` folds on
    // write, so the same person is « Marie.Dupont@Example.FR » in one table and
    // « marie.dupont@example.fr » in the other. An index seek finds one pair.
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    await eraseFully(t, owner, { email: "MARIE.DUPONT@EXAMPLE.FR" })

    const { orders, subscribers } = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").collect(),
      subscribers: await ctx.db.query("emailSubscribers").collect(),
    }))
    expect(orders[0]?.customerInfo.email).toBeUndefined()
    expect(subscribers).toHaveLength(0)
  })

  test("takes the rows that only exist because of the order", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    await eraseFully(t, owner, { email: EMAIL })

    const left = await t.run(async (ctx) => ({
      tickets: await ctx.db.query("kitchenTickets").collect(),
      quotes: await ctx.db.query("deliveryQuotes").collect(),
      usages: await ctx.db.query("promotionUsages").collect(),
      messages: await ctx.db.query("contactMessages").collect(),
      events: await ctx.db.query("emailEvents").collect(),
      limits: await ctx.db.query("rateLimits").collect(),
      addresses: await ctx.db.query("customerAddresses").collect(),
      favorites: await ctx.db.query("favorites").collect(),
      payments: await ctx.db.query("payments").collect(),
      profiles: await ctx.db.query("userProfiles").collect(),
      customers: await ctx.db.query("customers").collect(),
    }))

    expect(left.tickets, "a kitchen ticket copies the name, phone and allergens").toHaveLength(0)
    expect(left.quotes, "a delivery quote holds the coordinates of her door").toHaveLength(0)
    expect(left.usages).toHaveLength(0)
    expect(left.messages).toHaveLength(0)
    expect(left.events, "an email event points at a subscriber that must not survive it").toHaveLength(0)
    expect(left.limits, "the limiter key IS the address").toHaveLength(0)
    expect(left.addresses).toHaveLength(0)
    expect(left.favorites).toHaveLength(0)
    expect(
      left.customers,
      "the establishment's own address book still holds the person who asked to leave it"
    ).toHaveLength(0)

    // The payment stays — it is the proof the money moved — with the live
    // pointer to the provider's copy of her address taken out of it.
    expect(left.payments).toHaveLength(1)
    expect(left.payments[0]?.amount).toBe(1320)
    expect(left.payments[0]?.metadata?.receiptUrl).toBeUndefined()
    expect(left.payments[0]?.refundReason).toBeUndefined()

    // Her account row stays, emptied. Deleting it would lock the surviving
    // login into "no profile" for ever.
    const diner = left.profiles.find((p) => p.userId === "auth|marie")
    expect(diner).toBeDefined()
    expect(diner?.phones).toEqual([])
  })

  test("takes the game play and its prize together, in the right order", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    await eraseFully(t, owner, { email: EMAIL })

    const left = await t.run(async (ctx) => ({
      plays: await ctx.db.query("gamePlays").collect(),
      redemptions: await ctx.db.query("prizeRedemptions").collect(),
    }))
    expect(left.plays).toHaveLength(0)
    // `prizeRedemptions.gamePlayId` is a non-optional id: a redemption
    // surviving its play is a document whose schema promises one and whose
    // readers get null.
    expect(left.redemptions).toHaveLength(0)
  })

  test("reaches an anonymous player by their device alone", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    await eraseFully(t, owner, { fingerprint: FINGERPRINT })

    const left = await t.run(async (ctx) => ({
      plays: await ctx.db.query("gamePlays").collect(),
      referrals: await ctx.db.query("gameReferrals").collect(),
      orders: await ctx.db.query("orders").collect(),
    }))
    expect(left.plays).toHaveLength(0)
    expect(left.referrals, "a referral row IS a fingerprint").toHaveLength(0)
    // An order records no fingerprint, so this request cannot reach it — and
    // the report has to say so rather than implying the diner is gone.
    expect(left.orders[0]?.customerInfo.email).toBe(EMAIL_AS_TYPED)
  })

  test("says what it kept, and why, in words the operator can quote", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const result = await eraseFully(t, owner, { email: EMAIL })

    const tables = result.report.retained.map((r) => r.table)
    // The things a report that only counted deletions would let an operator
    // promise away.
    expect(tables).toContain("externalProcessors")
    expect(tables).toContain("betterAuth")
    expect(tables).toContain("platformWebhookFailures")
    expect(tables).toContain("emailSegments")
    /* `cmsHome` USED TO BE HERE, and the note was printed on every run (#434.7).
       It asked the operator to check the homepage testimonials by hand — for a
       table with no reader and no writer anywhere in the product, so there are
       none to check and never can be. A note nobody can act on makes every
       erasure read as incomplete and teaches an operator to skip the ones that
       are real, which is the three above. */
    expect(tables).not.toContain("cmsHome")
    for (const note of result.report.retained) {
      expect(note.reason.length).toBeGreaterThan(20)
    }
    expect(result.report.storeIds).toEqual([storeId])
    // True because she administers every establishment the deployment has —
    // one. `everyStore` is a statement about reach, not about the role, and it
    // is what unlocks the steps that cannot be scoped to a store at all.
    expect(result.report.everyStore).toBe(true)
  })

  test("names the processors that are still holding their own copy", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const result = await eraseFully(t, owner, { email: EMAIL })

    // The one step the runbook calls outstanding on EVERY request, and the one
    // the report used to be silent about. Stripe, SumUp, PayPal, Uber Direct,
    // Uber Eats and Deliveroo each keep what was sent to them and none of them
    // is reachable from this deployment; an operator reading only this screen
    // would answer « tout a été effacé » and be wrong.
    const note = result.report.retained.find((r) => r.table === "externalProcessors")
    expect(note, "no note names the external processors").toBeDefined()
    for (const provider of [
      "Stripe",
      "SumUp",
      "PayPal",
      "Uber Direct",
      "Uber Eats",
      "Deliveroo",
    ]) {
      expect(note?.reason, `the note does not name ${provider}`).toContain(provider)
    }
    // Square is a `payments.provider` schema literal that nothing writes and
    // `routeRefund` refuses by name. Naming it would send an operator to a
    // console they do not have, which is the `cmsHome` failure above wearing a
    // different hat.
    expect(note?.reason).not.toContain("Square")
  })

  test("leaves a trail that the request was answered", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    await eraseFully(t, owner, { email: EMAIL })

    const log = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    const entries = log.filter((row) => row.action === "privacy_erasure")
    expect(entries.length).toBeGreaterThan(0)
    // The address is kept HERE on purpose: this row is the establishment's
    // proof the request was honoured, and it has to be findable when the
    // person — or the CNIL — asks whether it was.
    expect(entries.some((row) => row.details?.includes(EMAIL))).toBe(true)
  })

  test("refuses a request from a role that may not answer one", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "serveur",
        role: "waiter" as const,
        storeIds: [storeId],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const waiter = t.withIdentity({ subject: "serveur" })

    // A waiter holds `customers:read` — they can see a diner. Answering a
    // data-subject request is a different act and needs `customers:manage`.
    await expect(
      waiter.mutation(api.privacy.eraseDataSubject, { email: EMAIL })
    ).rejects.toThrow()
    await expect(
      waiter.query(api.privacy.exportDataSubject, { email: EMAIL })
    ).rejects.toThrow()
  })

  test("refuses a request that names nobody", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    // Without this, an empty subject matches every row with no address and
    // erases the whole establishment.
    await expect(owner.mutation(api.privacy.eraseDataSubject, {})).rejects.toThrow(
      /PRIVACY_SUBJECT_REQUIRED/
    )
  })
})

/**
 * Every document in every table, searched for the diner.
 *
 * `systemAuditLog` is skipped: it keeps the address on purpose, as the proof
 * the request was answered.
 */
async function survivorsOf(
  t: ReturnType<typeof convexTest>,
  needles: string[]
): Promise<string[]> {
  const tableNames = Object.keys(
    (schema as unknown as { tables: Record<string, unknown> }).tables
  )
  // A silent zero here would make the whole sweep pass by looking at nothing.
  expect(tableNames.length).toBeGreaterThan(50)

  const survivors: string[] = []
  await t.run(async (ctx) => {
    for (const table of tableNames) {
      if (table === "systemAuditLog") continue
      const rows = await ctx.db.query(table as "orders").collect()
      for (const row of rows) {
        const serialised = JSON.stringify(row)
        for (const needle of needles) {
          if (serialised.includes(needle)) {
            survivors.push(`${table}.${String(row._id)} holds "${needle}"`)
          }
        }
      }
    }
  })
  return survivors
}

describe("the adversarial sweep", () => {
  test("no document in any table still holds the erased diner", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const needles = [EMAIL, EMAIL_AS_TYPED, PHONE, STREET, FINGERPRINT, "Marie Dupont"]

    // FIRST, PROVE THE SWEEP CAN FAIL. A search that finds nothing after the
    // erasure means nothing unless it found something before it — this is the
    // check that stops a broken query, a renamed table or a typo'd needle from
    // rendering the whole suite decorative.
    const before = await survivorsOf(t, needles)
    expect(before.length, "the seeded diner should be all over the database").toBeGreaterThan(10)

    await eraseFully(t, owner, { email: EMAIL, fingerprint: FINGERPRINT })

    expect(await survivorsOf(t, needles)).toEqual([])
  })

  test("the export offers exactly what the erasure would take", async () => {
    // Art. 20 and art. 17 have to agree: an export that shows less than the
    // erasure destroys is a person consenting to lose something they were
    // never shown. Both walks are the same code in different modes, and this
    // is the assertion that keeps them that way.
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const bundle = await owner.query(api.privacy.exportDataSubject, {
      email: EMAIL,
      fingerprint: FINGERPRINT,
    })
    const offered = new Set(bundle.records.map((r) => r.table))
    expect(bundle.complete).toBe(true)
    expect(offered.size).toBeGreaterThan(8)

    const result = await eraseFully(t, owner, { email: EMAIL, fingerprint: FINGERPRINT })
    const touched = new Set(
      result.report.tallies.filter((tl) => tl.deleted + tl.anonymised > 0).map((tl) => tl.table)
    )

    const takenButNeverOffered = [...touched].filter((table) => !offered.has(table))
    expect(takenButNeverOffered).toEqual([])
  })

  test("the export hands back the diner's own data, not a summary of it", async () => {
    const t = newHarness()
    const { storeId } = await seedDiner(t)
    const owner = await seedOwner(t, storeId)

    const bundle = await owner.query(api.privacy.exportDataSubject, { email: EMAIL })
    const orders = bundle.records.find((r) => r.table === "orders")?.rows ?? []
    expect(orders).toHaveLength(1)
    const serialised = JSON.stringify(orders[0])
    expect(serialised).toContain(STREET)
    expect(serialised).toContain(PHONE)
    // Reading is not erasing: the export must leave the row exactly as it was.
    const stored = await t.run((ctx) => ctx.db.query("orders").first())
    expect(stored?.customerInfo.email).toBe(EMAIL_AS_TYPED)
  })
})
