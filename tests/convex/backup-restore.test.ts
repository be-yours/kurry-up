// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A restored backup keeps its catalogue attached to its establishment (#224).
 *
 * `importTable` deletes a table and re-inserts its rows without their `_id` —
 * Convex will not let an insert choose one. So `stores` came back under **new**
 * ids while the products, menus, CMS pages and promotions restored after them
 * came back carrying the **old** `storeId`. Nothing objected: on a real
 * deployment `v.id("stores")` validates how an id is encoded, not that it
 * resolves. The deployment came up with every catalogue detached from its
 * establishment, and the owner's `userProfiles.storeIds` naming stores that no
 * longer existed — so they were locked out of every screen. Silently, and
 * irreversibly.
 *
 * Every id here is one this deployment actually issued: the fixture is seeded,
 * read back the way `exportTable` reads it, and fed to the import. That is the
 * real cycle, and it is the only way the ids survive the schema validator.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import {
  ARCHIVE_RELINK_TABLES,
  BACKUP_PAGE_SIZE,
  BACKUP_TABLES,
  DEFERRED_REMAP_TABLES,
} from "@be-yours/convex-functions/backupTables"
import { invoiceRefusal } from "@be-yours/convex-functions/invoices"

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

async function seedCatalogue(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
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
    const productId = await ctx.db.insert("products", {
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
    return { categoryId, productId }
  })
}

/**
 * What `exportTable` writes into the backup file: whole rows, `_id` included,
 * with the single-use credentials stripped.
 *
 * Goes through the real internal query rather than reading the table directly,
 * so the redaction of `teamMembers.invitationToken` and
 * `emailSubscribers.doubleOptInToken` is exercised by every test that exports.
 */
async function exportTables(
  t: ReturnType<typeof convexTest>,
  tables: readonly string[]
) {
  const data: Record<string, Record<string, unknown>[]> = {}
  for (const table of tables) {
    // PAGED, the way `system.exportBackup` does it (#432.4). The query used to
    // `.collect()` the whole table, which Convex refuses past 16,384 documents
    // — so an establishment trading two years could not take a backup at all.
    // Driving the cursor here rather than reading one page keeps this helper
    // honest about the real flow.
    const rows: Record<string, unknown>[] = []
    let cursor: string | null = null
    for (;;) {
      const page = await t.query(internal.systemInternal.exportTablePage, {
        tableName: table,
        cursor,
      })
      rows.push(...(page.rows as Record<string, unknown>[]))
      if (page.isDone) break
      cursor = page.cursor
    }
    data[table] = rows
  }
  return data
}

/**
 * Run the restore the way `system.importBackup` does.
 *
 * `BACKUP_TABLES` rather than a list written out here, so a table added to the
 * backup is covered by these tests without anyone remembering to add it — and
 * so a restore that goes wrong because the ORDER changed fails here.
 */
