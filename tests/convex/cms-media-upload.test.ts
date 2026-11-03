// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The media library refuses hostile uploads, and forgets what it deletes (#167).
 *
 * Two holes, both measured against the running functions before this suite
 * existed:
 *
 *   - `createMedia` inserted whatever it was handed. It accepted `text/html`
 *     and a 5 GB SVG. `validateMediaUpload` — the allow-list — was imported in
 *     exactly two places, `CmsMediaPicker` and `CmsMediaLibrary`, both browser
 *     components. The client validated and the server did not, and the client
 *     is not the security boundary: `createMedia`, `getPresignedUrlForMedia`
 *     and `confirmUpload` are all public Convex functions.
 *   - `confirmUpload` routed `image/svg+xml` around sharp and straight to
 *     `setMediaReady`. Nothing on that path read the bytes, so an SVG carrying
 *     `<script>` and `onload=` reached `status: "ready"` — measured, it
 *     returned `{"status":"ready"}`.
 *   - `deleteMedia` removed the Convex row only. `DeleteObjectCommand` appeared
 *     nowhere in the repository, so no erasure request could be satisfied.
 *
 * These run the real functions against the real schema. S3 is mocked because
 * the assertions are about which commands the code sends, not about AWS.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send }
  }),
  HeadObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "head", input }
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "get", input }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "put", input }
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return { _cmd: "delete", input }
  }),
  ListObjectVersionsCommand: vi.fn(function (input: unknown) {
    return { _cmd: "versions", input }
  }),
}))

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
  "<script>alert(document.cookie)</script></svg>"

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<circle cx="5" cy="5" r="4" fill="#c00"/></svg>'

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  process.env.AWS_S3_BUCKET_NAME = "test-bucket"
  process.env.AWS_REGION = "eu-west-3"
  process.env.AWS_ACCESS_KEY_ID = "test"
  process.env.AWS_SECRET_ACCESS_KEY = "test"
})

/**
 * Cancel whatever the test left on the scheduler.
 *
 * `deleteMedia` now queues the S3 purge through `ctx.scheduler.runAfter`. A
 * test finishes in milliseconds and leaves it pending; whatever fires it next
 * writes against a transaction that closed, and because nothing awaits it that
 * arrives as an unhandled rejection — a run then reports every test green and
 * still exits 1. Same guard as `store-deletion.test.ts`.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Le Bistrot",
      slug: "le-bistrot",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** A restaurant owner: the role that legitimately uploads to the media library. */
async function seedAdmin(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "admin-1",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "admin-1" })
}

/** Inserts a row directly, the way a version without the guard would have. */
async function seedMediaRow(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  overrides: Record<string, unknown>
) {
  return t.run((ctx) =>
    ctx.db.insert("cmsMedia", {
      storeId,
      kind: "image" as const,
      status: "processing" as const,
      filename: "photo.png",
      mimeType: "image/png",
      size: 1024,
      usageCount: 0,
      uploadedBy: "admin-1",
      uploadedAt: NOW,
      ...overrides,
    } as never)
  )
}

/** The keys every `DeleteObjectCommand` sent during the test named. */
function deletedKeys(): string[] {
  return send.mock.calls
    .map(([cmd]) => cmd as { _cmd?: string; input?: { Key?: string } })
    .filter((cmd) => cmd?._cmd === "delete")
    .map((cmd) => cmd.input?.Key ?? "")
}

/** `key@versionId` for every version-scoped delete; `key@current` otherwise. */
function deletedVersions(): string[] {
  return send.mock.calls
    .map(([cmd]) => cmd as { _cmd?: string; input?: { Key?: string; VersionId?: string } })
    .filter((cmd) => cmd?._cmd === "delete")
    .map((cmd) => `${cmd.input?.Key ?? ""}@${cmd.input?.VersionId ?? "current"}`)
}

/**
 * Answers `ListObjectVersionsCommand` with the versions of one key, and every
 * other command with `{}`.
 *
 * The two arrays are separate in the real response and both are versions:
 * `Versions` holds the stored objects, `DeleteMarkers` the tombstones written
 * over them by an earlier marker-only delete.
 */
