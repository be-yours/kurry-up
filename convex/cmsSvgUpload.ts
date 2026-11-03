"use node"

/**
 * CMS SVG Upload Action
 *
 * Receives an SVG string, refuses it if it carries active content, and uploads
 * it to S3 as a download rather than as a document.
 * Runs in Node.js environment for S3 SDK access.
 */

import { action } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { inspectSvgForActiveContent } from "@be-yours/cms"
import { buildMediaUrl } from "@be-yours/core/aws/media-url"

const MAX_SVG_SIZE = 1 * 1024 * 1024 // 1MB

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

// @guarded-inline: checks content:write on the storeId it is given
export const uploadSvg = action({
  args: {
    storeId: v.id("stores"),
    mediaId: v.id("cmsMedia"),
    svgContent: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // Being logged in was the whole check: any customer account of any
    // restaurant reached this. The storeId is an argument, so it has to be
    // matched against what the caller may actually do there.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: "content:write",
    });

    // Verify media record exists and belongs to the store
    const media = await ctx.runQuery(
      internal.cmsMedia._getMediaInternal,
      { mediaId: args.mediaId },
    )
    if (!media) throw new Error("Media not found")
    if (media.storeId !== args.storeId) throw new Error("Unauthorized")

    // Validate size
    if (args.svgContent.length > MAX_SVG_SIZE) {
      throw new Error("Le fichier SVG dépasse la taille maximale de 1MB")
    }

    // Refuse rather than scrub. The scrubber this replaces returned
    // `<svg/onload=…>` and `&#106;avascript:` unchanged and reported nothing
    // removed, so the caller stored an active document believing it was clean.
    const report = inspectSvgForActiveContent(args.svgContent)
    if (report.active) {
      throw new Error(
        `Ce SVG contient du contenu actif et a été refusé : ${report.reasons.join(", ")}.`,
      )
    }

    // Canonical S3 key derived from mediaId
    const key = `cms/${args.mediaId}/source.svg`

    // Upload to S3
    const bucketName = process.env.AWS_S3_BUCKET_NAME!
    const client = createS3Client()

    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: args.svgContent,
        ContentType: "image/svg+xml",
        // The object is served straight from the bucket, not through
        // /api/files, so its inertness has to travel with it. A browser
        // downloads this instead of opening it as a document; <img> still
        // draws it, which is the only way the CMS and storefront use it.
        ContentDisposition: "attachment",
      }),
    )

    // Mark as ready immediately (SVG: no processing needed)
    const publicUrl = buildPublicUrl(key)
    await ctx.runMutation(internal.cmsMedia.setMediaReady, {
      mediaId: args.mediaId,
      s3Key: key,
      sourceUrl: publicUrl,
    })

    return {
      size: args.svgContent.length,
    }
  },
})
