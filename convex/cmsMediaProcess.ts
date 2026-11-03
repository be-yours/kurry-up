"use node"

/**
 * CMS Media Image Processing Action
 *
 * Generates image variants (thumb, card) using sharp.
 * Called by confirmUpload after S3 source upload is verified.
 *
 * Variants:
 *   - thumb: 400x400 center crop, WebP quality 85
 *   - card:  800x450 center crop, WebP quality 85
 *
 * Idempotent: same S3 keys, PutObject overwrites, retry safe.
 */

import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import sharp from "sharp"
import { buildMediaUrl } from "@be-yours/core/aws/media-url"

const VARIANTS = {
  thumb: { width: 400, height: 400 },
  card: { width: 800, height: 450 },
} as const

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

export const processImage = internalAction({
  args: {
    mediaId: v.id("cmsMedia"),
    s3Key: v.string(),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME!
    const client = createS3Client()

    try {
      // 1. Fetch source from S3
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: args.s3Key,
      })
      const response = await client.send(getCommand)

      const chunks: Uint8Array[] = []
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const sourceBuffer = Buffer.concat(chunks)

      // 2. Extract dimensions
      const meta = await sharp(sourceBuffer).metadata()
      const sourceWidth = meta.width ?? 0
      const sourceHeight = meta.height ?? 0

      // 3. Derive key prefix: cms/{mediaId}/source.ext → cms/{mediaId}
      const keyPrefix = args.s3Key.substring(0, args.s3Key.lastIndexOf("/"))

      // 4. Generate variants
      const variants: Record<string, { url: string; width: number; height: number }> = {}

      for (const [variantName, dims] of Object.entries(VARIANTS)) {
        const variantKey = `${keyPrefix}/${variantName}.webp`
        const variantBuffer = await sharp(sourceBuffer)
          .resize(dims.width, dims.height, {
            fit: "cover",
            position: "centre",
          })
          .webp({ quality: 85 })
          .toBuffer()

        await client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: variantKey,
            Body: variantBuffer,
            ContentType: "image/webp",
          }),
        )

        variants[variantName] = {
          url: buildPublicUrl(variantKey),
          width: dims.width,
          height: dims.height,
        }
      }

      // 5. Mark as ready with all data
      const sourceUrl = buildPublicUrl(args.s3Key)

      await ctx.runMutation(internal.cmsMedia.setMediaReady, {
        mediaId: args.mediaId,
        s3Key: args.s3Key,
        sourceUrl,
        width: sourceWidth,
        height: sourceHeight,
        variants: {
          thumb: variants.thumb,
          card: variants.card,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[processImage] Failed for mediaId=${args.mediaId}:`,
        error,
      )

      await ctx.runMutation(internal.cmsMedia.setMediaFailed, {
        mediaId: args.mediaId,
        errorCode: "PROCESSING_FAILED",
        errorMessage: message.slice(0, 500),
      })
    }
  },
})
