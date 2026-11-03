"use node"

/**
 * The nightly backup, written somewhere that is not a laptop.
 *
 * `exportBackup` had exactly one caller: a button that built a Blob and
 * triggered a browser download. `grep backup` across both `crons.ts` files
 * returned nothing. So the maintenance fee's « Sauvegardes automatiques
 * quotidiennes de vos données et contenus » described a manual export that
 * happened when someone remembered, landed wherever they happened to be sitting,
 * and had no retention at all. Issue #366.
 *
 * `"use node"` because it reaches S3 with the AWS SDK, and the module boundary
 * that imposes is why the export itself lives in `system.ts`: an `httpAction`
 * and every query and mutation can call THAT, and only this half needs Node.
 *
 * ## Where the file goes, and what that costs
 *
 * The client's own bucket, under `backups/`. That follows the ownership
 * decision already made for their Convex deployment, their Stripe account and
 * their media (`tasks/production-accounts-checklist.md`): what is theirs stays
 * theirs and leaves with them.
 *
 * It is also the honest limit of this. **A backup in the client's own bucket
 * shares a blast radius with the data it protects** — an AWS account closed, a
 * key rotated wrongly, a bucket deleted, and both go together. It defends
 * against the failures that actually happen to a restaurant (a bad import, a
 * deleted establishment, a Convex incident) and not against losing the AWS
 * account. A genuinely independent copy means a BeInDigital-owned bucket, which
 * reverses that ownership decision and raises a GDPR sub-processor question the
 * CGV already touches. That is a commercial decision, not a code change, and it
 * is recorded in `tasks/sales-readiness-backlog.md` rather than quietly taken
 * here.
 *
 * ## Retention
 *
 * An S3 lifecycle rule over the `backups/` prefix, installed by
 * `scripts/setup-aws.sh` — 30 daily copies. Not a cron that deletes: a
 * lifecycle rule keeps working when the deployment is down, which is the
 * circumstance a backup exists for.
 *
 * `backups/` is deliberately NOT in `S3_FOLDERS`. That list drives the
 * `/api/files` proxy's allow-list, and a backup reachable over HTTP is the
 * whole database served to whoever guesses a key.
 */

import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

/**
 * The prefix, and the one place it is written.
 *
 * Not a member of `S3_FOLDERS` — see this module's header. The upload route and
 * the file proxy both derive their allow-lists from that constant, so keeping
 * `backups/` out of it is what stops a backup being downloadable through the
 * app by anyone who can name the key.
 */
export const BACKUP_S3_PREFIX = "backups"

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

/** `backups/2026-09-07T03-00-00-000Z.json` — sorts chronologically in a listing. */
export function backupObjectKey(now: number): string {
  return `${BACKUP_S3_PREFIX}/${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`
}

/** What the cron reports, so a failure is legible in the audit log. */
export type NightlyBackupOutcome =
  | { stored: true; key: string; bytes: number; tables: number }
  | { stored: false; reason: "not-configured" | "build-failed" | "upload-failed" }

export const runNightlyBackup = internalAction({
  args: {},
  handler: async (ctx): Promise<NightlyBackupOutcome> => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME
    if (!bucketName) {
      /* A deployment with no bucket is a legitimate state — a fresh site, a
         local `convex dev` — and this runs every night forever, so it must not
         throw. It must not be silent either: a client who believes they have
         nightly backups and has none is the failure #366 is about. */
      console.error(
        "[nightlyBackup] AWS_S3_BUCKET_NAME is not set — no off-site backup was written",
      )
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_export",
        performedBy: "cron",
        result: "failure",
        errorMessage: "AWS_S3_BUCKET_NAME non configuré : aucune sauvegarde hors site",
      })
      return { stored: false, reason: "not-configured" }
    }

    let payload: { manifest: unknown; data: Record<string, unknown[]> }
    try {
      payload = await ctx.runAction(internal.system.buildBackup, { performedBy: "cron" })
    } catch (error) {
      // `buildBackup` has already written its own failure entry; this one would
      // be a duplicate. Logged and reported to the caller instead.
      console.error("[nightlyBackup] the export failed:", error)
      return { stored: false, reason: "build-failed" }
    }

    const body = JSON.stringify(payload)
    const key = backupObjectKey(Date.now())

    try {
      await createS3Client().send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: body,
          ContentType: "application/json",
          /* Read by the lifecycle rule's own reasoning rather than by code: a
             backup is not media, and tagging it says so to anyone reading the
             bucket without this file in front of them. */
          Metadata: { kind: "beyours-backup" },
        }),
      )
    } catch (error) {
      console.error("[nightlyBackup] could not write the backup to S3:", error)
      await ctx.runMutation(internal.system._recordAuditEntry, {
        action: "backup_export",
        performedBy: "cron",
        result: "failure",
        errorMessage: `Écriture S3 refusée : ${error instanceof Error ? error.message : String(error)}`,
      })
      return { stored: false, reason: "upload-failed" }
    }

    const bytes = new TextEncoder().encode(body).length
    const tables = Object.keys(payload.data).length

    /* `buildBackup` already recorded the export itself. This second entry is
       about the copy leaving the deployment, which is the part a client is
       paying for and the part that can fail on its own. */
    await ctx.runMutation(internal.system._recordAuditEntry, {
      action: "backup_export",
      performedBy: "cron",
      result: "success",
      details: JSON.stringify({ key, bytes, tables, offsite: true }),
    })

    return { stored: true, key, bytes, tables }
  },
})
