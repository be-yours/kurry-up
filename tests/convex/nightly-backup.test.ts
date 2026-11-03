// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The nightly backup runs without a user, and lands somewhere that is not a
 * laptop.
 *
 * `grep backup` in `crons.ts` returned nothing. `exportBackup`'s only caller was
 * a button that built a Blob and triggered a browser download, and the function
 * could not be called from a cron at all: it opens with
 * `getAuthUserInternal`, which throws `"Not authenticated"` under a scheduled
 * job — the rule `crons.ts` states in its own header. So « Sauvegardes
 * automatiques quotidiennes de vos données et contenus » described a manual
 * export that happened when someone remembered. Issue #366.
 *
 * Two things are asserted, and the first is the one that made this impossible
 * before: the export core takes no identity, and the off-site write actually
 * puts bytes in the bucket.
 */

import { readFileSync } from "node:fs"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { internal } from "../../convex/_generated/api"
import schema from "../../convex/schema"
import { backupObjectKey } from "../../convex/systemBackupOffsite"
import { monorepoPath } from "../lib/repo-layout"

const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "put", input }
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "delete", input }
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "get", input }
  }),
  HeadObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "head", input }
  }),
  ListObjectVersionsCommand: vi.fn(function (input: unknown) {
    return { _cmd: "versions", input }
  }),
}))

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  process.env.AWS_S3_BUCKET_NAME = "test-bucket"
  process.env.AWS_REGION = "eu-west-3"
  process.env.AWS_ACCESS_KEY_ID = "test"
  process.env.AWS_SECRET_ACCESS_KEY = "test"
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The single `PutObjectCommand` the backup issued. */
function putCall(): { Bucket?: string; Key?: string; Body?: string } | undefined {
  return send.mock.calls
    .map(([cmd]) => cmd as { _cmd?: string; input?: Record<string, string> })
    .find((cmd) => cmd?._cmd === "put")?.input
}

/**
 * The one row `_setLastBackupAt` needs.
 *
 * Seeded in the tests that exercise the normal path, because a deployment that
 * has been through setup has it — and the case where it is missing gets its own
 * test below rather than being the silent default of every other one.
 */
async function seedSettings(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: false, clickAndCollect: true },
      hours: [],
      delivery: {},
      integrations: {},
      updatedAt: NOW,
    })
  )
}

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug: "pizzeria-napoli",
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

/**
 * The rehearsal runbook, read rather than remembered.
 *
 * Both apps resolve to the same file — it documents the drill, not either
 * app — and that is deliberate: a runbook whose commands nothing checks is a
 * runbook that quietly stops being true, and this one did. Its first inspection
 * command was `jq '{createdAt, deployedAppVersion, backupFormatVersion,
 * tableRowCounts}' backup.json`, against an object whose root is
 * `{ manifest, data }`. It returned four nulls, and `"tableRowCounts": null` is
 * what a good backup and a truncated one produce identically — while the step's
 * own prose makes that field the go/no-go gate. The very next line already
 * carried the `.manifest` prefix, which is why a read-through missed it.
 *
 * WHERE IT LIVES, AND WHY THAT MATTERS HERE. `apps/docs/deployment/` — above
 * this application, and therefore not in the tree a client receives. This file
 * SHIPS: the mirror copies every tracked file under `apps/themes` onto the
 * boilerplate, and rule 9 of `CLAUDE.md` tells the client to run `pnpm test`.
 * Read through `new URL("../../../docs/…")` it resolved, on a client's machine,
 * to a path outside their repository, and the whole file — the nightly backup
 * assertions below included — died on collection with
 * ENOENT '/home/runner/work/beyours-boilerplate/docs/deployment/backup-restore-rehearsal.md'.
 *
 * The runbook is the agency's document about the agency's drill. A client has
 * no copy of it and nothing to fix if it is wrong, so this block is scoped to
 * the engine checkout — by `monorepoPath`, which answers from the SHAPE of the
 * checkout, not from whether the file happens to be readable. Delete the
 * runbook in this repository and `readFileSync` still throws, loudly, which is
 * the property worth keeping.
 */
