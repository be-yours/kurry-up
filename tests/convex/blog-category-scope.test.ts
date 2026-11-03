// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * An article cannot be filed under another establishment's rubric (#112).
 *
 * THE HOLE. `generateArticle` is guarded — `_reserveQuota` checks `content:write`
 * on `storeId` — and that check says nothing about `categoryId`, which arrives as
 * a separate argument. A caller holding `content:write` on their own
 * establishment could pass another one's `blogCategories` id, and the article was
 * written with it. The manual editor had the same door.
 *
 * WHAT IT ACTUALLY BROKE, measured rather than assumed. Not a listing leak:
 * `listByCategory` is keyed on `storeId` + `publishedCategoryId`, so the other
 * establishment's blog never surfaces the article. Two things do go wrong:
 *
 *   - `getArticleBySlug` resolves the category with a bare `ctx.db.get` and
 *     renders `category.name` on the public page — so another establishment's
 *     rubric name appears on this one's blog.
 *   - The article is unreachable from its own category listing, because that
 *     listing resolves rubrics by `by_storeId_slug`. Published, and filed under
 *     nothing.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { ConvexError } from "convex/values"
import fs from "node:fs"
import { enginePackageFile } from "../lib/repo-layout"
import {
  createArticleCore,
  saveDraftCore,
} from "@be-yours/convex-functions/blog"
import schema from "../../convex/schema"
import type { Id } from "../../convex/_generated/dataModel"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_800_000_000_000
const AUTHOR = "owner_blog"

function newHarness() {
  return convexTest(schema, modules)
}

