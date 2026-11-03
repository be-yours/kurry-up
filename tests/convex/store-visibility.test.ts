// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A draft establishment is not readable by the storefront (#224, #169).
 *
 * `stores.list` drops drafts — that is what keeps an unpublished restaurant out
 * of the selector, the header dropdown and the sitemap. `stores.getById` walked
 * straight past it: anyone who knew or guessed an id got the address, the
 * contact details, the `orderMode` and the `overrides` of an establishment its
 * owner had never published.
 *
 * It cannot simply be closed. The query is public because the storefront needs
 * it before anyone signs in — checkout, the contact page, the open/closed banner
 * — and it is also what the administration reads: the store detail page exists
 * to publish drafts, and the KDS reads its own establishment. `kitchen` and
 * `delivery` do not hold `stores:read`, so `getAdminById` is not an option for
 * them. So the rule is by *caller*, not by query.
 *
 * Closing `getById` left the same document reachable by its other name.
 * `getBySlug` had no filter at all, and a slug is the guessable half of the
 * pair — it is the restaurant's name. The rule belongs to the establishment,
 * not to the query that happens to find it, so both doors now apply it and the
 * last describe block here holds them to the same answer.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Role =
  | "super_admin"
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "delivery"
  | "customer"

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


const slugOf = (name: string) => name.toLowerCase().replace(/\s+/g, "-")

async function seedStore(
  t: ReturnType<typeof convexTest>,
  name: string,
  status: "draft" | "open" | "closed" | "temporarily_unavailable"
) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: slugOf(name),
      address: {
        street: "12 rue Oberkampf",
        city: "Paris",
        postalCode: "75011",
        country: "France",
      },
      phone: "+33145678901",
      email: "napoli@example.com",
      hours: [],
      status,
      orderMode: "manual" as const,
      // The commercial terms an owner sets while the place is still a draft.
      overrides: {
        minimumOrderAmount: 25,
        deliveryRadius: 8,
        deliveryFee: 3.5,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
  storeIds: Id<"stores">[] = []
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
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

describe("stores.getById — a draft", () => {
  test("is not handed to an anonymous visitor", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")

    expect(await t.query(api.stores.getById, { id: draft })).toBeNull()
  })

  test("is not handed to a signed-in customer", async () => {
    // Signing up on the storefront must not become a way to read an
    // establishment its owner has not published.
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const asCustomer = await seedUser(t, "camille", "customer")

    expect(await asCustomer.query(api.stores.getById, { id: draft })).toBeNull()
  })

  test("leaks no address, contact or order mode with it", async () => {
    // The fields the audit named. Asserted individually so a partial answer —
    // a stripped object rather than nothing — cannot pass.
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")

    const store = await t.query(api.stores.getById, { id: draft })

    expect(store?.address).toBeUndefined()
    expect(store?.phone).toBeUndefined()
    expect(store?.email).toBeUndefined()
    expect(store?.orderMode).toBeUndefined()
  })

  test("is still handed to the owner who has to publish it", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const asOwner = await seedUser(t, "marie", "client_admin", [draft])

    const store = await asOwner.query(api.stores.getById, { id: draft })
    expect(store?.name).toBe("Pizza Draft")
  })

  test("is still handed to a kitchen role", async () => {
    // The KDS reads its own establishment through this query, and `kitchen`
    // does not hold `stores:read` — `getAdminById` is closed to it. Locking
    // drafts to `stores:read` would take the kitchen screen down.
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const asKitchen = await seedUser(t, "pierre", "kitchen", [draft])

    const store = await asKitchen.query(api.stores.getById, { id: draft })
    expect(store?.name).toBe("Pizza Draft")
  })
})

