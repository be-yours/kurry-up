/**
 * What extension the write half of the storage policy stores a file under.
 *
 * The route kept its own six-entry MIME-to-extension map while
 * `@be-yours/cms`'s `MIME_TO_EXT` — which calls itself the single source
 * of truth and is what the presigned Convex flow uses — held twelve. Anything
 * the shared list knew and the copy did not fell through to `"bin"`, and
 * `ALLOWED_MIME_TYPES.cms` admits six such types: mp4, webm, and the three
 * Office documents, plus gif elsewhere. So the CMS media library offered a
 * video upload, accepted it, and wrote `cms/<uuid>.bin`.
 *
 * Two maps where one of them is authoritative is not a tidiness problem: the
 * one an upload actually goes through was the wrong one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { ALLOWED_MIME_TYPES } from "@be-yours/core"
import { getExtensionFromMimeType } from "@be-yours/cms"

const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { input }
  }),
}))

// Signed in, and holding the editorial permission the `cms` folder needs.
vi.mock("@/lib/convex", () => ({
  isAuthenticated: async () => true,
  fetchAuthQuery: async () => ({ role: "client_admin" }),
}))

vi.mock("@be-yours/cms/sanitize", () => ({
  sanitizeSvg: (svg: string) => ({ sanitized: svg, removed: [] }),
}))

const { POST } = await import("@/app/api/upload/route")

/** The folders this route accepts, and the one the media library writes to. */
const CMS = "cms"

function upload(mimeType: string, folder = CMS, bytes = "x") {
  const form = new FormData()
  form.append("file", new File([bytes], `upload`, { type: mimeType }))
  form.append("folder", folder)
  return POST(
    new Request("https://resto.fr/api/upload", { method: "POST", body: form })
  )
}

/** The `Key` of the single PutObject the route sent. */
function storedKey(): string {
  const put = send.mock.calls
    .map(([cmd]) => cmd as { input?: { Key?: string } })
    .at(-1)
  return put?.input?.Key ?? ""
}

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  process.env.AWS_S3_BUCKET_NAME = "test-bucket"
  process.env.AWS_REGION = "eu-west-3"
  process.env.AWS_ACCESS_KEY_ID = "test"
  process.env.AWS_SECRET_ACCESS_KEY = "test"
})

describe("the upload route's stored extension", () => {
  it("stores an mp4 as .mp4, not .bin", async () => {
    const res = await upload("video/mp4")

    expect(res.status).toBe(200)
    expect(storedKey()).toMatch(/^cms\/[0-9a-f-]+\.mp4$/)
  })

  it("stores a webm as .webm", async () => {
    await upload("video/webm")
    expect(storedKey()).toMatch(/\.webm$/)
  })

  it.each([
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pptx",
    ],
  ])("stores %s as .%s", async (mimeType, ext) => {
    await upload(mimeType)
    expect(storedKey().endsWith(`.${ext}`)).toBe(true)
  })

  it("still stores the image types the private map did know", async () => {
    for (const [mimeType, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["application/pdf", "pdf"],
    ]) {
      await upload(mimeType)
      expect(storedKey().endsWith(`.${ext}`)).toBe(true)
    }
  })

  it("gives every type this route can accept a real extension", () => {
    // The general statement, so a type added to either list cannot reopen the
    // gap: `"bin"` is `getExtensionFromMimeType`'s I-do-not-know answer, and
    // nothing this route accepts may reach it.
    const accepted = new Set(
      (["products", "branding", "stores", "cms", "users"] as const).flatMap(
        (folder) => ALLOWED_MIME_TYPES[folder]
      )
    )

    const unnamed = [...accepted].filter(
      (mimeType) => getExtensionFromMimeType(mimeType) === "bin"
    )

    expect(unnamed).toEqual([])
  })
})
