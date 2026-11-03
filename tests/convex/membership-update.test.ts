// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Editing a membership that has already been accepted.
 *
 * `acceptInvitation` provisions the profile and `toggleActive`/`remove` take it
 * back, but `update` — the "Modifier le membre" dialog, the mutation an owner
 * actually uses — patched the roster row and touched nothing else. Every guard
 * resolves rights from `userProfiles` and none of them reads `teamMembers`, so
 * unticking a module, demoting a manager or moving someone to another
 * restaurant redrew the team screen and left the person's real access intact.
 *
 * The tests here are written from the owner's side: they perform the edit
 * through the public mutation, then ask the MEMBER to do something, because
 * "the profile row changed" is not the claim being made — "the member is now
 * refused" is.
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


async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: string,
  storeIds: Id<"stores">[]
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

/**
 * A member who has already accepted, which is the only state this file is
 * about: the roster row is bound to an account and a profile exists behind it.
 */
async function seedAcceptedMember(
  t: ReturnType<typeof convexTest>,
  opts: {
    subject: string
    token: string
    storeId?: Id<"stores">
    allStores?: boolean
    role?: "manager" | "kitchen" | "waiter" | "delivery"
    permissions?: string[]
  }
) {
  await t.run((ctx) =>
    ctx.db.insert("teamMembers", {
      storeId: opts.storeId,
      allStores: opts.allStores ?? false,
      name: "Yanis Moreau",
      email: `${opts.subject}@resto.example`,
      role: opts.role ?? "manager",
      permissions: opts.permissions ?? [],
      invitationStatus: "pending" as const,
      invitationToken: opts.token,
      invitedAt: Date.now(),
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )

  const asMember = t.withIdentity({ subject: opts.subject })
  await asMember.mutation(api.teamMembers.acceptInvitation, { token: opts.token })

  const memberId = await t.run(async (ctx) => {
    const row = await ctx.db
      .query("teamMembers")
      .withIndex("by_userId", (q) => q.eq("userId", opts.subject))
      .first()
    return row!._id
  })

  return { asMember, memberId }
}

function profileOf(t: ReturnType<typeof convexTest>, subject: string) {
  return t.run((ctx) =>
    ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", subject))
      .first()
  )
}

/** A harness bound to one identity, which is what every probe here acts through. */
type TestClient = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>

/** The manager-only action the module tests already lean on. */
function createCategory(client: TestClient, storeId: Id<"stores">, name = "Entrées") {
  return client.mutation(api.categories.create, {
    storeId,
    name,
    slug: name.toLowerCase(),
    sortOrder: 1,
    isActive: true,
  })
}

// ============================================================================
// The modules, after acceptance
// ============================================================================

describe("editing the module list", () => {
  test("unticking a module refuses the member who had it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-untick",
      storeId,
      role: "manager",
      permissions: ["dashboard", "orders", "products"],
    })

    // It worked while the box was ticked.
    await expect(createCategory(asMember, storeId)).resolves.toBeDefined()

    // The owner unticks "Produits / Menu". Before this fix the dialog reported
    // success, the roster row changed, and the member carried on creating
    // categories exactly as before.
    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      role: "manager",
      permissions: ["dashboard", "orders"],
    })

    await expect(createCategory(asMember, storeId, "Plats")).rejects.toThrow(
      /module_denied/
    )
  })

  test("ticking a module grants it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-tick",
      storeId,
      role: "manager",
      permissions: ["dashboard", "orders"],
    })

    await expect(createCategory(asMember, storeId)).rejects.toThrow(/module_denied/)

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      permissions: ["dashboard", "orders", "products"],
    })

    await expect(createCategory(asMember, storeId, "Plats")).resolves.toBeDefined()
  })

  test("clearing every box means unrestricted, as it does on the invitation", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-clear",
      storeId,
      role: "manager",
      permissions: ["dashboard", "orders"],
    })

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      permissions: [],
    })

    // An empty list is "no restriction recorded", never "nothing allowed" —
    // every profile shipped before modules existed has one.
    await expect(createCategory(asMember, storeId)).resolves.toBeDefined()
  })
})

