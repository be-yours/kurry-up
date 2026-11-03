/**
 * CMS Auto-Translation
 *
 * Schedules automatic GPT translation for CMS block text/richtext fields
 * after each draft save. Uses debounce + cancel + staleness check.
 *
 * Architecture (Convex constraint: mutations cannot fetch):
 *   scheduleCmsTranslation()  → helper called from saveDraftBlock (mutation ctx)
 *   _getCmsTranslationData    → internalQuery  (reads block + languages)
 *   executeCmsTranslation     → internalAction (orchestrates: query → fetch → mutation)
 *   _saveCmsTranslations      → internalMutation (upserts translations, clears job)
 */

// Initialize CMS registry (must run before any handler)
import { setCmsRegistry } from "@be-yours/cms"
import { appCmsConfig } from "../cms"
setCmsRegistry(appCmsConfig)

import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import type { Id } from "./_generated/dataModel"
import { getBlockDefinition, getPageDefinition } from "@be-yours/cms"
import {
  DEBOUNCE_MS,
  MAX_TRANSLATION_TEXT_LENGTH,
} from "@be-yours/convex-functions/autoTranslate"

// ── Helper: schedule CMS translation with debounce ────────────────────

/**
 * Schedule translation for a CMS block after save.
 * Called from saveDraftBlock via onAfterSave callback.
 *
 * - Cancels any previously scheduled job for this block
 * - Schedules new translation after DEBOUNCE_MS
 * - Saves the job ID on the block for cancel tracking
 */
export async function scheduleCmsTranslation(
  ctx: MutationCtx,
  blockId: string,
  storeId: string,
): Promise<void> {
  const typedBlockId = blockId as Id<"cmsBlocks">
  const typedStoreId = storeId as Id<"stores">
  const block = await ctx.db.get(typedBlockId)
  if (!block) return

  // Check if block has any translatable text fields
  const blockDef = getBlockDefinition(block.pageSlug, block.blockKey)
  if (!blockDef) return

  const hasTranslatableText = Object.entries(blockDef.fields).some(
    ([fieldKey, fieldDef]) => {
      if (fieldDef.translatable === false) return false
      if (fieldDef.type !== "text" && fieldDef.type !== "richtext") return false
      const value = block.values[fieldKey]
      return value && !value.isCleared && value.textValue
    },
  )

  if (!hasTranslatableText) return

  // Cancel previous scheduled job
  if (block.scheduledTranslationJobId) {
    try {
      await ctx.scheduler.cancel(block.scheduledTranslationJobId)
    } catch {
      // Job already executed or cancelled
    }
  }

  // Schedule new translation after debounce
  const jobId = await ctx.scheduler.runAfter(
    DEBOUNCE_MS,
    internal.cmsAutoTranslate.executeCmsTranslation,
    {
      blockId: typedBlockId,
      storeId: typedStoreId,
      scheduledAt: block.updatedAt,
    },
  )

  // Save job ID on the block for cancel tracking
  await ctx.db.patch(typedBlockId, {
    scheduledTranslationJobId: jobId,
  })
}

// ── Internal query: gather translation data ───────────────────────────

