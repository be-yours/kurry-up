// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The catalogue translates itself, or it does not sell abroad.
 *
 * Three independent faults kept this dead, and each one hid the next. The
 * schema declared none of the columns the translator writes, so every patch
 * was refused by the validator. `executeTranslation` and `batchChunk` were
 * registered as mutations while calling OpenAI, which Convex forbids. And
 * nothing called `scheduleTranslation` at all — a comment said to call it from
 * the product mutations, and nobody ever had.
 *
 * These tests run the real mutations and the real action against the real
 * schema, with `fetch` stubbed where GPT would be. They pin all three.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"
import * as autoTranslate from "../../convex/autoTranslate"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Every catalogue write now books two jobs — the platform menu sync and the
 * debounced translation. Running them after the test would write against a
 * closed transaction and surface as an unhandled rejection, so they are
 * cancelled rather than drained.
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
  vi.unstubAllGlobals()
})

// ── Fixtures ─────────────────────────────────────────────────────────────

async function seedStore(t: ReturnType<typeof convexTest>, name = "Chez Luigi") {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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

async function seedOwner(t: ReturnType<typeof convexTest>, storeIds: Id<"stores">[]) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:owner",
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "user:owner" })
}

/** French as the source language, English switched on beside it. */
async function seedLanguages(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("languages", {
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
    await ctx.db.insert("languages", {
      storeId,
      code: "en",
      name: "English",
      nativeName: "English",
      isDefault: false,
      isActive: true,
      isRtl: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

async function seedCategory(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
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
}

const PRODUCT_ARGS = {
  name: "Pizza Margherita",
  slug: "pizza-margherita",
  description: "Tomate, mozzarella, basilic frais",
  price: 1200,
  taxRate: 10,
  images: [],
  options: [],
  allergens: [],
  tags: [],
  isActive: true,
  isFeatured: false,
  sortOrder: 0,
}

/**
 * Stand in for OpenAI.
 *
 * The prompt labels each field `[name]:` and the parser reads those labels
 * back, so the stub has to answer in the same shape or nothing is written.
 */
function stubGpt(reply: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: reply } }] }),
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-key"
})

// ── Blocker 1: the schema accepts what the translator writes ─────────────

describe("catalogue translation schema", () => {
  test("products, categories and menus carry the translation columns", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const categoryId = await seedCategory(t, storeId)
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId,
        categoryId,
        ...PRODUCT_ARGS,
        source: "manual",
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
    const menuId = await t.run((ctx) =>
      ctx.db.insert("menus", {
        storeId,
        name: "Formule midi",
        price: 1500,
        sections: [],
        isActive: true,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const entry = {
      en: {
        name: "Margherita Pizza",
        description: "Tomato, mozzarella, fresh basil",
        _meta: { nameHash: "abc", nameAuto: true, descHash: "def", descAuto: true },
      },
    }

    await t.run(async (ctx) => {
      await ctx.db.patch(productId, { translations: entry, pendingTranslation: true })
      await ctx.db.patch(categoryId, { translations: entry, pendingTranslation: false })
      await ctx.db.patch(menuId, { translations: entry })
    })

    const product = await t.run((ctx) => ctx.db.get(productId))
    expect(product?.translations?.en?.name).toBe("Margherita Pizza")
    expect(product?.pendingTranslation).toBe(true)
  })

  test("stores carry the daily translation quota", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        translationQuota: { dailyLimit: 500, used: 7, resetAt: NOW + 86_400_000 },
      })
    )

    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.translationQuota).toEqual({
      dailyLimit: 500,
      used: 7,
      resetAt: NOW + 86_400_000,
    })
  })
})

// ── Blocker 2: the GPT calls happen in actions, not mutations ────────────

describe("function kinds", () => {
  test("every registration that reaches OpenAI is an action", () => {
    // A Convex mutation may not call `fetch`. Both of these do, transitively,
    // and both were registered as `internalMutation` — so neither could ever
    // have run in production, whatever the schema said.
    expect(
      (autoTranslate.executeTranslation as { isAction?: boolean }).isAction
    ).toBe(true)
    expect((autoTranslate.batchChunk as { isAction?: boolean }).isAction).toBe(true)
    expect(
      (autoTranslate.translateCatalogue as { isAction?: boolean }).isAction
    ).toBe(true)
  })

  test("the DB halves stay a query and a mutation", () => {
    expect(
      (autoTranslate._getTranslationPlan as { isQuery?: boolean }).isQuery
    ).toBe(true)
    expect(
      (autoTranslate._saveDocumentTranslations as { isMutation?: boolean }).isMutation
    ).toBe(true)
    expect(
      (autoTranslate._getBatchChunkPlan as { isQuery?: boolean }).isQuery
    ).toBe(true)
    expect(
      (autoTranslate._saveBatchChunk as { isMutation?: boolean }).isMutation
    ).toBe(true)
  })
})

