import { query, mutation, action, internalAction, internalMutation, type QueryCtx, type MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import {
  getAuthUser,
  requireRolePermission,
} from "@be-yours/convex-functions/auth"
import * as maintenanceDefs from "@be-yours/convex-functions/maintenance"
import {
  ARCHIVE_RELINK_TABLES,
  BACKUP_PAGE_SIZE,
  BACKUP_TABLES,
  DEFERRED_REMAP_TABLES,
  EXCLUDED_TABLES,
  EXPORTED_TABLES,
  EXPORT_ONLY_TABLES,
} from "@be-yours/convex-functions/backupTables"
import { Role, hasPermission, type Permission } from "@be-yours/core/auth/rbac"
import { profileAllowsPermission } from "@be-yours/convex-functions/teamAccess"
import { migrations } from "./migrations/index"

// Type returned by systemInternal.getAuthUserInternal
interface ActionAuthUser {
  userId: string
  role: Role
  storeIds: string[]
  profileId: string
  /** The invite dialog's module checkboxes, for the gate below. */
  permissions: string[]
}

/**
 * Both gates, for an ACTION (#649).
 *
 * An action cannot read the database, so it cannot call
 * `requireRolePermission` — it has only the row `getAuthUserInternal` handed
 * back. That row now carries the module list, so the same pair runs here:
 * role first, then the narrowing, which can only ever narrow.
 *
 * Every role holding a `system:*` permission is module-exempt today, so this
 * refuses nobody yet. It is here so the next role added is gated by default,
 * which is the whole lesson of the finding.
 */
function assertActionPermission(user: ActionAuthUser, permission: Permission): void {
  if (!hasPermission(user.role, permission)) {
    throw new Error(`Permission "${permission}" requise`)
  }
  if (!profileAllowsPermission({ role: user.role, permissions: user.permissions }, permission)) {
    throw new Error(`Module requis pour "${permission}"`)
  }
}

// Type returned by maintenance._getUpdateGatingData (annotated explicitly to
// break the api-type circularity between system.ts and maintenance.ts)
interface UpdateGatingData {
  contract: (maintenanceDefs.MaintenanceContractLike & { autoRenew: boolean }) | null
  releases: maintenanceDefs.ReleaseLike[]
}

// Type returned by checkForUpdates
interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  entitledVersion: string | null
  hasEntitledUpdate: boolean
  lockedVersions: string[]
  maintenanceStatus: maintenanceDefs.MaintenanceStatus
  coveredUntil: number | null
  registryError: string | null
  /**
   * Whether a release feed is configured at all. False means no lookup was
   * attempted, which is a different thing from one that was attempted and
   * failed — and the screen has to say so, or it accuses a registry that was
   * never asked.
   */
  registryConfigured: boolean
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const LOCK_DURATION_MS = 10 * 60 * 1000 // 10 minutes
const BACKUP_FORMAT_VERSION = "1.0.0"

const PERM_SYSTEM_READ = "system:read" as Permission
const PERM_SYSTEM_BACKUP = "system:backup" as Permission
const PERM_SYSTEM_RESTORE = "system:restore" as Permission
const PERM_SYSTEM_MIGRATE = "system:migrate" as Permission

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function requireSystemPermission(ctx: QueryCtx | MutationCtx, permission: Permission) {
  /* Role AND module (#649): `system` maps to the `settings` module. Every role
     holding a `system:*` permission is module-exempt today, so this narrows
     nobody yet and is here so the next one is gated by default. */
  return await requireRolePermission(ctx, permission)
}

async function getSettings(ctx: QueryCtx | MutationCtx) {
  return ctx.db.query("globalSettings").first()
}

function isLockActive(lock: { expiresAt: number } | undefined | null): boolean {
  if (!lock) return false
  return lock.expiresAt > Date.now()
}

// ─── Queries ────────────────────────────────────────────────────────────────────

/** Get system info: version snapshot, lock status, migrations, last backup */
// @guarded-inline: system:* permission checked in the handler
export const getSystemInfo = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireSystemPermission(ctx, PERM_SYSTEM_READ)

    const settings = await getSettings(ctx)

    return {
      deployedAppVersion: settings?.deployedAppVersion ?? null,
      backupFormatVersion: settings?.backupFormatVersion ?? BACKUP_FORMAT_VERSION,
      appliedMigrations: settings?.appliedMigrations ?? [],
      systemLock: settings?.systemLock ?? null,
      isLockActive: isLockActive(settings?.systemLock),
      lastBackupAt: settings?.lastBackupAt ?? null,
    }
  },
})

