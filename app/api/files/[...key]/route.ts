import { NextResponse } from "next/server"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"
import { ALLOWED_MIME_TYPES, isPrivateS3Folder, type S3Folder } from "@/lib/aws"
import { buildFileResponseHeaders } from "@/lib/services/file-serving"
import { isAuthenticated } from "@/lib/convex"

/**
 * Folders the product writes to. A key outside them is not something this app
 * uploaded, so it is not something this app serves — the bucket is not a
 * general-purpose file host, even for whoever holds its credentials.
 */
const SERVABLE_FOLDERS = new Set<S3Folder>(
  Object.keys(ALLOWED_MIME_TYPES) as S3Folder[]
)

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
 * GET /api/files/:folder/:filename
 *
 * The read side of the storage policy: the bucket grants no anonymous read, so
 * every image on the storefront and in the admin comes through here, signed
 * with the deployment's own credentials. Deployments that put a CDN in front
 * of the bucket set `AWS_S3_PUBLIC_BASE_URL` and never reach this route.
 *
 * Anonymous for the restaurant's own published media — a storefront visitor has
 * no session, and the storefront is public. Those responses are cached for a
 * year: keys carry a UUID, so a given key always denotes the same bytes.
 *
 * `users/` and `avatars/` are not that. They hold what an account holder
 * uploaded about themselves, nothing public renders them, and until #188 they
 * rode the same anonymous path — guarded only by the UUID in the key, which is
 * secrecy rather than access control: a URL leaks through a referrer header, a
 * shared link, a support screenshot or a database export, and cannot be
 * revoked. They now need a session, and their responses are `private,
 * no-store` so no shared cache can hand them on to a caller who has none.
 *
 * The gate is "signed in", not "signed in as the owner". The key is a flat
 * `users/<uuid>.<ext>` with no account in it, so ownership cannot be decided
 * from the request; deciding it would mean a new key shape and a migration of
 * the objects already stored. What this buys is the thing the issue asked for —
 * a leaked URL stops being a credential — and it is what the product needs
 * anyway: the account page shows the holder their own avatar, and the admin
 * roster shows a manager their colleagues'.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const { key: segments } = await params
  const key = segments.join("/")

  // Next hands back decoded segments, so a `%2F` arrives as a slash inside one
  // of them — reject that along with the empty and dot-dot segments rather
  // than letting a caller assemble a key the folder check never saw.
  const malformed = segments.some(
    (segment) => !segment || segment === ".." || segment.includes("/")
  )
  if (!key || malformed) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 })
  }

  const folder = segments[0] as S3Folder
  if (!SERVABLE_FOLDERS.has(folder)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }

  // Asked after the folder check and before S3 is touched, so an anonymous
  // caller learns nothing about whether the key exists.
  const isPrivate = isPrivateS3Folder(folder)
  if (isPrivate && !(await isAuthenticated())) {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }

  const bucketName = process.env.AWS_S3_BUCKET_NAME
  if (!bucketName) {
    return NextResponse.json({ error: "S3 not configured" }, { status: 500 })
  }

  try {
    const client = getS3Client()
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    )

    if (!response.Body) {
      return NextResponse.json({ error: "File not found" }, { status: 404 })
    }

    const bytes = await response.Body.transformToByteArray()

    // The stored ContentType is attacker-influenced — it comes from the
    // multipart header of whoever uploaded the object — so it decides how the
    // response is framed, never whether it may become a document.
    return new NextResponse(Buffer.from(bytes) as unknown as BodyInit, {
      status: 200,
      headers: buildFileResponseHeaders({
        contentType: response.ContentType,
        contentLength: bytes.length,
        isPrivate,
      }),
    })
  } catch (error: unknown) {
    const code = (error as { name?: string })?.name
    if (code === "NoSuchKey" || code === "NotFound") {
      return NextResponse.json({ error: "File not found" }, { status: 404 })
    }
    console.error("S3 proxy error:", error)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
