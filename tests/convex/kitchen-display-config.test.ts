// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * `displayConfig` reaches the dining-room screen through the real mutation (Q-2).
 *
 * The audit that produced 74de4e9 listed this field beside `orderConfirmation`
 * and `soundConfig` as dead — "mutations and audit entries wired, with no
 * reader or writer" — and `updateDisplayConfig` was deleted on the strength of
 * it. The reader was there the whole time and still is:
 * `kitchenTickets.getForDisplay` applies `autoDismissEnabled` and
 * `autoDismissMinutes` on every tick of the customer-facing screen at
 * `app/display/[storeId]/page.tsx`.
 *
 * So the setting was live, unwritable, and stuck on the query's fallback of
 * fifteen minutes: an order the customer was still waiting for left the wall
 * they were watching, and no screen in the product could change that.
 *
 * This test is what stops that happening twice. It writes through the real
 * `stores.updateDisplayConfig` and reads back through the real
 * `kitchenTickets.getForDisplay` — the same seam the dining room runs on — so a
 * mutation deleted again, or a schema field retyped out from under it, fails
 * here rather than on a restaurant wall.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

/**
 * Real wall-clock, not a frozen literal: `getForDisplay` compares `readyAt`
 * against its own `Date.now()`, so a ticket's age has to be measured from the
 * same clock the handler reads.
 */
const NOW = Date.now()
const MINUTE = 60_000

/** The fallback in `kitchenTickets.getForDisplay`, restated so a drift shows up here. */
const QUERY_DEFAULT = { autoDismissEnabled: true, autoDismissMinutes: 15 }

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Store mutations queue work through `ctx.scheduler.runAfter`. A test finishes
 * in milliseconds and leaves those jobs pending; whatever fires them next
 * writes against a transaction that closed, and because nothing awaits it that
 * arrives as an unhandled rejection — every test green and the run still
 * exiting 1, blaming whichever file happened to be running. Same guard, and the
 * same reasoning, as `kitchen-sound-config.test.ts`.
 */
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

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
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
  )
}

/** One order, ready `minutesAgo` minutes ago and never handed over. */
async function seedReadyTicket(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  orderNumber: string,
  minutesAgo: number
) {
  const readyAt = NOW - minutesAgo * MINUTE
  await t.run(async (ctx) => {
    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber,
      type: "pickup" as const,
      status: "ready" as const,
      customerInfo: { name: "Camille" },
      items: [],
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      source: "website" as const,
      paymentStatus: "paid" as const,
      createdAt: readyAt,
      updatedAt: readyAt,
    })
    await ctx.db.insert("kitchenTickets", {
      storeId,
      orderId,
      orderNumber,
      orderType: "pickup" as const,
      items: [],
      priority: "normal" as const,
      source: "website" as const,
      status: "ready" as const,
      readyAt,
      trackingToken: `tok-${orderNumber}`,
      printStatus: "not_required" as const,
      printAttempts: 0,
      createdAt: readyAt,
      updatedAt: readyAt,
    })
  })
}

/**
 * `client_admin` because one identity has to do both halves: `stores:write` for
 * the mutation, `kitchen:read` for the display query.
 */
