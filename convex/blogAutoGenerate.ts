"use node"

/**
 * Blog Auto Generate — Action (Node Runtime)
 *
 * "use node" allows fetch() to call OpenAI + Unsplash.
 * Contains ONLY the public action — internal functions live in
 * blogAutoGenerateInternal.ts (no "use node").
 *
 * Image pipeline:
 *   1. Unsplash (priority) — URL directe, attribution <img> + <p>
 *   2. GPT Image 1 Mini (fallback) — b64_json → S3 upload → processImage async
 */

import { v } from "convex/values"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import type { ActionCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { buildMediaUrl } from "@be-yours/core/aws/media-url"
import { resolveApprovalMode } from "@be-yours/convex-functions/blogAutoGuards"
import { sanitizeArticleHtml } from "@be-yours/convex-functions/htmlSanitize"

// ============================================================================
// S3 Helpers (same pattern as cmsMediaProcess.ts)
// ============================================================================

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

/**
 * The bucket is private: a key becomes either a CDN URL or a path on this
 * app's own `/api/files` proxy. One policy, in `@be-yours/core`.
 */
function buildPublicUrl(key: string): string {
  return buildMediaUrl(key, process.env.AWS_S3_PUBLIC_BASE_URL)
}

// ============================================================================
// Image Types
// ============================================================================

interface ImageResult {
  url: string
  alt: string
  source: "unsplash" | "openai"
  mediaId?: Id<"cmsMedia">
  photographerName?: string
  photographerUrl?: string
}

// ============================================================================
// Unsplash Fetch
// ============================================================================

type UnsplashPhoto = {
  urls: { regular: string; small: string }
  alt_description: string | null
  user: { name: string; links: { html: string } }
  links: { download_location: string }
}

async function searchUnsplashApi(
  query: string,
  accessKey: string,
  perPage = 10,
): Promise<UnsplashPhoto[]> {
  const params = new URLSearchParams({
    query,
    per_page: String(perPage),
    orientation: "landscape",
    order_by: "relevant",
  })
  const res = await fetch(
    `https://api.unsplash.com/search/photos?${params}`,
    { headers: { Authorization: `Client-ID ${accessKey}` } }
  )

  if (res.status === 429 || !res.ok) return []

  const data = (await res.json()) as { results: UnsplashPhoto[] }
  return data.results ?? []
}

async function fetchFromUnsplash(keyword: string): Promise<ImageResult | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY
  if (!accessKey) return null

  try {
    // Try full keyword first
    let results = await searchUnsplashApi(keyword, accessKey)

    // If no results, retry with simplified keyword (first 2-3 words)
    if (results.length === 0) {
      const simplified = keyword.split(/\s+/).slice(0, 3).join(" ")
      if (simplified !== keyword) {
        results = await searchUnsplashApi(simplified, accessKey)
      }
    }

    if (results.length === 0) return null

    // Random pick from top results for variety
    const photo = results[Math.floor(Math.random() * results.length)]
    if (!photo) return null

    // Trigger download tracking (Unsplash guideline)
    fetch(`${photo.links.download_location}?client_id=${accessKey}`).catch(() => {})

    return {
      url: photo.urls.regular,
      alt: photo.alt_description || keyword,
      source: "unsplash",
      photographerName: photo.user.name,
      photographerUrl: photo.user.links.html,
    }
  } catch (err) {
    console.error(`[blogAutoGenerate] Unsplash search failed for "${keyword}":`, err)
    return null
  }
}

// ============================================================================
// Download & Upload Image (for cover images from Unsplash)
// ============================================================================

