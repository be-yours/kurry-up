// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The seam #375 lived between: `issueInvoiceForOrder` refuses silently by
 * design, and the admin was promised as the surface that says so. This
 * crosses the whole path a seller-incomplete deployment takes — money in, no
 * invoice, the reason on the order — and then the way out: the owner saves
 * the seller identity through `globalSettings.upsert` (which accepted no
 * `seller` at all before this test's fix) and issues the missed invoice.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Role = "super_admin" | "client_admin" | "manager" | "kitchen" | "customer"

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const harnesses: ReturnType<typeof convexTest>[] = []

afterEach(async () => {
  for (const t of harnesses) {
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
      slug: "chez-luigi",
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

async function seedGlobalSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: {
        dineIn: true,
        takeaway: true,
        delivery: true,
        clickAndCollect: true,
      },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
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

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  price = 1_200
) {
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
      price,
      taxRate: 10,
      images: [],
      options: [],
      allergens: [],
      tags: [],
      isActive: true,
      isFeatured: false,
      sortOrder: 0,
      source: "manual",
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

function orderArgs(storeId: Id<"stores">, productId: Id<"products">, price = 1_200) {
  return {
    storeId,
    customerInfo: { name: "Camille", email: "camille@example.com" },
    items: [
      {
        productId,
        productName: "Margherita",
        quantity: 1,
        unitPrice: price,
        selectedOptions: [],
        subtotal: price,
      },
    ],
    type: "pickup" as const,
  }
}

describe("what a paid order says about its invoice", () => {
  test("a seller-incomplete deployment reports the refusal, and completing the identity opens the way out", async () => {
    const t = newHarness()
    await seedGlobalSettings(t)
    const storeId = await seedStore(t)
    const productId = await seedProduct(t, storeId)

    const orderId = (await t.mutation(
      api.orders.create,
      orderArgs(storeId, productId)
    )) as Id<"orders">

    const asManager = await seedUser(t, "user:m1", "manager", [storeId])
    await asManager.mutation(api.orders.markCashPaid, { orderId })

    // Money in, no invoice: the settlement path refused silently — by design —
    // and the order the admin reads must carry the reason.
    const refused = await asManager.query(api.orders.getById, { id: orderId })
    expect(refused?.invoiceNumber).toBeNull()
    expect(refused?.invoiceRefusal).toBe("seller_incomplete")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("invoices").collect()).toHaveLength(0)
    })

    // The way out: the owner saves the seller identity. `upsert` accepted no
    // `seller` argument at all before #375 — the state was unfixable from
    // inside the product.
    const asOwner = await seedUser(t, "user:o1", "client_admin", [storeId])
    await asOwner.mutation(api.globalSettings.upsert, {
      seller: { legalName: "SARL Chez Luigi" },
    })

    // The refusal is computed on read, never persisted: it clears by itself.
    const issuable = await asManager.query(api.orders.getById, { id: orderId })
    expect(issuable?.invoiceRefusal).toBeNull()
    expect(issuable?.invoiceNumber).toBeNull()

    // The catch-up mutation built for exactly this order issues the invoice…
    const issued = await asOwner.mutation(api.invoices.issueForOrder, { orderId })
    expect(issued.issued).toBe(true)

    // …and the order now names its fiscal document.
    const invoiced = await asManager.query(api.orders.getById, { id: orderId })
    expect(invoiced?.invoiceNumber).toMatch(/^FA-\d{4}-\d{6}$/)
    expect(invoiced?.invoiceRefusal).toBeNull()
  })
})
