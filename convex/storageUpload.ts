"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  getExtensionFromMimeType,
  validateMediaUpload,
} from "@be-yours/cms";
import { buildMediaUrl } from "@be-yours/core/aws/media-url";
import {
  S3_FOLDERS,
  type S3Folder as CoreS3Folder,
} from "@be-yours/core/aws/folders";
import { isInlineSafeContentType } from "@be-yours/core/aws/inline-safe";

// The folder list is defined once, in @be-yours/core/aws/folders, and is
// what /api/files will serve. Redeclaring it here is how category, blog and
// storefront uploads ended up with URLs that 404.
const ALLOWED_FOLDERS = S3_FOLDERS;
type S3Folder = CoreS3Folder;

const ALLOWED_MIME_TYPES: Record<S3Folder, string[]> = {
  products: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  branding: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  stores: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  /* NO `image/svg+xml` HERE, AND THERE CANNOT BE (#619).
     This action hands back a presigned PUT and the browser uploads the bytes
     straight to S3. Nothing on this path ever SEES the file, so nothing on this
     path can sanitise it — and the two paths the product actually intends for
     SVG both do: `cmsSvgUpload.uploadSvg` runs `inspectSvgForActiveContent`,
     and `POST /api/upload` runs `sanitizeSvg`. Allowing the type here was a
     signed permission to store `<svg><script>` with `Content-Type:
     image/svg+xml`.
     `/api/files` defuses it at serve time — attachment plus a sandbox CSP —
     but a deployment that sets `AWS_S3_PUBLIC_BASE_URL` fronts the bucket with
     a CDN and never passes through it. Route SVG through a path that reads the
     bytes; do not re-add the type. */
  cms: [
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "video/mp4", "video/webm",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  email: ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"],
  avatars: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  blogs: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  "blog-auto": ["image/png", "image/webp"],
  // No SVG here either, for the reason stated above `cms`.
  storefront: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  categories: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  users: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
};

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * The bucket is private: a key becomes either a CDN URL or a path on this
 * app's own `/api/files` proxy. One policy, in `@be-yours/core`.
 */
function buildPublicUrl(key: string): string {
  return buildMediaUrl(key, process.env.AWS_S3_PUBLIC_BASE_URL)
}

/**
 * Generate a presigned URL for direct browser-to-S3 upload.
 * Used for non-CMS uploads (products, branding, stores, email).
 *
 * Flow:
 *  1. Client calls this action with folder + contentType
 *  2. Returns { uploadUrl, key, publicUrl }
 *  3. Client PUTs file directly to uploadUrl
 *  4. Client stores publicUrl as the permanent accessible URL
 */
// @guarded-inline: checks content:write by role — no store to scope against
export const getPresignedUploadUrl = action({
  args: {
    folder: v.string(),
    contentType: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "content:write",
    });

    // Validate folder
    const folder = args.folder as S3Folder;
    if (!ALLOWED_FOLDERS.includes(folder)) {
      throw new Error(`Dossier non autorisé: ${args.folder}`);
    }

    // Validate MIME type
    const allowedTypes = ALLOWED_MIME_TYPES[folder];
    if (!allowedTypes.includes(args.contentType)) {
      throw new Error(
        `Type MIME non autorisé pour le dossier "${folder}". Types acceptés: ${allowedTypes.join(", ")}`
      );
    }

    // Generate unique key with sanitized filename
    const ext = getExtensionFromMimeType(args.contentType);
    const uuid = crypto.randomUUID();
    const sanitizedFilename = (args.filename ?? "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 100);
    const name = sanitizedFilename ? `${sanitizedFilename}-${uuid}` : uuid;
    const key = `${folder}/${name}.${ext}`;

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const client = createS3Client();

    /* Presigned PUT URL for upload (15 min).

       `ContentDisposition: attachment` for every type that is not a raster or a
       video (#619). A presigned PUT signs the headers it names, so this travels
       with the stored object and is what a CDN answers with — which is the case
       `/api/files` cannot reach. It is the backstop for the MIME table above,
       not a substitute for it: the table is what stops the type being stored,
       this is what stops a stored one being a document. `<img src="…">` is
       unaffected, because a browser applies a disposition to navigations and
       not to subresource loads. */
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: args.contentType,
      ...(isInlineSafeContentType(args.contentType)
        ? {}
        : { ContentDisposition: "attachment" }),
    });
    const uploadUrl = await getSignedUrl(client, putCommand, { expiresIn: 900 });

    // Where the browser will read it back from. The bucket grants no
    // anonymous read, so this is the CDN or this app's /api/files proxy.
    const publicUrl = buildPublicUrl(key);

    return { uploadUrl, key, publicUrl };
  },
});

/**
 * Generate a presigned URL for a CMS media upload.
 * The S3 key is derived server-side from the media record — no client-provided key.
 *
 * Flow:
 *  1. Client calls createMedia (gets mediaId)
 *  2. Client calls this action with mediaId
 *  3. Returns { uploadUrl, sourceKey }
 *  4. Client PUTs file to uploadUrl
 *  5. Client calls confirmUpload({ mediaId })
 */
// @guarded-inline: checks content:write on the store owning the media
export const getPresignedUrlForMedia = action({
  args: {
    mediaId: v.id("cmsMedia"),
  },
  handler: async (ctx, args): Promise<{ uploadUrl: string; sourceKey: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Read the media record
    const media = await ctx.runQuery(
      internal.cmsMedia._getMediaInternal,
      { mediaId: args.mediaId },
    );
    if (!media) throw new Error("Media not found");

    // The media record carries the restaurant it belongs to. Without this, any
    // logged-in account could confirm or re-presign an upload for any store's
    // media library.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: media.storeId,
      permission: "content:write",
    });

    // Only allow presign for processing or failed (retry) status
    if (media.status !== "processing" && media.status !== "failed") {
      throw new Error(
        `Cannot generate upload URL: media status is "${media.status}"`,
      );
    }

    // The row's own MIME type becomes the presigned `ContentType`, so this is
    // where an unacceptable one turns into a signed permission to upload it.
    // `createMedia` refuses these now, but rows written before that guard
    // existed still carry whatever they were given, and a retry presign reads
    // them straight back. Re-check rather than trust the row.
    const validation = validateMediaUpload(
      media.filename,
      media.mimeType,
      media.size,
    );
    if (!validation.valid) {
      throw new Error(
        `Cannot generate upload URL: ${validation.error?.message ?? "media refusé"}`,
      );
    }

    // Derive canonical S3 key
    const ext = getExtensionFromMimeType(media.mimeType);
    const sourceKey = `cms/${args.mediaId}/source.${ext}`;

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const client = createS3Client();

    // Same backstop as above: a CMS media row may legitimately be a PDF or an
    // Office document, and neither should ever open as a document.
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: sourceKey,
      ContentType: media.mimeType,
      ...(isInlineSafeContentType(media.mimeType)
        ? {}
        : { ContentDisposition: "attachment" }),
    });
    const uploadUrl = await getSignedUrl(client, putCommand, { expiresIn: 900 });

    return { uploadUrl, sourceKey };
  },
});