async function downloadAndUploadImage(
  imageUrl: string,
  keyword: string,
  ctx: ActionCtx,
  storeId: Id<"stores">,
  ownerId: string,
): Promise<Id<"cmsMedia"> | null> {
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get("content-type") || "image/jpeg"
    const ext = contentType.includes("png") ? "png" : "jpg"
    const filename = `cover-${keyword.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50)}.${ext}`

    const mediaId: Id<"cmsMedia"> = await ctx.runMutation(
      internal.blogAutoGenerateInternal._createBlogImage,
      { storeId, filename, mimeType: contentType, size: buffer.length, uploadedBy: ownerId }
    )

    const s3Key = `cms/${mediaId}/source.${ext}`
    const client = createS3Client()
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME!,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
      })
    )

    await ctx.scheduler.runAfter(
      0,
      internal.cmsMediaProcess.processImage,
      { mediaId, s3Key, mimeType: contentType }
    )

    return mediaId
  } catch (err) {
    console.error(`[blogAutoGenerate] Image download/upload failed for "${keyword}":`, err)
    return null
  }
}

// ============================================================================
// GPT Image Fallback
// ============================================================================

/**
 * The paid image fallback, used up to four times per article.
 *
 * Every one of these calls was free of the image quota: `monthlyImageQuota`
 * existed, `checkImageGenerationAccess` read it, and this path never asked. A
 * plan with five images a month could produce forty across ten articles. The
 * slot is now taken before the call and handed back if nothing comes of it —
 * and running out of images returns null rather than throwing, because the
 * article itself is still worth having.
 */
async function generateWithOpenAI(
  keyword: string,
  caption: string,
  ctx: ActionCtx,
  storeId: Id<"stores">,
  ownerId: string,
): Promise<ImageResult | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  const reservation = await ctx.runMutation(
    internal.blogAutoGenerateInternal._reserveImageQuota,
    { ownerId }
  )
  if (!reservation.ok) {
    console.warn(
      `[blogAutoGenerate] image quota exhausted, skipping "${keyword}": ${reservation.reason}`
    )
    return null
  }

  let produced = false
  try {
    const prompt = `Photo professionnelle de cuisine/restaurant : ${keyword}. Style éditorial, lumière naturelle, pas de texte, pas de logo, pas de marque.`

    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
      }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      data: Array<{ b64_json: string }>
    }

    const b64 = data.data?.[0]?.b64_json
    if (!b64) return null

    const buffer = Buffer.from(b64, "base64")
    const filename = `blog-${keyword.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50)}`

    // Create cmsMedia record
    const mediaId: Id<"cmsMedia"> = await ctx.runMutation(
      internal.blogAutoGenerateInternal._createBlogImage,
      {
        storeId,
        filename: `${filename}.png`,
        mimeType: "image/png",
        size: buffer.length,
        uploadedBy: ownerId,
      }
    )

    // Upload to S3
    const s3Key = `cms/${mediaId}/source.png`
    const client = createS3Client()
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME!,
        Key: s3Key,
        Body: buffer,
        ContentType: "image/png",
      })
    )

    // Schedule sharp processing (thumb + card variants) async
    await ctx.scheduler.runAfter(
      0,
      internal.cmsMediaProcess.processImage,
      { mediaId, s3Key, mimeType: "image/png" }
    )

    // Return immediate source URL (variants arrive async)
    const sourceUrl = buildPublicUrl(s3Key)

    produced = true
    return {
      url: sourceUrl,
      alt: caption || keyword,
      source: "openai",
      mediaId,
    }
  } catch (err) {
    console.error(`[blogAutoGenerate] GPT image generation failed for "${keyword}":`, err)
    return null
  } finally {
    if (!produced) {
      await ctx.runMutation(
        internal.blogAutoGenerateInternal._releaseImageQuota,
        { ownerId }
      )
    }
  }
}

// ============================================================================
// Image Injection
// ============================================================================

