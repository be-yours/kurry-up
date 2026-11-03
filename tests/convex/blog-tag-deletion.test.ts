// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A tag can be deleted (#524).
 *
 * WHAT WAS MISSING. `BlogArticleEditor` creates tags — typing a new name and
 * pressing enter calls `blog.createTag` — and nothing anywhere deleted one. The
 * package had `blog.deleteTag`, complete with its join cleanup, and no app
 * wrapped it. So every typo, every abandoned idea and every tag from a rewritten
 * article stayed in the picker for the life of the establishment, and the list
 * an author chooses from only ever grew.
 *
 * THE WRAPPER CARRIES THE ESTABLISHMENT CHECK, and that is not a detail. The
 * core takes a bare `tagId` and says nothing about whose it is — the same shape
 * as `blog.saveDraft`'s `categoryId`, which let an article be filed under
 * another establishment's rubric until #112. `storeMutation`'s `storeIdFrom`
 * resolves the owner from the row itself, so the permission is checked against
 * the establishment that actually holds the tag.
 *
 * `content:delete`, matching `deleteCategory`: removing a rubric and removing a
 * tag are the same act on the same screen, and a role that may do one has no
 * reason to be refused the other.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { deleteTag as deleteTagCore } from "@be-yours/convex-functions/blog"
import schema from "../../convex/schema"
import type { Id } from "../../convex/_generated/dataModel"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_800_000_000_000

function newHarness() {
  return convexTest(schema, modules)
}

async function seedStore(t: ReturnType<typeof convexTest>, slug: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: slug,
      slug,
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedTag(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  slug: string
) {
  return t.run((ctx) =>
    ctx.db.insert("blogTags", { storeId, name: slug, slug, createdAt: NOW })
  )
}

describe("deleting a blog tag", () => {
  test("removes the tag", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    const tagId = await seedTag(t, storeId, "recettes")

    await t.run((ctx) => deleteTagCore.handler(ctx, { tagId }))

    expect(await t.run((ctx) => ctx.db.get(tagId))).toBeNull()
  })

  test("removes what joined it to an article, so no row points at nothing", async () => {
    /*
     * The half that makes this a deletion rather than a leak. `blogArticleTags`
     * rows carry a `tagId` and the table has no cascade; a join left behind
     * resolves to `null` on every article read that follows.
     */
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    const tagId = await seedTag(t, storeId, "recettes")
    const categoryId = await t.run((ctx) =>
      ctx.db.insert("blogCategories", {
        storeId,
        name: "recettes",
        slug: "recettes",
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const articleId = await t.run((ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        draftCategoryId: categoryId,
        draftAuthorId: "owner_blog",
        updatedBy: "owner_blog",
        draftContent: {
          title: "Notre risotto",
          slug: "notre-risotto",
          excerpt: "",
          content: "",
          updatedAt: NOW,
        },
        draftSlug: "notre-risotto",
        status: "draft" as const,
        hasUnpublishedChanges: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("blogArticleTags", { storeId, articleId, tagId, isDraft: true })
    )

    await t.run((ctx) => deleteTagCore.handler(ctx, { tagId }))

    const joins = await t.run((ctx) => ctx.db.query("blogArticleTags").collect())
    expect(joins).toEqual([])
  })

  test("leaves another establishment's tags alone", async () => {
    // Anti-vacuity on the cleanup above: a handler that emptied the join table
    // would satisfy it and destroy every other establishment's tagging.
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const myTag = await seedTag(t, mine, "recettes")
    const theirTag = await seedTag(t, theirs, "nos-poissons")

    await t.run((ctx) => deleteTagCore.handler(ctx, { tagId: myTag }))

    expect(await t.run((ctx) => ctx.db.get(theirTag))).not.toBeNull()
  })

  test("refuses a tag that does not exist", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    const doomed = await seedTag(t, storeId, "temporaire")
    await t.run((ctx) => ctx.db.delete(doomed))

    await expect(
      t.run((ctx) => deleteTagCore.handler(ctx, { tagId: doomed }))
    ).rejects.toThrow()
  })
})

describe("the wrapper the admin calls", () => {
  const source = (): string =>
    readFileSync(join(process.cwd(), "convex/blog.ts"), "utf8")

  test("exists, so the editor has something to call", () => {
    expect(source()).toMatch(/export const deleteTag = storeMutation\(/)
  })

  test("is guarded on content:delete, like deleteCategory", () => {
    const body = source().slice(source().indexOf("export const deleteTag = storeMutation("))
    expect(body.slice(0, 400)).toMatch(/permission: "content:delete"/)
  })

  test("resolves the establishment from the tag, not from an argument", () => {
    /*
     * The core takes a bare `tagId`. Without `storeIdFrom`, `storeMutation`
     * would have to be given a `storeId` by the caller — and a caller that
     * supplies the establishment its own permission is checked against is not a
     * check at all. This is the same hole #112 closed on `categoryId`.
     */
    const body = source().slice(source().indexOf("export const deleteTag = storeMutation("))
    expect(body.slice(0, 400)).toMatch(/storeIdFrom: storeIdFromTag/)
  })
})