async function restore(
  t: ReturnType<typeof convexTest>,
  data: Record<string, Record<string, unknown>[]>
) {
  const idMap: Record<string, string> = {}

  for (const tableName of BACKUP_TABLES) {
    const rows = data[tableName]
    if (!rows) continue

    // The clear is its own paged mutation now (#432.4): `importTable` used to
    // read and delete every existing row in the same transaction as the
    // inserts, two passes over the whole table against the read ceiling.
    for (;;) {
      const pass = await t.mutation(internal.systemInternal.clearTablePage, {
        tableName,
      })
      if (pass.done) break
    }

    // And the inserts in pages, for the WRITE ceiling: the rows come from a
    // file an operator uploads.
    for (let offset = 0; offset < rows.length; offset += BACKUP_PAGE_SIZE) {
      const result = await t.mutation(internal.systemInternal.importTable, {
        tableName,
        rows: rows.slice(offset, offset + BACKUP_PAGE_SIZE),
        idMap,
      })
      Object.assign(idMap, result.idMap)
    }
  }

  // The second pass over the tables whose edges the order breaks on purpose.
  for (const tableName of DEFERRED_REMAP_TABLES) {
    let cursor: string | null = null
    for (;;) {
      const pass = await t.mutation(internal.systemInternal.remapDeferredReferences, {
        tableName,
        idMap,
        cursor,
      })
      if (pass.isDone) break
      cursor = pass.cursor
    }
  }

  /* The archive. `invoices` is never re-inserted, so no ordering reaches it,
     and every invoice was left naming the order and the store it had BEFORE the
     restore — on EVERY restore, this deployment included. Run here rather than
     written out, so a test cannot pass against a flow the real `importBackup`
     does not have. */
  let archiveRelinks = 0
  for (const tableName of ARCHIVE_RELINK_TABLES) {
    let cursor: string | null = null
    for (;;) {
      const pass = await t.mutation(internal.systemInternal.relinkArchiveReferences, {
        tableName,
        idMap,
        cursor,
      })
      archiveRelinks += pass.relinked
      if (pass.isDone) break
      cursor = pass.cursor
    }
  }

  // And the other end of the same link: an `orders.invoiceId` naming an invoice
  // this deployment does not have.
  const invoiceLinks = { repointed: 0, cleared: 0 }
  {
    let cursor: string | null = null
    for (;;) {
      const pass = await t.mutation(
        internal.systemInternal.reconcileOrderInvoiceLinks,
        { cursor }
      )
      invoiceLinks.repointed += pass.repointed
      invoiceLinks.cleared += pass.cleared
      if (pass.isDone) break
      cursor = pass.cursor
    }
  }

  const profiles = { updated: 0, dropped: 0 }
  {
    let cursor: string | null = null
    for (;;) {
      const pass = await t.mutation(internal.systemInternal.remapProfileStores, {
        idMap,
        cursor,
      })
      profiles.updated += pass.updated
      profiles.dropped += pass.dropped
      if (pass.isDone) break
      cursor = pass.cursor
    }
  }

  return { idMap, profiles, archiveRelinks, invoiceLinks }
}


/**
 * One paid order, its payment, its kitchen ticket, and the invoice issued for
 * it — the four tables a restore used to reach zero of.
 *
 * This comment promised all four and the body seeded two: no ticket, no
 * invoice, and `orders.invoiceId` never set. The two it skipped are exactly the
 * pair whose link a restore breaks, so the gap between the sentence and the
 * code was also the gap in the coverage.
 */