function stubVersions(byKey: Record<string, { versions: string[]; markers?: string[] }>) {
  send.mockImplementation(
    async (cmd: { _cmd?: string; input?: { Prefix?: string; Key?: string } }) => {
      if (cmd._cmd !== "versions") return {}
      const entry = byKey[cmd.input?.Prefix ?? ""]
      if (!entry) return { Versions: [], DeleteMarkers: [] }
      return {
        Versions: entry.versions.map((VersionId) => ({
          Key: cmd.input?.Prefix,
          VersionId,
        })),
        DeleteMarkers: (entry.markers ?? []).map((VersionId) => ({
          Key: cmd.input?.Prefix,
          VersionId,
        })),
        IsTruncated: false,
      }
    },
  )
}

// ============================================================================
// createMedia is the server-side allow-list
// ============================================================================

describe("createMedia refuses what the media library must not store", () => {
  test("refuses text/html — an upload path that accepts HTML is stored XSS", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    await expect(
      admin.mutation(api.cmsMedia.createMedia, {
        storeId,
        kind: "file",
        filename: "payload.html",
        mimeType: "text/html",
        size: 512,
        uploadedBy: "admin-1",
      })
    ).rejects.toThrow(/Type MIME "text\/html" non autoris/)

    const rows = await t.run((ctx) => ctx.db.query("cmsMedia").collect())
    expect(rows).toHaveLength(0)
  })

  test("refuses a 5 GB SVG", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    await expect(
      admin.mutation(api.cmsMedia.createMedia, {
        storeId,
        kind: "image",
        filename: "huge.svg",
        mimeType: "image/svg+xml",
        size: 5 * 1024 * 1024 * 1024,
        uploadedBy: "admin-1",
      })
    ).rejects.toThrow(/trop volumineux/)
  })

  test("refuses an image over the 10 MB cap", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    await expect(
      admin.mutation(api.cmsMedia.createMedia, {
        storeId,
        kind: "image",
        filename: "photo.png",
        mimeType: "image/png",
        size: 10 * 1024 * 1024 + 1,
        uploadedBy: "admin-1",
      })
    ).rejects.toThrow(/trop volumineux/)
  })

  test("refuses a filename whose extension contradicts the MIME type", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    await expect(
      admin.mutation(api.cmsMedia.createMedia, {
        storeId,
        kind: "image",
        filename: "payload.html",
        mimeType: "image/png",
        size: 1024,
        uploadedBy: "admin-1",
      })
    ).rejects.toThrow(/ne correspond pas au type "image\/png"/)
  })

  test("refuses a kind that contradicts the MIME type", async () => {
    // `kind` is a separate argument the caller picks, and it is what
    // `confirmUpload` branches on: an SVG declared as kind "file" skipped the
    // image path entirely.
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    await expect(
      admin.mutation(api.cmsMedia.createMedia, {
        storeId,
        kind: "file",
        filename: "photo.png",
        mimeType: "image/png",
        size: 1024,
        uploadedBy: "admin-1",
      })
    ).rejects.toThrow(/ne correspond pas au type MIME/)
  })

  test("still accepts a legitimate photograph", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await admin.mutation(api.cmsMedia.createMedia, {
      storeId,
      kind: "image",
      filename: "plat-du-jour.jpeg",
      mimeType: "image/jpeg",
      size: 2 * 1024 * 1024,
      uploadedBy: "admin-1",
    })

    const row = await t.run((ctx) => ctx.db.get(mediaId))
    expect(row?.status).toBe("processing")
    expect(row?.mimeType).toBe("image/jpeg")
  })
})

// ============================================================================
// The presign path cannot outrun createMedia
// ============================================================================

describe("getPresignedUrlForMedia re-checks the row it signs for", () => {
  test("refuses a row whose MIME type createMedia would now reject", async () => {
    // The presigned PUT carries `ContentType: media.mimeType`. A row written
    // before the guard existed still holds whatever it was given, and a retry
    // presign reads it straight back.
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      kind: "file" as const,
      filename: "payload.html",
      mimeType: "text/html",
      size: 512,
    })

    await expect(
      admin.action(api.storageUpload.getPresignedUrlForMedia, { mediaId })
    ).rejects.toThrow(/Type MIME "text\/html" non autoris/)
  })

  test("refuses a row that is over the size cap", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      filename: "huge.svg",
      mimeType: "image/svg+xml",
      size: 5 * 1024 * 1024 * 1024,
    })

    await expect(
      admin.action(api.storageUpload.getPresignedUrlForMedia, { mediaId })
    ).rejects.toThrow(/trop volumineux/)
  })
})