/**
 * Can this reader see this entry?
 *
 * System operations belong to no establishment and stay visible to every
 * `system:read` holder. Establishment entries are scoped the way the rest of
 * the admin surface is scoped: a super admin sees all of them, anyone else sees
 * the stores their profile actually lists. Without this the journal would be
 * the one screen where a client admin could read another establishment's
 * address and opening hours.
 *
 * Membership is enough to keep the journal honest about your own work, which
 * was not always true. `stores.create` could hand a client admin a restaurant
 * they were not a member of, so scoping alone hid their own creation from them
 * and the journal read as "nothing happened". That gap was patched here with a
 * second rule — an entry you performed stays visible whatever the scope says —
 * and then closed at its source in #117: creating an establishment now makes
 * you its administrator, so the second rule is gone and one rule decides again.
 *
 * One path can still put your own entry on a store you no longer administer: a
 * super admin rewriting your profile and dropping the store. Team revocation
 * cannot do it — `revocationEffect` returns an admin's profile untouched — so
 * that removal is always deliberate, and the scoped answer is the wanted one.
 * Being removed from a restaurant is exactly what scoping is for.
 *
 * ACCESS entries are the exception, and are super-admin only. They are about a
 * PERSON rather than an establishment — who was promoted, moved or dismissed —
 * so there is no store to scope them by, and the "no target means everyone"
 * rule above would have handed a client admin the rights history of every
 * account on the deployment. Narrow on purpose: widening this later is easy,
 * un-leaking it is not.
 */
function canReadAuditEntry(
  user: { role: Role; storeIds: string[] },
  entry: { targetStoreId?: string; targetUserId?: string },
): boolean {
  if (entry.targetUserId) return user.role === Role.SUPER_ADMIN
  if (!entry.targetStoreId) return true
  if (user.role === Role.SUPER_ADMIN) return true
  return user.storeIds.includes(entry.targetStoreId)
}

/** Get paginated audit log */
// @guarded-inline: system:* permission checked in the handler
export const getAuditLog = query({
  args: {
    paginationOpts: v.object({
      cursor: v.union(v.string(), v.null()),
      numItems: v.number(),
    }),
    filterAction: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireSystemPermission(ctx, PERM_SYSTEM_READ)

    const numItems = Math.min(args.paginationOpts.numItems, 100)

    // Use the appropriate index depending on whether we filter by action
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any
    if (args.filterAction) {
      q = ctx.db.query("systemAuditLog")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_action", (q: any) => q.eq("action", args.filterAction))
        .order("desc")
    } else {
      q = ctx.db.query("systemAuditLog")
        .withIndex("by_performedAt")
        .order("desc")
    }

    // Convex's own cursor rather than a hand-rolled one.
    //
    // This used to re-`take(numItems + 1)` from the top of the index on every
    // call and hunt for the previous page's last `_id` inside that slice, so
    // page two came back holding a single row and declaring itself done.
    // Nothing noticed while the log held only the handful of system
    // operations; now that every establishment change lands here, a journal
    // that stops at row eleven is a journal nobody can read.
    const result = await q.paginate({
      cursor: args.paginationOpts.cursor,
      numItems,
    })

    // Filtering after the page is drawn can hand back a short page — the
    // cursor and `isDone` stay correct, so the reader keeps paging. Scoping
    // before the read would need one index per reader.
    return {
      page: result.page.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => canReadAuditEntry(user, entry),
      ),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    }
  },
})

// ─── Internal mutations ─────────────────────────────────────────────────────────

