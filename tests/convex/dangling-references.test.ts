// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * References a delete used to leave behind.
 *
 * WHAT WAS BROKEN (#432.6). Three deletes left a row pointing at something that
 * no longer existed, and every one of them was invisible to the schema:
 *
 *  - `categories.remove` left `stores.stationMapping[].categoryId` — a
 *    **required** `v.id("categories")` inside an array. `v.id()` validates how
 *    an id is encoded, not that it resolves, so nothing complained. It was
 *    inert only because `orders.ts` builds a `Map` of strings rather than
 *    calling `ctx.db.get` — and `use-store-detail.ts` re-persists the whole
 *    array on every save of the kitchen tab, so the dead entry was written back
 *    for ever.
 *  - `blog.deleteArticle` left `blogAutoQueue.articleId` — a work item for an
 *    article nobody can open.
 *  - `languages.remove` left every `translations` row for that language.
 *    `languageCode` is a `v.string()`, because a language is identified by its
 *    BCP 47 code throughout the product, so the schema cannot see it is a
 *    foreign key. The consequence is the one that reaches a diner: re-adding
 *    the same code **resurrects the stale rows**, so an owner who removes
 *    German, rewrites the carte, and adds German back gets last month's German
 *    on the storefront.
 *
 * And one that is NOT a defect, pinned here so nobody "fixes" it:
 * `requiredActions.remove` leaves ids in `gamePlays.completedActions`, and the
 * only reader folds them into a set to answer "has this device already done
 * this action?". An id that no longer resolves never matches an action that is
 * still required. Rewriting that history to tidy an admin config change would
 * be the worse trade — those rows carry the prize claim, the cooldown and the
 * art. 7.1 consent.
 *
 * Driven through the registered mutations, because three of the four are about
 * what a real delete leaves in a real schema.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import { LANGUAGE_TRANSLATION_BATCH } from "@be-yours/convex-functions/languages"

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

async function seedCategory(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name: string
) {
  return t.run((ctx) =>
    ctx.db.insert("categories", {
      storeId,
      name,
      slug: name.toLowerCase(),
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

// ===========================================================================
// stores.stationMapping
// ===========================================================================

describe("categories.remove and the kitchen routing", () => {
  test("drops the station entry that named the deleted category", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const pizzas = await seedCategory(t, storeId, "Pizzas")
    const desserts = await seedCategory(t, storeId, "Desserts")

    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        kitchenStations: ["Four", "Froid"],
        stationMapping: [
          { categoryId: pizzas, station: "Four" },
          { categoryId: desserts, station: "Froid" },
        ],
        updatedAt: NOW,
      })
    )

    await owner.mutation(api.categories.remove, { id: pizzas })

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.stationMapping).toEqual([{ categoryId: desserts, station: "Froid" }])
  })

  test("and every surviving entry still resolves", async () => {
    // The property, not the array shape: the point of the cascade is that
    // nothing in `stationMapping` names a row that is gone. `v.id()` cannot say
    // so, which is why this dereferences each one.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const pizzas = await seedCategory(t, storeId, "Pizzas")
    const desserts = await seedCategory(t, storeId, "Desserts")
    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        stationMapping: [
          { categoryId: pizzas, station: "Four" },
          { categoryId: desserts, station: "Froid" },
        ],
        updatedAt: NOW,
      })
    )

    await owner.mutation(api.categories.remove, { id: pizzas })

    const resolved = await t.run(async (ctx) => {
      const store = await ctx.db.get(storeId)
      const mapping = (store?.stationMapping ?? []) as Array<{ categoryId: Id<"categories"> }>
      return Promise.all(mapping.map((entry) => ctx.db.get(entry.categoryId)))
    })
    expect(resolved.every((row) => row !== null)).toBe(true)
  })

  test("leaves a store with no routing alone", async () => {
    // The common case, and the one a filter written carelessly breaks: most
    // establishments have no `stationMapping` at all.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const pizzas = await seedCategory(t, storeId, "Pizzas")

    await owner.mutation(api.categories.remove, { id: pizzas })

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.stationMapping).toBeUndefined()
  })
})

