import { NextResponse } from "next/server"
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZES,
  buildMediaUrl,
  type S3Folder,
} from "@/lib/aws"
import { isAuthenticated, fetchAuthQuery } from "@/lib/convex"
import { api } from "@/convex/_generated/api"
import {
  decideUploadAccess,
  requiresEditorialPermission,
  UNAUTHENTICATED_ERROR,
} from "@/lib/services/upload-authorization"
import { getExtensionFromMimeType } from "@be-yours/cms"
import { sanitizeSvg } from "@be-yours/cms/sanitize"
import { isInlineSafeContentType } from "@/lib/services/file-serving"

// Deliberately narrower than the shared folder list.
// upload-authorization treats any folder outside EDITORIAL_FOLDERS as
// self-service, needing no `content:write`, so widening this set would let any
// signed-in customer publish into editorial folders such as `storefront/`,
// `blogs/` or `email/`. Those are written by the presigned Convex flow, which
// is authorised separately.
const VALID_FOLDERS = new Set<S3Folder>([
  "products",
  "branding",
  "stores",
  "cms",
  "users",
])

const SVG_CONTENT_TYPE = "image/svg+xml"

function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

/**
 * The caller's role, as their Convex profile reports it.
 *
 * `fetchAuthQuery` forwards the request's session to Convex, so this is the
 * caller's own profile and nobody else's. A failure here — no profile row, a
 * deployment that cannot be reached — returns no role, and no role is refused
 * by `decideUploadAccess`. Denying an upload because authorization could not be
 * established is the only safe direction.
 */
async function getCallerRole(): Promise<string | null> {
  try {
    const profile = await fetchAuthQuery(api.userProfiles.getMyProfile)
    return profile?.role ?? null
  } catch (error) {
    console.error("Upload authorization check failed:", error)
    return null
  }
}

/**
 * POST /api/upload
 * Accepts multipart form data, uploads file server-side to S3.
 * No CORS config needed on the S3 bucket.
 *
 * Form fields:
 * - file: File
 * - folder: S3Folder (e.g. "users", "products")
 */
export async function POST(request: Request) {
  try {
    // Refused before the body is read: an anonymous caller has no business
    // streaming a multipart upload into the process.
    const authenticated = await isAuthenticated()
    if (!authenticated) {
      return NextResponse.json(
        { error: UNAUTHENTICATED_ERROR },
        { status: 401 }
      )
    }

    const formData = await request.formData()
    const file = formData.get("file")
    const folder = formData.get("folder") as string | null

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Fichier manquant" },
        { status: 400 }
      )
    }

    if (!folder || !VALID_FOLDERS.has(folder as S3Folder)) {
      return NextResponse.json(
        { error: `Dossier invalide. Acceptés: ${[...VALID_FOLDERS].join(", ")}` },
        { status: 400 }
      )
    }

    const contentType = file.type
    const s3Folder = folder as S3Folder

    // Being signed in is not authorization: every storefront customer is signed
    // in. Writing to a folder the restaurant publishes from needs
    // `content:write`, the same check the Convex twin makes.
    const access = decideUploadAccess({
      folder: s3Folder,
      authenticated,
      role: requiresEditorialPermission(s3Folder) ? await getCallerRole() : null,
    })
    if (!access.allowed) {
      return NextResponse.json({ error: access.error }, { status: access.status })
    }

    // Validate MIME type
    const allowed = ALLOWED_MIME_TYPES[s3Folder]
    if (!allowed.includes(contentType)) {
      return NextResponse.json(
        { error: `Type non autorisé pour ${folder}. Acceptés: ${allowed.join(", ")}` },
        { status: 400 }
      )
    }

    // Validate file size
    const maxSize = MAX_FILE_SIZES[s3Folder]
    if (file.size > maxSize) {
      const maxMB = (maxSize / (1024 * 1024)).toFixed(0)
      return NextResponse.json(
        { error: `Fichier trop volumineux. Maximum: ${maxMB}MB` },
        { status: 400 }
      )
    }

    const bucketName = process.env.AWS_S3_BUCKET_NAME
    if (!bucketName) {
      return NextResponse.json(
        { error: "S3 bucket not configured" },
        { status: 500 }
      )
    }

    // Generate unique key.
    //
    // From `@be-yours/cms`, which calls itself the single source of truth
    // and is what the presigned Convex flow uses. This route kept a private
    // copy holding six of its twelve entries, so every type the shared list
    // knows and the copy did not was stored as `.bin`: an mp4 or a webm — both
    // admitted by `ALLOWED_MIME_TYPES.cms`, both offered by the media library's
    // own picker — and every Office document. Two maps, one of them wrong, and
    // the wrong one is the one an upload actually went through.
    const ext = getExtensionFromMimeType(contentType)
    const key = `${folder}/${crypto.randomUUID()}.${ext}`

    // Upload to S3 server-side
    let buffer = Buffer.from(await file.arrayBuffer())

    // An SVG is a document, not an image: stored as uploaded it can carry
    // script that runs on this origin. The CMS upload action has always
    // sanitized; this route stored the bytes it was handed.
    if (contentType === SVG_CONTENT_TYPE) {
      try {
        const { sanitized } = sanitizeSvg(buffer.toString("utf8"))
        buffer = Buffer.from(sanitized, "utf8")
      } catch (error) {
        console.error("SVG sanitization failed:", error)
        return NextResponse.json(
          { error: "SVG invalide ou trop volumineux" },
          { status: 400 }
        )
      }
    }

    const client = getS3Client()

    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        // Travels with the object, so it holds even if something ever serves
        // the bucket directly instead of going through /api/files.
        ...(isInlineSafeContentType(contentType)
          ? {}
          : { ContentDisposition: "attachment" as const }),
      })
    )

    // The bucket grants no anonymous read: this is the CDN when one fronts
    // it, and this app's own /api/files proxy otherwise.
    const publicUrl = buildMediaUrl(key, process.env.AWS_S3_PUBLIC_BASE_URL)

    return NextResponse.json({
      key,
      publicUrl,
      size: buffer.length,
    })
  } catch (error) {
    console.error("Upload error:", error)
    return NextResponse.json(
      { error: "Erreur lors de l'upload" },
      { status: 500 }
    )
  }
}
