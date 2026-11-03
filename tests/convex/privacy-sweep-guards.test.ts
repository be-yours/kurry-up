// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Axis 6 (the retention sweep) and axis 7 (consent).
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_760_000_000_000
const YEAR = 365 * 24 * 60 * 60 * 1000
const LONG_AGO = NOW - 4 * YEAR
const EMAIL = "marie.dupont@example.fr"
const EMAIL_AS_TYPED = "Marie.Dupont@Example.FR"
const PHONE = "+33612345678"

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

async function seedDeployment(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
      address: { street: "12 rue Oberkampf", city: "Paris", postalCode: "75011", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
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
    return storeId
  })
}

function orderRow(storeId: Id<"stores">, n: number, createdAt: number, extra = {}) {
  return {
    storeId,
    orderNumber: `ORD-${n}`,
    customerInfo: { name: "Marie Dupont", email: EMAIL_AS_TYPED, phone: PHONE },
    type: "delivery" as const,
    status: "completed" as const,
    items: [],
    subtotal: 1200,
    taxAmount: 120,
    total: 1320,
    paymentStatus: "paid" as const,
    source: "website" as const,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  }
}

/** Run the sweep the way `convex/privacy.ts` reschedules it, counting runs. */
async function sweepToEnd(
  t: ReturnType<typeof convexTest>,
  args: { now?: number; limit?: number } = {},
  maxRuns = 60
) {
  let report = await t.mutation(internal.privacy.sweepExpiredCustomerData, args)
  let runs = 1
  while (report.hasMore) {
    if (runs++ > maxRuns) {
      return { report, runs, ranAway: true as const }
    }
    report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
      ...args,
      state: report.state,
    })
  }
  return { report, runs, ranAway: false as const }
}

describe("what the retention sweep must not do", () => {
  test("what it must not touch — an order still out, a refund owed, a bonus unspent", async () => {
    const t = newHarness()
    const storeId = await seedDeployment(t)

    const kept = await t.run(async (ctx) => {
      const outForDelivery = await ctx.db.insert(
        "orders",
        orderRow(storeId, 1, LONG_AGO, { status: "out_for_delivery" as const })
      )
      const refundPending = await ctx.db.insert(
        "orders",
        orderRow(storeId, 2, LONG_AGO, { paymentStatus: "refund_pending" as const })
      )
      const referralId = await ctx.db.insert("gameReferrals", {
        storeId,
        code: "REF-MARIE",
        referrerFingerprint: "fp-1",
        conversions: 2,
        pendingBonuses: 2,
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
      })
      return { outForDelivery, refundPending, referralId }
    })

    const { report, ranAway } = await sweepToEnd(t, { now: NOW })
    expect(ranAway).toBe(false)
    expect(report.armed).toBe(true)

    const after = await t.run(async (ctx) => ({
      outForDelivery: await ctx.db.get(kept.outForDelivery),
      refundPending: await ctx.db.get(kept.refundPending),
      referral: await ctx.db.get(kept.referralId),
    }))
    expect(after.outForDelivery?.anonymisedAt, "a courier is still carrying it").toBeUndefined()
    expect(after.outForDelivery?.deliveryAddress ?? null).toBeNull()
    expect(after.refundPending?.anonymisedAt, "money is owed back").toBeUndefined()
    expect(after.referral, "two free turns she earned").not.toBeNull()
  })

  test("the sweep keeps the saved address of a diner who ordered last week", async () => {
    // The window is published as "three years from LAST CONTACT" — in the
    // consent notice, in the runbook and in `subscriberLastContact`, which
    // computes exactly that for the one table it can. `customerAddresses` is
    // swept on the row's own `updatedAt`, so a loyal diner who has not EDITED
    // their address in three years loses it while they are still a customer.
    const t = newHarness()
    const storeId = await seedDeployment(t)

    const addressId = await t.run(async (ctx) => {
      // She ordered yesterday, signed in.
      await ctx.db.insert(
        "orders",
        orderRow(storeId, 1, NOW - 86_400_000, { customerId: "auth|marie" })
      )
      return await ctx.db.insert("customerAddresses", {
        userId: "auth|marie",
        street: "8 rue de Charonne",
        city: "Paris",
        postalCode: "75011",
        country: "France",
        isDefault: true,
        createdAt: LONG_AGO,
        // Saved once, four years ago, and never edited since.
        updatedAt: LONG_AGO,
      })
    })

    await sweepToEnd(t, { now: NOW })

    expect(
      await t.run((ctx) => ctx.db.get(addressId)),
      "an active customer's default delivery address, deleted"
    ).not.toBeNull()
  })

  test("a run given no budget still moves, instead of rescheduling for ever", async () => {
    // The wrapper reschedules on `hasMore` alone and never asks whether the
    // last run moved. A zero budget used to skip the walk entirely and hand
    // back the identical state, still saying "more to do" — so the scheduler
    // re-fired every sixty seconds, for ever, doing nothing and writing no
    // audit line to say so. The floor of one row is what makes the loop
    // terminate.
    const t = newHarness()
    const storeId = await seedDeployment(t)
    await t.run((ctx) => ctx.db.insert("orders", orderRow(storeId, 1, LONG_AGO)))

    let report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
      now: NOW,
      limit: 0,
    })
    const positions = [JSON.stringify(report.state)]
    let runs = 1
    while (report.hasMore && report.state) {
      if (runs++ > 60) throw new Error("a zero-budget sweep never terminates")
      report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
        now: NOW,
        limit: 0,
        state: report.state,
      })
      positions.push(JSON.stringify(report.state))
    }

    expect(report.hasMore).toBe(false)
    expect(report.state).toBeUndefined()
    // Every run left the walk somewhere new. A repeat here is the loop.
    expect(new Set(positions).size).toBe(positions.length)
  })

  test("rows behind hundreds of skipped ones are still reached", async () => {
    // The starvation case: a store whose oldest orders are all already
    // anonymised, with one that is not sitting behind them.
    const t = newHarness()
    const storeId = await seedDeployment(t)

    const target = await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert(
          "orders",
          orderRow(storeId, i, LONG_AGO + i, { anonymisedAt: LONG_AGO })
        )
      }
      // Behind all of them, and never yet dealt with.
      return await ctx.db.insert("orders", orderRow(storeId, 999, LONG_AGO + 10_000))
    })

    const { ranAway, runs } = await sweepToEnd(t, { now: NOW })
    expect(ranAway, `the sweep never finished after ${runs} runs`).toBe(false)

    const after = await t.run((ctx) => ctx.db.get(target))
    expect(after?.anonymisedAt, "the row behind the skipped ones was never reached").toBeGreaterThan(
      0
    )
    expect(after?.customerInfo.email).toBeUndefined()
  })

  test("a paused sweep writes nothing but still reports what it would do", async () => {
    const t = newHarness()
    const storeId = await seedDeployment(t)
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("globalSettings").first()
      await ctx.db.patch(settings!._id, {
        dataRetention: {
          customerDataDays: 1095,
          enabled: false,
          updatedAt: NOW,
          updatedBy: "owner",
        },
      })
      await ctx.db.insert("orders", orderRow(storeId, 1, LONG_AGO))
    })

    const { report } = await sweepToEnd(t, { now: NOW })
    expect(report.armed).toBe(false)
    expect(report.tallies.find((x) => x.table === "orders")?.anonymised).toBe(1)

    const order = await t.run((ctx) => ctx.db.query("orders").first())
    expect(order?.customerInfo.email, "paused means paused").toBe(EMAIL_AS_TYPED)
  })
})