/** Escape a string for safe use in HTML attributes */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function injectImages(content: string, images: (ImageResult | null)[]): string {
  for (let i = 0; i < images.length; i++) {
    const placeholder = `[IMAGE_${i + 1}]`
    const img = images[i]

    if (!img) {
      content = content.replace(placeholder, "")
      continue
    }

    const safeAlt = escapeAttr(img.alt)

    if (img.source === "unsplash" && img.photographerName && img.photographerUrl) {
      const safePhotographer = escapeAttr(img.photographerName)
      const safeUrl = escapeAttr(img.photographerUrl)
      const html = `<img src="${img.url}" alt="${safeAlt}" />\n<p><em>Photo : <a href="${safeUrl}?utm_source=beindigital&amp;utm_medium=referral" target="_blank" rel="noopener noreferrer">${safePhotographer}</a> — <a href="https://unsplash.com/?utm_source=beindigital&amp;utm_medium=referral" target="_blank" rel="noopener noreferrer">Unsplash</a></em></p>`
      content = content.replace(placeholder, html)
    } else {
      content = content.replace(placeholder, `<img src="${img.url}" alt="${safeAlt}" />`)
    }
  }
  // Remove any remaining placeholders
  content = content.replace(/\[IMAGE_\d+\]/g, "")
  return content
}

// ============================================================================
// Generation pipeline
// ============================================================================

/**
 * Everything one article costs, with the caller's authorisation already done.
 *
 * Two callers reach it: the "Generate with AI" button, which authorises through
 * the session, and `executeAutoBlogQueue`, which runs on a cron and has no
 * session at all — the establishment was authorised when the owner saved the
 * configuration. Neither has a copy of the other's prompt: this used to be the
 * action's own body, and a scheduler bolted alongside it would have been a
 * second one to keep in step.
 *
 * The quota is reserved by the caller, before this is entered, and released by
 * the caller if this throws.
 */
interface GenerationParams {
  storeId: Id<"stores">
  categoryId: Id<"blogCategories">
  ownerId: string
  topic: string
  tone: "formel" | "decontracte" | "storytelling"
  locale: string
  autoTranslate: boolean
  approvalMode: "draft_review" | "auto_publish"
  /** Set on the scheduled path, so the article and its queue row commit together. */
  jobId?: Id<"blogAutoQueue">
}

