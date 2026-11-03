// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What a backup carries, checked against the schema rather than against memory.
 *
 * The export order and the import allow-list used to be written out twice, in
 * two files, and agree by hand. Between them they named **22 of this schema's
 * 77 tables**: no `orders`, no `payments`, no `kitchenTickets`, no
 * `translations`, and none of the sixteen `cms*` singletons — so a "backup" of
 * a restaurant's website did not contain that website's pages, and a restore
 * reached zero orders. The maintenance fee was sold on « Sauvegardes
 * automatiques quotidiennes de vos données et contenus ». Issues #169, #366.
 *
 * Three properties are asserted here, and each one is a way that list rots:
 *
 *  1. **Every table is classified.** A table added to the schema and to no list
 *     is silently absent from every backup — which is exactly how the sixteen
 *     CMS singletons happened.
 *  2. **The import order is a topological sort of the real foreign-key graph.**
 *     Derived from the schema's own validators, so a new `v.id()` field that
 *     breaks the order fails here rather than during someone's restore.
 *  3. **The fiscal archive is exported and never re-inserted.** `invoices.ts`
 *     states the rule in the schema itself (art. 242 nonies A CGI).
 */

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, test } from "vitest"
import schema from "../../convex/schema"
import {
  ARCHIVE_EDGES,
  ARCHIVE_RELINK_TABLES,
  BACKUP_TABLES,
  DEFERRED_REMAP_TABLES,
  EXCLUDED_TABLES,
  EXPORTED_TABLES,
  EXPORT_ONLY_TABLES,
  REDACTED_BACKUP_FIELDS,
} from "@be-yours/convex-functions/backupTables"

/**
 * The source of `backupTables.ts`, read rather than remembered.
 *
 * Two of the assertions below are about the PROSE in that file, because prose is
 * how the last two defects here were introduced: a header that claimed the
 * `orders → invoices` edge survived a restore (it does not, in either
 * direction), and a sentence that said "two edges" over a one-element array from
 * the day it was written. A comment nothing checks is a comment that drifts.
 */
const BACKUP_TABLES_SRC = readFileSync(
  createRequire(import.meta.url).resolve("@be-yours/convex-functions/backupTables"),
  "utf8",
)

const SCHEMA_TABLES = Object.keys(schema.tables)

/**
 * Which tables one table's rows can point at.
 *
 * Read out of the validator Convex compiled, not out of the source: a
 * `v.id("stores")` nested three objects deep inside an array is found the same
 * way as a top-level one, and nothing here has to be kept in step with a
 * refactor of the table files.
 *
 * `_storage` and `_scheduled_functions` are Convex's own and are not tables a
 * backup can carry.
 */
function referencedTables(name: string): string[] {
  const json = JSON.stringify(
    (schema.tables as Record<string, { validator: { json: unknown } }>)[name].validator.json,
  )
  const found = json.match(/"tableName":"([A-Za-z0-9_]+)"/g) ?? []
  return [
    ...new Set(
      found
        .map((entry) => entry.split('"')[3] as string)
        .filter((table) => table !== name && !table.startsWith("_")),
    ),
  ]
}