/** The config a queue row belongs to — `configId` is required. */
async function seedAutoConfig(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("blogAutoConfig", {
      ownerId: "owner-1",
      storeId,
      isEnabled: true,
      themes: ["Recettes"],
      frequency: "weekly" as const,
      preferredHour: 9,
      timezone: "Europe/Paris",
      tone: "decontracte" as const,
      primaryLocale: "fr",
      autoTranslate: false,
      approvalMode: "draft_review" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

// ===========================================================================
// blogAutoQueue
// ===========================================================================

describe("blog.deleteArticle and the generation queue", () => {
  test("takes the queue row that produced the article with it", async () => {
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
    const articleId = await t.run((ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "la-pate",
        draftCategoryId: categoryId,
        draftAuthorId: "owner-1",
        draftContent: {
          title: "La pâte",
          slug: "la-pate",
          excerpt: "Un extrait.",
          content: "<p>Farine.</p>",
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )
    const configId = await seedAutoConfig(t, storeId)
    await t.run((ctx) =>
      ctx.db.insert("blogAutoQueue", {
        ownerId: "owner-1",
        storeId,
        configId,
        status: "published" as const,
        scheduledFor: NOW,
        theme: "La pâte",
        locale: "fr",
        articleId,
        retryCount: 0,
        maxRetries: 3,
        idempotencyKey: `${storeId}-2026-09-a`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await owner.mutation(api.blog.deleteArticle, { articleId })

    expect(await t.run((ctx) => ctx.db.query("blogAutoQueue").collect())).toHaveLength(0)
  })

  test("and leaves a queue row for another article standing", async () => {
    // A cascade keyed on the wrong thing takes the whole queue with it, which
    // would silently cancel every article the planner had lined up.
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
    const articleId = await t.run((ctx) =>
      ctx.db.insert("blogArticles", {
        storeId,
        status: "draft" as const,
        hasUnpublishedChanges: true,
        draftSlug: "la-pate",
        draftCategoryId: categoryId,
        draftAuthorId: "owner-1",
        draftContent: {
          title: "La pâte",
          slug: "la-pate",
          excerpt: "Un extrait.",
          content: "<p>Farine.</p>",
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "owner-1",
      })
    )
    const configId = await seedAutoConfig(t, storeId)
    await t.run(async (ctx) => {
      await ctx.db.insert("blogAutoQueue", {
        ownerId: "owner-1",
        storeId,
        configId,
        status: "published" as const,
        scheduledFor: NOW,
        theme: "La pâte",
        locale: "fr",
        articleId,
        retryCount: 0,
        maxRetries: 3,
        idempotencyKey: `${storeId}-2026-09-a`,
        createdAt: NOW,
        updatedAt: NOW,
      })
      // A pending item, not yet written, so it names no article at all.
      await ctx.db.insert("blogAutoQueue", {
        ownerId: "owner-1",
        storeId,
        configId,
        status: "pending" as const,
        scheduledFor: NOW + 86_400_000,
        theme: "Le four à bois",
        locale: "fr",
        retryCount: 0,
        maxRetries: 3,
        idempotencyKey: `${storeId}-2026-09-b`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    await owner.mutation(api.blog.deleteArticle, { articleId })

    const remaining = await t.run((ctx) => ctx.db.query("blogAutoQueue").collect())
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.theme).toBe("Le four à bois")
  })
})

// ===========================================================================
// translations, by language code
// ===========================================================================

describe("languages.remove and the translations", () => {
  async function seedLanguage(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    code: string,
    isDefault: boolean
  ) {
    return t.run((ctx) =>
      ctx.db.insert("languages", {
        storeId,
        code,
        name: code,
        nativeName: code,
        isDefault,
        isActive: true,
        isRtl: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  async function seedTranslations(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    code: string,
    count: number
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("translations", {
          storeId,
          languageCode: code,
          entityType: "products",
          entityId: `product-${i}`,
          field: "name",
          value: `${code} nom ${i}`,
          isAutoTranslated: false,
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })
  }

  const remaining = (t: ReturnType<typeof convexTest>, code: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query("translations").collect()).filter((row) => row.languageCode === code)
    )

  test("takes the language's translations with it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedLanguage(t, storeId, "fr", true)
    const de = await seedLanguage(t, storeId, "de", false)
    await seedTranslations(t, storeId, "de", 5)
    await seedTranslations(t, storeId, "fr", 3)

    await owner.mutation(api.languages.remove, { id: de })

    expect(await remaining(t, "de")).toHaveLength(0)
    // And not the ones for a language that is still offered.
    expect(await remaining(t, "fr")).toHaveLength(3)
  })

  test("re-adding the same code does not resurrect last month's text", async () => {
    // The consequence that reaches a diner. Before the cascade, an owner who
    // removed German, rewrote the carte and added German back got the OLD
    // German on the storefront — and no state in the product could tell that
    // those rows were older than the text they translate.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedLanguage(t, storeId, "fr", true)
    const de = await seedLanguage(t, storeId, "de", false)
    await seedTranslations(t, storeId, "de", 4)

    await owner.mutation(api.languages.remove, { id: de })
    await seedLanguage(t, storeId, "de", false)

    expect(await remaining(t, "de")).toHaveLength(0)
  })

  test("drains a catalogue bigger than one batch", async () => {
    // A transaction has a document ceiling, so the sweep is batched and the app
    // wrapper reschedules until it is done. Seeded one row past the batch, which
    // is the cheapest way to demand a second pass.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedLanguage(t, storeId, "fr", true)
    const de = await seedLanguage(t, storeId, "de", false)
    await seedTranslations(t, storeId, "de", LANGUAGE_TRANSLATION_BATCH + 1)

    const result = await owner.mutation(api.languages.remove, { id: de })
    expect(result.hasMore).toBe(true)

    // The drain is BOOKED, not awaited: a delete must not wait on a
    // four-hundred-row sweep. That it is booked is the first assertion, because
    // a sweep that is never scheduled leaves exactly the half-cleared state the
    // batching was added to avoid.
    const booked = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(booked.map((job) => job.name)).toContain("languages:purgeTranslations")

    // Then run it as the scheduler would, the way `destructive-deletes` runs the
    // menu sweep: `finishAllScheduledFunctions` advances the clock and fires
    // every other delayed job in the harness, which is a different test.
    await t.mutation(internal.languages.purgeTranslations, {
      storeId: result.storeId,
      languageCode: result.languageCode,
    })

    expect(await remaining(t, "de")).toHaveLength(0)
  })

  test("the language row goes even if the drain has not finished", async () => {
    // Deliberate ordering: a language with half its translations gone is a
    // worse storefront than one that is simply no longer offered.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await seedLanguage(t, storeId, "fr", true)
    const de = await seedLanguage(t, storeId, "de", false)
    await seedTranslations(t, storeId, "de", LANGUAGE_TRANSLATION_BATCH + 1)

    await owner.mutation(api.languages.remove, { id: de })

    expect(await t.run((ctx) => ctx.db.get(de))).toBeNull()
  })
})

// ===========================================================================
// The one that is not a defect
// ===========================================================================

describe("requiredActions.remove", () => {
  test("leaves gamePlays alone, and that is the decision", async () => {
    // `gamePlays.completedActions` holds the ids of what a diner did. Those rows
    // carry the prize claim, the cooldown and the art. 7.1 consent, and editing
    // them to tidy an admin config change is the worse trade. The only reader
    // folds the ids into a set, where one that no longer resolves simply never
    // matches an action that is still required.
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)

    const actionId = await t.run((ctx) =>
      ctx.db.insert("requiredActions", {
        storeId,
        type: "instagram_follow" as const,
        name: "Suivez-nous",
        url: "https://instagram.test/luigi",
        isRequired: true,
        isActive: true,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const playId = await t.run(async (ctx) =>
      ctx.db.insert("gamePlays", {
        storeId,
        gameId: await ctx.db.insert("games", {
          storeId,
          name: "Roue",
          type: "wheel" as const,
          winRatio: 30,
          isActive: true,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        fingerprint: "fp-1",
        completedActions: [actionId],
        didWin: false,
        playedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await owner.mutation(api.requiredActions.remove, { id: actionId })

    const play = await t.run((ctx) => ctx.db.get(playId))
    expect(play).not.toBeNull()
    expect(play?.completedActions).toEqual([actionId])
  })
})
