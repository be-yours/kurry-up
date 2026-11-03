import { internalQuery, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { Role } from "@be-yours/core/auth/rbac"
import {
  remapIds,
  splitExportedRow,
  type IdMap,
} from "@be-yours/convex-functions/backupRemap"
import {
  BACKUP_PAGE_SIZE,
  isArchiveRelinkTable,
  isBackupTable,
  isExportedTable,
  redactExportedRow,
  type BackupTable,
} from "@be-yours/convex-functions/backupTables"

/* ─── The allow-lists ─────────────────────────────────────────────────────────
 *
 * Two of them, and the difference is the point. The EXPORT is wider than the
 * IMPORT: the fiscal archive (`invoices`, `numberSequences`) and the audit log
 * are carried in the file and must never be written back by a restore. A single
 * list would have forced a choice between losing them from every backup and
 * letting a restore rewrite a numbered series.
 *
 * Both come from `@be-yours/convex-functions/backupTables`, which
 * `system.ts` also reads. They used to be written out twice and agree by hand;
 * between them they named 22 of this schema's 77 tables (#169).
 */

function assertExportable(tableName: string): void {
  if (!isExportedTable(tableName)) {
    throw new Error(`Table "${tableName}" non autorisée pour l'export`)
  }
}

function assertImportable(tableName: string): asserts tableName is BackupTable {
  if (!isBackupTable(tableName)) {
    throw new Error(`Table "${tableName}" non autorisée pour l'import`)
  }
}

/**
 * The narrow permission to patch a row a restore never inserted.
 *
 * Deliberately not `assertImportable`: `relinkArchiveReferences` touches
 * export-only tables, and widening the import allow-list to reach them would
 * hand `importTable` the right to delete and re-insert a numbered fiscal
 * series. Its own list, its own check, and `ARCHIVE_EDGES` is where the
 * membership is argued.
 */
function assertArchiveRelinkable(tableName: string): void {
  if (!isArchiveRelinkTable(tableName)) {
    /* "rattachement des références après restauration" rather than
       "rattachement d'archive": `check:accents` derives `archive` from the
       `archivé` entry in its word list and cannot tell the noun from the past
       participle. The longer wording is also the more accurate one — it names
       what the pass does rather than which list it is allowed to touch. */
    throw new Error(
      `Table "${tableName}" non autorisée pour le rattachement des références après restauration`
    )
  }
}

// ─── Internal Queries ────────────────────────────────────────────────────────

/** Resolve authenticated user profile — safe to call from actions via ctx.runQuery */
export const getAuthUserInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    const profile = await ctx.db
      .query("userProfiles")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .withIndex("by_userId", (q: any) => q.eq("userId", identity.subject))
      .unique()

    if (!profile) throw new Error("User profile not found")

    const role = Object.values(Role).includes(profile.role as Role)
      ? (profile.role as Role)
      : Role.CUSTOMER

    return {
      userId: identity.subject,
      role,
      storeIds: profile.storeIds ?? [],
      profileId: profile._id as string,
      /* The invite dialog's module checkboxes. An ACTION cannot read the
         database, so the module gate can only run on what this returns — and
         while this omitted them, every `system:*` action was role-only (#649). */
      permissions: profile.permissions ?? [],
    }
  },
})

/** Get globalSettings for internal use (no auth) */
export const getSettingsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("globalSettings").first()
  },
})