async function runGenerationPipeline(
  ctx: ActionCtx,
  params: GenerationParams,
): Promise<{ articleId: string; status: "draft" | "published" }> {
  // 3. Get store/category context for the prompt
  const context = await ctx.runQuery(
    internal.blogAutoGenerateInternal._getGenerationContext,
    { storeId: params.storeId, categoryId: params.categoryId }
  )

  // 4. Call OpenAI for text generation
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured")
  }

  const toneLabel =
    params.tone === "formel"
      ? "formel et professionnel"
      : params.tone === "decontracte"
        ? "décontracté et accessible"
        : "storytelling et immersif"

  const systemPrompt = `Tu es un expert SEO et redacteur de blog professionnel pour un restaurant.
Tu generes des articles de blog HAUTEMENT OPTIMISES pour le referencement naturel (SEO), en HTML compatible avec l'editeur Tiptap.

Regles generales :
- Ecris en ${params.locale}
- Ton : ${toneLabel}
- Le restaurant s'appelle "${context.storeName}"
- Categorie de l'article : "${context.categoryName}"

=== FORMAT HTML OBLIGATOIRE ===
- TOUT le contenu DOIT être dans des balises HTML valides
- Chaque paragraphe DOIT être enveloppé dans <p>...</p>
- Chaque titre de section DOIT utiliser <h2>...</h2>
- Chaque sous-titre DOIT utiliser <h3>...</h3>
- Les listes DOIVENT utiliser <ul><li>...</li></ul> ou <ol><li>...</li></ol>
- Les citations DOIVENT utiliser <blockquote><p>...</p></blockquote>
- Utiliser <strong> pour le gras et <em> pour l'italique a l'interieur des <p>
- NE JAMAIS ecrire de texte brut sans balise HTML
- Ne pas utiliser <h1> (le titre est separe du contenu)
- Ne pas utiliser <br> entre les paragraphes, utiliser des <p> separes
- Place les marqueurs [IMAGE_1], [IMAGE_2], [IMAGE_3] dans le contenu HTML, entre les sections
- Chaque marqueur doit être sur sa propre ligne ENTRE deux balises (ex: </p>[IMAGE_1]<h2>)
- Ne pas inclure de balises <img> (les images seront injectees automatiquement)

Exemple de structure HTML attendue :
<p>Introduction accrocheuse avec le mot-clé principal...</p>
[IMAGE_1]
<h2>Premier sous-titre optimisé SEO</h2>
<p>Paragraphe explicatif avec <strong>informations cles</strong>...</p>
<p>Deuxième paragraphe de la section...</p>
<h3>Sous-section détaillée</h3>
<ul><li>Élément de liste pertinent</li><li>Autre element</li></ul>
[IMAGE_2]
<h2>Deuxième section principale</h2>
<p>Contenu riche avec des <em>variations semantiques</em>...</p>
<blockquote><p>Citation ou fait marquant</p></blockquote>
[IMAGE_3]
<h2>Conclusion</h2>
<p>Paragraphe de conclusion avec appel a l'action...</p>

=== REGLES SEO STRICTES (PRIORITE MAXIMALE) ===

**Structure et longueur :**
- Article de 1200-1800 mots minimum (les articles longs rankent mieux sur Google)
- 4-6 sections avec sous-titres <h2>, et des <h3> pour les sous-sections
- Hierarchie stricte : <h2> pour les sections principales, <h3> pour les sous-points
- Premier paragraphe : inclure le MOT-CLE PRINCIPAL dans les 100 premiers mots
- Dernier paragraphe : conclusion avec rappel du mot-clé principal et appel a l'action

**Mots-cles et semantique :**
- Identifier 1 mot-clé principal + 3-5 mots-clés secondaires (LSI keywords) liés au sujet
- Mot-cle principal : dans le titre, le premier paragraphe, au moins 2 sous-titres <h2>, et la conclusion
- Densité du mot-clé principal : 1-2% naturellement (pas de keyword stuffing)
- Utiliser des synonymes et variations semantiques tout au long de l'article
- Inclure des termes LSI (Latent Semantic Indexing) liés a la thematique restaurant/cuisine

**Featured Snippets (Position Zero) :**
- Inclure au moins 1 liste <ul> ou <ol> de 5-8 items (Google adore les listes)
- Commencer au moins 1 section par une definition ou reponse directe a une question
- Utiliser des formats "Qu'est-ce que...", "Comment...", "Pourquoi..." dans les <h2> quand pertinent
- Ajouter un paragraphe court (40-60 mots) apres chaque <h2> qui repond directement a la question du sous-titre

**Engagement et lisibilite :**
- Paragraphes courts (3-4 phrases max) pour faciliter la lecture mobile
- Utiliser <strong> pour mettre en evidence les informations cles (2-3 par section)
- Alterner paragraphes, listes et citations pour varier le rythme
- Inclure des données chiffrées, statistiques ou faits concrets quand possible
- Utiliser des questions rhetoriques pour maintenir l'engagement du lecteur

**Liens internes (suggestions) :**
- Dans le contenu, suggerer naturellement 2-3 sujets connexes que le lecteur pourrait explorer
- Formuler sous forme de phrases comme "Découvrez aussi nos..." ou "Pour en savoir plus sur..."

Reponds en JSON strict :
{
  "title": "...",
  "excerpt": "...(max 160 caractères)...",
  "content": "<p>...</p>[IMAGE_1]<h2>...</h2>...[IMAGE_2]...[IMAGE_3]...",
  "metaTitle": "...(max 60 caractères, optimisé SEO)...",
  "metaDescription": "...(max 160 caractères, optimisé SEO, avec mots-clés pertinents)...",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "coverImageKeyword": "keyword in english for cover image",
  "coverImageAlt": "description alt de l'image de couverture dans la langue de l'article",
  "imageKeywords": ["keyword1 in english", "keyword2 in english", "keyword3 in english"],
  "imageCaptions": ["legende 1 dans la langue de l'article", "legende 2", "legende 3"]
}

Regles pour le SEO des metadonnees :
- title : inclure le mot-clé principal, accrocheur, inciter au clic (50-70 caractères)
- metaTitle : différent du titre si possible, max 60 caractères, mot-clé principal au debut
- metaDescription : max 160 caractères, mot-clé principal, bénéfice clair, appel a l'action (verbe d'action)
- excerpt : résumé engageant qui donne envie de lire, avec le mot-clé principal
- tags : 4-6 tags pertinents en ${params.locale}, incluant le mot-clé principal et des variations

Regles pour l'image de couverture :
- coverImageKeyword : 1 mot-clé EN ANGLAIS pour l'image de couverture, TRÈS visuel et accrocheur
- coverImageAlt : description alt dans la langue de l'article, max 125 caractères, incluant le mot-clé principal

Regles STRICTES pour les images du contenu :
- imageKeywords : 3 mots-clés EN ANGLAIS, TRÈS SPECIFIQUES au sujet exact de l'article
- Chaque keyword DOIT inclure la cuisine, la culture, le pays ou le plat specifique mentionne dans l'article
- MAUVAIS exemples : "african food", "traditional dish", "restaurant interior", "fresh ingredients"
- BON exemples : "senegalese thieboudienne rice fish dish", "moroccan tagine lamb couscous", "japanese sushi chef preparation", "italian wood-fired pizza margherita"
- Les keywords doivent être suffisamment précis pour trouver des photos pertinentes sur une banque d'images
- imageCaptions : 3 légendes courtes dans la langue de l'article, en rapport direct avec le contenu, incluant des mots-clés
- Pas de logos, marques ou noms commerciaux dans les keywords`

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Ecris un article sur : ${params.topic}` },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI API error: ${response.status} ${response.statusText}`
    )
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }

  const rawContent = data.choices[0]?.message?.content?.trim()
  if (!rawContent) {
    throw new Error("OpenAI returned empty response")
  }

  // 5. Parse JSON response
  let generated: {
    title: string
    excerpt: string
    content: string
    metaTitle?: string
    metaDescription?: string
    tags?: string[]
    coverImageKeyword?: string
    coverImageAlt?: string
    imageKeywords?: string[]
    imageCaptions?: string[]
  }
  try {
    const cleaned = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim()
    generated = JSON.parse(cleaned)
  } catch {
    throw new Error("Failed to parse AI response as JSON")
  }

  if (!generated.title || !generated.content) {
    throw new Error("AI response missing required fields (title, content)")
  }

  // 6. Fetch cover image (dedicated, separate from content images)
  let coverImageId: Id<"cmsMedia"> | undefined
  const coverImageAlt = generated.coverImageAlt ?? ""
  if (generated.coverImageKeyword) {
    const coverImg = await fetchFromUnsplash(generated.coverImageKeyword)
    if (coverImg) {
      // For Unsplash cover: download and upload to S3 as cmsMedia for proper reference
      const coverMediaId = await downloadAndUploadImage(
        coverImg.url, generated.coverImageKeyword, ctx, params.storeId, params.ownerId
      )
      if (coverMediaId) coverImageId = coverMediaId
    }
    if (!coverImageId) {
      // Fallback: generate cover with GPT Image
      const gptCover = await generateWithOpenAI(
        generated.coverImageKeyword, coverImageAlt, ctx, params.storeId, params.ownerId
      )
      if (gptCover?.mediaId) {
        coverImageId = gptCover.mediaId
      }
    }
  }

  // 7. Fetch content images (Unsplash priority, GPT Image fallback)
  const keywords = generated.imageKeywords ?? []
  const captions = generated.imageCaptions ?? []
  const images: (ImageResult | null)[] = []

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]
    if (!keyword) continue
    const caption = captions[i] ?? keyword

    // Try Unsplash first
    let img = await fetchFromUnsplash(keyword)

    // Fallback to GPT Image
    if (!img) {
      img = await generateWithOpenAI(keyword, caption, ctx, params.storeId, params.ownerId)
    }

    images.push(img)
  }

  // 8. Inject images into HTML content
  let finalContent = injectImages(generated.content, images)

  // 9. Sanitize HTML — the shared allow-list, not a copy of it. This file
  //    used to carry its own, which is how the two could have drifted.
  finalContent = sanitizeArticleHtml(finalContent)

  // 10. Save the article, publishing it only where the plan allows.
  const saved: { articleId: string; status: "draft" | "published" } =
    await ctx.runMutation(
      internal.blogAutoGenerateInternal._saveGeneratedArticle,
      {
        storeId: params.storeId,
        ownerId: params.ownerId,
        title: generated.title,
        excerpt: generated.excerpt || "",
        content: finalContent,
        categoryId: params.categoryId,
        authorId: params.ownerId,
        coverImageId,
        coverImageAlt: coverImageAlt || undefined,
        metaTitle: generated.metaTitle || undefined,
        metaDescription: generated.metaDescription || undefined,
        tags: generated.tags,
        autoTranslate: params.autoTranslate,
        approvalMode: params.approvalMode,
      }
    )

  return saved
}

