// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A refused delete tells the owner why, and what to do about it.
 *
 * WHAT WAS BROKEN (#432.2, #432.3). Convex redacts the message of a plainly
 * thrown `Error` in production — the browser receives "Server Error" — and five
 * delete refusals were thrown that way. Each one is a sentence the owner is
 * meant to act on: how many products to move, which page still uses this image,
 * which language to make default first. What reached the screen was
 * `[CONVEX M(blog:deleteCategory)] [Request ID: …] Server Error`.
 *
 * The sharpest of the five was `categories.remove`, because
 * `packages/convex-functions/src/products.ts:658` names it as "the precedent
 * and the reasoning" for its own refusal — and it was the one throwing plainly.
 * `menus.remove`, the same screen class, always reached the owner, so the two
 * behaved differently with nothing to say why.
 *
 * #418 fixed the wrong half of it: it taught `categories-page.tsx` to call
 * `convexErrorMessage(...)`, a reader for a payload the server never sent, so
 * the screen printed its own fallback verbatim. Two of the five messages were
 * also in English on a French admin.
 *
 * These drive the registered mutations and read the error the way a screen
 * reads it — `convexErrorPayload`, which is what the admin's own helper is
 * built on. A test that asserted on `error.message` would pass on the broken
 * tree, because a plain `Error` has a perfectly good `message` everywhere
 * except production.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { convexErrorPayload } from "../../lib/convex-error"

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

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
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

/** An owner, so the refusal under test is the one being measured. */
async function seedOwner(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "owner-1",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "owner-1" })
}

/**
 * The refusal as a SCREEN sees it.
 *
 * `convexErrorPayload` returns `null` for anything that is not a `ConvexError`
 * — which is exactly what a plainly thrown `Error` becomes once Convex has
 * redacted it. So `null` here means "the owner was shown Server Error", and
 * that is the assertion, not the wording.
 */
async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise
    return { thrown: false as const, payload: null }
  } catch (error) {
    return { thrown: true as const, payload: convexErrorPayload(error) }
  }
}

// ===========================================================================
// The five refusals
// ===========================================================================