export const _recordAuditEntry = internalMutation({
  args: {
    action: v.union(
      v.literal("backup_export"),
      v.literal("backup_import"),
      v.literal("backup_import_dryrun"),
      v.literal("migration_run"),
      v.literal("version_check"),
      v.literal("lock_force_release"),
    ),
    performedBy: v.string(),
    details: v.optional(v.string()),
    result: v.union(v.literal("success"), v.literal("failure")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("systemAuditLog", {
      ...args,
      performedAt: Date.now(),
    })
  },
})

export const _acquireSystemLock = internalMutation({
  args: {
    operation: v.string(),
    lockedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const settings = await getSettings(ctx)
    if (!settings) throw new Error("Paramètres globaux introuvables")

    if (isLockActive(settings.systemLock)) {
      throw new Error(
        `Système verrouillé par "${settings.systemLock!.lockedBy}" ` +
        `pour "${settings.systemLock!.operation}". ` +
        `Expire a ${new Date(settings.systemLock!.expiresAt).toLocaleString()}`
      )
    }

    await ctx.db.patch(settings._id, {
      systemLock: {
        operation: args.operation,
        lockedBy: args.lockedBy,
        lockedAt: Date.now(),
        expiresAt: Date.now() + LOCK_DURATION_MS,
      },
    })
  },
})

export const _releaseSystemLock = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await getSettings(ctx)
    if (!settings) return
    await ctx.db.patch(settings._id, { systemLock: undefined })
  },
})

export const _syncAppVersion = internalMutation({
  args: { version: v.string() },
  handler: async (ctx, args) => {
    const settings = await getSettings(ctx)
    if (!settings) throw new Error("Paramètres globaux introuvables")
    await ctx.db.patch(settings._id, {
      deployedAppVersion: args.version,
      updatedAt: Date.now(),
    })
  },
})

export const _setLastBackupAt = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await getSettings(ctx)
    if (!settings) throw new Error("Paramètres globaux introuvables")
    await ctx.db.patch(settings._id, {
      lastBackupAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const _addAppliedMigration = internalMutation({
  args: {
    id: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const settings = await getSettings(ctx)
    if (!settings) return
    const current = settings.appliedMigrations ?? []
    await ctx.db.patch(settings._id, {
      appliedMigrations: [...current, {
        id: args.id,
        name: args.name,
        appliedAt: Date.now(),
      }],
      updatedAt: Date.now(),
    })
  },
})

// ─── Mutations ──────────────────────────────────────────────────────────────────

/** Force release system lock (owner/admin only) */
// @guarded-inline: system:* permission checked in the handler
export const forceReleaseLock = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireSystemPermission(ctx, PERM_SYSTEM_RESTORE)
    const settings = await getSettings(ctx)
    if (!settings) throw new Error("Paramètres globaux introuvables")

    await ctx.db.patch(settings._id, { systemLock: undefined })
    // Note: writing directly to systemAuditLog here is intentional —
    // mutations cannot call internalMutations, so we insert directly
    // instead of going through _recordAuditEntry.
    await ctx.db.insert("systemAuditLog", {
      action: "lock_force_release",
      performedBy: user.userId,
      performedAt: Date.now(),
      result: "success",
    })
  },
})

/** Sync runtime version to DB snapshot */
// @guarded-inline: system:* permission checked in the handler
export const syncVersion = mutation({
  args: { version: v.string() },
  handler: async (ctx, args) => {
    await requireSystemPermission(ctx, PERM_SYSTEM_READ)
    const settings = await getSettings(ctx)
    if (!settings) throw new Error("Paramètres globaux introuvables")

    await ctx.db.patch(settings._id, {
      deployedAppVersion: args.version,
      updatedAt: Date.now(),
    })
  },
})

// ─── Actions ────────────────────────────────────────────────────────────────────

/**
 * Check for available updates via npm registry, gated by the maintenance
 * contract: the release catalog is synced from the packument's `time` map,
 * then the entitled version is resolved against `coveredUntil`. Releases
 * published after the end of coverage are reported as locked.
 */