// ============================================================================
// Public Action
// ============================================================================

/**
 * Generate a blog article using AI with images.
 * 1. OpenAI text → { title, excerpt, content, imageKeywords, imageCaptions }
 * 2. For each keyword: Unsplash (priority) → GPT Image (fallback)
 * 3. Inject images, sanitize HTML, save draft
 */
// @guarded-inline: _reserveQuota checks content:write on this store, then the plan
export const generateArticle = action({
  args: {
    storeId: v.id("stores"),
    topic: v.string(),
    tone: v.union(
      v.literal("formel"),
      v.literal("decontracte"),
      v.literal("storytelling")
    ),
    locale: v.string(),
    categoryId: v.id("blogCategories"),
    autoTranslate: v.optional(v.boolean()),
    approvalMode: v.optional(
      v.union(v.literal("draft_review"), v.literal("auto_publish")),
    ),
  },
  handler: async (ctx, args): Promise<{ articleId: string; status: "draft" | "published" }> => {
    // 1. Auth check
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    const ownerId = identity.subject

    // 1b. Input validation
    if (args.topic.length > 500) throw new Error("Topic trop long (max 500 caractères)")
    if (args.locale.length > 10) throw new Error("Locale invalide")

    // 2. Authorise the establishment, and read what the plan allows. The store
    //    was previously absent from this check, so a plan holder could write
    //    into any restaurant in the deployment.
    const access = await ctx.runQuery(
      internal.blogAutoGenerateInternal._checkAccess,
      { storeId: args.storeId }
    )
    if (!access.allowed) {
      throw new Error(access.reason ?? "Accès refusé")
    }

    // 2b. The multi-language gate was a disabled <Switch> and nothing else:
    //     `autoTranslate` arrived as an argument and was obeyed. The spec
    //     (tasks/auto-blog-spec.md §5.2) reserves it for Enterprise.
    const entitlements = access.entitlements
    const autoTranslate = args.autoTranslate ?? false
    if (autoTranslate && !entitlements?.autoBlog?.allowMultiLanguage) {
      throw new Error(
        "La traduction automatique n'est pas disponible avec votre plan. Passez au plan Enterprise."
      )
    }

    // 2c. Reserve the article slot BEFORE the first paid call. Checking the
    //     quota and incrementing it after the generation left a window several
    //     minutes wide: ten concurrent requests all read the same count and all
    //     passed, measured at ten articles against a quota of two — every one
    //     of them billed. The reservation reads and writes in one transaction.
    const reservation = await ctx.runMutation(
      internal.blogAutoGenerateInternal._reserveQuota,
      { storeId: args.storeId }
    )
    if (!reservation.ok) {
      throw new Error(reservation.reason ?? "Quota mensuel atteint")
    }

    // Everything below this point can fail, and a failure must not cost the
    // owner the slot it just took.
    try {
      return await runGenerationPipeline(ctx, {
        storeId: args.storeId,
        categoryId: args.categoryId,
        ownerId,
        topic: args.topic,
        tone: args.tone,
        locale: args.locale,
        autoTranslate,
        approvalMode: resolveApprovalMode(entitlements, args.approvalMode),
      })
    } catch (error) {
      await ctx.runMutation(
        internal.blogAutoGenerateInternal._releaseQuota,
        { ownerId }
      )
      throw error
    }
  },
})