describe("consent, on both endpoints that write a play", () => {
  async function seedGame(t: ReturnType<typeof convexTest>) {
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
        totalAvailable: 100,
        remainingCount: 100,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const qrId = await ctx.db.insert("gameQRCodes", {
        storeId,
        code: "QR-1",
        tableNumber: "1",
        scannedCount: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      return { storeId, gameId, prizeId, qrId }
    })
  }

  test("play refuses a missing consent and an invented notice version", async () => {
    const t = newHarness()
    const { gameId } = await seedGame(t)

    await expect(
      t.mutation(api.gamePlay.play, {
        code: "QR-1",
        gameId,
        fingerprint: "fp-1",
        completedActions: [],
      })
    ).rejects.toThrow(/CONSENT_REQUIRED/)

    await expect(
      t.mutation(api.gamePlay.play, {
        code: "QR-1",
        gameId,
        fingerprint: "fp-1",
        completedActions: [],
        consentNoticeVersion: "fr-2099-12",
      })
    ).rejects.toThrow(/CONSENT_REQUIRED/)

    expect(await t.run((ctx) => ctx.db.query("gamePlays").collect())).toHaveLength(0)
  })

  test("claim refuses a play that recorded no consent", async () => {
    // `gamePlays.consent` is optional because rows written before the field
    // existed have none. `claim` is the one endpoint that turns an anonymous
    // play into a named person — a name, an e-mail and a phone number onto
    // this row — so it refuses a play whose legal basis was never recorded,
    // for the same reason `play` refuses to write one.
    const t = newHarness()
    const { storeId, gameId, prizeId } = await seedGame(t)

    const playId = await t.run((ctx) =>
      ctx.db.insert("gamePlays", {
        storeId,
        gameId,
        fingerprint: "fp-legacy",
        completedActions: [],
        didWin: true,
        prizeId,
        // No `consent` — a row written before the field existed.
        playedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      t.mutation(api.gamePlay.claim, {
        playId,
        firstName: "Marie",
        lastName: "Dupont",
        email: EMAIL,
        phone: PHONE,
      }),
      "a claim is where a play stops being anonymous"
    ).rejects.toThrow(/CONSENT_REQUIRED/)

    const play = await t.run((ctx) => ctx.db.get(playId))
    expect(
      { consent: play?.consent, email: play?.playerEmail, phone: play?.playerPhone },
      "personal data attached to a row with no legal basis on it"
    ).toEqual({ consent: undefined, email: undefined, phone: undefined })
  })
})