export const _getCmsTranslationData = internalQuery({
  args: {
    blockId: v.id("cmsBlocks"),
    storeId: v.id("stores"),
    scheduledAt: v.number(),
  },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId)

    // Staleness check: if block was re-edited since schedule, abandon
    if (!block || block.updatedAt !== args.scheduledAt) {
      return null
    }

    // Get block definition to know which fields are translatable
    const blockDef = getBlockDefinition(block.pageSlug, block.blockKey)
    if (!blockDef) return null

    // Get active languages
    const allLanguages = await ctx.db
      .query("languages")
      .withIndex("by_storeId", (q) => q.eq("storeId", args.storeId))
      .collect()

    const defaultLang = allLanguages.find((l) => l.isDefault)
    const targetLanguages = allLanguages.filter(
      (l) => l.isActive && !l.isDefault,
    )

    if (!defaultLang || targetLanguages.length === 0) return null

    // Collect translatable text fields
    const textsToTranslate: Array<{
      fieldKey: string
      text: string
    }> = []

    for (const [fieldKey, fieldDef] of Object.entries(blockDef.fields)) {
      if (fieldDef.translatable === false) continue
      if (fieldDef.type !== "text" && fieldDef.type !== "richtext") continue

      const value = block.values[fieldKey]
      if (!value || value.isCleared || !value.textValue) continue

      textsToTranslate.push({
        fieldKey,
        text: value.textValue,
      })
    }

    if (textsToTranslate.length === 0) return null

    return {
      sourceLang: defaultLang.code ?? "fr",
      targetLanguages: targetLanguages.map((l) => l.code),
      textsToTranslate,
      context: `${block.pageSlug} page, ${block.blockKey} section`,
    }
  },
})

// ── Internal action: orchestrate translation (fetch allowed here) ─────

function stripHtml(html: string): string {
  // TWO passes and a tail, because `replace(/<[^>]*>/g, "")` on its own is not
  // tag removal — it is tag removal once, over well-formed tags only.
  //
  //   `<scr<x>ipt>`   removing the inner match splices its neighbours back
  //                   together, so a second pass is needed to see the result
  //   `<script src=x` never matches the pattern AT ALL — there is no closing
  //                   `>` — so the single-pass form hands back, untouched, the
  //                   exact string it was asked to remove
  //
  // The loop settles the first. The tail settles the second: after the loop no
  // `<` can have a `>` anywhere after it (the loop would have eaten that pair),
  // so every surviving `<` opens a tag that never closed and the rest of the
  // string belongs to it. The input is Tiptap's own HTML, where a literal `<`
  // is always `&lt;`, so nothing legitimate is lost.
  let previous: string
  let current = html
  do {
    previous = current
    current = current.replace(/<[^>]*>/g, "")
  } while (current !== previous)

  return current.replace(/<[^>]*$/, "").trim()
}

async function translateViaGPT(
  text: string,
  sourceLang: string,
  targetLang: string,
  context: string,
  apiKey: string,
): Promise<string> {
  if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
    throw new Error(
      `Text too long for translation: ${text.length} characters (max ${MAX_TRANSLATION_TEXT_LENGTH})`,
    )
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You are a professional translator for a restaurant website CMS. Translate from ${sourceLang} to ${targetLang}. Context: ${context}. Only return the translated text, nothing else. Do not add any HTML tags or formatting.`,
        },
        { role: "user", content: text },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI API error: ${response.status} ${response.statusText}`,
    )
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  return data.choices[0]?.message?.content?.trim() ?? ""
}

export const executeCmsTranslation = internalAction({
  args: {
    blockId: v.id("cmsBlocks"),
    storeId: v.id("stores"),
    scheduledAt: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Gather translation data (query — reads DB)
    const data = await ctx.runQuery(
      internal.cmsAutoTranslate._getCmsTranslationData,
      {
        blockId: args.blockId,
        storeId: args.storeId,
        scheduledAt: args.scheduledAt,
      },
    )

    if (!data) return

    // 2. Get API key
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error("[cmsAutoTranslate] OPENAI_API_KEY not set")
      return
    }

    // 3. Translate each field for each target language (fetch — HTTP calls)
    const translations: Array<{
      fieldKey: string
      languageCode: string
      value: string
    }> = []

    for (const langCode of data.targetLanguages) {
      for (const { fieldKey, text } of data.textsToTranslate) {
        try {
          // Always strip HTML — translations store plain text only
          const textToSend = stripHtml(text)
          if (!textToSend) continue

          const translated = await translateViaGPT(
            textToSend,
            data.sourceLang,
            langCode,
            data.context,
            apiKey,
          )

          if (translated) {
            translations.push({
              fieldKey,
              languageCode: langCode,
              value: translated,
            })
          }
        } catch (error) {
          console.error(
            `[cmsAutoTranslate] Failed to translate ${fieldKey} to ${langCode}:`,
            error,
          )
        }
      }
    }

    if (translations.length === 0) return

    // 4. Save translations to DB (mutation — writes DB)
    await ctx.runMutation(
      internal.cmsAutoTranslate._saveCmsTranslations,
      {
        blockId: args.blockId,
        storeId: args.storeId,
        translations,
      },
    )
  },
})

