// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Axis 1 (a surviving copy) and axis 5 (referential integrity).
 *
 * The shipped adversarial sweep seeds ONE diner and erases with
 * `{ email, fingerprint }` together. Everything here seeds a shape it does not,
 * and erases the way a real request arrives: an address, and nothing else.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_760_000_000_000
const EMAIL = "marie.dupont@example.fr"
const EMAIL_AS_TYPED = "Marie.Dupont@Example.FR"
const PHONE = "+33612345678"
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

async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      address: { street: "12 rue Oberkampf", city: "Paris", postalCode: "75011", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedOwner(t: ReturnType<typeof convexTest>, storeIds: Id<"stores">[]) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner",
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner" })
}

async function eraseFully(
  t: ReturnType<typeof convexTest>,
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  subject: { email?: string; fingerprint?: string }
) {
  let result = await owner.mutation(api.privacy.eraseDataSubject, subject)
  let guard = 0
  while (!result.complete) {
    if (guard++ > 200) throw new Error("erasure never completed")
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

describe("copies of an erased diner", () => {
  test("a referral row is reached by an e-mail request, through the device on her game play", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const owner = await seedOwner(t, [storeId])

    // She played, was given a referral code, and shared it. `gameReferrals`
    // keeps her name against her device.
    await t.run((ctx) =>
      ctx.db.insert("gameReferrals", {
        storeId,
        code: "REF-MARIE",
        referrerFingerprint: FINGERPRINT,
        referrerName: "Marie Dupont",
        conversions: 3,
        pendingBonuses: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    // The play is how the deployment knows the device is hers.
    const gameId = await t.run((ctx) =>
      ctx.db.insert("games", {
        storeId,
        type: "wheel" as const,
        name: "Roue",
        winRatio: 100,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("gamePlays", {
        storeId,
        gameId,
        playerEmail: EMAIL_AS_TYPED,
        playerName: "Marie Dupont",
        fingerprint: FINGERPRINT,
        consent: { acceptedAt: NOW, noticeVersion: "fr-2026-09" },
        completedActions: [],
        didWin: false,
        playedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    // A data-subject request arrives as an address. Nobody hands over a
    // browser fingerprint with their RGPD letter.
    const result = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const referrals = await t.run((ctx) => ctx.db.query("gameReferrals").collect())

    // The row is gone, reached through the device handle the walk picked up
    // off her game play — so there is nothing left to declare about it. The
    // contract is "delete it, or say plainly that you did not"; this is the
    // first half.
    expect({
      reportedComplete: result.complete,
      referralRowsLeft: referrals.map((r) => ({
        name: r.referrerName,
        fingerprint: r.referrerFingerprint,
      })),
      declaredKept: result.report.retained.map((r) => r.table),
    }).toEqual({
      reportedComplete: true,
      referralRowsLeft: [],
      declaredKept: expect.not.arrayContaining(["gameReferrals"]),
    })
  })

  test("a prize redemption whose game play is gone is still reached", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const owner = await seedOwner(t, [storeId])

    const { redemptionId } = await t.run(async (ctx) => {
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
        fingerprint: FINGERPRINT,
        consent: { acceptedAt: NOW, noticeVersion: "fr-2026-09" },
        completedActions: [],
        didWin: true,
        prizeId,
        playedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const redemptionId = await ctx.db.insert("prizeRedemptions", {
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
      // The play is gone — a partial cleanup, a restore, a hand-edit. The
      // redemption is now reachable by NOTHING the erasure walks: it is found
      // only through `by_gamePlayId`, and the play it names no longer exists.
      await ctx.db.delete(playId)
      return { redemptionId }
    })

    const result = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const left = await t.run((ctx) => ctx.db.get(redemptionId))
    expect(
      left,
      "prizeRedemptions has a by_playerEmail index the erasure never uses"
    ).toBeNull()
  })

  test("a CSV-imported subscriber stored with a stray space is still reached", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const owner = await seedOwner(t, [storeId])

    // Exactly what `emailSubscribers.importBatch` writes: `.toLowerCase()` and
    // no `.trim()`. The store's own CSV import is the writer.
    await owner.mutation(api.emailSubscribers.importBatch, {
      storeId,
      subscribers: [{ email: ` ${EMAIL_AS_TYPED} `, firstName: "Marie", lastName: "Dupont" }],
    })
    const stored = await t.run((ctx) => ctx.db.query("emailSubscribers").collect())
    expect(stored, "the import must actually have written a row").toHaveLength(1)

    const result = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const left = await t.run((ctx) => ctx.db.query("emailSubscribers").collect())
    expect(
      left,
      `her address is still on the mailing list as "${stored[0]?.email}"`
    ).toHaveLength(0)
  })

  test("an order at a second establishment, a guest order, and an odd capitalisation", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Napoli Oberkampf")
    const storeB = await seedStore(t, "Napoli Bastille")
    const owner = await seedOwner(t, [storeA, storeB])

    await t.run(async (ctx) => {
      for (const [i, storeId] of [storeA, storeB].entries()) {
        await ctx.db.insert("orders", {
          storeId,
          orderNumber: `ORD-${i}`,
          // One signed in, one as a guest.
          ...(i === 0 ? { customerId: "auth|marie" } : {}),
          customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED, phone: PHONE },
          type: "delivery" as const,
          status: "completed" as const,
          items: [],
          subtotal: 1200,
          taxAmount: 120,
          total: 1320,
          paymentStatus: "paid" as const,
          source: "website" as const,
          externalPlatformData: { customer: { name: "Marie Dupont", phone: PHONE } },
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
      await ctx.db.insert("contactMessages", {
        storeId: storeB,
        name: "Marie Dupont",
        email: "MARIE.DUPONT@EXAMPLE.FR",
        subject: "Une question",
        message: "Bonjour",
        status: "new" as const,
        createdAt: NOW,
      })
    })

    await eraseFully(t, owner, { email: EMAIL })

    const left = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").collect(),
      messages: await ctx.db.query("contactMessages").collect(),
    }))
    expect(left.orders.map((o) => o.customerInfo.email)).toEqual([undefined, undefined])
    expect(left.orders.map((o) => o.externalPlatformData)).toEqual([undefined, undefined])
    expect(left.messages).toHaveLength(0)
  })
})

describe("referential integrity after an erasure", () => {
  const TABLE_NAMES = Object.keys(
    (schema as unknown as { tables: Record<string, unknown> }).tables
  )

  /**
   * Every `Id`-shaped string in every document, checked against the database.
   *
   * Walks nested objects and arrays too: `emailAutomations.steps[].templateId`
   * is a `v.id()` three levels down, and a checker that only reads the top
   * level of a document reports CLEAN by not looking.
   */
  async function danglingIds(t: ReturnType<typeof convexTest>): Promise<string[]> {
    const dangling: string[] = []
    await t.run(async (ctx) => {
      const live = new Set<string>()
      for (const table of TABLE_NAMES) {
        for (const row of await ctx.db.query(table as "orders").collect()) {
          live.add(String(row._id))
        }
      }
      // convex-test spells an id "<n>;<tableName>"; the table half has to be a
      // real table or it is not an id, it is a sentence with a semicolon.
      const idTable = (value: unknown): string | null => {
        if (typeof value !== "string") return null
        const match = /^\d+;([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)
        if (!match) return null
        return TABLE_NAMES.includes(match[1]!) ? match[1]! : null
      }

      const walk = (table: string, rowId: string, path: string, value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach((item, i) => walk(table, rowId, `${path}[${i}]`, item))
          return
        }
        if (value && typeof value === "object") {
          for (const [k, v2] of Object.entries(value)) {
            if (path === "" && k === "_id") continue
            walk(table, rowId, path === "" ? k : `${path}.${k}`, v2)
          }
          return
        }
        const target = idTable(value)
        if (target && !live.has(value as string)) {
          dangling.push(`${table}.${path} -> ${String(value)} (from ${rowId})`)
        }
      }

      for (const table of TABLE_NAMES) {
        for (const row of await ctx.db.query(table as "orders").collect()) {
          walk(table, String(row._id), "", row)
        }
      }
    })
    return dangling
  }

  test("the invoice survives, is reported, and the export hands it back (#367)", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Napoli Oberkampf")
    const owner = await seedOwner(t, [storeId])

    const { invoiceId } = await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "ORD-1",
        customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED, phone: PHONE },
        type: "delivery" as const,
        status: "completed" as const,
        items: [],
        subtotal: 1200,
        taxAmount: 120,
        total: 1320,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const invoiceId = await ctx.db.insert("invoices", {
        number: "FA-2026-000001",
        kind: "invoice" as const,
        issuedAt: NOW,
        year: 2026,
        orderId,
        orderNumber: "ORD-1",
        storeId,
        seller: { legalName: "Napoli SAS", storeName: "Napoli Oberkampf" },
        buyer: {
          name: "Marie Dupont",
          email: EMAIL,
          phone: PHONE,
          address: { street: "8 rue de Charonne", city: "Paris", postalCode: "75011" },
        },
        lines: [],
        subtotal: 1200,
        taxAmount: 120,
        taxBreakdown: [],
        total: 1320,
        currency: "EUR",
        payment: { method: "card", paidAt: NOW },
        createdAt: NOW,
      })
      await ctx.db.patch(orderId, { invoiceId })
      return { invoiceId }
    })

    // The export must hand the diner their own invoice (art. 15, 20).
    const exported = await owner.query(api.privacy.exportDataSubject, { email: EMAIL })
    const invoiceRecords = exported.records.find((r: { table: string }) => r.table === "invoices")
    expect(invoiceRecords?.rows).toHaveLength(1)

    const report = await eraseFully(t, owner, { email: EMAIL })

    // Kept, whole, buyer and all — a fiscal series has no holes (art. 242
    // nonies A CGI), and art. 17.3.b is what allows it.
    const invoice = await t.run((ctx) => ctx.db.get(invoiceId))
    expect(invoice).not.toBeNull()
    expect(invoice?.buyer.email).toBe(EMAIL)
    expect(invoice?.buyer.name).toBe("Marie Dupont")
    expect(invoice?.buyer.address?.street).toBe("8 rue de Charonne")

    // And SAID so. A report that stayed silent would have the operator tell the
    // diner everything was erased while their name sits on a document that
    // cannot be touched.
    const kept = report.report.retained.find((r: { table: string }) => r.table === "invoices")
    expect(kept, "the erasure report must name the invoice it kept").toBeDefined()
    expect(kept?.count).toBe(1)
    expect(kept?.reason).toMatch(/242 nonies A|17\.3\.b/)

    // The order itself still loses its customer.
    const order = await t.run(async (ctx) => (await ctx.db.query("orders").collect())[0])
    expect(order?.customerInfo?.email).toBeUndefined()
  })

  test("CONTROL: the dangling-id checker can actually fail", async () => {
    // Without this the CLEAN below means nothing: a checker whose id detector
    // never matches reports an empty list on any database at all.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "ORD-1",
        customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED },
        type: "delivery" as const,
        status: "completed" as const,
        items: [],
        subtotal: 1,
        taxAmount: 0,
        total: 1,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert("payments", {
        orderId,
        storeId,
        amount: 1,
        currency: "EUR",
        provider: "stripe" as const,
        status: "succeeded" as const,
        externalId: "pi_x",
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.delete(orderId)
    })
    expect(await danglingIds(t)).toHaveLength(1)
  })

  test("nothing points at a document the erasure removed", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const owner = await seedOwner(t, [storeId])

    const seeded = await t.run(async (ctx) => {
      const orderId = await ctx.db.insert("orders", {
        storeId,
        orderNumber: "ORD-1",
        customerId: "auth|marie",
        customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED, phone: PHONE },
        type: "delivery" as const,
        status: "completed" as const,
        items: [],
        subtotal: 1200,
        taxAmount: 120,
        total: 1320,
        paymentStatus: "paid" as const,
        source: "website" as const,
        uberDirectEstimateId: "est-42",
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-1",
        items: [],
        status: "completed" as const,
        priority: "normal" as const,
        source: "website" as const,
        orderType: "delivery" as const,
        printStatus: "printed" as const,
        printAttempts: 1,
        customerName: "Marie Dupont",
        trackingToken: "trk-1",
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
        createdAt: NOW,
        updatedAt: NOW,
      })
      // The quote the order consumed: it names the order it was spent on.
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
      // A subscriber with an automation run pointing at it.
      const subscriberId = await ctx.db.insert("emailSubscribers", {
        storeId,
        email: EMAIL,
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
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
      const templateId = await ctx.db.insert("emailTemplates", {
        storeId,
        name: "Bienvenue",
        subject: "Bienvenue",
        blocks: [],
        category: "automation" as const,
        isDefault: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const automationId = await ctx.db.insert("emailAutomations", {
        storeId,
        name: "Bienvenue",
        trigger: "welcome" as const,
        status: "active" as const,
        steps: [{ id: "s1", delayMinutes: 0, templateId }],
        stats: {
          sent: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          bounced: 0,
          unsubscribed: 0,
          converted: 0,
          revenue: 0,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert("emailAutomationRuns", {
        storeId,
        automationId,
        subscriberId,
        stepId: "s1",
        sentAt: NOW,
      })
      await ctx.db.insert("emailEvents", {
        storeId,
        subscriberId,
        type: "opened" as const,
        occurredAt: NOW,
      })
      return { orderId }
    })

    expect(await danglingIds(t), "the seed itself must be sound").toEqual([])

    await eraseFully(t, owner, { email: EMAIL })

    expect(
      await danglingIds(t),
      "a row promising a v.id() that resolves to null"
    ).toEqual([])
    // The order stays; whatever pointed at it must still resolve.
    expect(await t.run((ctx) => ctx.db.get(seeded.orderId))).not.toBeNull()
  })
})
