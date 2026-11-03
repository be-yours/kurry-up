// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Data past the retention window leaves on a schedule (RGPD art. 5.1.e).
 *
 * WHAT THIS GUARDS: `crons.ts` scheduled eight jobs and not one of them
 * touched a diner. A four-year-old order still carried a name, an e-mail, a
 * phone number and a street; a four-year-old game play still carried a device
 * fingerprint. The measurement that opened this card ran every scheduled
 * handler and found both rows exactly as seeded.
 *
 * The window is `globalSettings.dataRetention.customerDataDays`, and the
 * default is the CNIL's three years. It is the restaurant's decision, not this
 * suite's — what is asserted here is that whatever they set is enforced.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_760_000_000_000
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const FOUR_YEARS_AGO = NOW - 4 * YEAR_MS
const ONE_YEAR_AGO = NOW - YEAR_MS

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

async function seedSettings(
  t: ReturnType<typeof convexTest>,
  dataRetention?: { customerDataDays: number; enabled: boolean }
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
      ...(dataRetention
        ? { dataRetention: { ...dataRetention, updatedAt: NOW } }
        : {}),
    })
  )
}

/** One order and one game play at `at`, plus the store they belong to. */
async function seedAged(t: ReturnType<typeof convexTest>, at: number) {
  return await t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
      name: "Le Comptoir",
      slug: "le-comptoir",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: at,
      updatedAt: at,
    })
    const gameId = await ctx.db.insert("games", {
      storeId,
      type: "wheel" as const,
      name: "Roue",
      winRatio: 30,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    })
    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2022-0001",
      customerInfo: {
        name: "Marie Dupont",
        email: "marie.dupont@example.fr",
        phone: "+33612345678",
      },
      type: "delivery" as const,
      status: "completed" as const,
      items: [],
      subtotal: 2400,
      taxAmount: 240,
      total: 2640,
      deliveryAddress: {
        street: "8 rue de Charonne",
        city: "Paris",
        postalCode: "75011",
        country: "France",
      },
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: at,
      updatedAt: at,
    })
    const playId = await ctx.db.insert("gamePlays", {
      storeId,
      gameId,
      playerEmail: "marie.dupont@example.fr",
      fingerprint: "fp-9f3c2a",
      completedActions: [],
      didWin: false,
      userAgent: "Mozilla/5.0",
      playedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    return { storeId, orderId, playId }
  })
}