const RUNBOOK_PATH = monorepoPath("apps/docs/deployment/backup-restore-rehearsal.md")
const RUNBOOK: string | null = RUNBOOK_PATH === null ? null : readFileSync(RUNBOOK_PATH, "utf8")

/** The runbook text, or a throw — never a silent empty string standing in for it. */
function runbook(): string {
  if (RUNBOOK === null) {
    throw new Error("the rehearsal runbook is readable only in the engine monorepo")
  }
  return RUNBOOK
}

/**
 * Every manifest field the runbook tells an operator to read.
 *
 * Two `jq` shapes are recognised, because both are natural to write and both
 * appear: `.manifest.field`, and `.manifest | {a, b, c}`.
 */
function runbookManifestFields(): string[] {
  // `manifest.field` with or without the leading dot: the jq lines carry one,
  // the prose around them does not.
  const direct = [...runbook().matchAll(/\bmanifest\.([A-Za-z_]\w*)/g)].map(
    (match) => match[1] as string,
  )
  const projected = [...runbook().matchAll(/\.manifest\s*\|\s*\{([^}]*)\}/g)].flatMap((match) =>
    (match[1] as string).split(",").map((field) => field.trim()).filter(Boolean),
  )
  return [...new Set([...direct, ...projected])]
}

/**
 * The commands, without the prose.
 *
 * Step 1 quotes the broken `jq '{createdAt, …}'` in its own explanation of why
 * it was broken, and a guard that cannot tell a command from a description of
 * one would refuse the fix it is there to protect.
 */
function runbookCommands(): string[] {
  return [...runbook().matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((block) =>
    (block[1] as string).split("\n").map((line) => line.trim()).filter(Boolean),
  )
}

describe.skipIf(RUNBOOK === null)("the rehearsal runbook describes the file this writes", () => {
  test("every manifest field it names is one the manifest actually has", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)

    const payload = await t.action(internal.system.buildBackup, { performedBy: "cron" })
    const built = Object.keys(payload.manifest as Record<string, unknown>)

    const named = runbookManifestFields()
    // A guard over an empty set passes for the wrong reason.
    expect(named.length).toBeGreaterThan(4)

    const unknown = named.filter((field) => !built.includes(field))
    expect(
      unknown,
      `backup-restore-rehearsal.md names manifest fields that do not exist: ${unknown.join(", ")}`,
    ).toEqual([])
  })

  test("it does not tell an operator to read a manifest field off the root", async () => {
    /* The exact defect. `jq '{createdAt, …}' backup.json` reads the ROOT, which
       has only `manifest` and `data`, so every field comes back null — and a
       null row count looks the same whether the export was whole or stopped
       halfway. */
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)
    const payload = await t.action(internal.system.buildBackup, { performedBy: "cron" })

    const root = Object.keys(payload as Record<string, unknown>).sort()
    expect(root).toEqual(["data", "manifest"])

    const manifestFields = new Set(Object.keys(payload.manifest as Record<string, unknown>))
    for (const command of runbookCommands()) {
      const quoted = command.match(/jq\s+'([^']*)'/)
      if (!quoted) continue
      const body = quoted[1] as string
      // Every projection must be piped from `.manifest`, never taken from the
      // root — `jq '{createdAt, …}'` is the shape that returned four nulls.
      const projection = (body as string).match(/^\s*\{([^}]*)\}\s*$/)
      if (!projection) continue
      const fields = (projection[1] as string).split(",").map((f) => f.trim())
      const manifestOnes = fields.filter((f) => manifestFields.has(f))
      expect(
        manifestOnes,
        `jq '${body}' reads the root, but ${manifestOnes.join(", ")} live under .manifest`,
      ).toEqual([])
    }
  })
})