describe("backup coverage", () => {
  test("every table in the schema is classified, exactly once", () => {
    const classified = [
      ...BACKUP_TABLES,
      ...EXPORT_ONLY_TABLES,
      ...EXCLUDED_TABLES.map((entry) => entry.table),
    ]

    // Unclassified is the failure mode: a table added to the schema and to no
    // list is absent from every backup, and nothing says so.
    expect([...SCHEMA_TABLES].sort()).toEqual([...classified].sort())
    expect(new Set(classified).size).toBe(classified.length)
  })

  test("names no table the schema does not have", () => {
    for (const table of EXPORTED_TABLES) {
      expect(SCHEMA_TABLES).toContain(table)
    }
    for (const { table } of EXCLUDED_TABLES) {
      expect(SCHEMA_TABLES).toContain(table)
    }
  })

  test("carries the establishment's website, its orders and its translations", () => {
    // The families the old 22-table list dropped, named individually because
    // each was its own reported defect.
    for (const table of ["cmsPages", "cmsBlocks", "cmsMedia"]) {
      expect(BACKUP_TABLES).toContain(table)
    }
    for (const table of ["orders", "payments", "kitchenTickets", "translations", "teamMembers"]) {
      expect(BACKUP_TABLES).toContain(table)
    }
  })

  test("does not back up the sixteen legacy CMS singletons", () => {
    /*
     * THIS USED TO ASSERT THE OPPOSITE (#434.7). All sixteen were added on the
     * reasoning that a backup without the pages a client edits is not a backup of
     * a website — true of the CMS they were written for, and not of the one that
     * shipped. They were superseded by the block-based `cmsPages` / `cmsBlocks` /
     * `cmsMedia` above and measured at zero reads, zero inserts and zero patches,
     * so the nightly backup on every client deployment walked sixteen tables that
     * cannot hold a row.
     *
     * Excluded, not deleted: they stay declared in the schema because Convex
     * refuses a deploy that drops a table still holding rows, and nothing in this
     * repository can say whether a deployment provisioned two years ago still has
     * one. The classification test above requires every schema table to be in
     * exactly one bucket, which is what stops this being a silent omission.
     */
    const CMS_SINGLETONS = [
      "cms", "cmsHome", "cmsMenu", "cmsAbout", "cmsContact", "cmsBlogPosts",
      "cmsCart", "cmsCheckout", "cmsTracking", "cmsSignin", "cmsSignup",
      "cmsPrivacy", "cmsTerms", "cms404", "cmsMaintenance", "cmsAccount",
    ]
    const excluded = new Set(EXCLUDED_TABLES.map((entry) => entry.table))
    for (const table of CMS_SINGLETONS) {
      expect(BACKUP_TABLES, table).not.toContain(table)
      expect(excluded, table).toContain(table)
    }
  })

  test("the import order is a topological sort of the foreign-key graph", () => {
    const position = new Map(BACKUP_TABLES.map((table, index) => [table as string, index]))
    const exportOnly = new Set<string>(EXPORT_ONLY_TABLES)
    const deferred = new Set<string>(DEFERRED_REMAP_TABLES)

    const violations: string[] = []
    for (const table of BACKUP_TABLES) {
      for (const target of referencedTables(table)) {
        /* An export-only table has no position in this order — it is never
           inserted — so the ORDER cannot answer this edge either way, and the
           topological check has nothing to say about it. It used to be skipped
           on a different and false ground: that the reference "still resolves"
           because the invoice ids never change. Both ends of that link move, and
           the edges are declared and answered in `ARCHIVE_EDGES` now. The test
           below checks that declaration against the schema, so a NEW edge into
           the archive fails there rather than disappearing here. */
        if (exportOnly.has(target)) continue

        if (!position.has(target)) {
          violations.push(`${table} → ${target} (target is not restored)`)
          continue
        }
        if ((position.get(target) as number) > (position.get(table) as number)) {
          // An edge the order breaks on purpose is fixed by a second pass.
          if (deferred.has(table)) continue
          violations.push(`${table} → ${target} (target is imported later)`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test("every deferred table really has an edge that needs deferring", () => {
    // A stale entry here would cost a full table re-walk on every restore for
    // nothing, and would hide the next real cycle behind an exemption.
    const position = new Map(BACKUP_TABLES.map((table, index) => [table as string, index]))

    for (const table of DEFERRED_REMAP_TABLES) {
      const late = referencedTables(table).filter(
        (target) =>
          position.has(target) &&
          (position.get(target) as number) > (position.get(table) as number),
      )
      expect(late.length).toBeGreaterThan(0)
    }
  })

  test("every edge that crosses the archive boundary is declared, in both directions", () => {
    /* THE HOLE THIS CLOSES. The topological check above walks `BACKUP_TABLES`
       only, so `invoices`' own references were never examined at all — and
       `invoices.orderId` breaks on EVERY restore, this deployment included:
       `orders` is deleted and re-inserted under new ids while the invoices sit
       untouched. That is the authoritative half of `assertOrderHasNoInvoice`.

       Derived from the schema in both directions, so a new `v.id("invoices")`
       anywhere, or a new reference out of an export-only table, fails here and
       has to be answered in `ARCHIVE_EDGES` rather than discovered during
       someone's restore. */
    const exportOnly = new Set<string>(EXPORT_ONLY_TABLES)
    const restored = new Set<string>(BACKUP_TABLES)

    const actual: string[] = []
    for (const table of BACKUP_TABLES) {
      for (const target of referencedTables(table)) {
        if (exportOnly.has(target)) actual.push(`${table} -> ${target}`)
      }
    }
    for (const table of EXPORT_ONLY_TABLES) {
      for (const target of referencedTables(table)) {
        if (restored.has(target)) actual.push(`${table} -> ${target}`)
      }
    }

    const declared = ARCHIVE_EDGES.map((edge) => `${edge.from} -> ${edge.to}`)
    expect([...actual].sort()).toEqual([...declared].sort())

    // A declaration with no reason is the state this whole file exists to end.
    for (const edge of ARCHIVE_EDGES) {
      expect(edge.note.length, `${edge.from} -> ${edge.to} has no reason`).toBeGreaterThan(40)
    }
  })

  test("the tables relinked after an import are export-only, and every relinked edge is theirs", () => {
    // `relinkArchiveReferences` patches rows the restore never inserted. That
    // permission must not reach a table `importTable` also owns, and must not
    // reach one the archive does not contain.
    for (const table of ARCHIVE_RELINK_TABLES) {
      expect(EXPORT_ONLY_TABLES as readonly string[]).toContain(table)
      expect(BACKUP_TABLES as readonly string[]).not.toContain(table)
    }
    for (const edge of ARCHIVE_EDGES) {
      if (edge.answer === "relinked") expect(ARCHIVE_RELINK_TABLES).toContain(edge.from)
    }
  })

  test("the header's count of deferred edges is the array's own length", () => {
    /* `backupTables.ts` said "Two edges the order deliberately breaks are
       declared in `DEFERRED_REMAP_TABLES` below" over a one-element array, from
       the commit that introduced both (58f890f). No second edge was ever
       removed — the plural was never true, and a bullet list introduced by one
       reads as though a bullet was lost. */
    const claim = BACKUP_TABLES_SRC.match(/DEFERRED_REMAP_TABLES\.length === (\d+)/)
    expect(claim, "backupTables.ts no longer states the deferred-edge count").not.toBeNull()
    expect(Number(claim![1])).toBe(DEFERRED_REMAP_TABLES.length)
  })

  test("every deferred table is named in the bullets above the array", () => {
    // The other half of the same drift: a count that agrees with the array while
    // the bullets under it describe a different set.
    const block = BACKUP_TABLES_SRC.slice(
      BACKUP_TABLES_SRC.lastIndexOf("/**", BACKUP_TABLES_SRC.indexOf("export const DEFERRED_REMAP_TABLES")),
      BACKUP_TABLES_SRC.indexOf("export const DEFERRED_REMAP_TABLES"),
    )
    const bullets = block.match(/^\s*\*\s+- /gm) ?? []
    expect(bullets).toHaveLength(DEFERRED_REMAP_TABLES.length)
    for (const table of DEFERRED_REMAP_TABLES) {
      expect(block, `${table} has no bullet`).toContain(`\`${table}\` \u2192`)
    }
  })

  test("the fiscal archive is exported and never restored", () => {
    for (const table of ["invoices", "numberSequences"]) {
      // In the file: a backup that loses an establishment's invoices is not a
      // backup of that establishment.
      expect(EXPORTED_TABLES).toContain(table)
      // Not in the restore: a numbered series a restore can rewrite is not a
      // series (art. 242 nonies A CGI, and `tables/invoices.ts` says so).
      expect(BACKUP_TABLES).not.toContain(table)
    }
  })

  test("carries no credential and no identity", () => {
    for (const table of ["paymentConnections", "uberEatsConnections", "userProfiles"]) {
      expect(EXPORTED_TABLES).not.toContain(table)
      expect(EXCLUDED_TABLES.map((entry) => entry.table)).toContain(table)
    }
  })

  test("every exclusion carries a reason an operator can read", () => {
    // The manifest shows this list verbatim. "Absent because it is not the
    // establishment's" and "absent because someone forgot" used to look
    // identical from the outside.
    for (const { table, reason } of EXCLUDED_TABLES) {
      expect(reason.length, `${table} has no reason`).toBeGreaterThan(20)
    }
  })

  test("strips only fields the schema lets a restore come back without", () => {
    // A stripped field that the schema requires would make every restore of
    // that table fail validation.
    for (const [table, fields] of Object.entries(REDACTED_BACKUP_FIELDS)) {
      expect(BACKUP_TABLES).toContain(table)
      const validator = (
        schema.tables as Record<
          string,
          { validator: { json: { value: Record<string, { optional: boolean }> } } }
        >
      )[table].validator.json
      for (const field of fields) {
        expect(validator.value[field], `${table}.${field} is not in the schema`).toBeDefined()
        // A stripped field the schema requires would make every restore of that
        // table fail validation.
        expect(validator.value[field].optional, `${table}.${field} is required`).toBe(true)
      }
    }
  })
})