// ============================================================================
// The role, after acceptance
// ============================================================================

describe("editing the role", () => {
  test("a demotion actually demotes", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-demote",
      storeId,
      role: "manager",
    })

    await expect(createCategory(asMember, storeId)).resolves.toBeDefined()

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      role: "waiter",
    })

    expect((await profileOf(t, "user-yanis"))?.role).toBe("waiter")

    // `products:write` belongs to the manager role and not to the waiter, so
    // this is the ROLE gate refusing, not the module gate.
    await expect(createCategory(asMember, storeId, "Plats")).rejects.toThrow(
      /permission_denied/
    )
  })

  test("a promotion takes effect", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-promote",
      storeId,
      role: "waiter",
    })

    await expect(createCategory(asMember, storeId)).rejects.toThrow(/permission_denied/)

    await asOwner.mutation(api.teamMembers.update, { id: memberId, role: "manager" })

    await expect(createCategory(asMember, storeId, "Plats")).resolves.toBeDefined()
  })

  test("an edit in one restaurant cannot demote someone in another", async () => {
    const t = newHarness()
    const paris = await seedStore(t, "Luigi Paris")
    const lyon = await seedStore(t, "Luigi Lyon")
    const asOwner = await seedProfile(t, "user-owner", "super_admin", [])

    const { memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-paris",
      storeId: paris,
      role: "manager",
    })
    // A second position, accepted after the first.
    await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        storeId: lyon,
        allStores: false,
        name: "Yanis Moreau",
        email: "user-yanis@resto.example",
        role: "manager" as const,
        permissions: [],
        invitationStatus: "pending" as const,
        invitationToken: "tok-lyon",
        invitedAt: Date.now(),
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t
      .withIdentity({ subject: "user-yanis" })
      .mutation(api.teamMembers.acceptInvitation, { token: "tok-lyon" })

    // Paris demotes him to waiter. Lyon still calls him a manager, and the
    // profile carries ONE role — so the higher one has to win, or Lyon loses
    // its manager because of a decision Paris made.
    await asOwner.mutation(api.teamMembers.update, { id: memberId, role: "waiter" })

    const profile = await profileOf(t, "user-yanis")
    expect(profile?.role).toBe("manager")
    expect(profile?.storeIds.sort()).toEqual([paris, lyon].sort())
  })
})

// ============================================================================
// The establishment, after acceptance
// ============================================================================

describe("moving a member", () => {
  test("the restaurant they left is taken away, the one they joined is granted", async () => {
    const t = newHarness()
    const paris = await seedStore(t, "Luigi Paris")
    const lyon = await seedStore(t, "Luigi Lyon")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [paris, lyon])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-move",
      storeId: paris,
      role: "manager",
    })

    await asOwner.mutation(api.teamMembers.update, { id: memberId, storeId: lyon })

    const profile = await profileOf(t, "user-yanis")
    expect(profile?.storeIds).toEqual([lyon])

    // The half that matters: a move used to be an ADDITION as far as access was
    // concerned, because nothing ever removed Paris.
    await expect(createCategory(asMember, paris)).rejects.toThrow(/store_not_granted/)
    await expect(createCategory(asMember, lyon)).resolves.toBeDefined()
  })

  test("deactivating through update revokes, as toggling does", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { asMember, memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-deactivate",
      storeId,
      role: "manager",
    })

    await asOwner.mutation(api.teamMembers.update, { id: memberId, isActive: false })

    // `toggleActive` revoked and `update` did not, so the same intent expressed
    // through the other door left the member with everything.
    const profile = await profileOf(t, "user-yanis")
    expect(profile?.role).toBe("customer")
    expect(profile?.storeIds).toEqual([])

    await expect(createCategory(asMember, storeId)).rejects.toThrow()
  })
})