describe("the nightly backup", () => {
  test("builds an export with no user identity at all", async () => {
    /* The whole reason `buildBackup` exists. A scheduled job runs with no
       identity, so the guarded `exportBackup` — which opens with
       `getAuthUserInternal` — throws `"Not authenticated"` under a cron. */
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)

    const payload = await t.action(internal.system.buildBackup, {
      performedBy: "cron",
    })

    expect(payload.data.stores).toHaveLength(1)
    expect(payload.manifest.exportedBy).toBe("cron")
    /* The families a restore used to reach zero of. `cmsHome` was the fourth,
       and it left the backup set in #434.7: all sixteen legacy `cms*` singletons
       were superseded by `cmsPages` / `cmsBlocks` / `cmsMedia` and measured at
       zero writes anywhere, so backing them up walked sixteen tables that cannot
       hold a row. `cmsPages` is the one that carries a website now. */
    for (const table of ["orders", "payments", "kitchenTickets", "cmsPages"]) {
      expect(payload.manifest.tables).toContain(table)
    }
  })

  test("writes the export to the bucket, under backups/", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)

    const outcome = await t.action(internal.systemBackupOffsite.runNightlyBackup, {})

    expect(outcome).toMatchObject({ stored: true })
    const put = putCall()
    expect(put?.Bucket).toBe("test-bucket")
    expect(put?.Key).toMatch(/^backups\/.*\.json$/)

    // The bytes are the backup, not a manifest describing one.
    const written = JSON.parse(put?.Body as string)
    expect(written.data.stores).toHaveLength(1)
    expect(written.manifest.backupFormatVersion).toBeDefined()
  })

  test("records the off-site copy in the audit log", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)

    await t.action(internal.systemBackupOffsite.runNightlyBackup, {})

    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    const offsite = entries.filter(
      (e) => e.performedBy === "cron" && (e.details ?? "").includes("offsite"),
    )
    expect(offsite).toHaveLength(1)
    expect(offsite[0]?.result).toBe("success")
  })

  test("says so in the audit log when the deployment has no bucket", async () => {
    /* A fresh site or a local `convex dev` legitimately has no bucket, and this
       runs every night forever — so it must not throw. It must not be silent
       either: a client who believes they have nightly backups and has none is
       the failure this exists to end. */
    delete process.env.AWS_S3_BUCKET_NAME
    vi.spyOn(console, "error").mockImplementation(() => {})
    const t = convexTest(schema, modules)

    const outcome = await t.action(internal.systemBackupOffsite.runNightlyBackup, {})

    expect(outcome).toEqual({ stored: false, reason: "not-configured" })
    expect(putCall()).toBeUndefined()

    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    expect(entries.some((e) => e.result === "failure")).toBe(true)
  })

  test("reports a refused S3 write rather than throwing out of the cron", async () => {
    send.mockRejectedValue(new Error("AccessDenied"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const t = convexTest(schema, modules)
    await seedSettings(t)
    await seedStore(t)

    const outcome = await t.action(internal.systemBackupOffsite.runNightlyBackup, {})

    expect(outcome).toEqual({ stored: false, reason: "upload-failed" })
    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    expect(
      entries.some((e) => e.result === "failure" && (e.errorMessage ?? "").includes("S3")),
    ).toBe(true)
  })

  test("still stores a backup on a deployment that has no settings row yet", async () => {
    /* `_setLastBackupAt` throws when `globalSettings` is missing — a legitimate
       state on a site that has not been through setup. Left unguarded that
       turned a successful export into a failed job, every night, forever. */
    vi.spyOn(console, "error").mockImplementation(() => {})
    const t = convexTest(schema, modules)
    await seedStore(t)

    const outcome = await t.action(internal.systemBackupOffsite.runNightlyBackup, {})

    expect(outcome).toMatchObject({ stored: true })
    expect(putCall()?.Key).toMatch(/^backups\//)
  })

  test("names each night's copy so a listing sorts chronologically", () => {
    // Colons are legal in an S3 key and hostile in a filename; the ISO order
    // has to survive them.
    const first = backupObjectKey(Date.UTC(2026, 8, 7, 1, 30))
    const second = backupObjectKey(Date.UTC(2026, 8, 8, 1, 30))

    expect(first).toBe("backups/2026-09-07T01-30-00-000Z.json")
    expect(first < second).toBe(true)
    expect(first).not.toContain(":")
  })
})
