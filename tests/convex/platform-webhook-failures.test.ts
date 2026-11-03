// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The dead-letter queue for delivery-platform webhooks.
 *
 * It exists because the handlers used to guess. When the follow-up fetch to
 * Uber failed, an order was assigned to `allIntegrations[0]` — on a
 * multi-location account, one owner's order in another owner's kitchen, priced
 * at zero. The alternative to guessing is refusing, and a refusal is only
 * better than a guess if somebody can see it. That is what this table is for,
 * so the queue being readable is part of the fix, not a nicety.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")
const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []
function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}
afterEach(() => {
  harnesses.length = 0
})

/** A signed-in member of `role`, attached to `storeId`. */
async function seedMember(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  role: "manager" | "kitchen" | "waiter" | "delivery",
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: `user:${role}`,
      role,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: `user:${role}` })
}

async function seedStoreAndAdmin(t: ReturnType<typeof convexTest>) {
  const storeId = await t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:admin",
      role: "client_admin" as const,
      storeIds: [storeId as Id<"stores">],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return { storeId, asAdmin: t.withIdentity({ subject: "user:admin" }) }
}

describe("the queue an operator actually reads", () => {
  test("lists what is still open, and nothing that has been dealt with", async () => {
    // `resolvedAt` is optional, and this reads it through an index. An index
    // `eq` on an absent optional field is exactly the kind of query that
    // silently returns nothing, which would make the whole surface useless
    // while looking like an empty queue — i.e. like good news.
    const t = newHarness()
    const { asAdmin } = await seedStoreAndAdmin(t)

    await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "unidentified_store" as const,
      detail: "still open",
      rawBody: '{"event_type":"orders.notification"}',
    })
    const dealtWith = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "deliveroo" as const,
      reason: "unknown_store" as const,
      detail: "already handled",
    })
    await t.run((ctx) => ctx.db.patch(dealtWith, { resolvedAt: NOW, resolvedBy: "user:admin" }))

    const open = await asAdmin.query(api.platformWebhookFailures.listUnresolved, {})
    expect(open).toHaveLength(1)
    expect(open[0].detail).toBe("still open")
    /* NOT the body (#614). It is the verbatim platform payload — the diner's
       name, address and telephone — and this table has no `storeId`, so a list
       read is a read of every establishment at once. What the list carries is
       whether a body exists, so the panel knows whether offering « Voir la
       charge utile » would open an empty dialog. */
    expect(open[0]).not.toHaveProperty("rawBody")
    expect(open[0].hasRawBody).toBe(true)
  })

  test("the body is still kept verbatim, and reachable by an admin", async () => {
    // Anti-vacuity for the projection above: dropping the column outright would
    // satisfy it and lose the replay the queue exists for.
    const t = newHarness()
    const { asAdmin } = await seedStoreAndAdmin(t)
    const id = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "unidentified_store" as const,
      rawBody: '{"event_type":"orders.notification"}',
    })

    const payload = await asAdmin.query(api.platformWebhookFailures.getRawBody, { id })
    expect(payload?.rawBody).toContain("orders.notification")
  })

  test("marking one resolved takes it off the queue and records who", async () => {
    const t = newHarness()
    const { asAdmin } = await seedStoreAndAdmin(t)
    const id = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "fetch_failed" as const,
      detail: "429 from Uber",
    })

    await asAdmin.mutation(api.platformWebhookFailures.markResolved, { id })

    const open = await asAdmin.query(api.platformWebhookFailures.listUnresolved, {})
    expect(open).toHaveLength(0)
    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.resolvedBy).toBe("user:admin")
    expect(row?.resolvedAt).toBeTypeOf("number")
  })

  test("an anonymous caller cannot read it — these rows carry raw payloads", async () => {
    const t = newHarness()
    await seedStoreAndAdmin(t)
    await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "unidentified_store" as const,
    })
    await expect(
      t.query(api.platformWebhookFailures.listUnresolved, {})
    ).rejects.toThrow()
  })

  test("a very large body is truncated rather than stored whole", async () => {
    // A flood of malformed events must not be able to fill the deployment.
    const t = newHarness()
    const { asAdmin } = await seedStoreAndAdmin(t)
    await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "processing_failed" as const,
      rawBody: "x".repeat(100_000),
    })
    const [row] = await asAdmin.query(api.platformWebhookFailures.listUnresolved, {})
    const payload = await asAdmin.query(api.platformWebhookFailures.getRawBody, {
      id: row._id,
    })
    expect(payload!.rawBody!.length).toBeLessThanOrEqual(20_000)
  })
})

