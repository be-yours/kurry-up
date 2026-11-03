/**
 * What the SERVER enforces on a dish photograph (#495, held here since #532).
 *
 * WHAT WAS MEASURED. #532 inverted #495: `maxSizeMB` in
 * `ProductImagesField` changed from 5 to 50, every suite run, all green. The
 * reason is worth stating plainly rather than fixing by tightening a number —
 * **that constant is client-side decoration.** So is the `accept` attribute
 * beside it. Both live in the browser:
 *
 *   - `accept` filters the file PICKER and nothing else. A drag-and-drop, a
 *     paste, or anything that is not the picker dialog walks past it.
 *   - `maxSizeMB` is checked in `ImageUploader.validateFile`, in the page.
 *
 * Neither reaches the route. `/api/upload` enforces `ALLOWED_MIME_TYPES` and
 * `MAX_FILE_SIZES` from `@be-yours/core`, and nothing exercised either for
 * the `products` folder. That is the gap: the field advertises three types and
 * five megabytes, the server admits five types and ten.
 *
 * WHAT THIS CANNOT SEE, stated because it was measured. `MAX_FILE_SIZES` and
 * `ALLOWED_MIME_TYPES` reach both the route and this file from
 * `@be-yours/core`'s `dist`, not its `src`. Editing `packages/core/src`
 * changes neither until the package is rebuilt — verified: raising
 * `products` to 50MB in `src` left all nineteen cases green. What these cases
 * hold is the route's ENFORCEMENT, which is where the defect would live:
 * multiplying the route's `maxSize` by five turns two of them red, and
 * disabling its type check turns four.
 *
 * WHY THE SERVER'S LIST IS NOT NARROWED TO MATCH. `ALLOWED_MIME_TYPES` is one
 * table read by three things — this route, the presigned Convex flow through
 * `validateMimeType`, and `/api/files`, whose servable set is DERIVED from it.
 * Dropping `image/svg+xml` from `products` would stop serving every product SVG
 * already in a client's bucket. So the server's bounds are recorded here as
 * what they are, including the one that surprises — an SVG IS accepted for a
 * dish, and sanitized on the way in — and the general rule below is what stops
 * the two halves drifting further apart.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZES } from "@be-yours/core"
import { enginePackageFile } from "../lib/repo-layout"

const send = vi.fn()
const sanitizeSvg = vi.fn((svg: string) => ({ sanitized: svg, removed: [] }))

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { input }
  }),
}))

vi.mock("@/lib/convex", () => ({
  isAuthenticated: async () => true,
  fetchAuthQuery: async () => ({ role: "client_admin" }),
}))

vi.mock("@be-yours/cms/sanitize", () => ({
  sanitizeSvg: (svg: string) => sanitizeSvg(svg),
}))

const { POST } = await import("@/app/api/upload/route")

const PRODUCTS = "products"

function upload(mimeType: string, body: BlobPart = "x", folder = PRODUCTS) {
  const form = new FormData()
  form.append("file", new File([body], "upload", { type: mimeType }))
  form.append("folder", folder)
  return POST(
    new Request("https://resto.fr/api/upload", { method: "POST", body: form })
  )
}

/** A payload of exactly `bytes`, without holding a string of that length. */
function sized(bytes: number): Uint8Array {
  return new Uint8Array(bytes)
}

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  sanitizeSvg.mockImplementation((svg: string) => ({ sanitized: svg, removed: [] }))
  process.env.AWS_S3_BUCKET_NAME = "test-bucket"
  process.env.AWS_REGION = "eu-west-3"
  process.env.AWS_ACCESS_KEY_ID = "test"
  process.env.AWS_SECRET_ACCESS_KEY = "test"
})

describe("the size a dish photograph may be", () => {
  it("accepts one under the server's cap", () => {
    // Anti-vacuity: without this, every refusal below could be the route
    // refusing everything.
    return upload("image/jpeg", sized(1024)).then((res) => {
      expect(res.status).toBe(200)
    })
  })

  it("accepts one exactly at the cap", async () => {
    // `>` and not `>=`: ten megabytes is the maximum, not the first refusal.
    const res = await upload("image/jpeg", sized(MAX_FILE_SIZES.products))

    expect(res.status).toBe(200)
  })

  it("refuses eleven megabytes", async () => {
    /*
     * THE BOUND NOTHING TESTED. `maxSizeMB={5}` in the product field is a
     * browser check; this is the one a request actually meets, and it is twice
     * the number the field advertises.
     */
    const res = await upload("image/jpeg", sized(11 * 1024 * 1024))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/trop volumineux/)
  })

  it("stores nothing when it refuses on size", async () => {
    await upload("image/jpeg", sized(11 * 1024 * 1024))

    expect(send).not.toHaveBeenCalled()
  })
})