// ── Blocker 3: the catalogue mutations actually schedule ─────────────────

describe("scheduleTranslation callers", () => {
  test("products.create flags the new product and books a job", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.pendingTranslation).toBe(true)
    expect(doc?.scheduledTranslationJobId).toBeTruthy()
  })

  test("categories.create and menus.create book one too", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const categoryId = (await asOwner.mutation(api.categories.create, {
      storeId,
      name: "Desserts",
      slug: "desserts",
      sortOrder: 1,
      isActive: true,
    })) as Id<"categories">

    const menuId = (await asOwner.mutation(api.menus.create, {
      storeId,
      name: "Formule midi",
      price: 1500,
      sections: [
        {
          sectionId: "dessert",
          label: "Un dessert",
          type: "pick_category" as const,
          required: true,
          minChoices: 1,
          maxChoices: 1,
          allowDuplicates: false,
          sortOrder: 0,
          categoryId,
        },
      ],
      isActive: true,
      sortOrder: 0,
    })) as Id<"menus">

    const category = await t.run((ctx) => ctx.db.get(categoryId))
    const menu = await t.run((ctx) => ctx.db.get(menuId))
    expect(category?.pendingTranslation).toBe(true)
    expect(menu?.pendingTranslation).toBe(true)
  })

  test("an edit to the name re-books, and cancels the job the last edit booked", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">
    const firstJob = (await t.run((ctx) => ctx.db.get(productId)))
      ?.scheduledTranslationJobId

    await asOwner.mutation(api.products.update, {
      id: productId,
      name: "Pizza Reine",
    })

    const secondJob = (await t.run((ctx) => ctx.db.get(productId)))
      ?.scheduledTranslationJobId
    expect(secondJob).toBeTruthy()
    expect(secondJob).not.toBe(firstJob)

    // The debounce is the whole point: five edits in a row must cost one GPT
    // call, so the previous job has to be gone, not merely forgotten.
    const first = await t.run((ctx) => ctx.db.system.get(firstJob!))
    expect(first?.state.kind).toBe("canceled")
  })

  test("a price-only edit books nothing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    // Clear the create's booking so the assertion is about the update alone.
    await t.run((ctx) =>
      ctx.db.patch(productId, {
        pendingTranslation: false,
        scheduledTranslationJobId: undefined,
      })
    )

    await asOwner.mutation(api.products.update, { id: productId, price: 1400 })

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.pendingTranslation).toBe(false)
    expect(doc?.scheduledTranslationJobId).toBeUndefined()
  })
})

// ── End to end: an admin adds a language, a product gets translated ──────

describe("executeTranslation", () => {
  test("translates a product into every active language and bills the quota", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const gpt = stubGpt(
      "[name]: Margherita Pizza\n[description]: Tomato, mozzarella, fresh basil"
    )

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.translations?.en?.name).toBe("Margherita Pizza")
    expect(doc?.translations?.en?.description).toBe("Tomato, mozzarella, fresh basil")
    expect(doc?.translations?.en?._meta?.nameAuto).toBe(true)
    // The flags clear, or the admin watches a spinner for ever.
    expect(doc?.pendingTranslation).toBe(false)
    expect(doc?.scheduledTranslationJobId).toBeUndefined()

    // One call for one language, and the store is billed for it.
    expect(gpt).toHaveBeenCalledTimes(1)
    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.translationQuota?.used).toBe(1)
  })

  test("a second run over unchanged text sends nothing to GPT", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    stubGpt("[name]: Margherita Pizza\n[description]: Tomato, mozzarella, fresh basil")

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    const second = stubGpt("[name]: SHOULD NOT BE CALLED")
    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    // The source hash is unchanged, so there is nothing to send. At $0.001 a
    // product this is the difference between a bill and a rounding error.
    expect(second).not.toHaveBeenCalled()
    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.translations?.en?.name).toBe("Margherita Pizza")
  })

  test("never overwrites a translation a human wrote", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    await t.run((ctx) =>
      ctx.db.patch(productId, {
        translations: {
          en: {
            name: "The Real Margherita",
            _meta: { nameAuto: false, descHash: "stale" },
          },
        },
      })
    )

    const gpt = stubGpt("[name]: Margherita Pizza\n[description]: Tomato and basil")
    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.translations?.en?.name).toBe("The Real Margherita")
    // The description was still fair game, so one call was still made.
    expect(gpt).toHaveBeenCalledTimes(1)
    expect(doc?.translations?.en?.description).toBe("Tomato and basil")
  })

  test("clears the pending flag when there is nothing to translate", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    // No second language: the store is monolingual.
    await t.run((ctx) =>
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
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const gpt = stubGpt("[name]: nope")
    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(gpt).not.toHaveBeenCalled()
    expect(doc?.pendingTranslation).toBe(false)
    expect(doc?.scheduledTranslationJobId).toBeUndefined()
  })

  test("stops at the daily quota", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    const productId = (await asOwner.mutation(api.products.create, {
      storeId,
      categoryId,
      ...PRODUCT_ARGS,
    })) as Id<"products">

    await t.run((ctx) =>
      ctx.db.patch(storeId, {
        translationQuota: { dailyLimit: 2, used: 2, resetAt: Date.now() + 3_600_000 },
      })
    )

    const gpt = stubGpt("[name]: Margherita Pizza")
    await t.action(internal.autoTranslate.executeTranslation, {
      documentId: productId,
      tableName: "products",
      storeId,
    })

    expect(gpt).not.toHaveBeenCalled()
    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.translations).toBeUndefined()
    expect(doc?.pendingTranslation).toBe(false)
  })
})