describe("categories.remove — the function products.ts cites as its precedent", () => {
  test("refuses a category that still holds products, and says how many", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const categoryId = await t.run((ctx) =>
      ctx.db.insert("categories", {
        storeId,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId,
        categoryId,
        name: "Margherita",
        slug: "margherita",
        price: 1200,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        source: "manual" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const refusal = await refusalOf(owner.mutation(api.categories.remove, { id: categoryId }))

    expect(refusal.thrown).toBe(true)
    expect(refusal.payload?.code).toBe("category_has_products")
    // The count is the actionable part: "des produits" leaves the owner hunting.
    expect(refusal.payload?.message).toMatch(/1 produit\b/)
    expect(refusal.payload?.message).toMatch(/Déplacez-les/)
  })

  test("and the category is still there — a refusal that deleted it would be worse", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const categoryId = await t.run((ctx) =>
      ctx.db.insert("categories", {
        storeId,
        name: "Pizzas",
        slug: "pizzas",
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId,
        categoryId,
        name: "Margherita",
        slug: "margherita",
        price: 1200,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        source: "manual" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await refusalOf(owner.mutation(api.categories.remove, { id: categoryId }))

    expect(await t.run((ctx) => ctx.db.get(categoryId))).not.toBeNull()
  })
})

describe("languages.remove", () => {
  test("refuses the default language, in French", async () => {
    // Two defects in one line: redacted, and written in English on a French
    // admin screen.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const languageId = await t.run((ctx) =>
      ctx.db.insert("languages", {
        storeId,
        code: "fr",
        name: "French",
        nativeName: "Français",
        isDefault: true,
        isActive: true,
        isRtl: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const refusal = await refusalOf(owner.mutation(api.languages.remove, { id: languageId }))

    expect(refusal.payload?.code).toBe("language_is_default")
    expect(refusal.payload?.message).toMatch(/langue par défaut/)
    // Not the English sentence it used to be.
    expect(refusal.payload?.message).not.toMatch(/Cannot delete/)
  })
})

describe("blog.deleteCategory", () => {
  test("refuses a category articles still use, and counts them", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const categoryId = await t.run((ctx) =>
      ctx.db.insert("blogCategories", {
        storeId,
        name: "Recettes",
        slug: "recettes",
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
        draftSlug: "la-pate-a-pizza",
        draftCategoryId: categoryId,
        draftAuthorId: "owner-1",
        draftContent: {
          title: "La pâte à pizza",
          slug: "la-pate-a-pizza",
          excerpt: "Un extrait.",
          content: "<p>Farine.</p>",
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )

    const refusal = await refusalOf(
      owner.mutation(api.blog.deleteCategory, { categoryId })
    )

    expect(refusal.thrown).toBe(true)
    expect(refusal.payload?.code).toBe("blog_category_in_use")
    expect(refusal.payload?.message).toMatch(/1 article\b/)
  })
})

describe("cmsMedia.deleteMedia", () => {
  test("refuses a media a CMS block still shows, and names the page", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const mediaId = await t.run((ctx) =>
      ctx.db.insert("cmsMedia", {
        storeId,
        kind: "image" as const,
        status: "ready" as const,
        filename: "hero.webp",
        mimeType: "image/webp",
        size: 1234,
        usageCount: 0,
        uploadedBy: "owner-1",
        uploadedAt: NOW,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("cmsBlocks", {
        storeId,
        pageSlug: "accueil",
        blockKey: "hero",
        isDraft: false,
        values: { image: { mediaId } },
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_block")
    expect(refusal.payload?.message).toMatch(/« hero »/)
    expect(refusal.payload?.message).toMatch(/« accueil »/)
    // French, not "Cannot delete: media is referenced in block".
    expect(refusal.payload?.message).not.toMatch(/Cannot delete/)
  })

  test("refuses a media an article still illustrates, and names the article", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const mediaId = await t.run((ctx) =>
      ctx.db.insert("cmsMedia", {
        storeId,
        kind: "image" as const,
        status: "ready" as const,
        filename: "cover.webp",
        mimeType: "image/webp",
        size: 1234,
        usageCount: 0,
        uploadedBy: "owner-1",
        uploadedAt: NOW,
      })
    )
    await t.run(async (ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "la-pate-a-pizza",
        draftCategoryId: await ctx.db.insert("blogCategories", {
          storeId,
          name: "Recettes",
          slug: "recettes",
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        draftAuthorId: "owner-1",
        draftContent: {
          title: "La pâte à pizza",
          slug: "la-pate-a-pizza",
          excerpt: "Un extrait.",
          content: "<p>Farine.</p>",
          coverImageId: mediaId,
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )

    const refusal = await refusalOf(
      owner.mutation(api.cmsMedia.deleteMedia, { storeId, mediaId })
    )

    expect(refusal.payload?.code).toBe("media_in_use_by_article")
    expect(refusal.payload?.message).toMatch(/« La pâte à pizza »/)
  })
})

// ===========================================================================
// The screens, and the durable half
// ===========================================================================

/**
 * No admin screen reads `err.message` raw any more.
 *
 * `err instanceof Error ? err.message : "…"` looks like it shows the reason and
 * in production shows `[CONVEX M(...)] [Request ID: …] Server Error` — the
 * fallback is never reached, because a redacted error IS an `Error` with a
 * message. #418 swept `packages/admin/src` and left the blog and CMS admin,
 * which live in each app's own `components/admin/`:
 *
 *     raw err.message across app-level admin : 25
 *     files using the app's own convexErrorMessage : 0
 *
 * A scan rather than a list, because the defect was a habit and habits come
 * back with the next screen.
 */
describe("the admin screens", () => {
  test("read the refusal through convexErrorMessage, not err.message", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")

    const root = join(__dirname, "..", "..", "components", "admin")

    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry)
        return statSync(full).isDirectory()
          ? walk(full)
          : /\.tsx?$/.test(entry)
            ? [full]
            : []
      })
    }

    const files = walk(root)
    expect(files.length).toBeGreaterThan(20)

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8")
      // The exact shape: a caught value tested with `instanceof Error` and then
      // read for its `message`. Not any mention of `.message`, which a
      // legitimate `error.message` in a console line would trip.
      return /(\w+) instanceof Error \? \1\.message/.test(source)
    })

    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([])
  })
})