async function seedTrade(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  productId: Id<"products">
) {
  return t.run(async (ctx) => {
    const orderId = await ctx.db.insert("orders", {
      storeId,
      orderNumber: "CMD-000042",
      customerInfo: { name: "Camille Ferrand", email: "camille@example.fr" },
      type: "pickup" as const,
      status: "completed" as const,
      items: [
        {
          productId,
          productName: "Margherita",
          quantity: 2,
          unitPrice: 1200,
          selectedOptions: [],
          subtotal: 2400,
        },
      ],
      subtotal: 2400,
      taxAmount: 218,
      total: 2400,
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const paymentId = await ctx.db.insert("payments", {
      orderId,
      storeId,
      amount: 2400,
      currency: "EUR",
      provider: "stripe" as const,
      status: "succeeded" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const ticketId = await ctx.db.insert("kitchenTickets", {
      storeId,
      orderId,
      status: "completed" as const,
      priority: "normal" as const,
      items: [{ productName: "Margherita", quantity: 2, options: [] }],
      source: "website" as const,
      orderNumber: "CMD-000042",
      orderType: "pickup" as const,
      trackingToken: "trk_000000000000000042",
      printStatus: "printed" as const,
      printAttempts: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    /* The numbered document the sale issued (#367). Both directions of the link
       are seeded — `invoices.orderId` and `orders.invoiceId` — because a restore
       breaks them at different times: the first on every restore, the second
       only on a deployment rebuilt from the file. */
    const invoiceId = await ctx.db.insert("invoices", {
      number: "FA-2026-000001",
      kind: "invoice" as const,
      issuedAt: NOW,
      year: 2026,
      orderId,
      orderNumber: "CMD-000042",
      storeId,
      seller: { legalName: "Pizzeria Napoli SARL", storeName: "Pizzeria Napoli" },
      buyer: { name: "Camille Ferrand", email: "camille@example.fr" },
      lines: [
        { description: "Margherita", quantity: 2, unitPrice: 1200, subtotal: 2400, taxRatePercent: 10 },
      ],
      subtotal: 2400,
      total: 2400,
      taxAmount: 218,
      taxBreakdown: [{ ratePercent: 10, grossAmount: 2400, taxAmount: 218 }],
      currency: "EUR",
      payment: { method: "card", paidAt: NOW, provider: "stripe" },
      createdAt: NOW,
    })
    await ctx.db.patch(orderId, { invoiceId })
    return { orderId, paymentId, ticketId, invoiceId }
  })
}

// ============================================================================

describe("restoring a backup", () => {
  test("re-points the catalogue at the establishment it came back as", async () => {
    // The defect itself: the store gets a new id, and the catalogue has to
    // follow it rather than keep naming the one from the file.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    await seedCatalogue(t, storeId)
    const backup = await exportTables(t, ["stores", "categories", "products"])

    await restore(t, backup)

    const { store, category, product } = await t.run(async (ctx) => ({
      store: (await ctx.db.query("stores").collect())[0],
      category: (await ctx.db.query("categories").collect())[0],
      product: (await ctx.db.query("products").collect())[0],
    }))

    expect(store?._id).not.toBe(storeId)
    expect(category?.storeId).toBe(store?._id)
    expect(product?.storeId).toBe(store?._id)
    expect(product?.categoryId).toBe(category?._id)
  })

  test("leaves the restored product reachable from its store", async () => {
    // Not merely "the ids agree" — the index the app queries through has to
    // find it. A detached catalogue is invisible, not mislabelled.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    await seedCatalogue(t, storeId)
    const backup = await exportTables(t, ["stores", "categories", "products"])

    await restore(t, backup)

    const found = await t.run(async (ctx) => {
      const store = (await ctx.db.query("stores").collect())[0]
      return ctx.db
        .query("products")
        .withIndex("by_storeId", (q) => q.eq("storeId", store!._id))
        .collect()
    })

    expect(found.map((p) => p.name)).toEqual(["Margherita"])
  })

  test("keeps the owner's access to the establishment", async () => {
    // `userProfiles` is not in the backup — it holds identities, not restaurant
    // data — so its `storeIds` still name the pre-restore ids. Left alone,
    // every store-scoped screen refuses the person who just ran the restore.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "marie",
        role: "client_admin",
        storeIds: [storeId],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const backup = await exportTables(t, ["stores"])

    await restore(t, backup)

    const { profile, store } = await t.run(async (ctx) => ({
      profile: (await ctx.db.query("userProfiles").collect())[0],
      store: (await ctx.db.query("stores").collect())[0],
    }))

    expect(profile?.storeIds).toEqual([store?._id])
  })

  test("drops a profile's reference to a store the backup did not contain", async () => {
    // Keeping it would put back exactly the dangling id this change removes:
    // after the import that establishment does not exist.
    const t = newHarness()
    const kept = await seedStore(t, "Pizzeria Napoli")
    const backup = await exportTables(t, ["stores"])
    const gone = await seedStore(t, "Pizzeria Roma")
    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "marie",
        role: "client_admin",
        storeIds: [kept, gone],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const { profiles } = await restore(t, backup)

    const profile = await t.run(
      async (ctx) => (await ctx.db.query("userProfiles").collect())[0]
    )
    expect(profile?.storeIds).toHaveLength(1)
    expect(profiles.dropped).toBe(1)
  })

  test("leaves a reference the backup did not carry rather than inventing one", async () => {
    // A file holding one establishment and the products of two. The second
    // store's products name an id the map never learned, and there is nothing
    // to rewrite them to. Guessing would be worse than leaving them: the map is
    // the only authority on what an id became.
    const t = newHarness()
    const kept = await seedStore(t, "Pizzeria Napoli")
    await seedCatalogue(t, kept)
    const other = await seedStore(t, "Pizzeria Roma")
    await seedCatalogue(t, other)

    const all = await exportTables(t, ["stores", "categories", "products"])
    const backup = {
      stores: all.stores!.filter((s) => s._id === kept),
      categories: all.categories!.filter((c) => c.storeId === kept),
      products: all.products!,
    }

    await restore(t, backup)

    const { store, products } = await t.run(async (ctx) => ({
      store: (await ctx.db.query("stores").collect())[0],
      products: await ctx.db.query("products").collect(),
    }))

    // Both products were restored; only the one whose store was in the file
    // follows it. The other keeps naming a store this deployment no longer has —
    // the honest outcome, and the one the restore's message warns about.
    expect(products).toHaveLength(2)
    expect(products.filter((p) => p.storeId === store?._id)).toHaveLength(1)
  })

  test("still clears the table it is importing into", async () => {
    // The behaviour that was already there and must not regress: a restore
    // replaces, it does not append.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const backup = await exportTables(t, ["stores"])
    await seedStore(t, "Ajoutée Après")
    expect(storeId).toBeDefined()

    await restore(t, backup)

    const stores = await t.run((ctx) => ctx.db.query("stores").collect())
    expect(stores.map((s) => s.name)).toEqual(["Pizzeria Napoli"])
  })
})

/**
 * The half of #169 the maintenance fee was sold on.
 *
 * `exportBackup` covered 22 of 77 tables and `orders`, `payments` and
 * `kitchenTickets` were not among them, so a restore reached **zero orders**:
 * the establishment's trading history simply was not in the file. The pricing
 * page said « Sauvegardes automatiques quotidiennes de vos données ».
 */
describe("a restore that includes the trade", () => {
  test("brings back the seeded orders, still attached to their establishment", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const { categoryId, productId } = await seedCatalogue(t, storeId)
    await seedTrade(t, storeId, productId)
    expect(categoryId).toBeDefined()

    const backup = await exportTables(t, [
      "stores",
      "categories",
      "products",
      "orders",
      "payments",
    ])
    // The file carries them, which it did not before.
    expect(backup.orders).toHaveLength(1)

    await restore(t, backup)

    const { store, orders, payments } = await t.run(async (ctx) => ({
      store: (await ctx.db.query("stores").collect())[0],
      orders: await ctx.db.query("orders").collect(),
      payments: await ctx.db.query("payments").collect(),
    }))

    expect(orders).toHaveLength(1)
    expect(orders[0]?.orderNumber).toBe("CMD-000042")
    expect(orders[0]?.total).toBe(2400)
    // The store came back under a NEW id, and the order followed it.
    expect(orders[0]?.storeId).toBe(store?._id)
    // And the payment followed the order, which also moved.
    expect(payments).toHaveLength(1)
    expect(payments[0]?.orderId).toBe(orders[0]?._id)
  })

  test("re-points the kitchen station mapping at the categories it came back as", async () => {
    /* The cycle the import order has to break: `stores.stationMapping[].categoryId`
       names a category, and `categories` names a store, so whichever is imported
       first restores a reference the map cannot yet resolve. `stores` goes first
       because everything else depends on it — which left the kitchen routing
       naming categories that no longer existed. Silently: `v.id("categories")`
       validates an id's encoding, not that it resolves, so every ticket fell
       through to the single-station behaviour. */
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const { categoryId } = await seedCatalogue(t, storeId)
    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        kitchenStations: ["chaud", "froid"],
        stationMapping: [{ categoryId, station: "chaud" }],
      })
    )

    const backup = await exportTables(t, ["stores", "categories", "products"])
    await restore(t, backup)

    const { store, categories } = await t.run(async (ctx) => ({
      store: (await ctx.db.query("stores").collect())[0],
      categories: await ctx.db.query("categories").collect(),
    }))

    expect(store?.stationMapping?.[0]?.categoryId).toBe(categories[0]?._id)
    expect(store?.stationMapping?.[0]?.station).toBe("chaud")
  })

  test("strips a live invitation token on the way out", async () => {
    /* A backup is a JSON file an administrator downloads to a laptop. An
       unexpired invitation token in it grants a role to whoever opens the link. */
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        storeId,
        allStores: false,
        name: "Nadia Bonnet",
        email: "nadia@example.fr",
        role: "manager" as const,
        permissions: [],
        invitationStatus: "pending" as const,
        invitationToken: "tok_live_do_not_export",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const backup = await exportTables(t, ["teamMembers"])

    expect(backup.teamMembers).toHaveLength(1)
    // The member is carried — a restore that loses the team is a restore that
    // locks people out — but the credential is not.
    expect(backup.teamMembers?.[0]?.name).toBe("Nadia Bonnet")
    expect(backup.teamMembers?.[0]).not.toHaveProperty("invitationToken")
  })

  test("keeps the invoice attached to the order it came back as", async () => {
    /* `invoices` is export-only and `orders` is restored, so on EVERY restore —
       this deployment included — the invoices were left naming the ids the
       orders had before. `backupTables.ts` claimed the opposite ("the invoice
       rows are never re-inserted, so their ids never change, so the reference
       still resolves"), which is true of the invoice's own id and says nothing
       about the ids inside it, and `backup-coverage.test.ts` skipped the edge on
       the strength of that sentence.

       `invoices.by_orderId` is the AUTHORITATIVE half of
       `assertOrderHasNoInvoice` — the half that exists for an order invoiced
       before `orders.invoiceId` was populated — so after a restore such an order
       could be deleted with its invoice standing. */
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const { productId } = await seedCatalogue(t, storeId)
    const { orderId } = await seedTrade(t, storeId, productId)

    const backup = await exportTables(t, [
      "stores",
      "categories",
      "products",
      "orders",
      "payments",
      "kitchenTickets",
    ])

    const { archiveRelinks } = await restore(t, backup)
    expect(archiveRelinks).toBe(1)

    const { order, invoice, byOrder, store } = await t.run(async (ctx) => {
      const order = (await ctx.db.query("orders").collect())[0]!
      const invoice = (await ctx.db.query("invoices").collect())[0]!
      return {
        order,
        invoice,
        store: (await ctx.db.query("stores").collect())[0]!,
        byOrder: await ctx.db
          .query("invoices")
          .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
          .first(),
      }
    })

    // The order moved, and the invoice followed it.
    expect(order._id).not.toBe(orderId)
    expect(invoice.orderId).toBe(order._id)
    // The lookup `assertOrderHasNoInvoice` falls back to finds it again.
    expect(byOrder?.number).toBe("FA-2026-000001")
    // And the establishment's own invoice list is not empty either.
    expect(invoice.storeId).toBe(store._id)
    // Nothing about the DOCUMENT changed: only this deployment's pointers.
    expect(invoice.number).toBe("FA-2026-000001")
    expect(invoice.total).toBe(2400)
    expect(invoice.taxAmount).toBe(218)
  })

  test("leaves a restored order invoiceable when the invoice is not on this deployment", async () => {
    /* The other half, and the one only a REBUILT deployment sees. The invoices
       are in the file and are never re-inserted, so `orders.invoiceId` comes
       back naming a row nothing here has — and `invoiceRefusal` reads that field
       for TRUTHINESS rather than resolution:

           if (order.invoiceId) return "already_issued"

       so the sale could never be invoiced again, by the automatic path or the
       manual one, and the admin's order screen showed no number and the reason
       "already issued". For ever. */
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const { productId } = await seedCatalogue(t, storeId)
    const { invoiceId } = await seedTrade(t, storeId, productId)

    const backup = await exportTables(t, [
      "stores",
      "categories",
      "products",
      "orders",
      "payments",
      "kitchenTickets",
    ])
    // The file carries the invoice id, which is the whole point: it is what the
    // restored order will come back holding.
    expect(backup.orders?.[0]?.invoiceId).toBe(invoiceId)

    // A deployment rebuilt from the file: it has no fiscal archive of its own.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("invoices").collect()) {
        await ctx.db.delete(row._id)
      }
    })

    const { invoiceLinks } = await restore(t, backup)
    expect(invoiceLinks).toEqual({ repointed: 0, cleared: 1 })

    const order = await t.run(
      async (ctx) => (await ctx.db.query("orders").collect())[0]!
    )

    expect(order.invoiceId).toBeUndefined()
    // Invoiceable again, from this deployment's own fresh series. Nothing
    // fiscal was deleted: the documents are in the backup file, which is now the
    // only copy of that series.
    expect(invoiceRefusal(order, { legalName: "Pizzeria Napoli SARL" })).toBeNull()
  })

  test("re-points rather than clears when an invoice does stand for the order", async () => {
    // Clearing a link that IS recoverable would let a SECOND invoice be issued
    // for a sale that already has one — a duplicate fiscal document, which is a
    // worse outcome than the dangling id being fixed.
    const t = newHarness()
    const storeId = await seedStore(t, "Pizzeria Napoli")
    const { productId } = await seedCatalogue(t, storeId)
    await seedTrade(t, storeId, productId)

    const backup = await exportTables(t, [
      "stores",
      "categories",
      "products",
      "orders",
      "payments",
      "kitchenTickets",
    ])

    /* The mixed case: the invoice is here, but the order names an id that is
       not it — a file restored onto a deployment whose archive came back by
       another route. */
    await t.run(async (ctx) => {
      const invoice = (await ctx.db.query("invoices").collect())[0]!
      const { _id, _creationTime, ...fields } = invoice
      expect(_id).toBeDefined()
      expect(_creationTime).toBeDefined()
      const decoy = await ctx.db.insert("invoices", { ...fields, number: "FA-2026-000002" })
      await ctx.db.delete(decoy)
      for (const row of backup.orders ?? []) row.invoiceId = decoy
    })

    const { invoiceLinks } = await restore(t, backup)
    expect(invoiceLinks).toEqual({ repointed: 1, cleared: 0 })

    const { order, invoice } = await t.run(async (ctx) => ({
      order: (await ctx.db.query("orders").collect())[0]!,
      invoice: (await ctx.db.query("invoices").collect())[0]!,
    }))

    expect(order.invoiceId).toBe(invoice._id)
    expect(invoice.number).toBe("FA-2026-000001")
  })

  test("refuses to import the fiscal archive it happily exports", async () => {
    /* art. 242 nonies A CGI, and `tables/invoices.ts` states it in the schema:
       an invoice is never edited and never deleted, so a restore must not
       delete-and-re-insert the series. The export carries them regardless — a
       backup that loses an establishment's invoices is not a backup of that
       establishment. */
    const t = newHarness()

    await expect(
      t.query(internal.systemInternal.exportTablePage, {
        tableName: "invoices",
        cursor: null,
      })
    ).resolves.toMatchObject({ rows: [], isDone: true })

    await expect(
      t.mutation(internal.systemInternal.importTable, {
        tableName: "invoices",
        rows: [],
      })
    ).rejects.toThrow(/non autorisée pour l'import/)

    // And the CLEAR is behind the same allow-list. It is a separate mutation
    // since #432.4, so a restore that could delete the fiscal series while the
    // insert refused it would be worse than the ceiling it was split to avoid.
    await expect(
      t.mutation(internal.systemInternal.clearTablePage, { tableName: "invoices" })
    ).rejects.toThrow(/non autorisée pour l'import/)
  })
})

/**
 * A table bigger than one page survives the round trip.
 *
 * WHAT WAS BROKEN (#432.4). Every read in the backup subsystem was a bare
 * `.collect()` over a whole table:
 *
 *     const existing = await ctx.db.query(args.tableName).collect()
 *     for (const row of existing) { await ctx.db.delete(row._id) }
 *
 * Convex refuses a transaction that reads more than 16,384 documents, and
 * `BACKUP_TABLES` holds `orders`, `products`, `gamePlays`, `emailSubscribers`
 * and `kitchenTickets`. An establishment trading two years passes the ceiling
 * on its orders alone — so the export threw, the restore threw, and the feature
 * sold as « Sauvegardes automatiques quotidiennes de vos données et contenus »
 * could not be used by exactly the establishments with most to lose. The
 * instrument written for this class of defect, `queryBounds.test.ts`, covered
 * neither function.
 *
 * WHY THIS SEEDS `BACKUP_PAGE_SIZE + 1` AND NOT 16,384. The ceiling is Convex's
 * and cannot be reached in `convex-test`, which has no such limit — a test that
 * tried would prove nothing and take an hour. What CAN be proved here is the
 * thing the fix actually consists of: that the loop runs more than once and
 * loses nothing at the seam. A paging loop is only exercised by a second page,
 * and one row past the boundary is the cheapest way to demand one.
 *
 * If `BACKUP_PAGE_SIZE` is ever raised past what this seeds, the second page
 * disappears and these tests go green over a single-page run. The first
 * assertion below is there to refuse that.
 */
describe("a table larger than one page", () => {
  /** Cheap rows, and a table that is in `BACKUP_TABLES`. */
  async function seedManyCategories(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    count: number
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("categories", {
          storeId,
          name: `Catégorie ${i}`,
          slug: `categorie-${i}`,
          sortOrder: i,
          isActive: true,
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })
  }

  const ROWS = BACKUP_PAGE_SIZE + 1

  test("the fixture really crosses the page boundary", () => {
    // The anti-vacuity guard. Everything below is about the SECOND page; if the
    // page size grows past the fixture there is no second page and the
    // assertions stop measuring anything.
    expect(ROWS).toBeGreaterThan(BACKUP_PAGE_SIZE)
  })

  test("exports every row, across pages", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    await seedManyCategories(t, storeId, ROWS)

    const backup = await exportTables(t, ["categories"])

    expect(backup.categories).toHaveLength(ROWS)
    // And distinct rows, not the first page twice — a cursor threaded wrongly
    // re-reads page one for ever, which is the other way this loop breaks.
    expect(new Set(backup.categories.map((row) => row._id as string)).size).toBe(ROWS)
  })

  test("clears every row, across pages", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    await seedManyCategories(t, storeId, ROWS)

    let passes = 0
    for (;;) {
      const pass = await t.mutation(internal.systemInternal.clearTablePage, {
        tableName: "categories",
      })
      passes += 1
      if (pass.done) break
    }

    // More than one pass, which is the whole point: a clear that finished in one
    // is a clear that read the table whole.
    expect(passes).toBeGreaterThan(1)
    expect(await t.run((ctx) => ctx.db.query("categories").collect())).toHaveLength(0)
  })

  test("restores every row, and the storeId still resolves", async () => {
    // The round trip, which is where a paging bug shows as data loss rather
    // than as an error: rows dropped at a page seam come back silently short.
    const t = newHarness()
    const storeId = await seedStore(t, "Chez Luigi")
    await seedManyCategories(t, storeId, ROWS)

    const backup = await exportTables(t, ["stores", "categories"])
    await restore(t, backup)

    const stores = await t.run((ctx) => ctx.db.query("stores").collect())
    const categories = await t.run((ctx) => ctx.db.query("categories").collect())

    expect(stores).toHaveLength(1)
    expect(categories).toHaveLength(ROWS)
    // Every one re-pointed at the establishment it came back as — the defect
    // `importTable`'s id map exists for, now measured across a page boundary.
    const newStoreId = stores[0]!._id
    expect(categories.every((c) => c.storeId === newStoreId)).toBe(true)
  })
})