// ============================================================================
// confirmUpload reads an SVG before it publishes it
// ============================================================================

describe("confirmUpload and the SVG branch", () => {
  /** HEAD succeeds, GET returns `body`. */
  function s3Returning(body: string) {
    send.mockImplementation(async (cmd: { _cmd: string }) => {
      if (cmd._cmd === "get") {
        return { Body: { transformToString: async () => body } }
      }
      return {}
    })
  }

  test("refuses an SVG carrying <script> and onload=, and removes the object", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    s3Returning(HOSTILE_SVG)

    const mediaId = await seedMediaRow(t, storeId, {
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      size: HOSTILE_SVG.length,
    })

    const result = await admin.action(
      api.cmsMediaConfirmUpload.confirmUpload,
      { mediaId }
    )

    expect(result.status).toBe("failed")

    const row = await t.run((ctx) => ctx.db.get(mediaId))
    expect(row?.status).toBe("failed")
    expect(row?.errorCode).toBe("SVG_ACTIVE_CONTENT")
    // Refused means gone: the key is derivable from the mediaId alone, so a
    // leftover object is a live URL.
    expect(deletedKeys()).toContain(`cms/${mediaId}/source.svg`)
  })

  test("purges the refused SVG's versions, not just a delete marker over it", async () => {
    /* The bucket `setup-aws.sh` builds has versioning ON, and there a
       `DeleteObject` with no `VersionId` deletes nothing: it writes a delete
       marker and keeps every prior version, still billed and still readable by
       anyone who can name a version id. This branch shipped its own bare
       `DeleteObjectCommand` — the very defect #331 removed from
       `cmsMediaDelete.ts` — so the one object on this path we have decided is
       hostile kept its bytes for the thirty days of the lifecycle rule. */
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      size: HOSTILE_SVG.length,
    })
    const key = `cms/${mediaId}/source.svg`

    // HEAD and GET as the SVG branch needs them; the version listing as a
    // versioned bucket answers it.
    send.mockImplementation(
      async (cmd: { _cmd?: string; input?: { Prefix?: string } }) => {
        if (cmd._cmd === "get") {
          return { Body: { transformToString: async () => HOSTILE_SVG } }
        }
        if (cmd._cmd === "versions") {
          return {
            Versions:
              cmd.input?.Prefix === key
                ? [
                    { Key: key, VersionId: "v2" },
                    { Key: key, VersionId: "v1" },
                  ]
                : [],
            DeleteMarkers: [],
            IsTruncated: false,
          }
        }
        return {}
      }
    )

    const result = await admin.action(api.cmsMediaConfirmUpload.confirmUpload, {
      mediaId,
    })

    expect(result.status).toBe("failed")
    expect(deletedVersions()).toEqual([
      `${key}@v2`,
      `${key}@v1`,
      `${key}@current`,
    ])
  })

  test("publishes an SVG that carries no active content", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    s3Returning(CLEAN_SVG)

    const mediaId = await seedMediaRow(t, storeId, {
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      size: CLEAN_SVG.length,
    })

    const result = await admin.action(
      api.cmsMediaConfirmUpload.confirmUpload,
      { mediaId }
    )

    expect(result.status).toBe("ready")

    const row = await t.run((ctx) => ctx.db.get(mediaId))
    expect(row?.status).toBe("ready")
    expect(row?.s3Key).toBe(`cms/${mediaId}/source.svg`)
    expect(deletedKeys()).toHaveLength(0)
  })

  test("rewrites a published SVG with Content-Disposition: attachment", async () => {
    // A presigned PUT can only carry headers the signature covers, so the
    // browser's upload lands without one. `/api/files` forces `attachment` on
    // read, but a deployment serving the bucket through a CDN never goes
    // through it — the inertness has to travel with the object.
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)
    s3Returning(CLEAN_SVG)

    const mediaId = await seedMediaRow(t, storeId, {
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      size: CLEAN_SVG.length,
    })

    await admin.action(api.cmsMediaConfirmUpload.confirmUpload, { mediaId })

    const puts = send.mock.calls
      .map(([cmd]) => cmd as { _cmd?: string; input?: Record<string, unknown> })
      .filter((cmd) => cmd?._cmd === "put")

    expect(puts).toHaveLength(1)
    expect(puts[0]?.input).toMatchObject({
      Key: `cms/${mediaId}/source.svg`,
      ContentType: "image/svg+xml",
      ContentDisposition: "attachment",
      Body: CLEAN_SVG,
    })
  })

  test("refuses a row the allow-list would never have accepted", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      kind: "file" as const,
      filename: "payload.html",
      mimeType: "text/html",
      size: 512,
    })

    const result = await admin.action(
      api.cmsMediaConfirmUpload.confirmUpload,
      { mediaId }
    )

    expect(result.status).toBe("failed")
    const row = await t.run((ctx) => ctx.db.get(mediaId))
    expect(row?.errorCode).toBe("INVALID_UPLOAD")
  })
})