/**
 * Export ONE PAGE of a table.
 *
 * This was `.collect()` over the whole table (#432.4). Convex refuses a
 * transaction that reads more than 16,384 documents, and `BACKUP_TABLES` holds
 * `orders`, `products`, `gamePlays`, `emailSubscribers` and `kitchenTickets` —
 * so an establishment trading two years passed the ceiling on its orders alone
 * and the export simply threw. Every time, for ever, with no admin action that
 * could clear it. The feature is sold as « Sauvegardes automatiques
 * quotidiennes de vos données et contenus ».
 *
 * `system.exportBackup` drives the cursor. Paging rather than a `.take()` with
 * a bigger number, because a bigger number is the same defect with a later
 * threshold — and because `paginate` is the only read here whose cost does not
 * grow with the table.
 *
 * A backup is a JSON file an administrator downloads to whatever laptop they
 * were sitting at, and two single-use credentials were in it: an unexpired team
 * invitation token grants a role to whoever opens the link, and a double-opt-in
 * token confirms a subscription on someone else's behalf. Both fields are
 * optional, so a restore comes back without them and the invitation is simply
 * re-sent.
 */
export const exportTablePage = internalQuery({
  args: {
    tableName: v.string(),
    /** `null` for the first page; otherwise the previous page's `cursor`. */
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    assertExportable(args.tableName)
    const page = await (
      ctx.db.query(args.tableName as never) as unknown as {
        paginate: (opts: { numItems: number; cursor: string | null }) => Promise<{
          page: Record<string, unknown>[]
          continueCursor: string
          isDone: boolean
        }>
      }
    ).paginate({ numItems: BACKUP_PAGE_SIZE, cursor: args.cursor })

    return {
      rows: page.page.map((row) => redactExportedRow(args.tableName, row)),
      cursor: page.continueCursor,
      isDone: page.isDone,
    }
  },
})

// ─── Internal Mutations ──────────────────────────────────────────────────────

/**
 * Import rows into a table — clears existing data, then inserts.
 *
 * Convex will not let an insert choose its `_id`, so every restored row comes
 * back under a new one. That used to end the story: `stores` came back with new
 * ids while the products, menus, CMS pages and promotions restored after them
 * came back carrying the **old** `storeId`, and `v.id("stores")` waved it
 * through because it validates an id's encoding, not that it resolves. The
 * deployment came up with every catalogue detached from its establishment, and
 * `userProfiles.storeIds` naming stores that no longer existed — so the owner
 * was locked out of everything. Silently, and irreversibly.
 *
 * `idMap` carries `old id → new id` from the tables already imported, and every
 * id inside a row is rewritten through it before the insert. The caller passes
 * back what this returns, which is why `system.importBackup` walks the tables in
 * dependency order: a reference can only be rewritten once its target has been
 * inserted.
 *
 * References the map cannot resolve — a table never exported, or a row deleted
 * before the backup was taken — are left as they are. `backupRemap` explains
 * why they are not counted: there is no portable way to tell a reference from
 * an ordinary string, and the restore says plainly what a backup does not carry
 * instead of reporting a number that would be zero in exactly the case it
 * exists to catch.
 */
export const importTable = internalMutation({
  args: {
    tableName: v.string(),
    rows: v.array(v.any()),
    idMap: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    assertImportable(args.tableName)

    const idMap: IdMap = args.idMap ?? {}

    /* NO CLEAR HERE ANY MORE. This handler used to `.collect()` the whole table
       and delete it before inserting, which is the #432.4 ceiling twice over —
       a read and a write of every existing row, in the same transaction as the
       inserts. `clearTablePage` below does the deletes, one page at a time, and
       `system.importBackup` drains it before calling this.

       What that costs, stated rather than glossed: the clear and the insert are
       no longer one transaction, so a failure between them leaves the table
       empty instead of leaving it as it was. Per-table atomicity was never the
       guarantee — a restore is one mutation PER TABLE and always has been, so a
       failure on the fourth table already left three restored and the rest
       untouched. The change is that the window now exists inside a table as
       well, and the alternative is a restore that cannot run at all past
       16,384 rows. `system.importBackup` reports how far it got. */

    // Insert: strip Convex system fields, rewrite every id the map knows, and
    // record what this table's own rows became.
    const inserted: IdMap = {}
    for (const row of args.rows) {
      const { oldId, data } = splitExportedRow(row)
      const newId = await (ctx.db as never as {
        insert: (table: string, doc: Record<string, unknown>) => Promise<string>
      }).insert(args.tableName, remapIds(data, idMap))
      if (oldId) inserted[oldId] = newId
    }

    return { idMap: inserted }
  },
})

