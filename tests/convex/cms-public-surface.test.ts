// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What an anonymous visitor may read about a CMS page (#97).
 *
 * TWO FINDINGS, and they resolve in opposite directions — which is the point of
 * testing them together.
 *
 * `cms.listPages` was registered `query(cmsDefs.listPages)` under
 * `@public-by-design: published storefront page content, no auth by design`. The
 * annotation was wrong about the payload: it returns `hasUnpublishedChanges` and
 * `draftUpdatedAt` for every page of the establishment, which is a list of what
 * the staff are working on. Its only caller in the repository is the admin's own
 * content screen — so it is GUARDED now, and nothing anonymous lost a reader.
 *
 * `cms.getPageBlocks` is genuinely read with no session: it is the published page
 * a visitor came for. So it is NARROWED instead. It used to hand out
 * `hasUnpublishedChanges`, `draftUpdatedAt` and `updatedBy` — editorial state and
 * a staff user id — to anybody who asked.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
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
      name: "Chez Luigi",
      slug: "chez-luigi",
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: "client_admin" | "kitchen",
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

/** A page with a published block and a draft nobody outside should hear about. */
async function seedPage(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  const pageSlug = "storefront-layout"
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsPages", {
      storeId,
      pageSlug,
      hasPublished: true,
      hasUnpublishedChanges: true,
      publishedAt: NOW - 86_400_000,
      draftUpdatedAt: NOW,
      // The staff identifier that used to reach an anonymous reader.
      updatedBy: "user:marie-the-manager",
      updatedAt: NOW,
    })
    await ctx.db.insert("cmsBlocks", {
      storeId,
      pageSlug,
      blockKey: "hero",
      values: { title: { type: "text" as const, value: "Bienvenue" } },
      isDraft: false,
      updatedBy: "user:marie-the-manager",
      updatedAt: NOW,
    })
    await ctx.db.insert("cmsBlocks", {
      storeId,
      pageSlug,
      blockKey: "hero",
      values: {
        title: { type: "text" as const, value: "Brouillon que personne ne doit voir" },
      },
      isDraft: true,
      updatedBy: "user:marie-the-manager",
      updatedAt: NOW,
    })
  })
  return pageSlug
}

describe("cms.getPageBlocks, read with no session", () => {
  test("serves the published block", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const pageSlug = await seedPage(t, storeId)

    const page = await t.query(api.cms.getPageBlocks, { storeId, pageSlug })
    expect(page.blocks).toHaveLength(1)
    expect(page.blocks[0].values.title.value).toBe("Bienvenue")
  })

  test("does not serve the draft", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const pageSlug = await seedPage(t, storeId)

    const serialised = JSON.stringify(
      await t.query(api.cms.getPageBlocks, { storeId, pageSlug })
    )
    expect(serialised).not.toContain("Brouillon")
  })

  test("says nothing about who wrote it", async () => {
    // THE LEAK. `updatedBy` is a staff user id, and this query has no session.
    const t = newHarness()
    const storeId = await seedStore(t)
    const pageSlug = await seedPage(t, storeId)

    const page = await t.query(api.cms.getPageBlocks, { storeId, pageSlug })
    expect(page.pageMeta).not.toHaveProperty("updatedBy")
    expect(JSON.stringify(page)).not.toContain("marie-the-manager")
  })

  test("says nothing about work in progress", async () => {
    // `hasUnpublishedChanges` and `draftUpdatedAt` tell a visitor that the staff
    // are mid-edit, and when. Neither is a visitor's business.
    const t = newHarness()
    const storeId = await seedStore(t)
    const pageSlug = await seedPage(t, storeId)

    const page = await t.query(api.cms.getPageBlocks, { storeId, pageSlug })
    expect(page.pageMeta).not.toHaveProperty("hasUnpublishedChanges")
    expect(page.pageMeta).not.toHaveProperty("draftUpdatedAt")
  })

  test("keeps exactly the two fields a page may state about itself", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const pageSlug = await seedPage(t, storeId)

    const page = await t.query(api.cms.getPageBlocks, { storeId, pageSlug })
    expect(Object.keys(page.pageMeta ?? {}).sort()).toEqual([
      "hasPublished",
      "publishedAt",
    ])
  })

  test("answers null metadata for a page that has never been edited", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    const page = await t.query(api.cms.getPageBlocks, {
      storeId,
      pageSlug: "storefront-layout",
    })
    expect(page.pageMeta).toBeNull()
    expect(page.blocks).toEqual([])
  })
})

describe("cms.listPages", () => {
  test("is refused with no session", async () => {
    /*
     * THE FINDING. It was public, and it returns `hasUnpublishedChanges` and
     * `draftUpdatedAt` for every page — a list of what the staff are working on.
     * Its only caller is the admin's own content screen.
     */
    const t = newHarness()
    const storeId = await seedStore(t)

    await expect(t.query(api.cms.listPages, { storeId })).rejects.toThrow(
      /Not authenticated/
    )
  })

  test("is refused to a role without content:read", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(asKitchen.query(api.cms.listPages, { storeId })).rejects.toThrow()
  })

  test("still serves the screen that reads it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    await seedPage(t, storeId)

    const pages = await asOwner.query(api.cms.listPages, { storeId })
    const home = pages.find((p: { slug: string }) => p.slug === "storefront-layout")
    expect(home).toMatchObject({ hasPublished: true, hasUnpublishedChanges: true })
  })
})