async function seedOwner(
  t: ReturnType<typeof convexTest>,
  storeIds: Id<"stores">[]
) {
  const subject = "user:client_admin"
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

// ============================================================================

describe("stores.updateDisplayConfig", () => {
  test("the window the owner stores is the one the dining-room screen applies", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedOwner(t, [storeId])

    // Ready half an hour ago: past the query's own fifteen-minute fallback, so
    // an unconfigured establishment has already dropped it.
    await seedReadyTicket(t, storeId, "A17", 30)

    const beforeWrite = await asOwner.query(api.kitchenTickets.getForDisplay, {
      storeId,
    })
    expect(beforeWrite.ready).toHaveLength(0)

    await asOwner.mutation(api.stores.updateDisplayConfig, {
      id: storeId,
      displayConfig: { autoDismissEnabled: true, autoDismissMinutes: 45 },
    })

    const afterWrite = await asOwner.query(api.kitchenTickets.getForDisplay, {
      storeId,
    })
    expect(afterWrite.displayConfig).toEqual({
      autoDismissEnabled: true,
      autoDismissMinutes: 45,
    })
    expect(afterWrite.ready.map((ticket) => ticket.orderNumber)).toEqual(["A17"])
  })

  test("switched off, a long-ready order stays on the screen", async () => {
    // The setting that matters most to the customer standing in front of it.
    // An establishment that hands orders over by name, not by a screen the
    // staff clear, needs the number to survive until somebody presses
    // "Récupéré" — however long the queue takes.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedOwner(t, [storeId])
    await seedReadyTicket(t, storeId, "B04", 90)

    await asOwner.mutation(api.stores.updateDisplayConfig, {
      id: storeId,
      displayConfig: { autoDismissEnabled: false, autoDismissMinutes: 15 },
    })

    const display = await asOwner.query(api.kitchenTickets.getForDisplay, {
      storeId,
    })
    expect(display.displayConfig.autoDismissEnabled).toBe(false)
    expect(display.ready.map((ticket) => ticket.orderNumber)).toEqual(["B04"])
  })

  test("stores nothing, and the query's own default applies", async () => {
    // The state every establishment is in until an owner opens the tab, and
    // the reason the missing writer was a defect rather than a tidy-up.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedOwner(t, [storeId])
    await seedReadyTicket(t, storeId, "C01", 2)
    await seedReadyTicket(t, storeId, "C02", 30)

    const display = await asOwner.query(api.kitchenTickets.getForDisplay, {
      storeId,
    })

    expect(display.displayConfig).toEqual(QUERY_DEFAULT)
    // Two minutes old stays, thirty minutes old is gone — fifteen, unset.
    expect(display.ready.map((ticket) => ticket.orderNumber)).toEqual(["C01"])
  })

  test("clearing the setting returns the screen to that default", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedOwner(t, [storeId])
    await seedReadyTicket(t, storeId, "D09", 30)

    await asOwner.mutation(api.stores.updateDisplayConfig, {
      id: storeId,
      displayConfig: { autoDismissEnabled: false, autoDismissMinutes: 15 },
    })
    await asOwner.mutation(api.stores.updateDisplayConfig, { id: storeId })

    const display = await asOwner.query(api.kitchenTickets.getForDisplay, {
      storeId,
    })
    expect(display.displayConfig).toEqual(QUERY_DEFAULT)
    expect(display.ready).toHaveLength(0)
  })

  /**
   * The range guard, from the screen's side.
   *
   * `v.number()` accepts `0`, negatives, `NaN` and `Infinity`, and Convex
   * stores the float64 specials verbatim. `getForDisplay` turns whatever is
   * stored into `readyAt > now - minutes * 60_000`: zero and negatives keep
   * only tickets that became ready in the future, and `NaN` makes every
   * comparison false — each of them empties the ready column of the
   * customer-facing screen, which is the failure this whole setting was
   * restored to prevent, reached through the writer instead of around it.
   * `Infinity` is refused for a different reason: it does not blank the screen
   * but silently duplicates `autoDismissEnabled: false`.
   *
   * The assertion that matters is not the stored number. It is that the order
   * is still on the wall afterwards.
   */
  describe("refuses a window that would empty the screen", () => {
    for (const [label, autoDismissMinutes] of [
      ["zero", 0],
      ["a negative", -30],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["beyond the maximum", 100_000],
    ] as const) {
      test(`${label} leaves the ready order on the screen`, async () => {
        const t = newHarness()
        const storeId = await seedStore(t)
        const asOwner = await seedOwner(t, [storeId])
        await seedReadyTicket(t, storeId, "E42", 5)

        await expect(
          asOwner.mutation(api.stores.updateDisplayConfig, {
            id: storeId,
            displayConfig: { autoDismissEnabled: true, autoDismissMinutes },
          })
        ).rejects.toThrow(/invalid_display_config/)

        const display = await asOwner.query(api.kitchenTickets.getForDisplay, {
          storeId,
        })
        // Nothing was written, so the screen is still on the query's default
        // and the customer's order is still showing.
        expect(display.displayConfig).toEqual(QUERY_DEFAULT)
        expect(display.ready.map((ticket) => ticket.orderNumber)).toEqual(["E42"])
      })
    }

    test("a refusal writes neither the setting nor an audit entry", async () => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const asOwner = await seedOwner(t, [storeId])

      await expect(
        asOwner.mutation(api.stores.updateDisplayConfig, {
          id: storeId,
          displayConfig: { autoDismissEnabled: true, autoDismissMinutes: 0 },
        })
      ).rejects.toThrow()

      const store = await t.run((ctx) => ctx.db.get(storeId))
      expect(store?.displayConfig).toBeUndefined()
      const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
      expect(entries).toHaveLength(0)
    })

    test("the boundaries themselves are accepted", async () => {
      // A guard that refuses its own endpoints is an off-by-one nobody notices
      // until an owner picks the value the form offers.
      const t = newHarness()
      const storeId = await seedStore(t)
      const asOwner = await seedOwner(t, [storeId])

      for (const autoDismissMinutes of [1, 240]) {
        await asOwner.mutation(api.stores.updateDisplayConfig, {
          id: storeId,
          displayConfig: { autoDismissEnabled: true, autoDismissMinutes },
        })
        const display = await asOwner.query(api.kitchenTickets.getForDisplay, {
          storeId,
        })
        expect(display.displayConfig.autoDismissMinutes).toBe(autoDismissMinutes)
      }
    })
  })

  test("leaves the audit trail an entry", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedOwner(t, [storeId])

    await asOwner.mutation(api.stores.updateDisplayConfig, {
      id: storeId,
      displayConfig: { autoDismissEnabled: true, autoDismissMinutes: 30 },
    })

    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    expect(entries.some((e) => e.details?.includes("updateDisplayConfig"))).toBe(
      true
    )
  })
})
