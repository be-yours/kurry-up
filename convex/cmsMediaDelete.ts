"use node"

/**
 * CMS Media S3 Purge Action
 *
 * Deletes the objects a media row owned, after the row itself has gone.
 *
 * `deleteMedia` removed the Convex row and nothing else — `DeleteObjectCommand`
 * appeared nowhere in the repository, so every file a restaurant ever deleted
 * was still in the bucket. An erasure request could not be satisfied, and the
 * media library reported a deletion that had not happened.
 *
 * ## Then a delete marker was not a deletion either
 *
 * `setup-aws.sh` turns bucket **versioning** on. On a versioned bucket
 * `DeleteObjectCommand` without a `VersionId` deletes nothing at all: it writes
 * a *delete marker* over the key and retains every prior version. The object
 * stops appearing in a listing, keeps being billed, and stays readable by
 * anyone who can name a version id. So « définitivement supprimé » kept every
 * byte a second time, and the offboarding runbook ticked an erasure box the
 * infrastructure could not honour.
 *
 * The purge below enumerates the key's versions and deletes each one by id.
 * Delete markers are removed too, and by id: a marker IS a version, so removing
 * only the object versions leaves the key hidden with its marker still billed,
 * and removing only the marker un-deletes the file.
 *
 * ## The permission this needs, and the deployments that lack it
 *
 * `s3:DeleteObjectVersion` and `s3:ListBucketVersions`. `setup-aws.sh` grants
 * both now; every client provisioned before it did not, and re-running the
 * script is what fixes them. Rather than throw on those deployments, the action
 * falls back to the plain delete and reports which of the two happened. The
 * lifecycle rules the same script installs (`NoncurrentVersionExpiration` +
 * `ExpiredObjectDeleteMarker`) are what eventually collects what a fallback
 * leaves behind.
 *
 * ## Who that report is for, and who it is NOT for
 *
 * Not the caller. `deleteMedia` schedules this action and answers the browser
 * before it runs (`cmsMedia.ts`), so the returned counts reach nobody — the
 * media library cannot know the outcome even in principle, and its confirmation
 * dialog is written accordingly.
 *
 * So the fallback goes to `captureBackendError` as well as to `console.error`.
 * A Convex log line lives in one client's dashboard and expires; #368 settled
 * that this is not a record of a failure that carries legal weight, and "the
 * files a restaurant was told were permanently deleted are still in the bucket"
 * is one. An operator has to be able to find out afterwards.
 *
 * A mutation cannot reach S3, so this runs as a scheduled action. Its keys
 * arrive as arguments: the row is already committed away by the time it runs
 * and there is nothing left to look them up from.
 *
 * Best-effort by design. A key that is already absent is a success (S3 delete
 * is idempotent), and one that fails is logged rather than thrown — retrying
 * the whole action would re-delete the keys that worked, and the row is gone
 * either way.
 */

import { internalAction } from "./_generated/server"
import type { ActionCtx } from "./_generated/server"
import { captureBackendError } from "./errorReporting"
import { v } from "convex/values"
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3"

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

/**
 * How many version pages one key may cost.
 *
 * S3 returns up to 1 000 entries a page. A key with more than a hundred pages
 * of versions is not a photograph re-uploaded a few times; purging what was
 * found is still right, and the ceiling stops one media deletion running for
 * the whole of the action's budget.
 */
const MAX_VERSION_PAGES = 100

/** What one key's purge did. `purged` is the only outcome that frees bytes. */
type KeyOutcome = "purged" | "delete-marker"

/**
 * Every stored version of exactly one key, or `null` when they cannot be read.
 *
 * `null` means the listing was refused — on a versioned bucket that is almost
 * always an IAM policy predating `s3:ListBucketVersions`. It is not propagated
 * as a throw: the row is already gone, and a delete that throws leaves the
 * object present with nobody told.
 *
 * It IS reported, though. The refusal is the moment this deployment stops being
 * able to honour an erasure request, and a `console.error` alone puts that in
 * one client's Convex log window, which expires — #368 ruled that inadequate
 * for a failure with legal consequences, and this is one. `ctx` is here for no
 * other reason.
 *
 * Filtered to an EXACT key match, because the S3 API is prefix-based and
 * `cms/42/source.webp` is a prefix of `cms/42/source.webp.bak`. Purging by
 * prefix would take a neighbouring object with it.
 */
