// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A restaurant only takes the kinds of order it offers (#224).
 *
 * `globalSettings.services` is four switches on the settings page — sur place,
 * à emporter, livraison, click & collect. Nothing enforced them. The storefront
 * read `store.overrides.services`, which is `undefined` on every establishment
 * that has not customised it, and the selector treated `undefined` as "offer
 * everything". `orders.create` never looked at `args.type` at all, so even a
 * correctly hidden button was one persisted cart away from a delivery order at
 * a restaurant that does not deliver.
 *
 * These run the real mutation against the real schema. The client half is a
 * courtesy; this is the rule.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorCode } from "../../lib/convex-error"

/**
 * The refusal code a call produced, as the browser reads it off `data`.
 *
 * These assertions matched the thrown message, and the messages are French
 * customer copy now — copy gets edited, the `code` is the contract, and only
 * `ConvexError.data` survives Convex's production redaction. See
 * `packages/convex-functions/src/refusal.ts`.
 */
async function refusalCode(call: Promise<unknown>): Promise<string | null> {
  try {
    await call
    return null
  } catch (error) {
    return convexErrorCode(error)
  }
}


const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Services = {
  dineIn: boolean
  takeaway: boolean
  delivery: boolean
  clickAndCollect: boolean
}

const ALL_ON: Services = {
  dineIn: true,
  takeaway: true,
  delivery: true,
  clickAndCollect: true,
}

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Product, menu and store mutations queue work through `ctx.scheduler.runAfter`
 * — `scheduleMenuSync` puts the Uber Eats and Deliveroo syncs at a 5s delay on
 * every catalogue write. A test finishes in milliseconds and leaves them
 * pending; whatever fires them next writes against a transaction that closed,
 * and because nothing awaits it that arrives as an unhandled rejection. The run
 * then reports every test green and still exits 1, blaming whichever file
 * happened to be running rather than the one that queued the work.
 *
 * Cancel rather than run. `syncAllStores` is an `internalAction`, and running
 * one here is the disease, not the cure: convex-test patches its
 * `_scheduled_functions` row on completion, an action has no transaction to
 * patch it in, and the failure comes straight back. Finishing the queue with
 * `finishAllScheduledFunctions` was tried first and made it worse — ten
 * rejections in a run where leaving the jobs alone produced two.
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
        // Only what is still outstanding: cancelling a job that already
        // finished is not a no-op. Same guard as `cancelScheduled` in
        // campaign-send.test.ts, which reached this from the other direction.
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})


async function seedStore(
  t: ReturnType<typeof convexTest>,
  extra: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
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
      ...extra,
    })
  )
}

async function seedGlobalServices(
  t: ReturnType<typeof convexTest>,
  services: Services
) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 20,
      services,
      hours: [],
      delivery: { feeMode: "fixed" as const, fee: 0 },
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedProduct(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      storeId,
      name: "Pizzas",
      slug: "pizzas",
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("products", {
      storeId,
      categoryId,
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
  })
}

function orderArgs(
  storeId: Id<"stores">,
  productId: Id<"products">,
  type: "delivery" | "pickup" | "dine_in"
) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: 1,
        unitPrice: 1200,
        selectedOptions: [],
        subtotal: 1200,
      },
    ],
    type,
    ...(type === "delivery"
      ? {
          deliveryAddress: {
            street: "2 rue de Rivoli",
            city: "Paris",
            postalCode: "75001",
            country: "France",
          },
        }
      : {}),
  }
}

// ============================================================================

describe("orders.create — the services in force", () => {
  test("refuses a delivery order at a restaurant that does not deliver", async () => {
    const t = newHarness()
    await seedGlobalServices(t, { ...ALL_ON, delivery: false })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      refusalCode(
        t.mutation(api.orders.create, orderArgs(storeId, productId, "delivery"))
      )
    ).resolves.toBe("service_not_offered")

    const written = await t.run((ctx) => ctx.db.query("orders").collect())
    expect(written).toEqual([])
  })

  test("still takes the kinds it does offer", async () => {
    // The mirror. A rule that refuses everything would pass the test above.
    const t = newHarness()
    await seedGlobalServices(t, { ...ALL_ON, delivery: false })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, "pickup"))
    ).resolves.toBeDefined()
    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, "dine_in"))
    ).resolves.toBeDefined()
  })

  test("reads the establishment's override before the global switches", async () => {
    // One location of a chain stops delivering while the others carry on.
    const t = newHarness()
    await seedGlobalServices(t, ALL_ON)
    const storeId = await seedStore(t, {
      overrides: { services: { ...ALL_ON, delivery: false } },
    })
    const productId = await seedProduct(t, storeId)

    await expect(
      refusalCode(
        t.mutation(api.orders.create, orderArgs(storeId, productId, "delivery"))
      )
    ).resolves.toBe("service_not_offered")
  })

  test("lets an override re-open a service the global switches turned off", async () => {
    const t = newHarness()
    await seedGlobalServices(t, { ...ALL_ON, delivery: false })
    const storeId = await seedStore(t, { overrides: { services: ALL_ON } })
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, "delivery"))
    ).resolves.toBeDefined()
  })

  test("takes every kind when nothing has been configured", async () => {
    // No settings row at all — a deployment nobody has opened the settings
    // page on. Refusing everything there would close a working restaurant.
    const t = newHarness()
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    await expect(
      t.mutation(api.orders.create, orderArgs(storeId, productId, "delivery"))
    ).resolves.toBeDefined()
  })

  test("refuses every kind for a restaurant that has stopped serving", async () => {
    const t = newHarness()
    await seedGlobalServices(t, {
      dineIn: false,
      takeaway: false,
      delivery: false,
      clickAndCollect: false,
    })
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    for (const type of ["delivery", "pickup", "dine_in"] as const) {
      await expect(
        refusalCode(
          t.mutation(api.orders.create, orderArgs(storeId, productId, type))
        )
      ).resolves.toBe("service_not_offered")
    }
  })
})