// ── Internal mutation: save translations + clear job ID ───────────────

export const _saveCmsTranslations = internalMutation({
  args: {
    blockId: v.id("cmsBlocks"),
    storeId: v.id("stores"),
    translations: v.array(
      v.object({
        fieldKey: v.string(),
        languageCode: v.string(),
        value: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    // Clear the scheduled job reference
    const block = await ctx.db.get(args.blockId)
    if (block) {
      await ctx.db.patch(args.blockId, {
        scheduledTranslationJobId: undefined,
      })
    }

    // Upsert each translation
    for (const t of args.translations) {
      const existing = await ctx.db
        .query("translations")
        .withIndex("by_storeId_entity", (q) =>
          q
            .eq("storeId", args.storeId)
            .eq("entityType", "cms")
            .eq("entityId", args.blockId),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("languageCode"), t.languageCode),
            q.eq(q.field("field"), t.fieldKey),
          ),
        )
        .first()

      if (existing) {
        await ctx.db.patch(existing._id, {
          value: t.value,
          isAutoTranslated: true,
          updatedAt: now,
        })
      } else {
        await ctx.db.insert("translations", {
          storeId: args.storeId,
          entityType: "cms",
          entityId: args.blockId,
          field: t.fieldKey,
          languageCode: t.languageCode,
          value: t.value,
          isAutoTranslated: true,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  },
})

// ── Page-level bulk translation ───────────────────────────────────────

/**
 * Schedule translation for ALL blocks of a CMS page.
 * Called from translateAllPageFields mutation.
 *
 * - Cancels any per-block scheduled jobs
 * - Marks all draft blocks as translating
 * - Schedules a single executePageTranslation action
 */
export async function schedulePageTranslation(
  ctx: MutationCtx,
  storeId: string,
  pageSlug: string,
): Promise<void> {
  const typedStoreId = storeId as Id<"stores">

  const draftBlocks = await ctx.db
    .query("cmsBlocks")
    .withIndex("by_storeId_pageSlug", (q) =>
      q.eq("storeId", typedStoreId).eq("pageSlug", pageSlug),
    )
    .filter((q) => q.eq(q.field("isDraft"), true))
    .collect()

  // Schedule page translation immediately (no debounce)
  const jobId = await ctx.scheduler.runAfter(
    0,
    internal.cmsAutoTranslate.executePageTranslation,
    {
      storeId: typedStoreId,
      pageSlug,
    },
  )

  // Mark all draft blocks as translating + cancel existing per-block jobs
  for (const block of draftBlocks) {
    if (block.scheduledTranslationJobId) {
      try {
        await ctx.scheduler.cancel(block.scheduledTranslationJobId)
      } catch {
        // Already executed or cancelled
      }
    }
    await ctx.db.patch(block._id, { scheduledTranslationJobId: jobId })
  }
}

// ── Internal query: gather ALL translation data for a page ────────────

export const _getPageTranslationData = internalQuery({
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const pageDef = getPageDefinition(args.pageSlug)
    if (!pageDef) return null

    const allBlocks = await ctx.db
      .query("cmsBlocks")
      .withIndex("by_storeId_pageSlug", (q) =>
        q.eq("storeId", args.storeId).eq("pageSlug", args.pageSlug),
      )
      .collect()

    const allLanguages = await ctx.db
      .query("languages")
      .withIndex("by_storeId", (q) => q.eq("storeId", args.storeId))
      .collect()

    const defaultLang = allLanguages.find((l) => l.isDefault)
    const targetLanguages = allLanguages.filter(
      (l) => l.isActive && !l.isDefault,
    )

    if (!defaultLang || targetLanguages.length === 0) return null

    const blocksToTranslate: Array<{
      blockId: string
      blockKey: string
      texts: Array<{ fieldKey: string; text: string }>
    }> = []

    for (const blockDef of pageDef.blocks) {
      // Prefer draft, fallback to published
      const draft = allBlocks.find(
        (b) => b.blockKey === blockDef.key && b.isDraft,
      )
      const published = allBlocks.find(
        (b) => b.blockKey === blockDef.key && !b.isDraft,
      )
      const block = draft ?? published
      if (!block) continue

      const texts: Array<{ fieldKey: string; text: string }> = []
      for (const [fieldKey, fieldDef] of Object.entries(blockDef.fields)) {
        if (fieldDef.translatable === false) continue
        if (fieldDef.type !== "text" && fieldDef.type !== "richtext") continue
        const value = block.values[fieldKey]
        if (!value || value.isCleared || !value.textValue) continue
        texts.push({ fieldKey, text: value.textValue })
      }

      if (texts.length > 0) {
        blocksToTranslate.push({
          blockId: block._id,
          blockKey: blockDef.key,
          texts,
        })
      }
    }

    if (blocksToTranslate.length === 0) return null

    return {
      sourceLang: defaultLang.code ?? "fr",
      targetLanguages: targetLanguages.map((l) => l.code),
      blocksToTranslate,
    }
  },
})

// ── Internal action: translate ALL text fields for a page ─────────────

export const executePageTranslation = internalAction({
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const data = await ctx.runQuery(
        internal.cmsAutoTranslate._getPageTranslationData,
        {
          storeId: args.storeId,
          pageSlug: args.pageSlug,
        },
      )

      if (!data) return

      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        console.error("[cmsAutoTranslate] OPENAI_API_KEY not set")
        return
      }

      for (const block of data.blocksToTranslate) {
        const translations: Array<{
          fieldKey: string
          languageCode: string
          value: string
        }> = []

        for (const langCode of data.targetLanguages) {
          for (const { fieldKey, text } of block.texts) {
            try {
              const textToSend = stripHtml(text)
              if (!textToSend) continue

              const translated = await translateViaGPT(
                textToSend,
                data.sourceLang,
                langCode,
                `${args.pageSlug} page, ${block.blockKey} section`,
                apiKey,
              )

              if (translated) {
                translations.push({
                  fieldKey,
                  languageCode: langCode,
                  value: translated,
                })
              }
            } catch (error) {
              console.error(
                `[cmsAutoTranslate] Page translate failed: ${block.blockKey}.${fieldKey} → ${langCode}:`,
                error,
              )
            }
          }
        }

        if (translations.length > 0) {
          await ctx.runMutation(
            internal.cmsAutoTranslate._saveCmsTranslations,
            {
              blockId: block.blockId as Id<"cmsBlocks">,
              storeId: args.storeId,
              translations,
            },
          )
        }
      }
    } finally {
      // Always clear remaining translation flags
      await ctx.runMutation(
        internal.cmsAutoTranslate._clearPageTranslationFlags,
        {
          storeId: args.storeId,
          pageSlug: args.pageSlug,
        },
      )
    }
  },
})

// ── Internal mutation: clear translation flags for a page ─────────────

export const _clearPageTranslationFlags = internalMutation({
  args: {
    storeId: v.id("stores"),
    pageSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("cmsBlocks")
      .withIndex("by_storeId_pageSlug", (q) =>
        q.eq("storeId", args.storeId).eq("pageSlug", args.pageSlug),
      )
      .collect()

    for (const block of blocks) {
      if (block.scheduledTranslationJobId) {
        await ctx.db.patch(block._id, {
          scheduledTranslationJobId: undefined,
        })
      }
    }
  },
})