describe("stores.getById — a published establishment", () => {
  test.each(["open", "closed", "temporarily_unavailable"] as const)(
    "stays readable by an anonymous visitor when %s",
    async (status) => {
      // The mirror, and the reason this is a caller rule rather than a closed
      // query: checkout, the contact page and the open/closed banner all read
      // it before anyone signs in. A `closed` restaurant still has a menu.
      const t = newHarness()
      const storeId = await seedStore(t, "Pizza Open", status)

      const store = await t.query(api.stores.getById, { id: storeId })
      expect(store?.name).toBe("Pizza Open")
      expect(store?.address.city).toBe("Paris")
    }
  )

  test("still hides the printer API key from an anonymous visitor", async () => {
    const t = newHarness()
    const storeId = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Pizza Open",
        slug: "pizza-open",
        address: {
          street: "12 rue Oberkampf",
          city: "Paris",
          postalCode: "75011",
          country: "France",
        },
        hours: [],
        status: "open" as const,
        printConfig: {
          provider: "star_cloud" as const,
          apiKey: "sk-printer-secret",
          triggers: ["confirmed" as const],
          paperSize: "80mm" as const,
          enabled: true,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const store = await t.query(api.stores.getById, { id: storeId })
    expect(store?.printConfig).toBeDefined()
    expect(store?.printConfig).not.toHaveProperty("apiKey")
  })
})

describe("stores.getBySlug — a draft", () => {
  // The slug is the half of the pair nobody has to guess: it is built from the
  // restaurant's name. Closing `getById` and leaving this open moved the leak
  // rather than fixing it.
  test("is not handed to an anonymous visitor", async () => {
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")

    expect(
      await t.query(api.stores.getBySlug, { slug: slugOf("Pizza Draft") })
    ).toBeNull()
  })

  test("is not handed to a signed-in customer", async () => {
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")
    const asCustomer = await seedUser(t, "camille", "customer")

    expect(
      await asCustomer.query(api.stores.getBySlug, {
        slug: slugOf("Pizza Draft"),
      })
    ).toBeNull()
  })

  test("leaks no address, contact, order mode or overrides with it", async () => {
    // The four the audit named, asserted one by one so a stripped object —
    // an answer rather than nothing — cannot pass.
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")

    const store = await t.query(api.stores.getBySlug, {
      slug: slugOf("Pizza Draft"),
    })

    expect(store?.address).toBeUndefined()
    expect(store?.phone).toBeUndefined()
    expect(store?.email).toBeUndefined()
    expect(store?.orderMode).toBeUndefined()
    expect(store?.overrides).toBeUndefined()
  })

  test("is still handed to the owner who has to publish it", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const asOwner = await seedUser(t, "marie", "client_admin", [draft])

    const store = await asOwner.query(api.stores.getBySlug, {
      slug: slugOf("Pizza Draft"),
    })
    expect(store?.name).toBe("Pizza Draft")
  })

  test("is still handed to a kitchen role", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Draft", "draft")
    const asKitchen = await seedUser(t, "pierre", "kitchen", [draft])

    const store = await asKitchen.query(api.stores.getBySlug, {
      slug: slugOf("Pizza Draft"),
    })
    expect(store?.name).toBe("Pizza Draft")
  })

  test("answers null for a slug no establishment carries", async () => {
    // The absent case and the refused case are the same answer, so knowing
    // whether a draft exists under a guessed name is not a thing this query
    // tells you either.
    const t = newHarness()
    await seedStore(t, "Pizza Draft", "draft")

    expect(
      await t.query(api.stores.getBySlug, { slug: "pizza-nonexistent" })
    ).toBeNull()
  })
})

describe("stores.getBySlug — a published establishment", () => {
  test.each(["open", "closed", "temporarily_unavailable"] as const)(
    "stays readable by an anonymous visitor when %s",
    async (status) => {
      // What the change must not break: `generateCmsMetadata` renders the
      // storefront's title and description from this query, server-side and
      // without an identity.
      const t = newHarness()
      await seedStore(t, "Pizza Open", status)

      const store = await t.query(api.stores.getBySlug, {
        slug: slugOf("Pizza Open"),
      })
      expect(store?.name).toBe("Pizza Open")
      expect(store?.address.city).toBe("Paris")
    }
  )

  test("still hides the printer API key from an anonymous visitor", async () => {
    const t = newHarness()
    await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: "Pizza Open",
        slug: "pizza-open",
        address: {
          street: "12 rue Oberkampf",
          city: "Paris",
          postalCode: "75011",
          country: "France",
        },
        hours: [],
        status: "open" as const,
        printConfig: {
          provider: "star_cloud" as const,
          apiKey: "sk-printer-secret",
          triggers: ["confirmed" as const],
          paperSize: "80mm" as const,
          enabled: true,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const store = await t.query(api.stores.getBySlug, { slug: "pizza-open" })
    expect(store?.printConfig).toBeDefined()
    expect(store?.printConfig).not.toHaveProperty("apiKey")
  })
})

describe("the two doors to one establishment", () => {
  // The decision this file exists to hold: visibility belongs to the
  // establishment, not to the query that finds it. Written as an agreement
  // between the two rather than twice over, so a rule added to one and not the
  // other fails here whatever that rule turns out to be.
  test.each(["draft", "open", "closed", "temporarily_unavailable"] as const)(
    "agree for an anonymous visitor when %s",
    async (status) => {
      const t = newHarness()
      const storeId = await seedStore(t, "Pizza Deux Portes", status)

      const byId = await t.query(api.stores.getById, { id: storeId })
      const bySlug = await t.query(api.stores.getBySlug, {
        slug: slugOf("Pizza Deux Portes"),
      })

      expect(bySlug).toEqual(byId)
    }
  )

  test("agree for the owner on a draft", async () => {
    const t = newHarness()
    const draft = await seedStore(t, "Pizza Deux Portes", "draft")
    const asOwner = await seedUser(t, "marie", "client_admin", [draft])

    const byId = await asOwner.query(api.stores.getById, { id: draft })
    const bySlug = await asOwner.query(api.stores.getBySlug, {
      slug: slugOf("Pizza Deux Portes"),
    })

    expect(bySlug).toEqual(byId)
    expect(byId?.name).toBe("Pizza Deux Portes")
  })
})

describe("teamMembers.list — the id it is given", () => {
  test("refuses an id this deployment never issued", async () => {
    // Why `/dashboard/team` has to verify the persisted selection before
    // querying: `v.id("stores")` refuses a well-formed id from another
    // deployment, Convex raises that out of `useQuery` during render, and the
    // page goes down rather than degrading. Same shape as #119.
    const t = newHarness()
    const asOwner = await seedUser(t, "marie", "client_admin")

    await expect(
      asOwner.query(api.teamMembers.list, {
        storeId: "j91b7c3d5e7f9g1h3j5k7m9n1p3q5r7s" as Id<"stores">,
      })
    ).rejects.toThrow()
  })

  test("answers for an establishment that exists", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizza Open", "open")
    const asOwner = await seedUser(t, "marie", "client_admin", [storeId])

    await expect(
      asOwner.query(api.teamMembers.list, { storeId })
    ).resolves.toEqual([])
  })
})