// @guarded-inline: getAuthUser + hasPermission on system:*
export const checkForUpdates = action({
  args: { currentVersion: v.string() },
  handler: async (ctx, args): Promise<UpdateCheckResult> => {
    const user: ActionAuthUser = await ctx.runQuery(internal.systemInternal.getAuthUserInternal, {})
    assertActionPermission(user, PERM_SYSTEM_READ)

    let registryError: string | null = null

    // 1. Sync the release catalog from the release feed (best effort — an
    //    outage must not hide already-known releases).
    //
    //    This used to fetch `registry.npmjs.org/@be-yours/restaurant-theme`
    //    unconditionally. No package by that name is published anywhere, and the
    //    engine's ten packages go to npm.pkg.github.com as `restricted`, not to
    //    npmjs — so the request was a guaranteed 404 and every owner who opened
    //    this screen was told "Registre npm inaccessible (HTTP 404)", for ever.
    //    There is no correct public URL to substitute: which feed a deployment
    //    reads, and with what credentials, is a deployment decision.
    //
    //    So it is configuration now. Unset means no feed, which the screen
    //    reports as unconfigured rather than as a registry that let us down.
    const packumentUrl = process.env.ENGINE_RELEASE_PACKUMENT_URL?.trim()
    const registryConfigured = Boolean(packumentUrl)

    if (packumentUrl) {
      try {
        // A private registry (GitHub Packages, a proxy) needs a token. Kept
        // optional: a public or unauthenticated feed needs no header.
        const token = process.env.ENGINE_RELEASE_REGISTRY_TOKEN?.trim()
        const res = await fetch(packumentUrl, {
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        })

        if (res.ok) {
          const data = await res.json()
          const releases = maintenanceDefs.parseNpmTimeMap(data.time)
          if (releases.length > 0) {
            await ctx.runMutation(internal.maintenance._upsertReleases, {
              releases,
              source: "npm",
            })
          }
        } else {
          registryError = `Registre indisponible (HTTP ${res.status})`
        }
      } catch (error) {
        registryError = error instanceof Error ? error.message : String(error)
      }
    }

    // 2. Resolve entitlement from the stored catalog + contract
    const { contract, releases }: UpdateGatingData = await ctx.runQuery(
      internal.maintenance._getUpdateGatingData,
      {}
    )
    const entitlement = maintenanceDefs.resolveUpdateEntitlement({
      releases,
      contract,
      currentVersion: args.currentVersion,
      nowMs: Date.now(),
    })

    const result: UpdateCheckResult = {
      currentVersion: args.currentVersion,
      latestVersion: entitlement.latestVersion ?? args.currentVersion,
      hasUpdate: entitlement.hasUpdate,
      // Maintenance gating
      entitledVersion: entitlement.entitledVersion,
      hasEntitledUpdate: entitlement.hasEntitledUpdate,
      lockedVersions: entitlement.lockedVersions,
      maintenanceStatus: entitlement.maintenanceStatus,
      coveredUntil: contract?.coveredUntil ?? null,
      registryError,
      registryConfigured,
    }

    await ctx.runMutation(internal.system._recordAuditEntry, {
      action: "version_check",
      performedBy: user.userId,
      result: registryError ? "failure" : "success",
      details: JSON.stringify({
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        hasUpdate: result.hasUpdate,
        entitledVersion: result.entitledVersion,
        maintenanceStatus: result.maintenanceStatus,
      }),
      ...(registryError ? { errorMessage: registryError } : {}),
    })

    return result
  },
})

/**
 * Build a backup, with no identity of any kind.
 *
 * The guarded `exportBackup` below is the button; this is the work. They were
 * one function, and that made a nightly backup impossible to write: the guard
 * calls `getAuthUserInternal`, which throws `"Not authenticated"` under a cron —
 * a scheduled job runs with NO user identity, a rule `crons.ts` states in its
 * own header (*"the nightly menu push already died that way once"*). So the
 * only caller `exportBackup` ever had was a button that built a Blob and
 * downloaded it to whatever laptop the administrator was sitting at. No cron,
 * no off-site copy, no retention — while the maintenance fee was sold on
 * « Sauvegardes automatiques quotidiennes de vos données et contenus » (#366).
 *
 * `performedBy` is a label for the audit entry, not a permission: an
 * `internalAction` is unreachable from a browser, and the two call sites are
 * the guarded wrapper (which passes the operator's id) and the cron (which
 * passes `"cron"`).
 */
