// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Axis 4 (authorisation).
 *
 * `privacyScope` claims two gates — the role's grant, then the modules on the
 * profile — and claims an erasure reaches only the establishments the caller
 * administers. Both claims are tested here, plus what the export hands over.
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

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  userId: string,
  role: "client_admin" | "manager" | "super_admin" | "waiter",
  storeIds: Id<"stores">[],
  permissions: string[] = []
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId,
      role: role as "client_admin",
      storeIds,
      permissions,
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: userId })
}

function orderRow(storeId: Id<"stores">, n: number, extra = {}) {
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
    createdAt: NOW + n,
    updatedAt: NOW + n,
    ...extra,
  }
}

async function eraseFully(
  t: ReturnType<typeof convexTest>,
  caller: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  subject: { email?: string; fingerprint?: string }
) {
  let result = await caller.mutation(api.privacy.eraseDataSubject, subject)
  let guard = 0
  while (!result.complete) {
    if (guard++ > 100) throw new Error("erasure never completed")
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

describe("who may answer a data-subject request", () => {
  test("a manager and an unauthenticated caller are both refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Napoli")
    const manager = await seedProfile(t, "chef", "manager", [storeId])

    await expect(manager.mutation(api.privacy.eraseDataSubject, { email: EMAIL })).rejects.toThrow()
    await expect(manager.query(api.privacy.exportDataSubject, { email: EMAIL })).rejects.toThrow()
    await expect(manager.query(api.privacy.previewErasure, { email: EMAIL })).rejects.toThrow()
    await expect(manager.mutation(api.privacy.setRetention, { customerDataDays: 90, enabled: true })).rejects.toThrow()

    // No identity at all.
    await expect(t.mutation(api.privacy.eraseDataSubject, { email: EMAIL })).rejects.toThrow()
    await expect(t.query(api.privacy.exportDataSubject, { email: EMAIL })).rejects.toThrow()
  })

  test("continueErasure is not on the public api surface", async () => {
    const publicPrivacy = Object.keys(
      (api as unknown as { privacy: Record<string, unknown> }).privacy
    )
    expect(publicPrivacy).not.toContain("continueErasure")
    expect(publicPrivacy).not.toContain("sweepExpiredCustomerData")
  })

  test("the module list does not narrow an administrator, and the code says so", async () => {
    // A DECISION, NOT A HOLE. `profileAllowsPermission` exempts admins by
    // design — `MODULE_EXEMPT_ROLES` — so that a stray module list on an
    // owner's profile cannot shut them out of their own restaurant, and
    // `customers:manage` is held by admins alone. Taking the "Clients" module
    // away from an administrator therefore takes nothing away here.
    //
    // This test exists because the comment in `privacyScope` used to claim two
    // gates bound where only one does. It pins the real behaviour so the claim
    // cannot quietly come back.
    const t = newHarness()
    const storeId = await seedStore(t, "Napoli")
    const restricted = await seedProfile(t, "restricted", "client_admin", [storeId], [
      "kitchen",
      "products",
    ])

    await t.run((ctx) => ctx.db.insert("orders", orderRow(storeId, 1)))

    const result = await eraseFully(t, restricted, { email: EMAIL })
    expect(result.complete).toBe(true)

    // A manager holding the very same module list is still refused, because
    // the ROLE gate is the one that binds.
    const manager = await seedProfile(t, "chef2", "manager", [storeId], ["orders"])
    await expect(
      manager.mutation(api.privacy.eraseDataSubject, { email: EMAIL })
    ).rejects.toThrow()
  })

  test("an administrator of one establishment cannot reach into another", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Napoli Oberkampf")
    const storeB = await seedStore(t, "Napoli Bastille")
    // She administers A. B is somebody else's dining room.
    const adminA = await seedProfile(t, "admin-a", "client_admin", [storeA])

    const seeded = await t.run(async (ctx) => {
      await ctx.db.insert("orders", orderRow(storeA, 1, { customerId: "auth|marie" }))
      const orderB = await ctx.db.insert("orders", orderRow(storeB, 2, { customerId: "auth|marie" }))
      const categoryId = await ctx.db.insert("categories", {
        storeId: storeB,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const productB = await ctx.db.insert("products", {
        storeId: storeB,
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
      // A favourite she saved at the OTHER establishment.
      const favouriteB = await ctx.db.insert("favorites", {
        userId: "auth|marie",
        productId: productB,
        storeId: storeB,
        createdAt: NOW,
      })
      return { orderB, favouriteB }
    })

    const report = await eraseFully(t, adminA, { email: EMAIL })
    expect(report.report.storeIds, "the report names only A").toEqual([storeA])

    const left = await t.run(async (ctx) => ({
      orderB: await ctx.db.get(seeded.orderB),
      favouriteB: await ctx.db.get(seeded.favouriteB),
    }))

    // Store B's order is out of reach, and so is a row she saved there. The
    // walk's global steps — saved addresses, profile, favourites — are gated on
    // reaching every establishment, because nothing can partition them by
    // store and a partial scope would let the administrator of one restaurant
    // delete a row belonging to another while the report named only their own.
    expect(left.orderB?.customerInfo.email).toBe(EMAIL_AS_TYPED)
    expect(
      left.favouriteB,
      "an administrator of A deleted a row belonging to establishment B"
    ).not.toBeNull()

    // And it is said out loud rather than left as a silent zero, so the
    // operator does not tell the diner the job is finished.
    expect(report.report.retained.map((r) => r.table)).toContain("customerAddresses")
  })

  test("the export does not hand one establishment a diner's rows from another", async () => {
    const t = newHarness()
    const storeA = await seedStore(t, "Napoli Oberkampf")
    const storeB = await seedStore(t, "Napoli Bastille")
    const adminA = await seedProfile(t, "admin-a", "client_admin", [storeA])

    await t.run(async (ctx) => {
      await ctx.db.insert("orders", orderRow(storeA, 1, { customerId: "auth|marie" }))
      const categoryId = await ctx.db.insert("categories", {
        storeId: storeB,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const productB = await ctx.db.insert("products", {
        storeId: storeB,
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
      await ctx.db.insert("favorites", {
        userId: "auth|marie",
        productId: productB,
        storeId: storeB,
        createdAt: NOW,
      })
    })

    const bundle = await adminA.query(api.privacy.exportDataSubject, { email: EMAIL })
    const favourites = (bundle.records.find((r) => r.table === "favorites")?.rows ??
      []) as Array<{ storeId: string }>

    expect(
      favourites.filter((f) => String(f.storeId) === String(storeB)),
      "rows from an establishment this caller does not administer"
    ).toEqual([])
  })
})