describe("the retention sweep", () => {
  test("anonymises an order past the window and deletes the game play", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { orderId, playId } = await seedAged(t, FOUR_YEARS_AGO)

    const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    expect(report.armed).toBe(true)
    expect(report.windowDays).toBe(1095)

    const { order, play } = await t.run(async (ctx) => ({
      order: await ctx.db.get(orderId),
      play: await ctx.db.get(playId),
    }))
    // The accounting record survives; the person does not.
    expect(order).not.toBeNull()
    expect(order?.total).toBe(2640)
    expect(order?.customerInfo.email).toBeUndefined()
    expect(order?.customerInfo.phone).toBeUndefined()
    expect(order?.deliveryAddress).toBeUndefined()
    expect(order?.anonymisedAt).toBe(NOW)
    // A game play is not an accounting record and never was.
    expect(play).toBeNull()
  })

  test("leaves data that is still inside the window alone", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { orderId, playId } = await seedAged(t, ONE_YEAR_AGO)

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    const { order, play } = await t.run(async (ctx) => ({
      order: await ctx.db.get(orderId),
      play: await ctx.db.get(playId),
    }))
    expect(order?.customerInfo.email).toBe("marie.dupont@example.fr")
    expect(play).not.toBeNull()
  })

  test("honours a window the establishment set", async () => {
    const t = newHarness()
    // Six months. A one-year-old order is now past it.
    await seedSettings(t, { customerDataDays: 180, enabled: true })
    const { orderId } = await seedAged(t, ONE_YEAR_AGO)

    const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(report.windowDays).toBe(180)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.customerInfo.email).toBeUndefined()
  })

  test("a deployment that never configured anything still gets the CNIL default", async () => {
    // The failure mode this rules out: "absent" read as "off", so a client who
    // never opened the screen keeps every diner for ever and believes they
    // configured nothing rather than that they configured infinity.
    const t = newHarness()
    await seedSettings(t)
    const { orderId } = await seedAged(t, FOUR_YEARS_AGO)

    const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(report.windowDays).toBe(1095)

    const order = await t.run((ctx) => ctx.db.get(orderId))
    expect(order?.customerInfo.email).toBeUndefined()
  })

  test("paused means reporting, not sleeping", async () => {
    const t = newHarness()
    await seedSettings(t, { customerDataDays: 1095, enabled: false })
    const { orderId, playId } = await seedAged(t, FOUR_YEARS_AGO)

    const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    expect(report.armed).toBe(false)
    // It says what it WOULD have done, so the establishment can see the
    // backlog a deliberate pause is accruing.
    expect(report.tallies.find((tl) => tl.table === "orders")?.anonymised).toBe(1)
    expect(report.tallies.find((tl) => tl.table === "gamePlays")?.deleted).toBe(1)

    const { order, play } = await t.run(async (ctx) => ({
      order: await ctx.db.get(orderId),
      play: await ctx.db.get(playId),
    }))
    expect(order?.customerInfo.email).toBe("marie.dupont@example.fr")
    expect(play).not.toBeNull()
  })

  test("never touches an order still being served", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, FOUR_YEARS_AGO)
    const liveId = await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId,
        orderNumber: "ORD-2022-0002",
        customerInfo: { name: "Yanis", phone: "+33600000000" },
        type: "delivery" as const,
        // Stale, but still on its way to somebody's door: blanking the address
        // makes the delivery permanently unbookable.
        status: "out_for_delivery" as const,
        items: [],
        subtotal: 1000,
        taxAmount: 100,
        total: 1100,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: FOUR_YEARS_AGO,
        updatedAt: FOUR_YEARS_AGO,
      })
    )

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    const live = await t.run((ctx) => ctx.db.get(liveId))
    expect(live?.customerInfo.phone).toBe("+33600000000")
    expect(live?.anonymisedAt).toBeUndefined()
  })

  test("does not walk the same rows again the next night", async () => {
    // Without `anonymisedAt` an anonymised order is indistinguishable from a
    // walk-in who gave no details, so the sweep would re-process it every
    // night for ever and the report would count it again each time.
    const t = newHarness()
    await seedSettings(t)
    await seedAged(t, FOUR_YEARS_AGO)

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    const second = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    expect(second.tallies.find((tl) => tl.table === "orders")).toBeUndefined()
  })

  test("clears the limiter rows nothing ever deleted", async () => {
    const t = newHarness()
    await seedSettings(t)
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", {
        key: "contactPerEmail:marie.dupont@example.fr",
        windowStart: FOUR_YEARS_AGO,
        count: 1,
      })
    )

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })

    const left = await t.run((ctx) => ctx.db.query("rateLimits").collect())
    expect(left).toHaveLength(0)
  })

  test("reaches a kitchen ticket the 30-day purge deliberately skips", async () => {
    // `purgeExpiredTickets` never touches a ticket that is still on the pass,
    // however old it is. One abandoned at `pending` years ago still carries a
    // name, a phone number and a list of allergens — art. 9 health data with
    // no retention basis at all.
    const t = newHarness()
    await seedSettings(t)
    const { storeId, orderId } = await seedAged(t, FOUR_YEARS_AGO)
    const ticketId = await t.run((ctx) =>
      ctx.db.insert("kitchenTickets", {
        storeId,
        orderId,
        orderNumber: "ORD-2022-0001",
        items: [],
        status: "pending" as const,
        priority: "normal" as const,
        source: "website" as const,
        orderType: "delivery" as const,
        printStatus: "printed" as const,
        printAttempts: 1,
        customerName: "Marie Dupont",
        customerPhone: "+33612345678",
        allergens: ["fruits de mer"],
        trackingToken: "trk-stale",
        createdAt: FOUR_YEARS_AGO,
        updatedAt: FOUR_YEARS_AGO,
      })
    )

    await t.mutation(internal.kitchenTickets.purgeExpiredTickets, {})
    expect(
      await t.run((ctx) => ctx.db.get(ticketId)),
      "the 30-day purge skips a live ticket, which is what leaves the hole"
    ).not.toBeNull()

    await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(await t.run((ctx) => ctx.db.get(ticketId))).toBeNull()
  })
})