// ============================================================================
// deleteMedia takes the files with it
// ============================================================================

describe("deleteMedia purges S3", () => {
  test("schedules a purge of the source and every variant", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      status: "ready" as const,
      s3Key: "cms/abc/source.png",
      sourceUrl: "/api/files/cms/abc/source.png",
      variants: {
        thumb: {
          url: "/api/files/cms/abc/thumb.webp",
          width: 400,
          height: 400,
        },
        card: { url: "/api/files/cms/abc/card.webp", width: 800, height: 450 },
        og: { url: "/api/files/cms/abc/og.webp", width: 1200, height: 630 },
      },
    })

    await admin.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.name).toBe("cmsMediaDelete:purgeS3Objects")

    const args = scheduled[0]?.args?.[0] as { s3Keys: string[] }
    expect([...args.s3Keys].sort()).toEqual([
      "cms/abc/card.webp",
      "cms/abc/og.webp",
      "cms/abc/source.png",
      "cms/abc/thumb.webp",
    ])
  })

  test("recovers keys from a legacy row that only stored URLs", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      status: "ready" as const,
      url: "/api/files/cms/legacy/source.png",
      thumbnailUrl: "/api/files/cms/legacy/thumb.webp",
    })

    await admin.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    const args = scheduled[0]?.args?.[0] as { s3Keys: string[] }
    expect([...args.s3Keys].sort()).toEqual([
      "cms/legacy/source.png",
      "cms/legacy/thumb.webp",
    ])
  })

  test("a media referenced by a CMS block keeps its row and its files", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      status: "ready" as const,
      s3Key: "cms/used/source.png",
      usageCount: 1,
    })

    await t.run((ctx) =>
      ctx.db.insert("cmsBlocks", {
        storeId,
        pageSlug: "home",
        blockKey: "hero",
        isDraft: false,
        values: { image: { mediaId } },
        updatedAt: NOW,
        updatedBy: "admin-1",
      })
    )

    await expect(
      admin.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    ).rejects.toThrow(/media_in_use_by_block/)
    // The refusal is a `ConvexError` now, so the sentence survives Convex's
    // production redaction and reaches the media library rather than becoming
    // "Server Error" beside a delete button (#432.3). Matched on the CODE,
    // which is the contract; the wording is asserted in
    // `delete-refusals-reach-the-owner.test.ts`.

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(scheduled).toHaveLength(0)
    expect(await t.run((ctx) => ctx.db.get(mediaId))).not.toBeNull()
  })

  test("a media referenced by a blog article keeps its row and its files", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const admin = await seedAdmin(t, storeId)

    const mediaId = await seedMediaRow(t, storeId, {
      status: "ready" as const,
      s3Key: "cms/cover/source.png",
    })

    const categoryId = await t.run((ctx) =>
      ctx.db.insert("blogCategories", {
        storeId,
        name: "Actualités",
        slug: "actualites",
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await t.run((ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "notre-nouvelle-carte",
        draftCategoryId: categoryId,
        draftAuthorId: "admin-1",
        draftContent: {
          title: "Notre nouvelle carte",
          slug: "notre-nouvelle-carte",
          excerpt: "Ce que le chef a prévu pour cet automne.",
          coverImageId: mediaId,
          content: "<p>Bientôt.</p>",
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "admin-1",
      })
    )

    await expect(
      admin.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    ).rejects.toThrow(/media_in_use_by_article/)

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(scheduled).toHaveLength(0)
  })

  test("purgeS3Objects sends a DeleteObjectCommand per key", async () => {
    const t = newHarness()

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png", "cms/abc/thumb.webp"],
    })

    expect(result).toEqual({
      deleted: 2,
      failed: 0,
      purged: 2,
      deleteMarkersOnly: 0,
    })
    expect(deletedKeys()).toEqual([
      "cms/abc/source.png",
      "cms/abc/thumb.webp",
    ])
  })

  test("purgeS3Objects refuses a key that could climb out of the prefix", async () => {
    const t = newHarness()

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/../../etc/passwd"],
    })

    expect(result).toEqual({
      deleted: 0,
      failed: 1,
      purged: 0,
      deleteMarkersOnly: 0,
    })
    expect(deletedKeys()).toHaveLength(0)
  })

  test("one failing key does not stop the rest", async () => {
    const t = newHarness()
    send.mockImplementation(async (cmd: { input?: { Key?: string } }) => {
      if (cmd.input?.Key === "cms/abc/thumb.webp") {
        throw new Error("AccessDenied")
      }
      return {}
    })

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: [
        "cms/abc/source.png",
        "cms/abc/thumb.webp",
        "cms/abc/card.webp",
      ],
    })

    expect(result).toMatchObject({ deleted: 2, failed: 1 })
  })
})