export const buildBackup = internalAction({
  args: { performedBy: v.string() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (ctx, args): Promise<{ manifest: any; data: Record<string, any[]> }> => {
    const user = { userId: args.performedBy }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const settings: any = await ctx.runQuery(internal.systemInternal.getSettingsInternal, {})

      /* One list, in `@be-yours/convex-functions/backupTables`, shared with
         the import allow-list in `systemInternal.ts`. It used to be written out
         twice and the two had to agree by hand; between them they named 22 of
         this schema's 77 tables, omitting the orders, the payments, the
         translations and all sixteen CMS singletons — so a "backup" of a
         restaurant's website did not contain that website's pages (#169). */
      const tableNames = EXPORTED_TABLES

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: Record<string, any[]> = {}
      const tableSummary: Record<string, number> = {}

      /* Paged, not collected (#432.4). `exportTable` used to `.collect()` the
         whole table, and Convex refuses a transaction that reads more than
         16,384 documents — so an establishment trading two years threw on its
         orders alone and could not take a backup at all, for ever, with no
         admin action that cleared it. The loop is the fix; `BACKUP_PAGE_SIZE`
         is the page. */
      for (const tableName of tableNames) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = []
        let cursor: string | null = null
        for (;;) {
          const page: { rows: unknown[]; cursor: string; isDone: boolean } =
            await ctx.runQuery(internal.systemInternal.exportTablePage, {
              tableName,
              cursor,
            })
          rows.push(...page.rows)
          if (page.isDone) break
          cursor = page.cursor
        }
        data[tableName] = rows
        tableSummary[tableName] = rows.length
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const manifest: Record<string, any> = {
        createdAt: Date.now(),
        deployedAppVersion: settings?.deployedAppVersion ?? "unknown",
        backupFormatVersion: BACKUP_FORMAT_VERSION,
        exportedBy: user.userId,
        tables: Object.keys(data),
        tableRowCounts: tableSummary,
        /* What the file carries but a restore will not put back, and what it
           does not carry at all — both stated in the file itself. An operator
           reading a backup could not previously tell "absent because it is not
           the establishment's" from "absent because someone forgot", and that
           ambiguity is the defect #169 names. */
        restoredTables: [...BACKUP_TABLES],
        archivedNotRestored: EXPORT_ONLY_TABLES.map((table) => ({
          table,
          reason:
            table === "systemAuditLog"
              ? "Journal d'audit : conservé dans la sauvegarde, jamais réécrit par une restauration."
              : "Document fiscal numéroté (art. 242 nonies A CGI) : conservé dans la sauvegarde, jamais réécrit par une restauration.",
        })),
        excludedTables: EXCLUDED_TABLES,
        note: "Images S3 non incluses — seules les references/URLs sont sauvegardees",
      }

      /* Best-effort, and only this one. `_setLastBackupAt` throws when the
         deployment has no `globalSettings` row — a legitimate state on a site
         that has not been through setup yet, and one the nightly cron would
         otherwise hit every night forever, turning a successful export into a
         failed job. The stamp is a convenience on the System screen; the export
         it would date has already been built. */
      try {
        await ctx.runMutation(internal.system._setLastBackupAt, {})
      } catch (stampError) {
        console.error("[backup] could not stamp lastBackupAt:", stampError)
      }
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_export",
        performedBy: user.userId,
        result: "success",
        details: JSON.stringify({ tables: Object.keys(tableSummary), totalRows: Object.values(tableSummary).reduce((a, b) => a + b, 0) }),
      })

      return { manifest, data }
    } catch (error) {
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_export",
        performedBy: user.userId,
        result: "failure",
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
})

/** Export a full backup as JSON — the admin button. */
// @guarded-inline: getAuthUser + hasPermission on system:backup
export const exportBackup = action({
  args: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (ctx): Promise<{ manifest: any; data: Record<string, any[]> }> => {
    const user: ActionAuthUser = await ctx.runQuery(internal.systemInternal.getAuthUserInternal, {})
    assertActionPermission(user, PERM_SYSTEM_BACKUP)

    return await ctx.runAction(internal.system.buildBackup, {
      performedBy: user.userId,
    })
  },
})

