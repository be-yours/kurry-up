/// <reference types="vite/client" />

/**
 * The presigned upload path cannot store an executable object (#619).
 *
 * `getPresignedUploadUrl` hands back a signed S3 `PutObject` and the browser
 * uploads the bytes straight to the bucket. Nothing on this path ever sees the
 * file, so nothing on this path can sanitise it — and it accepted
 * `image/svg+xml` for `cms` and `storefront`, with no `ContentDisposition`.
 * The two paths the product intends for SVG both read the bytes:
 * `cmsSvgUpload.uploadSvg` runs `inspectSvgForActiveContent`, and
 * `POST /api/upload` runs `sanitizeSvg`.
 *
 * `/api/files` defuses a stored SVG at serve time — attachment plus
 * `default-src 'none'; sandbox` — so this was MEDIUM and not HIGH. It stops
 * being defused the moment a deployment sets `AWS_S3_PUBLIC_BASE_URL`, a
 * documented option that fronts the bucket with a CDN: then the object is
 * served with its stored type, from an origin that never reaches that route.
 *
 * Source-level, because the defect is in what the action SIGNS. Driving it
 * needs AWS credentials and a bucket; what the signature contains is decided
 * here, in this file, and that is what regressed.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isInlineSafeContentType } from "@be-yours/core/aws/inline-safe"

const SOURCE = readFileSync(join(process.cwd(), "convex/storageUpload.ts"), "utf8")

/** Comments removed: this fix is explained in one that names the type it removed. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

describe("what the presigned action will sign for", () => {
  it("does not accept SVG for any folder", () => {
    expect(CODE).not.toMatch(/image\/svg\+xml/)
  })

  it("still accepts the raster types the admin actually uploads", () => {
    // Anti-vacuity: emptying the MIME table would satisfy the case above and
    // break every product photograph.
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(CODE).toContain(type)
    }
  })

  it("still accepts the CMS document types, which are not images", () => {
    expect(CODE).toContain("application/pdf")
  })

  it("marks anything not inline-safe as an attachment", () => {
    expect(CODE).toMatch(/ContentDisposition:\s*"attachment"/)
    expect(CODE).toMatch(/isInlineSafeContentType\(/)
  })

  it("applies that to the CMS media presign too, not only the generic one", () => {
    const occurrences = CODE.match(/ContentDisposition:\s*"attachment"/g) ?? []
    expect(occurrences).toHaveLength(2)
  })
})

describe("the list the disposition is decided from", () => {
  /*
   * It used to live in `lib/services/file-serving.ts`, which only the
   * `/api/files` proxy reads. The upload side had no notion of it, which is how
   * the two ended up disagreeing about SVG.
   */
  it("treats SVG as needing an attachment", () => {
    expect(isInlineSafeContentType("image/svg+xml")).toBe(false)
  })

  it("treats a PDF and an Office document the same way", () => {
    expect(isInlineSafeContentType("application/pdf")).toBe(false)
    expect(
      isInlineSafeContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false)
  })

  it("lets a raster image render inline", () => {
    expect(isInlineSafeContentType("image/png")).toBe(true)
    expect(isInlineSafeContentType("image/jpeg; charset=binary")).toBe(true)
  })

  it("is read by the serve side as well, so the two cannot disagree", () => {
    const serve = readFileSync(
      join(process.cwd(), "lib/services/file-serving.ts"),
      "utf8",
    )
    expect(serve).toMatch(/@be-yours\/core\/aws\/inline-safe/)
    expect(serve).not.toMatch(/const INLINE_SAFE_CONTENT_TYPES = new Set/)
  })
})

describe("SVG still has a path, and it reads the bytes", () => {
  it("cmsSvgUpload inspects for active content", () => {
    // Anti-vacuity for the refusal above: removing the type without leaving a
    // way to upload a logo would be a regression, not a fix.
    const svgUpload = readFileSync(join(process.cwd(), "convex/cmsSvgUpload.ts"), "utf8")
    expect(svgUpload).toMatch(/inspectSvgForActiveContent/)
  })
})