/**
 * « Définitivement supprimé » has to mean the bytes are gone.
 *
 * `setup-aws.sh` turns bucket versioning ON, and on a versioned bucket a
 * DeleteObject with no VersionId deletes NOTHING: it writes a delete marker
 * over the key and retains every prior version — still billed, still readable
 * by anyone who can name a version id. The media library said the file was
 * permanently deleted, the offboarding runbook ticked an erasure box, and an
 * RGPD erasure request was answered falsely. Issue #331.
 */
/**
 * The reports `captureBackendError` left on the scheduler.
 *
 * It schedules `internal.errorReporting.reportError` rather than awaiting the
 * Sentry POST, so the durable record is observable here as a queued job — read
 * before `afterEach` cancels it.
 */
async function scheduledErrorReports(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs
      .filter((job) => job.name === "errorReporting:reportError")
      .map((job) => job.args[0] as {
        source: string
        message: string
        tags?: Record<string, string>
        extra?: Record<string, string | number | boolean | null>
      })
  })
}

describe("purgeS3Objects on a versioned bucket", () => {
  test("deletes every version and every delete marker, by id", async () => {
    const t = newHarness()
    stubVersions({
      "cms/abc/source.png": { versions: ["v2", "v1"], markers: ["m1"] },
    })

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    expect(result).toEqual({
      deleted: 1,
      failed: 0,
      purged: 1,
      deleteMarkersOnly: 0,
    })
    /* The marker is deleted too, and by id. A marker IS a version: removing
       only the object versions leaves the key hidden with its marker still
       billed, and removing only the marker un-deletes the file. The trailing
       `@current` is the unconditional plain delete — between the listing and
       here another writer may have added a version. */
    expect(deletedVersions()).toEqual([
      "cms/abc/source.png@v2",
      "cms/abc/source.png@v1",
      "cms/abc/source.png@m1",
      "cms/abc/source.png@current",
    ])
  })

  test("does not take a neighbour whose key merely starts the same", async () => {
    // The S3 API is prefix-based and `cms/abc/source.png` is a prefix of
    // `cms/abc/source.png.bak`. Purging by prefix would delete a file nobody
    // asked to delete.
    const t = newHarness()
    send.mockImplementation(async (cmd: { _cmd?: string; input?: { Prefix?: string } }) => {
      if (cmd._cmd !== "versions") return {}
      return {
        Versions: [
          { Key: "cms/abc/source.png", VersionId: "v1" },
          { Key: "cms/abc/source.png.bak", VersionId: "bak1" },
        ],
        IsTruncated: false,
      }
    })

    await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    expect(deletedVersions()).not.toContain("cms/abc/source.png@bak1")
    expect(deletedVersions()).toEqual([
      "cms/abc/source.png@v1",
      "cms/abc/source.png@current",
    ])
  })

  test("walks a truncated version listing to the end", async () => {
    const t = newHarness()
    let page = 0
    send.mockImplementation(async (cmd: { _cmd?: string }) => {
      if (cmd._cmd !== "versions") return {}
      page += 1
      return page === 1
        ? {
            Versions: [{ Key: "cms/abc/source.png", VersionId: "v3" }],
            IsTruncated: true,
            NextKeyMarker: "cms/abc/source.png",
            NextVersionIdMarker: "v3",
          }
        : {
            Versions: [{ Key: "cms/abc/source.png", VersionId: "v2" }],
            IsTruncated: false,
          }
    })

    await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    expect(deletedVersions()).toEqual([
      "cms/abc/source.png@v3",
      "cms/abc/source.png@v2",
      "cms/abc/source.png@current",
    ])
  })

  test("reports the marker-only outcome when the listing is refused", async () => {
    /* Every client provisioned before `s3:ListBucketVersions` reached the IAM
       policy is in this state. Throwing would leave the row deleted and the
       object present with nobody told; saying nothing would repeat the
       original lie. */
    const t = newHarness()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    send.mockImplementation(async (cmd: { _cmd?: string }) => {
      if (cmd._cmd === "versions") throw new Error("AccessDenied")
      return {}
    })

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    expect(result).toEqual({
      deleted: 1,
      failed: 0,
      purged: 0,
      deleteMarkersOnly: 1,
    })
    expect(deletedVersions()).toEqual(["cms/abc/source.png@current"])
    expect(errors.mock.calls.flat().join(" ")).toContain("s3:DeleteObjectVersion")
    errors.mockRestore()
  })

  /**
   * ...and it has to reach somewhere that outlives the log window.
   *
   * The test above pins a `console.error`, which is where the fallback was
   * reported and the only place it was reported. A Convex log line lives in one
   * client's dashboard and expires; #368 is this repository's own ruling that
   * such a line is not an adequate record of a failure with legal weight, and
   * "the files a restaurant was told were permanently deleted are still in the
   * bucket" is exactly that kind of failure.
   *
   * Nobody downstream can find out any other way. `deleteMedia` schedules this
   * action and answers the browser before it runs, so the counts below reach no
   * caller, and the confirmation dialog is written accordingly. The tracker is
   * the only durable record there is.
   */
  test("reports the marker-only fallback to the error tracker, not only to the log", async () => {
    const t = newHarness()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    send.mockImplementation(async (cmd: { _cmd?: string }) => {
      if (cmd._cmd === "versions") throw new Error("AccessDenied")
      return {}
    })

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    const reports = await scheduledErrorReports(t)
    errors.mockRestore()

    expect(result.deleteMarkersOnly).toBe(1)

    // Both halves of the fallback are reported: the refused listing, with the
    // AWS error that caused it, and the run-level summary that says how many
    // objects were left hidden rather than erased.
    expect(reports.map((report) => report.tags?.step).sort()).toEqual([
      "delete-marker-only",
      "list-versions-refused",
    ])
    for (const report of reports) {
      expect(report.source).toBe("cmsMediaDelete.purgeS3Objects")
    }

    const refusal = reports.find((r) => r.tags?.step === "list-versions-refused")
    expect(refusal?.message).toContain("AccessDenied")
    expect(refusal?.extra?.key).toBe("cms/abc/source.png")

    const summary = reports.find((r) => r.tags?.step === "delete-marker-only")
    expect(summary?.message).toContain("s3:DeleteObjectVersion")
    expect(summary?.extra?.deleteMarkersOnly).toBe(1)
  })

  test("says nothing to the tracker when every version was purged", async () => {
    // A report on a successful purge would train an operator to ignore the
    // ones that matter.
    const t = newHarness()
    stubVersions({ "cms/abc/source.png": { versions: ["v1"], markers: [] } })

    const result = await t.action(internal.cmsMediaDelete.purgeS3Objects, {
      s3Keys: ["cms/abc/source.png"],
    })

    expect(result).toMatchObject({ purged: 1, deleteMarkersOnly: 0 })
    expect(await scheduledErrorReports(t)).toEqual([])
  })
})