/** Import backup — dry run mode by default */
// @guarded-inline: getAuthUser + hasPermission on system:restore
export const importBackup = action({
  args: {
    manifest: v.any(),
    data: v.any(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user: ActionAuthUser = await ctx.runQuery(internal.systemInternal.getAuthUserInternal, {})
    assertActionPermission(user, PERM_SYSTEM_RESTORE)

    // Validate manifest
    const { manifest, data } = args
    if (!manifest?.backupFormatVersion || !manifest?.tables) {
      throw new Error("Manifest invalide : backupFormatVersion et tables requis")
    }
    if (manifest.backupFormatVersion !== BACKUP_FORMAT_VERSION) {
      throw new Error(
        `Version de backup incompatible : ${manifest.backupFormatVersion} (attendu : ${BACKUP_FORMAT_VERSION})`
      )
    }

    // Validate data structure
    if (typeof data !== "object" || data === null) {
      throw new Error("Données de backup invalides")
    }
    for (const table of manifest.tables) {
      if (data[table] !== undefined && !Array.isArray(data[table])) {
        throw new Error(`Table "${table}" invalide : tableau attendu`)
      }
    }

    // Build summary
    const summary: Record<string, number> = {}
    for (const table of manifest.tables) {
      summary[table] = Array.isArray(data[table]) ? data[table].length : 0
    }

    if (args.dryRun) {
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_import_dryrun",
        performedBy: user.userId,
        result: "success",
        details: JSON.stringify({ tables: summary }),
      })

      return {
        dryRun: true,
        summary,
        totalRows: Object.values(summary).reduce((a, b) => a + b, 0),
        message: "Mode aperçu — aucune donnée modifiée. ATTENTION : l'import réel n'est pas atomique — en cas d'échec, certaines tables pourraient être partiellement modifiées.",
      }
    }

    // Real import
    try {
      await ctx.runMutation(internal.system._acquireSystemLock, {
        operation: "backup_import",
        lockedBy: user.userId,
      })

      /* The same list the export walks, minus the archive. `EXPORT_ONLY_TABLES`
         are in the file and never re-inserted: a numbered fiscal series that a
         restore can rewrite is not a series (art. 242 nonies A CGI), and
         `tables/invoices.ts` states that rule in the schema itself.

         That does NOT leave the link between an order and its invoice intact,
         and this comment claimed for months that it did. Both ends of the link
         move — `orders` is re-inserted under new ids, so the invoices point at
         nothing; and on a rebuilt deployment the invoices are absent, so the
         orders point at nothing. Neither can be answered by the import ORDER,
         because an export-only table has no position in it. Both are repaired
         after the last insert, below. */
      const importOrder = BACKUP_TABLES

      // The id map, carried table by table.
      //
      // An insert cannot choose its `_id`, so every restored row comes back
      // under a new one. Without this, `stores` came back with new ids while
      // everything restored after them kept the old `storeId`, and
      // `v.id("stores")` let it through — it validates an id's encoding, not
      // that it resolves. The deployment came up with every catalogue detached
      // from its establishment. `importOrder` is why this works: a reference is
      // only rewritable once its target has been inserted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idMap: Record<string, string> = {}

      for (const tableName of importOrder) {
        if (!data[tableName] || !Array.isArray(data[tableName])) continue

        /* The clear comes first and in pages (#432.4). `importTable` used to
           read every existing row and delete it in the same transaction as the
           inserts — two passes over the whole table against a 16,384-document
           ceiling, so a restaurant with two years of orders could not restore
           its own backup.

           `drainClear` loops until a short page says the table is empty. The
           bound on the loop is that each pass deletes a full page or is the
           last one, so it terminates on any finite table. */
        for (;;) {
          const pass: { deleted: number; done: boolean } = await ctx.runMutation(
            internal.systemInternal.clearTablePage,
            { tableName }
          )
          if (pass.done) break
        }

        /* And the inserts in pages too, for the write ceiling rather than the
           read one: a mutation may write 16,384 documents and 8 MiB, and the
           rows come from a file an operator uploads. Annotated rather than
           inferred: `importBackup` reaches these mutations through `internal`,
           and letting TypeScript infer the shape back out of them makes the
           action's own return type circular. */
        const rows = data[tableName]
        for (let offset = 0; offset < rows.length; offset += BACKUP_PAGE_SIZE) {
          const result: { idMap: Record<string, string> } = await ctx.runMutation(
            internal.systemInternal.importTable,
            { tableName, rows: rows.slice(offset, offset + BACKUP_PAGE_SIZE), idMap }
          )
          Object.assign(idMap, result.idMap)
        }
      }

      /* The foreign-key graph has a cycle, so no order can satisfy every edge.
         `stores.stationMapping[].categoryId` points at `categories`, which
         cannot come first because it points back at `stores` — so the kitchen
         routing came back naming categories that no longer existed. Silently:
         every ticket fell through to the single-station behaviour and nobody
         was told the routing had been lost. One more pass with the FULL map
         closes it. */
      let deferredRemaps = 0
      for (const tableName of DEFERRED_REMAP_TABLES) {
        let cursor: string | null = null
        for (;;) {
          const pass: { patched: number; cursor: string; isDone: boolean } =
            await ctx.runMutation(internal.systemInternal.remapDeferredReferences, {
              tableName,
              idMap,
              cursor,
            })
          deferredRemaps += pass.patched
          if (pass.isDone) break
          cursor = pass.cursor
        }
      }

      /* The fiscal archive is not re-inserted, so no ordering can reach it —
         and every invoice was therefore left naming the order and the store it
         had BEFORE this restore. `invoices.by_orderId` is the authoritative
         half of `assertOrderHasNoInvoice`, so an order invoiced before
         `orders.invoiceId` existed became deletable with its invoice standing;
         `by_storeId_issuedAt` is the establishment's invoice list, and it came
         back empty. Re-pointing those two ids is not editing the document —
         art. 242 nonies A fixes its number, dates, parties and figures, not
         this deployment's pointers at the sale. `ARCHIVE_EDGES` declares every
         edge that crosses the boundary. */
      let archiveRelinks = 0
      for (const tableName of ARCHIVE_RELINK_TABLES) {
        let cursor: string | null = null
        for (;;) {
          const pass: { relinked: number; cursor: string; isDone: boolean } =
            await ctx.runMutation(internal.systemInternal.relinkArchiveReferences, {
              tableName,
              idMap,
              cursor,
            })
          archiveRelinks += pass.relinked
          if (pass.isDone) break
          cursor = pass.cursor
        }
      }

      /* The other half, and the one only a REBUILT deployment sees: the
         invoices are in the file and not in this database, so a restored
         `orders.invoiceId` names a row nothing here has. `invoiceRefusal` reads
         that field for truthiness rather than resolution, so the sale could
         never be invoiced again — the admin showed no number and the reason
         "already issued", for ever. Re-pointed where an invoice stands for the
         order, cleared where none does, and counted either way: an operator has
         to be told, because the archived documents are then only in the backup
         file. */
      const invoiceLinks = { repointed: 0, cleared: 0 }
      {
        let cursor: string | null = null
        for (;;) {
          const pass: {
            repointed: number
            cleared: number
            cursor: string
            isDone: boolean
          } = await ctx.runMutation(
            internal.systemInternal.reconcileOrderInvoiceLinks,
            { cursor }
          )
          invoiceLinks.repointed += pass.repointed
          invoiceLinks.cleared += pass.cleared
          if (pass.isDone) break
          cursor = pass.cursor
        }
      }

      // `userProfiles` is not in the backup — it holds identities, not
      // restaurant data — so its `storeIds` still name the deployment's stores
      // from before the restore. Left alone, every store-scoped screen refuses
      // the owner who just ran the restore.
      const profiles = { updated: 0, dropped: 0 }
      {
        let cursor: string | null = null
        for (;;) {
          const pass: {
            updated: number
            dropped: number
            cursor: string
            isDone: boolean
          } = await ctx.runMutation(internal.systemInternal.remapProfileStores, {
            idMap,
            cursor,
          })
          profiles.updated += pass.updated
          profiles.dropped += pass.dropped
          if (pass.isDone) break
          cursor = pass.cursor
        }
      }

      /* A backup carries personal data — orders, payments, kitchen tickets,
         subscribers — and can be older than the retention window it is restored
         into. Re-running the purge is what stops a restore resurrecting what
         the establishment was obliged to remove (art. 5.1.e). Scheduled rather
         than awaited: the sweep reschedules itself until it is done, and a
         restore must not wait on it. */
      await ctx.scheduler.runAfter(0, internal.privacy.sweepExpiredCustomerData, {})

      await ctx.runMutation(internal.system._releaseSystemLock, {})
      /* The counts, not just the row totals. `importBackup`'s `message` is the
         only place the invoice repair is described, and the admin's toast shows
         the row count rather than the message — so without this the fact that a
         restore detached an order from an invoice this deployment does not have
         would exist only in the return value of an action nobody kept. The
         rehearsal runbook reads this entry. */
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_import",
        performedBy: user.userId,
        result: "success",
        details: JSON.stringify({
          tables: summary,
          deferredRemaps,
          archiveRelinks,
          repointedInvoices: invoiceLinks.repointed,
          clearedInvoiceLinks: invoiceLinks.cleared,
          remappedProfiles: profiles.updated,
          droppedProfileStores: profiles.dropped,
        }),
      })

      return {
        dryRun: false,
        summary,
        totalRows: Object.values(summary).reduce((a, b) => a + b, 0),
        remappedIds: Object.keys(idMap).length,
        remappedProfiles: profiles.updated,
        droppedProfileStores: profiles.dropped,
        deferredRemaps,
        archiveRelinks,
        repointedInvoices: invoiceLinks.repointed,
        clearedInvoiceLinks: invoiceLinks.cleared,
        /* What a restore does NOT put back, said every time rather than left to
           be discovered. The old wording named orders, payments, tickets and
           team members; all four are restored now, and the one thing still
           deliberately untouched is the fiscal archive.

           The two sentences after it are the ones that used to be missing. A
           restore that quietly detached an order from its invoice, or quietly
           left every invoice pointing at a deleted order, is the same silence
           the whole backup module exists to end — and on a rebuilt deployment
           the operator has to be told that the backup FILE is now the only copy
           of the old series. */
        message:
          "Import terminé. Les factures et leur numérotation sont conservées telles quelles : un document fiscal numéroté ne peut pas être réécrit par une restauration (art. 242 nonies A CGI)." +
          (archiveRelinks > 0
            ? ` ${archiveRelinks} facture(s) ont été rattachées aux commandes et aux établissements revenus sous un nouvel identifiant ; le contenu des documents est inchangé.`
            : "") +
          (invoiceLinks.repointed > 0
            ? ` ${invoiceLinks.repointed} commande(s) ont été rattachées à la facture déjà émise pour elles.`
            : "") +
          (invoiceLinks.cleared > 0
            ? ` ${invoiceLinks.cleared} commande(s) renvoyaient à une facture absente de ce déploiement : le lien a été retiré pour qu'une facture puisse de nouveau être émise, dans la série de ce déploiement. Les documents d'origine ne sont que dans le fichier de sauvegarde — conservez-le : il est la seule copie de cette série (art. L102 B du LPF, six ans).`
            : "") +
          (profiles.dropped > 0
            ? ` ${profiles.dropped} accès à un établissement absent de la sauvegarde ont été retirés des profils.`
            : ""),
      }
    } catch (error) {
      try {
        await ctx.runMutation(internal.system._releaseSystemLock, {})
        await ctx.runMutation(internal.system._recordAuditEntry, {
          action: "backup_import",
          performedBy: user.userId,
          result: "failure",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      } catch (cleanupError) {
        console.error("Failed to clean up after error:", cleanupError)
      }
      throw error
    }
  },
})