/**
 * Delete ONE PAGE of a table, so a restore can clear it at all.
 *
 * The other half of #432.4. `importTable` read every existing row and deleted
 * it in one transaction; past 16,384 rows that throws before a single insert,
 * so a restaurant with two years of orders could not restore its own backup.
 *
 * `done` is what the caller loops on. It is computed from the page being short
 * rather than from a second count — a count is another whole-table read, which
 * is the thing being removed.
 */
export const clearTablePage = internalMutation({
  args: { tableName: v.string() },
  handler: async (ctx, args) => {
    assertImportable(args.tableName)

    const rows = await (
      ctx.db.query(args.tableName as never) as unknown as {
        take: (n: number) => Promise<{ _id: string }[]>
      }
    ).take(BACKUP_PAGE_SIZE)

    for (const row of rows) {
      await ctx.db.delete(row._id as never)
    }

    return { deleted: rows.length, done: rows.length < BACKUP_PAGE_SIZE }
  },
})

/**
 * A second pass over one table with the FULL id map.
 *
 * The foreign-key graph has a cycle, so no single order can satisfy every edge.
 * `stores.stationMapping[].categoryId` points at `categories`, and `categories`
 * points back at `stores` — so whichever comes first restores a reference the
 * map cannot yet resolve. `stores` goes first, because everything else in the
 * backup depends on it, and the kitchen routing was therefore restored naming
 * categories that no longer existed.
 *
 * Silently, which is the part that matters: `v.id("categories")` validates an
 * id's encoding rather than that it resolves, so every ticket simply fell
 * through to the single-station behaviour and nobody was told the routing had
 * been lost.
 *
 * `remapIds` rewrites any string the map knows, anywhere in a row, so this
 * needs no per-field knowledge and costs one patch per row that changed.
 * `DEFERRED_REMAP_TABLES` in `backupTables.ts` is the list of edges the import
 * order breaks on purpose.
 */