// ============================================================================
// What an edit must NOT touch
// ============================================================================

describe("what the roster has no say over", () => {
  test("an owner's own authority is not the team screen's to lower", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asRoot = await seedProfile(t, "user-root", "super_admin", [])

    // A client admin who also appears on a roster row for their own store.
    await seedProfile(t, "user-boss", "client_admin", [storeId])
    const memberId = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        storeId,
        allStores: false,
        name: "Claire Petit",
        email: "claire@resto.example",
        role: "waiter" as const,
        permissions: [],
        userId: "user-boss",
        invitationStatus: "accepted" as const,
        invitedAt: Date.now(),
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asRoot.mutation(api.teamMembers.update, {
      id: memberId,
      role: "delivery",
      permissions: ["orders"],
    })

    const profile = await profileOf(t, "user-boss")
    expect(profile?.role).toBe("client_admin")
    expect(profile?.storeIds).toEqual([storeId])
    expect(profile?.permissions).toEqual([])
  })

  test("editing an invitation nobody has accepted writes no profile", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])

    const memberId = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        storeId,
        allStores: false,
        name: "Claire Petit",
        email: "claire@resto.example",
        role: "manager" as const,
        permissions: ["dashboard", "orders", "products"],
        invitationStatus: "pending" as const,
        invitationToken: "tok-pending",
        invitedAt: Date.now(),
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      permissions: ["dashboard", "orders"],
    })

    const profiles = await t.run((ctx) => ctx.db.query("userProfiles").collect())
    expect(profiles.map((p) => p.userId)).toEqual(["user-owner"])

    // And the edit is what acceptance goes on to read.
    await t
      .withIdentity({ subject: "user-claire" })
      .mutation(api.teamMembers.acceptInvitation, { token: "tok-pending" })
    expect((await profileOf(t, "user-claire"))?.permissions?.sort()).toEqual([
      "dashboard",
      "orders",
    ])
  })
})

// ============================================================================
// The trail
// ============================================================================

describe("audit", () => {
  test("a roster edit is recorded, and says it came from the roster", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-trail",
      storeId,
      role: "manager",
      permissions: ["dashboard", "orders", "products"],
    })

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      role: "waiter",
      permissions: ["dashboard", "orders"],
    })

    const entries = await t.run(async (ctx) => {
      const rows = await ctx.db.query("systemAuditLog").collect()
      return rows
        .filter((r) => String(r.action).startsWith("access_"))
        .map((r) => ({
          action: r.action,
          performedBy: r.performedBy,
          targetUserId: r.targetUserId,
          details: JSON.parse(String(r.details)),
        }))
    })

    // Two: the acceptance, then the edit.
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      action: "access_changed",
      performedBy: "user-owner",
      targetUserId: "user-yanis",
    })
    expect(entries[1]?.details).toMatchObject({
      operation: "membership_updated",
      changes: {
        role: { from: "manager", to: "waiter" },
        permissions: { removed: ["products"] },
      },
    })
  })

  test("re-saving a member unchanged writes nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedProfile(t, "user-owner", "client_admin", [storeId])
    const { memberId } = await seedAcceptedMember(t, {
      subject: "user-yanis",
      token: "tok-noop",
      storeId,
      role: "manager",
      permissions: ["dashboard", "orders"],
    })

    await asOwner.mutation(api.teamMembers.update, {
      id: memberId,
      role: "manager",
      permissions: ["dashboard", "orders"],
    })

    // Opening the dialog and pressing Save is a normal thing to do. A trail
    // that fills with "no change" is a trail nobody reads.
    const entries = await t.run(async (ctx) => {
      const rows = await ctx.db.query("systemAuditLog").collect()
      return rows.filter((r) => String(r.action).startsWith("access_"))
    })
    expect(entries).toHaveLength(1)
  })
})
