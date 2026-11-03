/**
 * Blog Auto-Translation
 *
 * Schedules automatic GPT translation for blog article text fields
 * after each draft save. Uses debounce + cancel + staleness check.
 *
 * Architecture (Convex constraint: mutations cannot fetch):
 *   scheduleBlogTranslation()  → helper called from saveDraft (mutation ctx)
 *   _getBlogTranslationData    → internalQuery  (reads article + languages)
 *   executeBlogTranslation     → internalAction (orchestrates: query → fetch → mutation)
 *   _saveBlogTranslations      → internalMutation (upserts translations, clears job)
 */

import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import type { Id } from "./_generated/dataModel"
import {
  DEBOUNCE_MS,
  MAX_TRANSLATION_TEXT_LENGTH,
} from "@be-yours/convex-functions/autoTranslate"

// ── Helper: schedule blog translation with debounce ─────────────────

/**
 * Schedule translation for a blog article after save.
 * Called from saveDraft via onAfterSave callback.
 *
 * - Cancels any previously scheduled job for this article
 * - Schedules new translation after DEBOUNCE_MS
 * - Saves the job ID on the article for cancel tracking
 */
export async function scheduleBlogTranslation(
  ctx: MutationCtx,
  articleId: string,
  storeId: string,
): Promise<void> {
  const typedArticleId = articleId as Id<"blogArticles">
  const typedStoreId = storeId as Id<"stores">
  const article = await ctx.db.get(typedArticleId)
  if (!article) return

  // Check if article has translatable text content
  const draft = article.draftContent
  if (!draft) return

  const hasText =
    draft.title?.trim() ||
    draft.excerpt?.trim() ||
    draft.content?.trim() ||
    draft.metaTitle?.trim() ||
    draft.metaDescription?.trim()

  if (!hasText) return

  // Cancel previous scheduled job
  if (article.scheduledTranslationJobId) {
    try {
      await ctx.scheduler.cancel(article.scheduledTranslationJobId)
    } catch {
      // Job already executed or cancelled
    }
  }

  // Schedule new translation after debounce
  const jobId = await ctx.scheduler.runAfter(
    DEBOUNCE_MS,
    internal.blogAutoTranslate.executeBlogTranslation,
    {
      articleId: typedArticleId,
      storeId: typedStoreId,
      scheduledAt: article.updatedAt,
    },
  )

  // Save job ID on the article for cancel tracking
  await ctx.db.patch(typedArticleId, {
    scheduledTranslationJobId: jobId,
  })
}

// ── Internal query: gather translation data ───────────────────────────

export const _getBlogTranslationData = internalQuery({
  args: {
    articleId: v.id("blogArticles"),
    storeId: v.id("stores"),
    scheduledAt: v.number(),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId)

    // Staleness check: if article was re-edited since schedule, abandon
    if (!article || article.updatedAt !== args.scheduledAt) {
      return null
    }

    const draft = article.draftContent
    if (!draft) return null

    // Get active languages
    const allLanguages = await ctx.db
      .query("languages")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .withIndex("by_storeId", (q: any) => q.eq("storeId", args.storeId))
      .collect()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultLang = allLanguages.find((l: any) => l.isDefault)
    const targetLanguages = allLanguages.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l: any) => l.isActive && !l.isDefault,
    )

    if (!defaultLang || targetLanguages.length === 0) return null

    // Collect translatable text fields
    const textsToTranslate: Array<{
      fieldKey: string
      text: string
    }> = []

    if (draft.title?.trim()) {
      textsToTranslate.push({ fieldKey: "title", text: draft.title })
    }
    if (draft.excerpt?.trim()) {
      textsToTranslate.push({ fieldKey: "excerpt", text: draft.excerpt })
    }
    if (draft.content?.trim()) {
      // Strip HTML from Tiptap content
      const stripped = stripHtml(draft.content)
      if (stripped) {
        textsToTranslate.push({ fieldKey: "content", text: stripped })
      }
    }
    if (draft.metaTitle?.trim()) {
      textsToTranslate.push({ fieldKey: "metaTitle", text: draft.metaTitle })
    }
    if (draft.metaDescription?.trim()) {
      textsToTranslate.push({
        fieldKey: "metaDescription",
        text: draft.metaDescription,
      })
    }

    if (textsToTranslate.length === 0) return null

    return {
      sourceLang: defaultLang.code ?? "fr",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      targetLanguages: targetLanguages.map((l: any) => l.code as string),
      textsToTranslate,
      context: `blog article "${draft.title}"`,
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
          content: `You are a professional translator for a restaurant blog. Translate from ${sourceLang} to ${targetLang}. Context: ${context}. Only return the translated text, nothing else. Do not add any HTML tags or formatting.`,
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

export const executeBlogTranslation = internalAction({
  args: {
    articleId: v.id("blogArticles"),
    storeId: v.id("stores"),
    scheduledAt: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Gather translation data
    const data = await ctx.runQuery(
      internal.blogAutoTranslate._getBlogTranslationData,
      {
        articleId: args.articleId,
        storeId: args.storeId,
        scheduledAt: args.scheduledAt,
      },
    )

    if (!data) return

    // 2. Get API key
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error("[blogAutoTranslate] OPENAI_API_KEY not set")
      return
    }

    // 3. Translate each field for each target language
    const translations: Array<{
      fieldKey: string
      languageCode: string
      value: string
    }> = []

    for (const langCode of data.targetLanguages) {
      for (const { fieldKey, text } of data.textsToTranslate) {
        try {
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
            `[blogAutoTranslate] Failed to translate ${fieldKey} to ${langCode}:`,
            error,
          )
        }
      }
    }

    if (translations.length === 0) return

    // 4. Save translations to DB
    await ctx.runMutation(
      internal.blogAutoTranslate._saveBlogTranslations,
      {
        articleId: args.articleId,
        storeId: args.storeId,
        translations,
      },
    )
  },
})

// ── Internal mutation: save translations + clear job ID ───────────────

export const _saveBlogTranslations = internalMutation({
  args: {
    articleId: v.id("blogArticles"),
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
    const article = await ctx.db.get(args.articleId)
    if (article) {
      await ctx.db.patch(args.articleId, {
        scheduledTranslationJobId: undefined,
      })
    }

    // Upsert each translation
    for (const t of args.translations) {
      const existing = await ctx.db
        .query("translations")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_storeId_entity", (q: any) =>
          q
            .eq("storeId", args.storeId)
            .eq("entityType", "blogArticleDraft")
            .eq("entityId", args.articleId),
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((q: any) =>
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
          entityType: "blogArticleDraft",
          entityId: args.articleId as string,
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