describe("the types a dish photograph may be", () => {
  it.each(ALLOWED_MIME_TYPES.products)("accepts %s, which the table lists", async (mimeType) => {
    const res = await upload(mimeType, mimeType === "image/svg+xml" ? "<svg/>" : "x")

    expect(res.status).toBe(200)
  })

  it.each(["application/pdf", "video/mp4", "text/html", "application/javascript"])(
    "refuses %s, which it does not",
    async (mimeType) => {
      const res = await upload(mimeType)

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Type non autorisé/)
    }
  )

  it("stores nothing when it refuses on type", async () => {
    await upload("text/html", "<script>alert(1)</script>")

    expect(send).not.toHaveBeenCalled()
  })

  it("sanitizes an SVG rather than storing the bytes it was handed", async () => {
    /*
     * The one that surprises, so it is written down rather than left to be
     * rediscovered: `image/svg+xml` IS on the products list. An SVG is a
     * document, not an image — stored as uploaded it can carry script that runs
     * on this origin — and the route sanitizes before it stores.
     *
     * This is why the list is not narrowed here: it is shared with
     * `/api/files`, whose servable set derives from it, so dropping the type
     * would stop serving every product SVG already in a client's bucket.
     */
    const res = await upload("image/svg+xml", '<svg onload="alert(1)"/>')

    expect(res.status).toBe(200)
    expect(sanitizeSvg).toHaveBeenCalledOnce()
  })

  it("refuses an SVG the sanitizer will not accept", async () => {
    sanitizeSvg.mockImplementation(() => {
      throw new Error("not an svg")
    })

    const res = await upload("image/svg+xml", "not markup at all")

    expect(res.status).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })
})

/** The uploader component's source, at whichever address this checkout uses. */
function fieldSource(): string {
  const file = enginePackageFile("admin", "src/pages/products/product-images-field.tsx")
  if (file === null) {
    throw new Error(
      "product-images-field.tsx is not in this checkout, so what the field " +
        "advertises would be compared against nothing"
    )
  }
  return file
}

describe("what the product field advertises", () => {
  // Resolved through `repo-layout`, not from the working directory: this file
  // ships, and `../../packages/admin` is an address only the engine monorepo
  // has. `admin` publishes `src`, so a client HAS this component — under
  // `node_modules/@be-yours/admin` — and only the path to it was wrong.
  const FIELD = readFileSync(fieldSource(), "utf8")

  /** `accept="…"` on the uploader, as the field declares it. */
  function advertisedTypes(): string[] {
    const match = /accept="([^"]+)"/.exec(FIELD)
    expect(match, "the field no longer declares an accept list").not.toBeNull()
    return match![1]!.split(",").map((t) => t.trim())
  }

  /** `maxSizeMB={n}` on the uploader. */
  function advertisedMegabytes(): number {
    const match = /maxSizeMB=\{(\d+)\}/.exec(FIELD)
    expect(match, "the field no longer declares a size").not.toBeNull()
    return Number(match![1])
  }

  it("names only types the server will accept", () => {
    /*
     * THE DIRECTION THAT MATTERS. The field may be NARROWER than the server —
     * that is a product decision, and today it is: three types against five.
     * It may never be WIDER, because then the picker offers something the
     * upload refuses, and the diner-facing half of that is an owner told their
     * photograph is the wrong type by a dialog that had just offered it.
     */
    const server = new Set(ALLOWED_MIME_TYPES.products)
    const advertisedButRefused = advertisedTypes().filter((t) => !server.has(t))

    expect(advertisedButRefused).toEqual([])
  })

  it("names a size the server will accept", () => {
    // Same direction. Smaller than the server's is a decision; larger is a
    // failed upload after a successful-looking one.
    expect(advertisedMegabytes() * 1024 * 1024).toBeLessThanOrEqual(
      MAX_FILE_SIZES.products
    )
  })

  it("reads a field that really declares both", () => {
    // Anti-vacuity for the two above: a renamed prop would make both pass by
    // failing to find anything, if the expectations inside the helpers ever
    // stopped throwing.
    expect(advertisedTypes().length).toBeGreaterThan(0)
    expect(advertisedMegabytes()).toBeGreaterThan(0)
  })
})