// ============================================================================
// Scheduled execution
// ============================================================================

/**
 * How many jobs one sweep will take on.
 *
 * A generation is several minutes of OpenAI, and Convex bounds how long an
 * action may run. Five is a batch a ten-minute sweep finishes comfortably; the
 * rest wait for the next one, which is what a queue is for.
 */
const QUEUE_BATCH_SIZE = 5

/**
 * Every 10 minutes: generate the articles the planner queued.
 *
 * No session, so no `api.*` and no guarded wrapper — the store was authorised
 * when the owner saved the configuration. A job that throws is recorded on its
 * own row and the sweep carries on: one restaurant's bad prompt must not stop
 * every other restaurant's article.
 */
export const executeAutoBlogQueue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ claimed: number; generated: number; failed: number }> => {
    // The package layer works in plain strings — it has no generated
    // `dataModel` to import — so the ids are branded back here.
    const dueIds: string[] = await ctx.runQuery(
      internal.blogAutoPlanner._dueJobIds,
      { limit: QUEUE_BATCH_SIZE }
    )
    const jobIds = dueIds as Id<"blogAutoQueue">[]

    let claimed = 0
    let generated = 0
    let failed = 0

    for (const jobId of jobIds) {
      const job = await ctx.runMutation(internal.blogAutoPlanner._claimJob, { jobId })
      // Another sweep took it, the config was switched off, or the
      // subscription lapsed. `_claimJob` has already recorded which.
      if (!job) continue
      claimed++

      // A configuration with no default category cannot produce an article:
      // `createArticleCore` needs one. That is a setup problem, not a transient
      // one, so it burns a retry and eventually fails rather than looping.
      if (!job.categoryId) {
        await ctx.runMutation(internal.blogAutoPlanner._failJob, {
          jobId,
          errorCode: "no_category",
          errorMessage: "Aucune catégorie par défaut n'est configurée pour le blog automatique.",
        })
        failed++
        continue
      }

      // The same bounds the button applies. `themes` and `primaryLocale` are
      // free strings on the configuration row, and a prompt is billed by its
      // length — the scheduled path must not be the cheap way round the check.
      if (job.theme.length > 500 || job.locale.length > 10) {
        await ctx.runMutation(internal.blogAutoPlanner._failJob, {
          jobId,
          errorCode: "invalid_config",
          errorMessage: "La thématique ou la langue configurée dépasse la longueur autorisée.",
        })
        failed++
        continue
      }

      const reservation = await ctx.runMutation(
        internal.blogAutoGenerateInternal._reserveQuotaForOwner,
        { ownerId: job.ownerId }
      )
      if (!reservation.ok) {
        await ctx.runMutation(internal.blogAutoPlanner._failJob, {
          jobId,
          errorCode: "quota_exhausted",
          errorMessage: reservation.reason ?? "Quota mensuel atteint",
        })
        failed++
        continue
      }

      try {
        // The job id travels with the request: `_saveGeneratedArticle` writes
        // the article and completes the queue row in one transaction, so there
        // is no window in which the article exists and the job still says
        // `generating` — which is what the recovery sweep would have retried.
        await runGenerationPipeline(ctx, {
          storeId: job.storeId as Id<"stores">,
          categoryId: job.categoryId as Id<"blogCategories">,
          ownerId: job.ownerId,
          topic: job.theme,
          tone: job.tone,
          locale: job.locale,
          autoTranslate: job.autoTranslate,
          approvalMode: job.approvalMode,
          jobId,
        })
        generated++
      } catch (error) {
        await ctx.runMutation(
          internal.blogAutoGenerateInternal._releaseQuota,
          { ownerId: job.ownerId }
        )
        await ctx.runMutation(internal.blogAutoPlanner._failJob, {
          jobId,
          errorCode: "generation_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        failed++
      }
    }

    return { claimed, generated, failed }
  },
})
