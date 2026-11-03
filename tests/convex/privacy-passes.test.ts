// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Axis 2 (multi-pass truncation) and axis 3 (the report lying).
 *
 * `ERASURE_SCAN_BUDGET` is 400, so everything here seeds more than that and
 * drives the loop through `internal.privacy.continueErasure` to the end.
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

async function seedStore(t: ReturnType<typeof convexTest>, name = "Pizzeria Napoli") {
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

/** Drive the erasure the way `convex/privacy.ts` does, counting the passes. */
async function eraseFully(
  t: ReturnType<typeof convexTest>,
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  subject: { email?: string; fingerprint?: string },
  maxPasses = 400
) {
  let result = await owner.mutation(api.privacy.eraseDataSubject, subject)
  let passes = 1
  while (!result.complete) {
    if (passes++ > maxPasses) throw new Error(`erasure never completed after ${maxPasses} passes`)
    result = await t.mutation(internal.privacy.continueErasure, {
      ...subject,
      storeIds: result.storeIds as Id<"stores">[],
      everyStore: result.everyStore,
      actor: result.actor,
      state: result.state,
    })
  }
  return { result, passes }
}

describe("an erasure bigger than one pass", () => {
  test("600 orders, driven to completion, leaves none behind", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert("orders", orderRow(storeId, i, NOW + i * 1000))
      }
    })

    const { result, passes } = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)
    expect(passes, "600 rows cannot fit in one 400-row pass").toBeGreaterThan(1)

    const left = await t.run((ctx) => ctx.db.query("orders").collect())
    const stillNamed = left.filter((o) => o.customerInfo.email !== undefined)
    expect(stillNamed.map((o) => o.orderNumber)).toEqual([])
    expect(
      result.report.tallies.find((x) => x.table === "orders")?.anonymised,
      "the tally must equal the work"
    ).toBe(600)
  })

  test("50 orders sharing one createdAt to the millisecond — none is stepped over", async () => {
    // A double-submitted checkout writes two rows with the same timestamp. A
    // walk that resumes at "> lastSeen" steps over the second one.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        // Identical createdAt for every one of them.
        await ctx.db.insert("orders", orderRow(storeId, i, NOW))
      }
      // Plus enough rows to force the walk across several pages while the
      // clashing block is in the middle of it.
      for (let i = 50; i < 500; i++) {
        await ctx.db.insert("orders", orderRow(storeId, i, NOW + i * 1000))
      }
    })

    const { result } = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const left = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(left.filter((o) => o.customerInfo.email !== undefined)).toHaveLength(0)
    expect(left).toHaveLength(500)
  })

  test("500 game plays with their redemptions, deleted across passes", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
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
        name: "Pizza",
        type: "free_product" as const,
        validityDays: 7,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      for (let i = 0; i < 500; i++) {
        const playId = await ctx.db.insert("gamePlays", {
          storeId,
          gameId,
          playerEmail: EMAIL_AS_TYPED,
          fingerprint: `fp-${i}`,
          consent: { acceptedAt: NOW, noticeVersion: "fr-2026-09" },
          completedActions: [],
          didWin: true,
          prizeId,
          // Half of them share a timestamp.
          playedAt: i < 250 ? NOW : NOW + i * 1000,
          createdAt: NOW,
          updatedAt: NOW,
        })
        await ctx.db.insert("prizeRedemptions", {
          storeId,
          gamePlayId: playId,
          prizeId,
          playerEmail: EMAIL_AS_TYPED,
          redemptionCode: `CODE${i}`,
          status: "pending" as const,
          expiresAt: NOW + 7 * 86_400_000,
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })

    const { result } = await eraseFully(t, owner, { email: EMAIL })
    expect(result.complete).toBe(true)

    const left = await t.run(async (ctx) => ({
      plays: await ctx.db.query("gamePlays").collect(),
      redemptions: await ctx.db.query("prizeRedemptions").collect(),
    }))
    expect(left.plays).toHaveLength(0)
    expect(left.redemptions).toHaveLength(0)
  })

  test("the account discovered on pass one is still known on the last pass", async () => {
    // `state.userIds` is found in `orders` and consumed at the very end, many
    // passes later. If it does not survive the round trip through the
    // scheduler's validator, her saved addresses are silently skipped.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      // The signed-in order is FIRST in index order, so it is found on pass one
      // and has to survive every pass after it.
      await ctx.db.insert("orders", orderRow(storeId, 0, NOW, { customerId: "auth|marie" }))
      for (let i = 1; i < 900; i++) {
        await ctx.db.insert("orders", orderRow(storeId, i, NOW + i * 1000))
      }
      await ctx.db.insert("customerAddresses", {
        userId: "auth|marie",
        street: "8 rue de Charonne",
        city: "Paris",
        postalCode: "75011",
        country: "France",
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    const { result, passes } = await eraseFully(t, owner, { email: EMAIL })
    expect(passes).toBeGreaterThan(2)
    expect(result.complete).toBe(true)

    const addresses = await t.run((ctx) => ctx.db.query("customerAddresses").collect())
    expect(addresses, "her saved address outlived the erasure").toHaveLength(0)
  })
})