async function seedStore(t: ReturnType<typeof convexTest>, slug: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: slug,
      slug,
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

async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  slug: string
) {
  return t.run((ctx) =>
    ctx.db.insert("blogCategories", {
      storeId,
      name: slug,
      slug,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** Create an article through the one insert every write path funnels through. */
const create = (
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  categoryId: Id<"blogCategories">
) =>
  t.run((ctx) =>
    createArticleCore(ctx, {
      storeId,
      title: "Notre risotto de printemps",
      categoryId,
      authorId: AUTHOR,
    })
  )

describe("filing an article under a rubric", () => {
  test("accepts one belonging to the same establishment", async () => {
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    const categoryId = await seedCategory(t, storeId, "recettes")

    await expect(create(t, storeId, categoryId)).resolves.toBeDefined()
  })

  test("refuses one belonging to another establishment", async () => {
    /*
     * THE DEFECT. `content:write` on my own establishment was the whole of the
     * check; the rubric id was never compared against it.
     */
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const theirCategory = await seedCategory(t, theirs, "nos-poissons")

    await expect(create(t, mine, theirCategory)).rejects.toThrow(
      /n'appartient pas à cet établissement/
    )
  })

  test("refuses a rubric that does not exist", async () => {
    // Same refusal, deliberately: which of the two it was is information about
    // another establishment that this caller has no claim to.
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const doomed = await seedCategory(t, theirs, "temporaire")
    await t.run((ctx) => ctx.db.delete(doomed))

    await expect(create(t, mine, doomed)).rejects.toThrow(
      /n'appartient pas à cet établissement/
    )
  })

  test("refuses with a ConvexError, so the sentence survives to the browser", async () => {
    /*
     * A plain `Error` is redacted to "Server Error" in production — the reason
     * `refusal.ts` exists — so the class is the part that decides whether the
     * diner-facing sentence arrives at all.
     *
     * `error.data.code` is deliberately NOT asserted here: `convexTest`'s
     * `t.run` rethrows the error with `data` stripped, so the check would pass on
     * `undefined === undefined` after any future rename and prove nothing. The
     * code is pinned where it is observable — `blog_category_not_in_store` is
     * read by the admin's `convexErrorMessage`, and the message it produces is
     * what the tests above match on.
     */
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const theirCategory = await seedCategory(t, theirs, "nos-poissons")

    try {
      await create(t, mine, theirCategory)
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError)
      expect(String((error as Error).message)).toMatch(/rubrique/)
    }
  })

  test("writes nothing when it refuses", async () => {
    // A half-written article would be worse than the cross-store reference: it
    // would be a draft nobody asked for, under a rubric that is not there.
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const theirCategory = await seedCategory(t, theirs, "nos-poissons")

    await expect(create(t, mine, theirCategory)).rejects.toThrow()

    const articles = await t.run((ctx) => ctx.db.query("blogArticles").collect())
    expect(articles).toEqual([])
  })

  test("keeps two establishments' rubrics of the same name apart", async () => {
    // Both call it « recettes ». The slug is unique per store, not globally, so
    // the id is the only thing that separates them — which is what makes the
    // check an id comparison rather than a slug one.
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const myCategory = await seedCategory(t, mine, "recettes")
    const theirCategory = await seedCategory(t, theirs, "recettes")

    await expect(create(t, mine, myCategory)).resolves.toBeDefined()
    await expect(create(t, mine, theirCategory)).rejects.toThrow()
  })
})

/**
 * The same rule on the EDIT path (#526).
 *
 * #499 put the check in `createArticleCore` and stopped there, and the wrapper's
 * own guard does not close the gap: `saveDraft` validates the ARTICLE's store
 * through `storeIdFromArticle` and never the `categoryId` beside it, which
 * arrives from the browser.
 *
 * It does not stay in the draft, which is why this is worth its own suite:
 * `publishArticleCore` copies `draftCategoryId` to `publishedCategoryId`
 * unconditionally, three public readers resolve it with a bare `ctx.db.get`, and
 * `category.name` renders on the page.
 */
describe("re-filing an article under a rubric", () => {
  /** Save a draft through the one patch every edit funnels through. */
  const saveDraft = (
    t: ReturnType<typeof convexTest>,
    articleId: string,
    categoryId: Id<"blogCategories">
  ) =>
    t.run((ctx) =>
      saveDraftCore(ctx, {
        articleId,
        /* The shape `blogContentFieldsValidator` requires. `title` is read to
           build the slug; the rest is what the editor sends, and none of it
           matters to the rule under test — but the schema validates the patch,
           so a short fixture fails on the wrong thing. */
        draftContent: {
          title: "Notre risotto de printemps",
          slug: "notre-risotto-de-printemps",
          excerpt: "Riz carnaroli, asperges vertes, parmesan.",
          content: "<p>Le riz est nacré à feu vif.</p>",
          updatedAt: NOW,
        },
        categoryId,
        authorId: AUTHOR,
        updatedBy: AUTHOR,
      })
    )

  test("accepts another rubric of the same establishment", async () => {
    // Anti-vacuity: without this, a `saveDraftCore` that refused every category
    // would pass the refusal tests below.
    const t = newHarness()
    const storeId = await seedStore(t, "chez-camille")
    const first = await seedCategory(t, storeId, "recettes")
    const second = await seedCategory(t, storeId, "actualites")
    const articleId = await create(t, storeId, first)

    // `.resolves` and not a value: `saveDraftCore` returns nothing, and what is
    // being asserted is that it did not refuse. `t.run` resolves `null` for a
    // void handler, so the assertion is on the absence of a throw.
    await expect(saveDraft(t, articleId as string, second)).resolves.toBeNull()
  })

  test("refuses one belonging to another establishment", async () => {
    /*
     * THE DEFECT. A member with `content:write` on their own establishment
     * edits their own article and sends another establishment's rubric id.
     */
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const theirs = await seedStore(t, "sushi-bar")
    const myCategory = await seedCategory(t, mine, "recettes")
    const theirCategory = await seedCategory(t, theirs, "nos-poissons")
    const articleId = await create(t, mine, myCategory)

    await expect(saveDraft(t, articleId as string, theirCategory)).rejects.toThrow(
      /n'appartient pas à cet établissement/
    )
  })

  test("refuses a rubric that does not exist", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "chez-camille")
    const myCategory = await seedCategory(t, mine, "recettes")
    const doomed = await seedCategory(t, mine, "temporaire")
    const articleId = await create(t, mine, myCategory)
    await t.run((ctx) => ctx.db.delete(doomed))

    await expect(saveDraft(t, articleId as string, doomed)).rejects.toThrow(
      /n'appartient pas à cet établissement/
    )
  })

  test("takes the store from the ARTICLE, not from anything a caller sends", async () => {
    // The store is the article's. Taking it from the caller would reopen the
    // door one field along — `saveDraftCore` has no `storeId` argument at all,
    // and this pins that it stays that way.
    // Resolved through `repo-layout` rather than by walking up to `packages/`:
    // this file SHIPS, and that path exists only in the engine monorepo. A
    // client's copy is under `node_modules/@be-yours/convex-functions`,
    // which `enginePackageFile` knows about and a `../../../../` does not.
    const blog = enginePackageFile("convex-functions", "src/blog.ts")
    if (blog === null) {
      throw new Error(
        "blog.ts is not in this checkout, so the rule about saveDraftCore's " +
          "arguments would be checked against nothing"
      )
    }

    const source = fs.readFileSync(blog, "utf8")
    expect(source).toContain("assertCategoryInStore(ctx, article.storeId, args.categoryId)")
  })
})