// ── The batch back-fill has a way in ────────────────────────────────────

describe("translateCatalogue", () => {
  test("opens a job and translates the catalogue that was already there", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    // Two products that predate the second language — the case the batch
    // translator exists for, and could never reach before: nothing started
    // chunk 0, so `batchChunk` only ever scheduled itself.
    await t.run(async (ctx) => {
      for (const name of ["Pizza Margherita", "Pizza Reine"]) {
        await ctx.db.insert("products", {
          storeId,
          categoryId,
          ...PRODUCT_ARGS,
          name,
          slug: name.toLowerCase().replace(/\s+/g, "-"),
          source: "manual",
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })

    stubGpt("[name]: Translated\n[description]: Translated description")

    const job = await asOwner.action(api.autoTranslate.translateCatalogue, {
      storeId,
      targetLang: "en",
      entityType: "products",
    })

    expect(job.totalItems).toBe(2)

    // Chunk 0 is booked on the scheduler — the thing that never happened
    // before, because `batchChunk` only ever scheduled itself.
    const booked = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(
      booked.some((j) => j.name.includes("batchChunk") && j.state.kind === "pending")
    ).toBe(true)

    // Then run it. Driving convex-test's scheduler needs fake timers, and this
    // suite stubs `fetch`; calling the action is the same code path with one
    // less emulation layer in the way.
    await t.action(internal.autoTranslate.batchChunk, {
      storeId,
      targetLang: "en",
      entityType: "products",
      jobId: job.jobId as Id<"translationJobs">,
    })

    const products = await t.run((ctx) =>
      ctx.db
        .query("products")
        .withIndex("by_storeId", (q) => q.eq("storeId", storeId))
        .collect()
    )
    expect(products).toHaveLength(2)
    for (const product of products) {
      expect(product.translations?.en?.name).toBe("Translated")
    }

    const stored = await t.run((ctx) => ctx.db.get(job.jobId as Id<"translationJobs">))
    expect(stored?.status).toBe("completed")
    expect(stored?.completedItems).toBe(2)
  })

  test("bills the batch against the same daily quota as the incremental path", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])

    await t.run(async (ctx) => {
      for (const name of ["Un", "Deux", "Trois", "Quatre"]) {
        await ctx.db.insert("products", {
          storeId, categoryId, ...PRODUCT_ARGS, name,
          slug: name.toLowerCase(), source: "manual",
          createdAt: NOW, updatedAt: NOW,
        })
      }
      // Two calls left in the window.
      await ctx.db.patch(storeId, {
        translationQuota: { dailyLimit: 10, used: 8, resetAt: Date.now() + 3_600_000 },
      })
    })

    const gpt = stubGpt("[name]: Translated")
    const job = await asOwner.action(api.autoTranslate.translateCatalogue, {
      storeId, targetLang: "en", entityType: "products",
    })
    await t.action(internal.autoTranslate.batchChunk, {
      storeId, targetLang: "en", entityType: "products",
      jobId: job.jobId as Id<"translationJobs">,
    })

    // The batch had no quota at all: `translateCatalogue` is fired three
    // times by the admin on every language added, so a large catalogue spent
    // hundreds of unmetered OpenAI calls in one click.
    expect(gpt).toHaveBeenCalledTimes(2)
    const store = await t.run((ctx) => ctx.db.get(storeId))
    expect(store?.translationQuota?.used).toBe(10)

    // And it says so rather than reporting a catalogue that is translated.
    const stored = await t.run((ctx) => ctx.db.get(job.jobId as Id<"translationJobs">))
    expect(stored?.status).toBe("failed")
    expect(stored?.error).toMatch(/quota/i)
  })

  test("does not pay again for text it already translated", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const asOwner = await seedOwner(t, [storeId])
    await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId, categoryId, ...PRODUCT_ARGS, source: "manual",
        createdAt: NOW, updatedAt: NOW,
      })
    )

    stubGpt("[name]: Translated\n[description]: Translated description")
    const first = await asOwner.action(api.autoTranslate.translateCatalogue, {
      storeId, targetLang: "en", entityType: "products",
    })
    await t.action(internal.autoTranslate.batchChunk, {
      storeId, targetLang: "en", entityType: "products",
      jobId: first.jobId as Id<"translationJobs">,
    })

    // Adding a language twice, or re-adding a removed one, must not re-buy
    // the whole catalogue.
    const second = stubGpt("[name]: SHOULD NOT BE CALLED")
    const rerun = await asOwner.action(api.autoTranslate.translateCatalogue, {
      storeId, targetLang: "en", entityType: "products",
    })
    await t.action(internal.autoTranslate.batchChunk, {
      storeId, targetLang: "en", entityType: "products",
      jobId: rerun.jobId as Id<"translationJobs">,
    })

    expect(second).not.toHaveBeenCalled()
  })

  test("refuses to write a translation of text that changed under it", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        storeId, categoryId, ...PRODUCT_ARGS, source: "manual",
        createdAt: NOW, updatedAt: NOW,
      })
    )

    // Rename the dish between the plan and the save, the way an owner editing
    // during a back-fill would. The batch had no staleness check, so it wrote
    // a translation of the old name — and never revisited it.
    const plan = await t.query(internal.autoTranslate._getBatchChunkPlan, {
      storeId, targetLang: "en", entityType: "products",
    })
    await t.run((ctx) => ctx.db.patch(productId, { name: "Pizza Reine" }))

    await t.mutation(internal.autoTranslate._saveBatchChunk, {
      storeId,
      targetLang: "en",
      results: [
        {
          documentId: productId,
          fields: { name: "Margherita Pizza" },
          hashes: { name: "stale-hash" },
        },
      ],
      completed: 1,
      gptCalls: 1,
      quotaResetAt: plan!.quotaResetAt,
      isLastChunk: true,
      quotaExhausted: false,
    })

    const doc = await t.run((ctx) => ctx.db.get(productId))
    expect(doc?.translations?.en?.name).toBeUndefined()
  })

  test("a delete mid-batch does not step over the next document", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)
    const categoryId = await seedCategory(t, storeId)

    const ids: Id<"products">[] = []
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        ids.push(
          await ctx.db.insert("products", {
            storeId, categoryId, ...PRODUCT_ARGS,
            name: `Produit ${i}`, slug: `produit-${i}`, source: "manual",
            createdAt: NOW, updatedAt: NOW,
          })
        )
      }
    })

    const first = await t.query(internal.autoTranslate._getBatchChunkPlan, {
      storeId, targetLang: "en", entityType: "products",
    })
    // The cursor is a creation time, not an index. With an index, deleting a
    // document mid-run slid the next chunk left and the boundary document was
    // never translated — while the job still reported every item done.
    expect(first!.nextCursor).toBeNull()

    await t.run((ctx) => ctx.db.delete(ids[0]!))
    const cursor = String(
      (await t.run((ctx) => ctx.db.get(ids[1]!)))!._creationTime
    )
    const next = await t.query(internal.autoTranslate._getBatchChunkPlan, {
      storeId, targetLang: "en", entityType: "products", cursor,
    })

    expect(next!.documents.map((d) => d.documentId)).toEqual([ids[2]])
  })

  test("refuses a caller with no rights on the establishment", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    await seedLanguages(t, theirs)
    const asOwner = await seedOwner(t, [mine])

    await expect(
      asOwner.action(api.autoTranslate.translateCatalogue, {
        storeId: theirs,
        targetLang: "en",
        entityType: "products",
      })
    ).rejects.toThrow(/Access denied|not authorized|permission/i)
  })

  test("refuses an anonymous caller", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedLanguages(t, storeId)

    await expect(
      t.action(api.autoTranslate.translateCatalogue, {
        storeId,
        targetLang: "en",
        entityType: "products",
      })
    ).rejects.toThrow(/Not authenticated/)
  })
})