describe("the report, and what it may not claim", () => {
  test("a caller cannot hand back a state and forge a finished erasure", async () => {
    // WHAT THIS PINS DOWN. `eraseDataSubject` used to take the walk's `state`
    // as a public argument so the screen could drive the passes. A caller could
    // then send `{ step: 9 }` — past the last step — and the walk exited at
    // once: `complete` came back true, and a `privacy_erasure` line was written
    // saying the erasure had finished, with the caller's own invented tallies,
    // while every row sat untouched. That audit line is the establishment's
    // art. 5.2 proof to the CNIL.
    //
    // The argument is gone. Continuation is `continueErasure`, which is
    // internal and reachable only from the scheduler.
    const t = newHarness()
    const storeId = await seedStore(t, "Napoli")
    const owner = await seedOwner(t, [storeId])
    await t.run((ctx) => ctx.db.insert("orders", orderRow(storeId, 1, NOW)))

    await expect(
      owner.mutation(api.privacy.eraseDataSubject, {
        email: EMAIL,
        state: {
          step: 9,
          storeIndex: 0,
          cursor: null,
          userIds: [],
          fingerprints: [],
          tallies: [{ table: "orders", deleted: 0, anonymised: 41 }],
          retained: [],
        },
      } as never)
    ).rejects.toThrow()

    const log = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    expect(log, "a refused call must leave no trace of an erasure").toHaveLength(0)
    const order = await t.run((ctx) => ctx.db.query("orders").first())
    expect(order?.customerInfo.email).toBe(EMAIL_AS_TYPED)
  })

  test("previewErasure writes nothing at all", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      await ctx.db.insert("orders", orderRow(storeId, 1, NOW, { customerId: "auth|marie" }))
      await ctx.db.insert("contactMessages", {
        storeId,
        name: "Marie Dupont",
        email: EMAIL,
        subject: "Une question",
        message: "Bonjour",
        status: "new" as const,
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
    })

    const tableNames = Object.keys(
      (schema as unknown as { tables: Record<string, unknown> }).tables
    )
    const snapshot = async () =>
      await t.run(async (ctx) => {
        const out: Record<string, string> = {}
        for (const table of tableNames) {
          const rows = await ctx.db.query(table as "orders").collect()
          out[table] = JSON.stringify(
            rows.map((r) => r).sort((a, b) => String(a._id).localeCompare(String(b._id)))
          )
        }
        return out
      })

    const before = await snapshot()
    await owner.query(api.privacy.previewErasure, { email: EMAIL })
    expect(await snapshot()).toEqual(before)
  })

  test("the preview's numbers are the numbers the erasure produces", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert("orders", orderRow(storeId, i, NOW + i * 1000))
      }
    })

    const preview = await owner.query(api.privacy.previewErasure, { email: EMAIL })
    const { result } = await eraseFully(t, owner, { email: EMAIL })

    const asMap = (tallies: { table: string; deleted: number; anonymised: number }[]) =>
      Object.fromEntries(tallies.map((x) => [x.table, `${x.deleted}/${x.anonymised}`]))

    // If the preview says 600 the erasure must do 600, and if it cannot
    // promise 600 it must say `complete: false` so the screen can hedge.
    if (preview.complete) {
      expect(asMap(preview.tallies)).toEqual(asMap(result.report.tallies))
    } else {
      expect(preview.tallies.find((x) => x.table === "orders")?.anonymised ?? 0).toBeLessThanOrEqual(
        result.report.tallies.find((x) => x.table === "orders")?.anonymised ?? 0
      )
    }
  })
})