export const remapDeferredReferences = internalMutation({
  args: {
    tableName: v.string(),
    idMap: v.record(v.string(), v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    assertImportable(args.tableName)

    /* One page per call, and the caller loops (#432.4). `.collect()` here was
       the same ceiling as the clear: `DEFERRED_REMAP_TABLES` is `["stores"]`
       today, which is small, and that is exactly why the defect was invisible —
       the list is a declaration of which edges the import order breaks, and the
       next entry could be `orders`. */
    const page = await (
      ctx.db.query(args.tableName as never) as unknown as {
        paginate: (opts: { numItems: number; cursor: string | null }) => Promise<{
          page: Record<string, unknown>[]
          continueCursor: string
          isDone: boolean
        }>
      }
    ).paginate({ numItems: BACKUP_PAGE_SIZE, cursor: args.cursor })

    let patched = 0

    for (const row of page.page) {
      const { data } = splitExportedRow(row)
      const rewritten = remapIds(data, args.idMap)
      // Compared rather than patched blindly: a restore of a large table would
      // otherwise write every row a second time for nothing.
      if (JSON.stringify(rewritten) === JSON.stringify(data)) continue
      await ctx.db.patch(row._id as never, rewritten as never)
      patched += 1
    }

    return { patched, cursor: page.continueCursor, isDone: page.isDone }
  },
})

/**
 * Re-point the ARCHIVE at the rows the restore brought back.
 *
 * `invoices` is export-only: it is carried in the file and never deleted or
 * re-inserted, because a numbered fiscal series a restore can rewrite is not a
 * series (art. 242 nonies A CGI). `orders` and `stores`, which every invoice
 * points at, ARE deleted and re-inserted — under new ids. So on EVERY restore,
 * this deployment included, each invoice was left naming an order and a store
 * that no longer existed.
 *
 * `backupTables.ts` claimed the opposite for months — "the invoice rows are
 * never re-inserted, so their ids never change, so the reference still
 * resolves" — which is true of the invoice's OWN id and says nothing about the
 * ids inside it. `backup-coverage.test.ts` skipped the edge on the strength of
 * that sentence, so nothing ever looked.
 *
 * What it cost: `invoices.by_orderId` is the authoritative half of
 * `assertOrderHasNoInvoice`, the guard that refuses to delete an order that has
 * been invoiced — and the half that exists for an order invoiced before
 * `orders.invoiceId` was populated. After a restore it found nothing, so such
 * an order could be deleted with its invoice standing. `by_storeId_issuedAt` is
 * how an establishment's invoices are listed, and that list came back empty.
 *
 * This is not editing the document. Art. 242 nonies A fixes the number, the
 * dates, the parties, the lines and the figures; `orderId` and `storeId` are
 * this deployment's pointers at the sale and the establishment, and re-pointing
 * them at the rows those came back as is what keeps the archive attached to
 * anything. `ARCHIVE_EDGES` in `backupTables.ts` declares every edge that
 * crosses this boundary and what answers it.
 */
export const relinkArchiveReferences = internalMutation({
  args: {
    tableName: v.string(),
    idMap: v.record(v.string(), v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    assertArchiveRelinkable(args.tableName)

    /* One page per call, and this is the one where the ceiling was certain
       rather than possible: the comment below already says "an establishment
       with a year of trade has a year of invoices", and it then read all of
       them in one transaction. A restaurant issuing forty invoices a day
       crosses 16,384 in fourteen months, and from then on every restore threw
       here — after the inserts had already happened (#432.4). */
    const page = await (
      ctx.db.query(args.tableName as never) as unknown as {
        paginate: (opts: { numItems: number; cursor: string | null }) => Promise<{
          page: Record<string, unknown>[]
          continueCursor: string
          isDone: boolean
        }>
      }
    ).paginate({ numItems: BACKUP_PAGE_SIZE, cursor: args.cursor })

    let relinked = 0

    for (const row of page.page) {
      const { data } = splitExportedRow(row)
      const rewritten = remapIds(data, args.idMap)
      // Compared rather than patched blindly: an establishment with a year of
      // trade has a year of invoices, and a restore must not write every one of
      // them a second time for nothing.
      if (JSON.stringify(rewritten) === JSON.stringify(data)) continue
      await ctx.db.patch(row._id as never, rewritten as never)
      relinked += 1
    }

    return { relinked, cursor: page.continueCursor, isDone: page.isDone }
  },
})

/**
 * Make a restored order invoiceable again when its invoice is not here.
 *
 * The other half of the same break, and the one that only shows on a REBUILT
 * deployment. `orders.invoiceId` survives the restore verbatim — `remapIds`
 * rewrites a string only when the map has an entry for it, and the map only
 * ever holds ids of rows `importTable` inserted, so no invoice id is ever in
 * it. On the deployment the backup came from that is harmless: the invoices are
 * still there under the same ids. On a deployment rebuilt from the file they
 * are not there at all, and `invoiceRefusal` tests that field for TRUTHINESS
 * rather than resolution:
 *
 *     if (order.invoiceId) return "already_issued"
 *
 * so the sale could never be invoiced again — not by `orders`' automatic path,
 * not by the manual button — and the admin's order screen showed no number and
 * the reason "already issued", for ever.
 *
 * Three outcomes per order, in this order:
 *
 *  - the id resolves — nothing to do, and this is the common case;
 *  - it does not, but an invoice stands for this order (found through
 *    `by_orderId`, which `relinkArchiveReferences` has just re-pointed) — the
 *    link is restored rather than dropped, because clearing it would let a
 *    SECOND invoice be issued for a sale that already has one;
 *  - it does not and none stands — the field is cleared, and the order is
 *    invoiceable again from this deployment's own series.
 *
 * Clearing deletes nothing fiscal. The invoices are in the backup file, and on
 * a rebuilt deployment that file is the only copy of the old series and must be
 * kept as such (art. L102 B LPF, six years). `numberSequences` is export-only
 * too, so the rebuilt deployment starts a fresh series rather than reissuing
 * numbers that have already been handed out. The count comes back to
 * `importBackup` and into the message the operator reads, because a restore
 * that quietly detached an order from its invoice would be the same silence
 * this whole module exists to end.
 */
export const reconcileOrderInvoiceLinks = internalMutation({
  args: {
    /** `null` for the first page; otherwise the previous page's `cursor`. */
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    /* One page, and the caller loops (#432.4). This read the WHOLE orders table
       and then did a `ctx.db.get` per order carrying an invoice id — two reads
       per order against Convex's 16,384-document ceiling, on the largest table
       a restaurant has. It ran at the END of a restore, after every insert, so
       crossing the ceiling left the deployment restored and the archive
       detached, which is the exact silence this module exists to end. */
    const page = await ctx.db
      .query("orders")
      .paginate({ numItems: BACKUP_PAGE_SIZE, cursor: args.cursor })
    const orders = page.page
    let repointed = 0
    let cleared = 0

    for (const order of orders) {
      if (!order.invoiceId) continue
      if (await ctx.db.get(order.invoiceId)) continue

      const standing = await ctx.db
        .query("invoices")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .first()

      if (standing) {
        await ctx.db.patch(order._id, { invoiceId: standing._id, updatedAt: Date.now() })
        repointed += 1
      } else {
        // `undefined` removes the field, which is what an optional column with
        // no value means. The order is then refused for the reason that is
        // actually true of it, if any, rather than for one that never will be.
        await ctx.db.patch(order._id, { invoiceId: undefined, updatedAt: Date.now() })
        cleared += 1
      }
    }

    return { repointed, cleared, cursor: page.continueCursor, isDone: page.isDone }
  },
})

/**
 * Re-point the profiles at the establishments they came back as.
 *
 * `userProfiles` is not exported — it holds identities, not restaurant data —
 * so a restore cannot replace it. But its `storeIds` name the stores of the
 * deployment *before* the restore, and after one those ids resolve to nothing:
 * every store-scoped screen refuses the owner, and `profileProvisioning` will
 * not hand them their own profile back. Rewriting the list in place is the one
 * thing that keeps a restore from locking out the person who ran it.
 *
 * Ids the map does not know are dropped rather than kept: they name stores the
 * backup did not contain, which after this import do not exist.
 */
export const remapProfileStores = internalMutation({
  args: {
    idMap: v.record(v.string(), v.string()),
    /** `null` for the first page; otherwise the previous page's `cursor`. */
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    /* Paged like the rest, though this is the one table where the ceiling is
       not reachable today: `userProfiles` holds staff, and a chain with fifty
       locations and twenty people each is a thousand rows. It is paged anyway
       because the reason it is safe is a fact about the CUSTOMER rather than
       about the code, and "small enough" is not a property a reader can check
       at the call site (#432.4). */
    const page = await ctx.db
      .query("userProfiles")
      .paginate({ numItems: BACKUP_PAGE_SIZE, cursor: args.cursor })
    const profiles = page.page
    let updated = 0
    let dropped = 0

    for (const profile of profiles) {
      const before = profile.storeIds ?? []
      if (before.length === 0) continue

      const after = before
        .map((id) => args.idMap[id as unknown as string])
        .filter((id): id is string => typeof id === "string")

      dropped += before.length - after.length
      if (after.length === before.length && after.every((id, i) => id === (before[i] as unknown as string))) {
        continue
      }

      await ctx.db.patch(profile._id, {
        storeIds: after as unknown as typeof before,
        updatedAt: Date.now(),
      })
      updated++
    }

    return { updated, dropped, cursor: page.continueCursor, isDone: page.isDone }
  },
})
