"use node"

/**
 * CMS Media Upload Confirmation Action
 *
 * Verifies that the source file exists in S3, then either:
 *   - Schedules sharp processing for images (non-SVG)
 *   - Reads an SVG back and refuses it if it carries active content
 *   - Marks as ready immediately for video and files
 *
 * Idempotent:
 *   - status=ready → no-op success
 *   - status=processing → continue flow
 *   - status=failed → retry flow
 *   - deleted/missing → explicit error
 */

import { action } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import {
  getExtensionFromMimeType,
  inspectSvgForActiveContent,
  validateMediaUpload,
} from "@be-yours/cms"
import { buildMediaUrl } from "@be-yours/core/aws/media-url"

const SVG_MIME = "image/svg+xml"

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
 * The bucket is private: a key becomes either a CDN URL or a path on this
 * app's own `/api/files` proxy. One policy, in `@be-yours/core`.
 */
function buildPublicUrl(key: string): string {
  return buildMediaUrl(key, process.env.AWS_S3_PUBLIC_BASE_URL)
}

/** Reads an S3 object back as text, whichever body shape the SDK hands over. */
async function readObjectAsText(
  client: S3Client,
  bucketName: string,
  key: string,
): Promise<string> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  )
  const body = response.Body as
    | { transformToString?: () => Promise<string> }
    | AsyncIterable<Uint8Array>
    | undefined

  if (body && typeof (body as { transformToString?: unknown }).transformToString === "function") {
    return await (body as { transformToString: () => Promise<string> }).transformToString()
  }

  const chunks: Uint8Array[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// @guarded-inline: checks content:write on the store owning the media
export const confirmUpload = action({
  args: {
    mediaId: v.id("cmsMedia"),
  },
  handler: async (ctx, args): Promise<{ status: "ready" | "processing" | "failed" }> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // Read the media record
    const media = await ctx.runQuery(
      internal.cmsMedia._getMediaInternal,
      { mediaId: args.mediaId },
    )
    if (!media) throw new Error("Media not found")

    // The media record carries the restaurant it belongs to. Without this, any
    // logged-in account could confirm or re-presign an upload for any store's
    // media library.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: media.storeId,
      permission: "content:write",
    })

    // Idempotent: already ready → no-op
    if (media.status === "ready") {
      return { status: "ready" as const }
    }

    // Only processing or failed (retry) are valid
    if (media.status !== "processing" && media.status !== "failed") {
      throw new Error(
        `Cannot confirm upload: media status is "${media.status}"`,
      )
    }

    // The row's MIME type decides which branch below runs, and rows written
    // before `createMedia` validated can say anything. Refuse rather than
    // publish something the allow-list would never have accepted.
    const validation = validateMediaUpload(
      media.filename,
      media.mimeType,
      media.size,
    )
    if (!validation.valid) {
      await ctx.runMutation(internal.cmsMedia.setMediaFailed, {
        mediaId: args.mediaId,
        errorCode: "INVALID_UPLOAD",
        errorMessage: (validation.error?.message ?? "Upload refusé").slice(0, 500),
      })
      return { status: "failed" as const }
    }

    // Derive canonical S3 key
    const ext = getExtensionFromMimeType(media.mimeType)
    const s3Key = `cms/${args.mediaId}/source.${ext}`

    // HEAD check: verify source file exists in S3
    const bucketName = process.env.AWS_S3_BUCKET_NAME!
    const client = createS3Client()

    let exists = false
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }),
      )
      exists = true
    } catch {
      exists = false
    }

    if (!exists) {
      await ctx.runMutation(internal.cmsMedia.setMediaFailed, {
        mediaId: args.mediaId,
        errorCode: "S3_NOT_FOUND",
        errorMessage: "Source file not found in S3 after upload",
      })
      return { status: "failed" as const }
    }

    // An SVG never reaches sharp, so nothing on this path had ever looked at
    // its bytes: `createMedia` → presign → PUT → confirmUpload marked one
    // `ready` with `<script>` and `onload=` intact. `cmsSvgUpload.uploadSvg` is
    // the route the media library's own button takes and it does inspect, but
    // every one of these is a public Convex function and the browser is not
    // the only caller. Read it back and apply the same refusal.
    if (media.mimeType === SVG_MIME) {
      let svg: string
      try {
        svg = await readObjectAsText(client, bucketName, s3Key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await ctx.runMutation(internal.cmsMedia.setMediaFailed, {
          mediaId: args.mediaId,
          errorCode: "SVG_UNREADABLE",
          errorMessage: message.slice(0, 500),
        })
        return { status: "failed" as const }
      }

      const report = inspectSvgForActiveContent(svg)
      if (report.active) {
        // Refused means gone: leaving the object in the bucket leaves a live
        // URL, since the key is derivable from the mediaId alone.
        //
        // Through `purgeS3Objects`, not a bare `DeleteObjectCommand`. The
        // bucket `setup-aws.sh` builds has versioning ON, and there a
        // `DeleteObject` with no `VersionId` deletes nothing — it writes a
        // delete marker over the key and keeps every prior version, still
        // billed and still readable by anyone who can name a version id. This
        // path was written after #331 fixed exactly that in
        // `cmsMediaDelete.ts` and reintroduced it here, so a refused SVG —
        // the one object on this path we have decided is hostile — kept its
        // bytes for the thirty days of the lifecycle rule.
        //
        // Awaited rather than scheduled: the media row is about to be marked
        // failed and the caller told the file was refused, and that sentence
        // should not run ahead of the bytes going.
        try {
          await ctx.runAction(internal.cmsMediaDelete.purgeS3Objects, {
            s3Keys: [s3Key],
          })
        } catch (error) {
          console.error(
            `[confirmUpload] Could not remove refused SVG ${s3Key}:`,
            error,
          )
        }

        await ctx.runMutation(internal.cmsMedia.setMediaFailed, {
          mediaId: args.mediaId,
          errorCode: "SVG_ACTIVE_CONTENT",
          errorMessage:
            `Ce SVG contient du contenu actif et a été refusé : ${report.reasons.join(", ")}.`.slice(
              0,
              500,
            ),
        })
        return { status: "failed" as const }
      }

      // The browser PUT this object straight to S3 under a presigned URL, and
      // a presigned PUT can only carry headers the signature covers — signing
      // `Content-Disposition` would make every upload send it or fail. So the
      // object lands without one. `/api/files` forces `attachment` on read, but
      // a deployment with `AWS_S3_PUBLIC_BASE_URL` set serves the bucket
      // through a CDN and never passes through it. Rewriting the object here is
      // what makes its inertness travel with it, the same way `cmsSvgUpload`
      // and `/api/upload` already do.
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: svg,
          ContentType: SVG_MIME,
          ContentDisposition: "attachment",
        }),
      )
    }

    // Determine processing path
    const isProcessableImage =
      media.kind === "image" && media.mimeType !== SVG_MIME

    if (isProcessableImage) {
      // Schedule sharp processing (runs immediately, 0ms delay)
      await ctx.scheduler.runAfter(
        0,
        internal.cmsMediaProcess.processImage,
        {
          mediaId: args.mediaId,
          s3Key,
          mimeType: media.mimeType,
        },
      )
      return { status: "processing" as const }
    } else {
      // SVG, video, file: mark ready immediately with sourceUrl + s3Key
      const sourceUrl = buildPublicUrl(s3Key)
      await ctx.runMutation(internal.cmsMedia.setMediaReady, {
        mediaId: args.mediaId,
        s3Key,
        sourceUrl,
      })
      return { status: "ready" as const }
    }
  },
})