describe("the sweep makes progress, night after night", () => {
  /** Run the sweep to completion, carrying its cursor, like the cron does. */
  async function sweepFully(t: ReturnType<typeof convexTest>, maxRuns = 40) {
    let report = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    let runs = 1
    while (report.hasMore && report.state) {
      if (runs++ > maxRuns) {
        throw new Error(
          `the sweep still reports work after ${maxRuns} runs — it is not advancing`
        )
      }
      report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
        now: NOW,
        state: report.state,
      })
    }
    return runs
  }

  test("reaches work sitting behind more skipped rows than one run can hold", async () => {
    // THE BUG THIS PINS DOWN: the first version of the sweep took the oldest N
    // rows of a table each run and skipped the ones not ready. An establishment
    // whose old orders are all already anonymised handed it the same N skipped
    // rows every night, for ever, and it never reached the three behind them.
    // It reported a clean run while doing nothing — indistinguishable from
    // having nothing to do.
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, FOUR_YEARS_AGO)

    const BLOCKERS = 450 // more than one run's whole budget
    await t.run(async (ctx) => {
      for (let i = 0; i < BLOCKERS; i++) {
        await ctx.db.insert("orders", {
          storeId,
          orderNumber: `ORD-DONE-${i}`,
          customerInfo: { name: "Client anonymisé" },
          type: "pickup" as const,
          status: "completed" as const,
          items: [],
          subtotal: 100,
          taxAmount: 10,
          total: 110,
          paymentStatus: "paid" as const,
          source: "website" as const,
          // Already dealt with on an earlier night.
          anonymisedAt: FOUR_YEARS_AGO,
          createdAt: FOUR_YEARS_AGO - BLOCKERS + i,
          updatedAt: FOUR_YEARS_AGO,
        })
      }
    })

    const behind: Array<Id<"orders">> = await t.run(async (ctx) => {
      const ids: Array<Id<"orders">> = []
      for (let i = 0; i < 3; i++) {
        ids.push(
          await ctx.db.insert("orders", {
            storeId,
            orderNumber: `ORD-TODO-${i}`,
            customerInfo: { name: "Yanis Martin", email: "yanis@example.fr" },
            type: "pickup" as const,
            status: "completed" as const,
            items: [],
            subtotal: 100,
            taxAmount: 10,
            total: 110,
            paymentStatus: "paid" as const,
            source: "website" as const,
            createdAt: FOUR_YEARS_AGO + i,
            updatedAt: FOUR_YEARS_AGO,
          })
        )
      }
      return ids
    })

    await sweepFully(t)

    const left = await t.run(async (ctx) =>
      Promise.all(behind.map((id) => ctx.db.get(id)))
    )
    for (const order of left) {
      expect(order?.customerInfo.email, `${order?.orderNumber} was never reached`).toBeUndefined()
      expect(order?.anonymisedAt).toBe(NOW)
    }
  })

  test("reaches an old subscriber behind a list of active ones", async () => {
    // Same starvation, different clock: a subscriber's window runs from their
    // LAST CONTACT, so the oldest rows of a busy list are the ones most likely
    // to be kept — and they sit at the head of the walk.
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, FOUR_YEARS_AGO)

    const stale = await t.run(async (ctx) => {
      const base = {
        storeId,
        status: "active" as const,
        source: "order" as const,
        tags: [],
        consentSource: "commande",
        bounceCount: 0,
        metadata: {
          totalOrders: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          favoriteProducts: [],
          orderTypes: [],
        },
      }
      // 120 people who signed up years ago and ordered last week.
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("emailSubscribers", {
          ...base,
          email: `actif-${i}@example.fr`,
          consentAt: FOUR_YEARS_AGO,
          metadata: { ...base.metadata, lastOrderAt: NOW - 7 * 86_400_000 },
          createdAt: FOUR_YEARS_AGO - 200 + i,
          updatedAt: NOW,
        })
      }
      // One who has not been heard from since.
      return await ctx.db.insert("emailSubscribers", {
        ...base,
        email: "silencieux@example.fr",
        consentAt: FOUR_YEARS_AGO,
        createdAt: FOUR_YEARS_AGO,
        updatedAt: FOUR_YEARS_AGO,
      })
    })

    await sweepFully(t)

    expect(await t.run((ctx) => ctx.db.get(stale))).toBeNull()
    const active = await t.run((ctx) => ctx.db.query("emailSubscribers").collect())
    expect(active).toHaveLength(120)
  })

  test("stops asking for another run once there is nothing left", async () => {
    // The other half of the same failure: a sweep that always says `hasMore`
    // reschedules itself for ever, every minute, on a deployment with nothing
    // to do.
    const t = newHarness()
    await seedSettings(t)
    await seedAged(t, FOUR_YEARS_AGO)

    const runs = await sweepFully(t)
    expect(runs).toBeLessThan(5)

    const final = await t.mutation(internal.privacy.sweepExpiredCustomerData, { now: NOW })
    expect(final.hasMore).toBe(false)
    expect(final.state).toBeUndefined()
    expect(final.tallies).toEqual([])
  })
})

