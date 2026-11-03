// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What a storefront visitor can do without a session.
 *
 * `contactMessages.create` and `emailSubscribers.subscribe` are public by
 * necessity and had no bound of any kind: `message` was an unbounded
 * `v.string()`, and nothing counted how often either was called. One loop could
 * fill a restaurant's inbox and its database.
 *
 * Driven through the real mutations, unauthenticated, because that is how they
 * are reached.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Mutations here queue work through `ctx.scheduler.runAfter`. A test finishes
 * in milliseconds and leaves it pending; whatever fires it next writes against
 * a transaction that closed, and because nothing awaits it that arrives as an
 * unhandled rejection — every assertion green and the run still exiting 1,
 * blaming whichever file happened to be running.
 *
 * Cancel rather than run: several of these hand off to actions, and an action
 * has no transaction for convex-test to record its completion in.
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
})


async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
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

const contact = (
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  over: { email?: string; message?: string; subject?: string } = {}
) =>
  t.mutation(api.contactMessages.create, {
    storeId,
    name: "Yanis",
    email: over.email ?? "yanis@resto.example",
    subject: over.subject ?? "Réservation",
    message: over.message ?? "Une table pour six samedi ?",
  })

describe("contactMessages.create", () => {
  test("accepts a message a person would write", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await expect(contact(t, storeId)).resolves.toBeDefined()
  })

  test("refuses a message no person would type", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    // The defect exactly: `v.string()` carries no length, so this was accepted
    // and stored.
    await expect(
      contact(t, storeId, { message: "x".repeat(5_001) })
    ).rejects.toThrow(/dépasse/)
  })

  test("stops one address after three in an hour", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    for (let i = 0; i < 3; i++) {
      await expect(contact(t, storeId), `message ${i + 1}`).resolves.toBeDefined()
    }
    await expect(contact(t, storeId)).rejects.toThrow(/Trop de requêtes/)

    // Refused means not stored — the point of the limit.
    const stored = await t.run((ctx) => ctx.db.query("contactMessages").collect())
    expect(stored).toHaveLength(3)
  })

  test("counts an address as one however it was typed", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await contact(t, storeId, { email: "yanis@resto.example" })
    await contact(t, storeId, { email: "Yanis@Resto.Example" })
    await contact(t, storeId, { email: "YANIS@RESTO.EXAMPLE" })

    // A limiter that disagrees on case is one Shift key from being no limiter.
    await expect(
      contact(t, storeId, { email: "yAnIs@ReStO.eXaMpLe" })
    ).rejects.toThrow(/Trop de requêtes/)
  })

  test("still bounds a flood that changes address every time", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    // The per-address window is trivially dodged. The per-restaurant one is
    // the one that cannot be, and it is why both exist.
    let refusedAt = 0
    for (let i = 0; i < 70; i++) {
      try {
        await contact(t, storeId, { email: `flood-${i}@example.test` })
      } catch {
        refusedAt = i
        break
      }
    }
    expect(refusedAt).toBe(60)
  })
})

describe("emailSubscribers.subscribe", () => {
  test("accepts a sign-up", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await expect(
      t.mutation(api.emailSubscribers.subscribe, {
        storeId,
        email: "yanis@resto.example",
      })
    ).resolves.toBeDefined()
  })

  test("bounds sign-ups arriving at one restaurant", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    let refusedAt = 0
    for (let i = 0; i < 110; i++) {
      try {
        await t.mutation(api.emailSubscribers.subscribe, {
          storeId,
          email: `flood-${i}@example.test`,
        })
      } catch (error) {
        // A duplicate address is a different refusal; only the limit counts.
        if (!/Trop de requêtes/.test(String(error))) throw error
        refusedAt = i
        break
      }
    }
    expect(refusedAt).toBe(100)
  })
})