async function collectVersions(
  ctx: ActionCtx,
  client: S3Client,
  bucketName: string,
  key: string,
): Promise<Array<{ VersionId: string }> | null> {
  const found: Array<{ VersionId: string }> = []
  let KeyMarker: string | undefined
  let VersionIdMarker: string | undefined

  try {
    for (let page = 0; page < MAX_VERSION_PAGES; page += 1) {
      const result = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          Prefix: key,
          KeyMarker,
          VersionIdMarker,
        }),
      )

      // Two separate arrays in the response, and both are versions: `Versions`
      // holds the stored objects, `DeleteMarkers` the tombstones written over
      // them. Reading only the first is how a purge leaves the markers behind.
      for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
        if (entry.Key === key && entry.VersionId) {
          found.push({ VersionId: entry.VersionId })
        }
      }

      if (!result.IsTruncated) return found
      KeyMarker = result.NextKeyMarker
      VersionIdMarker = result.NextVersionIdMarker
    }
  } catch (error) {
    console.error(
      `[purgeS3Objects] Could not list versions of ${key} — the IAM policy may predate s3:ListBucketVersions:`,
      error,
    )
    await captureBackendError(ctx, {
      error,
      source: "cmsMediaDelete.purgeS3Objects",
      tags: { step: "list-versions-refused" },
      extra: { key },
    })
    return null
  }

  return found
}

export const purgeS3Objects = internalAction({
  args: {
    s3Keys: v.array(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    deleted: number
    failed: number
    /** Keys whose every version is gone. */
    purged: number
    /**
     * Keys left behind a delete marker because this deployment cannot purge.
     * Non-zero means an erasure request is NOT satisfied by this run, and the
     * bytes wait on the bucket's lifecycle rules.
     */
    deleteMarkersOnly: number
  }> => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME
    if (!bucketName) {
      console.error("[purgeS3Objects] AWS_S3_BUCKET_NAME is not set")
      return {
        deleted: 0,
        failed: args.s3Keys.length,
        purged: 0,
        deleteMarkersOnly: 0,
      }
    }

    const client = createS3Client()
    let deleted = 0
    let failed = 0
    let purged = 0
    let deleteMarkersOnly = 0

    for (const key of args.s3Keys) {
      // A key that could climb out of the media prefix never came from
      // `collectMediaS3Keys`; refusing it costs nothing and keeps this action
      // from becoming a general-purpose bucket eraser.
      if (!key || key.includes("..")) {
        failed += 1
        continue
      }

      try {
        const versions = await collectVersions(ctx, client, bucketName, key)
        let outcome: KeyOutcome = "delete-marker"

        if (versions !== null) {
          for (const { VersionId } of versions) {
            await client.send(
              new DeleteObjectCommand({ Bucket: bucketName, Key: key, VersionId }),
            )
          }
          outcome = "purged"
        }

        /* Unconditional, and not a tidy-up. Between the listing and here another
           writer may have added a version, and on an unversioned or suspended
           bucket the listing legitimately comes back empty while the object
           exists — that is the case this call covers. */
        await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))

        deleted += 1
        if (outcome === "purged") purged += 1
        else deleteMarkersOnly += 1
      } catch (error) {
        failed += 1
        console.error(`[purgeS3Objects] Failed to delete ${key}:`, error)
      }
    }

    if (deleteMarkersOnly > 0) {
      // Loud, because the difference is legal rather than cosmetic: these files
      // are hidden, not erased, and someone may have been told otherwise.
      const summary =
        `${deleteMarkersOnly} object(s) left behind a delete marker only — ` +
        `their bytes remain in the bucket. Re-run scripts/setup-aws.sh to grant ` +
        `s3:DeleteObjectVersion and s3:ListBucketVersions.`
      console.error(`[purgeS3Objects] ${summary}`)
      // And durably, not only into the log. Nobody reads this return value —
      // `deleteMedia` schedules the action and answers the browser before it
      // runs — so the tracker is the only place an operator can later learn
      // that « définitivement supprimé » was not true of these files. #368
      // settled that a console.error is not a record of a failure that carries
      // legal weight.
      await captureBackendError(ctx, {
        error: new Error(`[purgeS3Objects] ${summary}`),
        source: "cmsMediaDelete.purgeS3Objects",
        level: "warning",
        tags: { step: "delete-marker-only" },
        extra: { deleteMarkersOnly, purged, deleted, failed },
      })
    }

    return { deleted, failed, purged, deleteMarkersOnly }
  },
})