describe("the retention window itself", () => {
  async function ownerOf(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
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

  test("reads back as the CNIL default until somebody sets it", async () => {
    const t = newHarness()
    await seedSettings(t)
    const current = await t.query(api.privacy.getRetention, {})
    expect(current).toEqual({
      customerDataDays: 1095,
      // The audience window has its own default, and a shorter one: 25 months
      // is the CNIL ceiling for audience measurement, and staying under it is
      // what keeps « Fréquentation » off a consent banner.
      audienceDays: 760,
      // Table bookings have a third, with the same three-year default and a
      // ceiling that is the same number: it may only be shortened.
      reservationDays: 1095,
      enabled: true,
      isDefault: true,
    })
  })

  test("an owner can change it, and it is recorded", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, ONE_YEAR_AGO)
    const owner = await ownerOf(t, storeId)

    await owner.mutation(api.privacy.setRetention, { customerDataDays: 730, enabled: true })

    expect(await t.query(api.privacy.getRetention, {})).toEqual({
      customerDataDays: 730,
      audienceDays: 760,
      reservationDays: 1095,
      enabled: true,
      isDefault: false,
    })
    const stored = await t.run((ctx) => ctx.db.query("globalSettings").first())
    // Who chose the window is part of the decision, not metadata.
    expect(stored?.dataRetention?.updatedBy).toBe("owner")
  })

  /*
   * `setRetention` builds a fresh `dataRetention` object and patches it over
   * the old one, so a field it does not name is DESTROYED. With one window that
   * was invisible; with two it would reset an establishment's audience
   * retention every time somebody adjusted the diner one.
   */
  test("saving the diner window does not wipe the audience one", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, ONE_YEAR_AGO)
    const owner = await ownerOf(t, storeId)

    await owner.mutation(api.privacy.setRetention, {
      customerDataDays: 1095,
      audienceDays: 90,
      enabled: true,
    })
    await owner.mutation(api.privacy.setRetention, {
      customerDataDays: 730,
      enabled: true,
    })

    expect(await t.query(api.privacy.getRetention, {})).toMatchObject({
      customerDataDays: 730,
      audienceDays: 90,
    })
  })

  test("refuses an audience window past the CNIL ceiling", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, ONE_YEAR_AGO)
    const owner = await ownerOf(t, storeId)

    await expect(
      owner.mutation(api.privacy.setRetention, {
        customerDataDays: 1095,
        audienceDays: 1000,
        enabled: true,
      })
    ).rejects.toThrow(/AUDIENCE_WINDOW_OUT_OF_RANGE/)
  })

  test("refuses a window that is obviously a typo", async () => {
    const t = newHarness()
    await seedSettings(t)
    const { storeId } = await seedAged(t, ONE_YEAR_AGO)
    const owner = await ownerOf(t, storeId)

    // A misplaced decimal point here deletes a restaurant's customer history
    // tonight.
    await expect(
      owner.mutation(api.privacy.setRetention, { customerDataDays: 1, enabled: true })
    ).rejects.toThrow(/RETENTION_WINDOW_OUT_OF_RANGE/)
    await expect(
      owner.mutation(api.privacy.setRetention, { customerDataDays: 100_000, enabled: true })
    ).rejects.toThrow(/RETENTION_WINDOW_OUT_OF_RANGE/)
  })
})