/** Run pending migrations */
// @guarded-inline: getAuthUser + hasPermission on system:migrate
export const runMigrations = action({
  args: {},
  handler: async (ctx) => {
    const user: ActionAuthUser = await ctx.runQuery(internal.systemInternal.getAuthUserInternal, {})
    assertActionPermission(user, PERM_SYSTEM_MIGRATE)

    try {
      await ctx.runMutation(internal.system._acquireSystemLock, {
        operation: "migrations",
        lockedBy: user.userId,
      })

      // Get applied migrations
      const settings = await ctx.runQuery(internal.systemInternal.getSettingsInternal, {})
      const applied = new Set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (settings?.appliedMigrations ?? []).map((m: any) => m.id)
      )

      // Get migration registry (statically imported at top of file)
      const pending = migrations.filter((m) => !applied.has(m.id))

      if (pending.length === 0) {
        await ctx.runMutation(internal.system._releaseSystemLock, {})
        return { applied: 0, message: "Aucune migration en attente" }
      }

      let count = 0
      for (const migration of pending) {
        await migration.run(ctx)
        await ctx.runMutation(internal.system._addAppliedMigration, {
          id: migration.id,
          name: migration.name,
        })
        count++
      }

      await ctx.runMutation(internal.system._releaseSystemLock, {})
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "migration_run",
        performedBy: user.userId,
        result: "success",
        details: JSON.stringify({
          applied: count,
          migrations: pending.map((m) => m.id),
        }),
      })

      return { applied: count, message: `${count} migration(s) appliquee(s)` }
    } catch (error) {
      try {
        await ctx.runMutation(internal.system._releaseSystemLock, {})
        await ctx.runMutation(internal.system._recordAuditEntry, {
          action: "migration_run",
          performedBy: user.userId,
          result: "failure",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      } catch (cleanupError) {
        console.error("Failed to clean up after error:", cleanupError)
      }
      throw error
    }
  },
})