/**
 * WHO MAY READ THE QUEUE, AND WHAT (#614).
 *
 * It was gated on `orders:read`, which six roles hold — `kitchen`, `waiter` and
 * `delivery` among them. The rows are verbatim Uber Eats and Deliveroo payloads
 * carrying the diner's name, delivery address and telephone, and this table has
 * no `storeId`, so the guard could not be scoped either: a waiter attached to
 * one location received every unresolved event of every location. The screen's
 * nav entry gates on `stores:read`, three roles — the UI was hiding what the
 * server handed out.
 */
describe("who may read the queue", () => {
  for (const role of ["kitchen", "waiter", "delivery"] as const) {
    test(`a ${role} account is refused the list`, async () => {
      const t = newHarness()
      const { storeId } = await seedStoreAndAdmin(t)
      await t.mutation(internal.platformWebhookFailures.record, {
        platform: "deliveroo" as const,
        reason: "unidentified_store" as const,
        rawBody: '{"customer":{"name":"Camille","phone":"+33600000000"}}',
      })

      const asRole = await seedMember(t, storeId as Id<"stores">, role)
      await expect(
        asRole.query(api.platformWebhookFailures.listUnresolved, {})
      ).rejects.toThrow(/stores:read/)
    })

    test(`a ${role} account cannot clear the operator's queue`, async () => {
      const t = newHarness()
      const { storeId } = await seedStoreAndAdmin(t)
      const id = await t.mutation(internal.platformWebhookFailures.record, {
        platform: "uberEats" as const,
        reason: "fetch_failed" as const,
      })

      const asRole = await seedMember(t, storeId as Id<"stores">, role)
      await expect(
        asRole.mutation(api.platformWebhookFailures.markResolved, { id })
      ).rejects.toThrow()

      const row = await t.run((ctx) => ctx.db.get(id))
      expect(row?.resolvedAt).toBeUndefined()
    })
  }

  test("a manager runs the queue — reads it and clears it", async () => {
    // Anti-vacuity, and the reason the write gate is a compound: a gate only
    // `client_admin` satisfies would leave a manager looking at a « Marquer
    // traité » button that always refuses.
    const t = newHarness()
    const { storeId } = await seedStoreAndAdmin(t)
    const id = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "fetch_failed" as const,
    })

    const asManager = await seedMember(t, storeId as Id<"stores">, "manager")
    expect(await asManager.query(api.platformWebhookFailures.listUnresolved, {})).toHaveLength(1)

    await asManager.mutation(api.platformWebhookFailures.markResolved, { id })
    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.resolvedBy).toBe("user:manager")
  })

  test("a manager may run the queue and not read a payload", async () => {
    // `customers:manage` is `super_admin` and `client_admin` only — the same
    // gate the « Données personnelles » screen uses, because it is the same
    // data.
    const t = newHarness()
    const { storeId } = await seedStoreAndAdmin(t)
    const id = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "deliveroo" as const,
      reason: "unidentified_store" as const,
      rawBody: '{"customer":{"name":"Camille"}}',
    })

    const asManager = await seedMember(t, storeId as Id<"stores">, "manager")
    await expect(
      asManager.query(api.platformWebhookFailures.getRawBody, { id })
    ).rejects.toThrow(/customers:manage/)
  })

  test("an anonymous caller is refused the payload too", async () => {
    const t = newHarness()
    await seedStoreAndAdmin(t)
    const id = await t.mutation(internal.platformWebhookFailures.record, {
      platform: "uberEats" as const,
      reason: "unidentified_store" as const,
      rawBody: "{}",
    })
    await expect(
      t.query(api.platformWebhookFailures.getRawBody, { id })
    ).rejects.toThrow()
  })
})
