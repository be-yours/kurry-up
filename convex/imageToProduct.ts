"use node"

import { action } from "./_generated/server"
import { internal, api } from "./_generated/api"
import { v } from "convex/values"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import sharp from "sharp"
import {
  singleProductVisionSchema,
  menuVisionResultSchema,
  enrichmentResultSchema,
} from "@be-yours/convex-schema/validators"
import type {
  ProductSuggestion,
  AnalyzeImageResult,
  AiField,
  ParsingWarning,
} from "@be-yours/convex-schema/types"
import { buildMediaUrl, mediaKeyFromUrl } from "@be-yours/core/aws/media-url"
import { fetchPublicUrl, parsePublicUrl } from "@be-yours/core/net/public-url"
import { promises as dns } from "node:dns"
import {
  ALLERGEN_KIND,
  KNOWN_ALLERGENS,
  resolveAllergens,
} from "@be-yours/core/allergens"

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DIMENSION = 2048
const MIN_RESOLUTION_FOR_UPSCALE = 800
const IMAGE_GEN_BATCH_SIZE = 5
const MAX_PRODUCTS_PER_ANALYSIS = 30
const MAX_IMAGES_TO_GENERATE = 15

/** DALL-E 3 Standard 1024x1024 = $0.040 per image */
const DALLE_COST_PER_IMAGE = 0.04

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
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

/** Normalize a string for fuzzy matching: lowercase, no accents, trimmed */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
}

/** Simple fuzzy match score between 0 and 1 */
function fuzzyScore(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  // Word overlap
  const wordsA = new Set(na.split(/\s+/))
  const wordsB = new Set(nb.split(/\s+/))
  const intersection = [...wordsA].filter((w) => wordsB.has(w))
  const union = new Set([...wordsA, ...wordsB])
  return union.size > 0 ? intersection.length / union.size : 0
}

/** Sanitize AI-extracted text before using in prompts (prevents prompt injection) */
function sanitizeForPrompt(text: string, maxLength: number = 100): string {
  return text
    .replace(/["""''`]/g, "")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, maxLength)
}

// ─── SSRF Protection ────────────────────────────────────────────────────────

/**
 * Fetch a caller-supplied image url without becoming their proxy (#618).
 *
 * WHAT THIS REPLACES. A `validateImageUrl` that checked the literal hostname
 * against a six-entry list and one regex, followed by a bare `fetch(url)`. Node
 * and undici default to `redirect: "follow"`, so only the FIRST hostname was
 * ever looked at: an attacker-controlled public host answering
 * `302 Location: http://169.254.169.254/latest/meta-data/` was fetched with no
 * check at all. The list also held `127.0.0.1` and nothing else in
 * 127.0.0.0/8, and `[::1]` and no other IPv6 form.
 *
 * `fetchPublicUrl` lives in `@be-yours/core` because both apps carried an
 * identical copy of the old check, so both carried the defect. It uses
 * `redirect: "manual"` and re-checks every hop before taking it. The resolver
 * is injected — this is a Node action, so it has one; the package must stay
 * loadable from a Convex isolate, so it does not import `node:dns` itself.
 *
 * Reachable with `products:write`, which a manager holds, so this was never
 * anonymous-facing. It was still a blind request-forgery primitive from a staff
 * account into whatever the action runtime can reach.
 */
async function fetchExternalImage(url: string): Promise<Response> {
  return fetchPublicUrl(url, {
    lookup: (hostname) => dns.lookup(hostname, { all: true }),
  })
}

// ─── Image Processing ────────────────────────────────────────────────────────

type ProcessedImage = {
  processedUrl: string
  originalUrl: string
  enhanced: boolean
  /**
   * The processed bytes, inlined as a `data:` URL. The vision call sends this
   * rather than `processedUrl`: OpenAI fetches the URL it is given from its
   * own servers, and nothing in the bucket is anonymously readable.
   */
  processedDataUrl: string
}

async function processImage(imageUrl: string): Promise<ProcessedImage> {
  const bucketName = requireEnv("AWS_S3_BUCKET_NAME")
  const client = createS3Client()

  // Ours, or somebody else's? `mediaKeyFromUrl` recognises every shape the
  // product has stored — proxy path, CDN, and the direct S3 endpoint rows
  // written before the bucket went private.
  let sourceBuffer: Buffer
  const key = mediaKeyFromUrl(imageUrl, {
    publicBaseUrl: process.env.AWS_S3_PUBLIC_BASE_URL,
    bucketName,
  })
  if (key) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))
    const chunks: Uint8Array[] = []
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    sourceBuffer = Buffer.concat(chunks)
  } else {
    // External URL — every hop of the redirect chain is checked, not just the
    // first hostname (SSRF protection, #618).
    const response = await fetchExternalImage(imageUrl)
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`)
    sourceBuffer = Buffer.from(await response.arrayBuffer())
  }

  // Get metadata
  const meta = await sharp(sourceBuffer).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const needsUpscale = width < MIN_RESOLUTION_FOR_UPSCALE && height < MIN_RESOLUTION_FOR_UPSCALE

  // Process: resize if too large, sharpen, convert to WebP
  let pipeline = sharp(sourceBuffer)

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
  }

  // Apply sharpening for clarity
  pipeline = pipeline.sharpen({ sigma: 1.0, m1: 1.0, m2: 0.5 })

  // If the image is very small, upscale to 800px (Sharp-based, not AI)
  if (needsUpscale) {
    const targetSize = MIN_RESOLUTION_FOR_UPSCALE
    pipeline = pipeline.resize(targetSize, targetSize, {
      fit: "inside",
      withoutEnlargement: false,
      kernel: "lanczos3",
    })
  }

  const processedBuffer = await pipeline.webp({ quality: 85 }).toBuffer()

  // Upload processed image to S3
  const uuid = crypto.randomUUID()
  const processedKey = `products/${uuid}.webp`
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: processedKey,
      Body: processedBuffer,
      ContentType: "image/webp",
    })
  )

  return {
    processedUrl: buildPublicUrl(processedKey),
    originalUrl: imageUrl,
    enhanced: needsUpscale || width > MAX_DIMENSION || height > MAX_DIMENSION,
    processedDataUrl: `data:image/webp;base64,${processedBuffer.toString("base64")}`,
  }
}

// ─── Allergens ───────────────────────────────────────────────────────────────

/*
 * This action is the only thing in production that writes `products.allergens`
 * without a human typing the value, so whatever the model answers is what a
 * diner is eventually shown. Asked in French for "les allergènes très
 * probables", it answered in free prose — a different wording every run — and
 * none of that resolves against the vocabulary in
 * `@be-yours/core/allergens`. Every surface downstream then has to render
 * it as unverified, which is how an unrecognised value entered the database in
 * the first place.
 *
 * So the model is steered at the vocabulary rather than left to invent one,
 * and its answer is resolved through `normalizeAllergen` before storage. There
 * is no second alias table here: this file consults the same one the badge,
 * the ticket, the product form and the Uber Eats sync consult.
 */

/**
 * The keys offered to the model, comma-separated.
 *
 * Dietary markers are deliberately excluded. `vegetarian` and `vegan` are part
 * of the vocabulary but they are not allergens, and inviting the model to put
 * them in an allergen field is how "Allergène : Végan" ends up in front of a
 * diner. The owner declares those in the product form.
 */
const AI_ALLERGEN_VOCABULARY = KNOWN_ALLERGENS.filter(
  (allergen) => ALLERGEN_KIND[allergen] === "allergen"
).join(", ")

/**
 * The allergen instruction shared by both vision prompts, so the single-dish
 * and menu paths cannot drift apart.
 *
 * It overrides the prompt's closing language instruction for this one field:
 * the keys are identifiers, not copy, and a translated key resolves to nothing.
 */
const ALLERGEN_PROMPT_RULES = `  * Choisis les valeurs dans cette liste, en anglais, recopiées telles quelles : ${AI_ALLERGEN_VOCABULARY}
  * Ces identifiants ne se traduisent pas et ne se reformulent pas, malgré la consigne de langue en fin de message.
  * Un allergène certain qui manque à cette liste : nomme-le en français, en un ou deux mots. Jamais une phrase.
  * Aucun allergène probable : tableau vide. Jamais de mention négative comme "sans gluten".`

/**
 * Reduce the model's answer to the canonical vocabulary before it is stored.
 *
 * A value the vocabulary recognises — under any spelling, French or English —
 * becomes its canonical key, so the badge, the kitchen ticket and the Uber Eats
 * payload all read the same thing. A value it does not recognise is KEPT, in
 * the model's own wording: it may name a real allergen this list has never
 * heard of, and dropping it would delete a declaration. It simply stays
 * unverified, which every rendering surface already handles.
 *
 * Deduplication follows `resolveAllergens`: "Lactose" and "lait" are one
 * declaration, and an unrecognised value dedupes on its normalised form.
 */
export function normalizeExtractedAllergens(values: readonly string[]): string[] {
  // Delegates rather than re-deriving. This function used to carry its own copy
  // of the resolve-and-dedupe loop, and the copy is where a defect lived: it
  // keyed unrecognised values by `normalizeAllergenKey`, which collapses
  // anything outside [a-z0-9] to the empty string, so a model answering with
  // two CJK allergen names had the second deleted before it was ever stored.
  return resolveAllergens(values).map((entry) => entry.allergen ?? entry.raw)
}

// ─── Vision Analysis ─────────────────────────────────────────────────────────

export const SINGLE_SYSTEM_PROMPT = `Tu es un expert en restauration, gastronomie et redaction SEO pour sites de commande en ligne.
Analyse cette photo d'un plat de restaurant.
Retourne un JSON strictement conforme au schema fourni.

Regles :
- "name" : identifie le plat. source="detected" si du texte est visible, sinon source="inferred" base sur l'apparence.
- "description" : redige une description optimisee SEO (2-3 phrases, 120-160 caracteres ideal).
  * Commence par le mot-cle principal (nom du plat ou type de cuisine).
  * Inclus naturellement les ingredients phares et le mode de preparation (grille, fait maison, artisanal...).
  * Utilise des mots sensoriels qui convertissent (savoureux, croustillant, fondant, genereux, frais...).
  * Mentionne les atouts nutritionnels ou dietetiques si pertinents (fait maison, produits frais, sans gluten...).
  * Chaque description doit etre UNIQUE — jamais de formulation generique repetee entre produits.
  * source="detected" si visible sur l'image, sinon source="generated".
- "price" : en euros decimaux (ex: 12.50 pour 12,50 EUR). source="detected" si visible, sinon value=null.
- "ingredients" : liste les ingredients visibles ou hautement probables. source="detected" pour les visibles, source="inferred" pour les deduits.
- "allergens" : TOUJOURS source="inferred", JAMAIS source="detected". Indique uniquement les allergènes très probables vu les ingrédients.
${ALLERGEN_PROMPT_RULES}
- "detectedCategoryName" : source="detected" si section visible sur l'image, sinon value=null avec source="inferred".
- "suggestedCategoryName" : toujours rempli (Entree, Plat principal, Dessert, Boisson, etc.), source="inferred".
- "confidence" : 0.0 a 1.0, ta certitude pour CE champ specifiquement.
- "warnings" : ajoute un warning si quelque chose est ambigu, flou, ou incertain. severity="warning" si impactant, "info" si mineur.

Langue : francais.`

export const MENU_SYSTEM_PROMPT = `Tu es un expert en restauration, OCR de menus et redaction SEO pour sites de commande en ligne.
Analyse cette photo de menu/carte de restaurant.
Extrais TOUS les plats, boissons et items visibles.
Retourne un JSON conforme au schema fourni, avec un tableau "products".

Regles par champ :
- "name" : texte exact lu sur le menu. source="detected".
- "price" : en euros decimaux (ex: 12.50 pour 12,50 EUR). source="detected". Si illisible, value=null + warning "Prix illisible".
- "detectedCategoryName" : source="detected" si le menu a des sections visibles (Entrees, Plats, etc.). Sinon value=null, source="inferred".
- "suggestedCategoryName" : toujours rempli, source="inferred" base sur le type de plat.
- "description" : source="detected" si presente sur le menu (texte exact). Si absente, genere une description SEO (2-3 phrases, 120-160 caracteres) :
  * Commence par le mot-cle principal (nom du plat).
  * Inclus les ingredients phares et le mode de preparation.
  * Utilise des mots sensoriels (savoureux, croustillant, fondant, genereux, frais...).
  * Mentionne les atouts si pertinents (fait maison, produits frais...).
  * Chaque description UNIQUE — pas de formulation copier-coller entre produits.
  * source="generated", confidence=0.7.
- "ingredients" : source="detected" si listes. Sinon value=[] avec source="inferred" et confidence=0.
- "allergens" : TOUJOURS source="inferred". Déduis uniquement à partir du nom du plat et des ingrédients détectés.
${ALLERGEN_PROMPT_RULES}
- "warnings" : un par ambiguite (prix coupe, nom tronque, section incertaine, texte flou).

Langue : francais.`

const ENRICHMENT_SYSTEM_PROMPT = `Tu es un expert en gastronomie et redaction SEO de fiches produits pour restaurants en ligne.
Complete les champs vides de ces produits avec du contenu optimise pour le referencement naturel.

Regles :
- "description" : redige une description SEO optimisee (2-3 phrases, 120-160 caracteres ideal) :
  * Commence par le mot-cle principal (nom du plat ou type de cuisine).
  * Inclus naturellement les ingredients cles et le mode de preparation (grille, roti, fait maison, artisanal...).
  * Utilise des mots sensoriels qui convertissent (savoureux, croustillant, fondant, genereux, frais, moelleux...).
  * Mentionne les avantages (fait maison, produits frais, de saison, sans gluten...) si pertinent.
  * Adapte le ton au type de cuisine (street food = decontracte, gastronomique = raffine).
  * Chaque description doit etre UNIQUE — jamais de formulation generique ou repetitive entre produits.
  * source="generated".
- "ingredients" : liste les ingredients typiques de ce plat. source="generated". Sois realiste, pas exhaustif.
- NE MODIFIE PAS les champs déjà remplis (confidence > 0).
- Mets confidence entre 0.5 et 0.8 pour les champs generes (jamais 1.0 — ce sont des suggestions).

Retourne le JSON enrichi conforme au schema.`

/** Raw product from OpenAI (flat values, no AiField wrapper) */
type RawVisionProduct = {
  name: string
  description: string
  price: number | null
  ingredients: string[]
  allergens: string[]
  detectedCategoryName: string | null
  suggestedCategoryName: string
  warnings: string[]
}

/** Product with AiField wrappers, ready for UI */
type WrappedProduct = {
  name: AiField<string>
  description: AiField<string>
  price: AiField<number | null>
  ingredients: AiField<string[]>
  allergens: AiField<string[]>
  detectedCategoryName: AiField<string | null>
  suggestedCategoryName: AiField<string>
  warnings: ParsingWarning[]
}

type VisionResult = {
  products: WrappedProduct[]
  usage?: { prompt_tokens: number; completion_tokens: number }
}

/** Wrap flat OpenAI values into AiField objects with source + confidence */
function wrapRawProduct(raw: RawVisionProduct): WrappedProduct {
  return {
    name: { value: raw.name, source: "detected", confidence: 0.9 },
    description: {
      value: raw.description,
      source: raw.description ? "detected" : "generated",
      confidence: raw.description ? 0.8 : 0,
    },
    price: {
      value: raw.price !== null ? Math.round(raw.price * 100) : null,
      source: raw.price !== null ? "detected" : "generated",
      confidence: raw.price !== null ? 0.85 : 0,
    },
    ingredients: {
      value: raw.ingredients,
      source: raw.ingredients.length > 0 ? "detected" : "generated",
      confidence: raw.ingredients.length > 0 ? 0.7 : 0,
    },
    // Resolved against the canonical vocabulary here, at the only boundary the
    // model's answer crosses on its way to the database. Unrecognised values
    // survive as written — see `normalizeExtractedAllergens`.
    allergens: {
      value: normalizeExtractedAllergens(raw.allergens),
      source: "inferred",
      confidence: 0.5,
    },
    detectedCategoryName: {
      value: raw.detectedCategoryName,
      source: "detected",
      confidence: raw.detectedCategoryName ? 0.8 : 0,
    },
    suggestedCategoryName: {
      value: raw.suggestedCategoryName,
      source: "generated",
      confidence: 0.75,
    },
    warnings: raw.warnings.map((w) => ({
      field: "general",
      message: w,
      severity: "info" as const,
    })),
  }
}

/**
 * @param image - Either a `data:` URL or a URL OpenAI can fetch itself. Callers
 *   pass the inlined bytes: the bucket grants no anonymous read.
 */
async function analyzeWithVision(
  image: string,
  mode: "single" | "menu",
  apiKey: string
): Promise<VisionResult> {
  const systemPrompt = mode === "single" ? SINGLE_SYSTEM_PROMPT : MENU_SYSTEM_PROMPT

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: image, detail: "high" },
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`OpenAI Vision API error: ${response.status} — ${errorText}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error("OpenAI returned empty response")

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error("L'IA a retourné une réponse invalide. Réessayez avec une image plus nette.")
  }

  // Normalize: single mode returns a flat object, wrap in products array
  if (mode === "single") {
    const validated = singleProductVisionSchema.parse(parsed)
    return {
      products: [wrapRawProduct(validated)],
      usage: data.usage,
    }
  }

  const validated = menuVisionResultSchema.parse(parsed)
  // Cap products to prevent cost explosion
  const cappedProducts = validated.products.slice(0, MAX_PRODUCTS_PER_ANALYSIS)
  return {
    products: cappedProducts.map(wrapRawProduct),
    usage: data.usage,
  }
}

// ─── Enrichment ──────────────────────────────────────────────────────────────

async function enrichMissingSuggestions(
  products: VisionResult["products"],
  apiKey: string
): Promise<{ enriched: VisionResult["products"]; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  // Find products needing enrichment and track their original indices
  const toEnrich: Array<{ product: VisionResult["products"][number]; originalIndex: number }> = []
  products.forEach((p, i) => {
    if (
      (!p.description.value || p.description.confidence === 0) ||
      (p.ingredients.value.length === 0 && p.ingredients.confidence === 0)
    ) {
      toEnrich.push({ product: p, originalIndex: i })
    }
  })

  if (toEnrich.length === 0) {
    return { enriched: products }
  }

  // Prepare enrichment input with original index as tempId
  const enrichmentInput = toEnrich.map(({ product, originalIndex }) => ({
    tempId: `enrich-${originalIndex}`,
    name: product.name.value,
    description: product.description.value,
    ingredients: product.ingredients.value,
  }))

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.5,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ENRICHMENT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Produits a enrichir :\n${JSON.stringify({ products: enrichmentInput }, null, 2)}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    // Enrichment is non-critical — return original on failure
    console.error(`Enrichment failed: ${response.status}`)
    return { enriched: products }
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) return { enriched: products }

  try {
    const parsedResult = enrichmentResultSchema.parse(JSON.parse(content))

    // Merge enrichments back using original indices
    const enrichmentMap = new Map(parsedResult.products.map((e) => [e.tempId, e]))
    const enrichedProducts = products.map((p, i) => {
      const enrichment = enrichmentMap.get(`enrich-${i}`)
      if (!enrichment) return p

      return {
        ...p,
        description:
          !p.description.value || p.description.confidence === 0
            ? { value: enrichment.description, source: "generated" as const, confidence: 0.7 }
            : p.description,
        ingredients:
          p.ingredients.value.length === 0 && p.ingredients.confidence === 0
            ? { value: enrichment.ingredients, source: "generated" as const, confidence: 0.6 }
            : p.ingredients,
      }
    })

    return { enriched: enrichedProducts, usage: data.usage }
  } catch (e) {
    console.error("Enrichment parsing failed:", e)
    return { enriched: products }
  }
}

// ─── Category Mapping ────────────────────────────────────────────────────────

type CategoryDoc = {
  _id: string
  name: string
}

function mapCategories(
  products: VisionResult["products"],
  categories: CategoryDoc[]
): Array<{ matchedCategoryId: string | null }> {
  return products.map((p) => {
    const suggested = p.suggestedCategoryName.value
    const detected = p.detectedCategoryName.value

    // Try detected name first, then suggested
    const namesToTry = [detected, suggested].filter(Boolean) as string[]

    for (const name of namesToTry) {
      let bestScore = 0
      let bestId: string | null = null

      for (const cat of categories) {
        const score = fuzzyScore(name, cat.name)
        if (score > bestScore) {
          bestScore = score
          bestId = cat._id
        }
      }

      if (bestScore >= 0.8 && bestId) {
        return { matchedCategoryId: bestId }
      }
    }

    return { matchedCategoryId: null }
  })
}

// ─── Product Image Generation (DALL-E 3) ─────────────────────────────────

async function generateProductImage(
  productName: string,
  description: string,
  categoryName: string,
  apiKey: string
): Promise<string> {
  // Sanitize AI-extracted values to prevent prompt injection
  const safeName = sanitizeForPrompt(productName, 80)
  const safeCategory = sanitizeForPrompt(categoryName, 50)
  const safeDesc = sanitizeForPrompt(description, 150)

  const prompt = `Professional food photography of ${safeName}. ${safeCategory} dish. ${safeDesc ? safeDesc + ". " : ""}Appetizing, high quality, restaurant menu style, beautiful plating, soft natural lighting, pure white background (#FFFFFF). No text, no watermarks, no labels, no writing.`

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: prompt.slice(0, 4000),
      n: 1,
      size: "1024x1024",
      quality: "standard",
      response_format: "b64_json",
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error")
    throw new Error(`DALL-E 3 error: ${response.status} — ${errText}`)
  }

  const data = (await response.json()) as {
    data: Array<{ b64_json: string; revised_prompt?: string }>
  }

  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error("DALL-E returned no image data")

  const rawBuffer = Buffer.from(b64, "base64")

  // Process with Sharp: resize to 800x800, convert to WebP
  const processedBuffer = await sharp(rawBuffer)
    .resize(800, 800, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer()

  // Upload to S3
  const uuid = crypto.randomUUID()
  const key = `products/${uuid}.webp`
  const client = createS3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: requireEnv("AWS_S3_BUCKET_NAME"),
      Key: key,
      Body: processedBuffer,
      ContentType: "image/webp",
    })
  )

  return buildPublicUrl(key)
}

/**
 * Generate individual product images in parallel batches.
 * Returns a map of product index -> generated image URL.
 * Capped to MAX_IMAGES_TO_GENERATE to control costs.
 */
async function generateAllProductImages(
  products: VisionResult["products"],
  apiKey: string
): Promise<Map<number, string>> {
  const imageMap = new Map<number, string>()
  const toGenerate = products.slice(0, MAX_IMAGES_TO_GENERATE)

  for (let i = 0; i < toGenerate.length; i += IMAGE_GEN_BATCH_SIZE) {
    const batch = toGenerate.slice(i, i + IMAGE_GEN_BATCH_SIZE)
    const promises = batch.map((p, j) =>
      generateProductImage(
        p.name.value,
        p.description.value,
        p.suggestedCategoryName.value,
        apiKey
      )
        .then((url) => ({ index: i + j, url }))
        .catch((err) => {
          console.error(`Image generation failed for "${p.name.value}":`, err)
          return null
        })
    )

    const results = await Promise.all(promises)
    for (const r of results) {
      if (r) imageMap.set(r.index, r.url)
    }
  }

  return imageMap
}

// ─── Post-processing ─────────────────────────────────────────────────────────

function postProcess(
  product: VisionResult["products"][number]
): VisionResult["products"][number] {
  // Force allergens to always be "inferred"
  const allergens = {
    ...product.allergens,
    source: "inferred" as const,
  }

  // Normalize price: ensure non-negative integer or null
  let price = product.price
  if (price.value !== null) {
    const rounded = Math.round(Math.abs(price.value))
    price = { ...price, value: rounded }
  }

  return { ...product, allergens, price }
}

// ─── Main Action ─────────────────────────────────────────────────────────────

// @guarded-inline: runs authHelpers.checkStorePermission on the target store
export const analyze = action({
  args: {
    imageUrl: v.string(),
    mode: v.union(v.literal("single"), v.literal("menu")),
    storeId: v.id("stores"),
  },
  handler: async (ctx, args): Promise<AnalyzeImageResult> => {
    // Auth check
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")
    const ownerId = identity.subject

    // Verify store access (uses internal auth helper)
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: "products:write",
    })

    // Reserve the analysis BEFORE the first paid call. The quota used to be
    // checked here and incremented after three OpenAI requests had already been
    // made, so concurrent requests all read the same count and all passed.
    const reservation = await ctx.runMutation(
      internal.authHelpers.reserveImageToProductQuota,
      { ownerId }
    )
    if (!reservation.ok) {
      throw new Error(reservation.reason ?? "Quota atteint")
    }

    try {

    /* SSRF protection: refuse the url before spending a quota reservation on
       it. `processImage` checks again — and checks every redirect hop — because
       this call only sees the url the caller typed. Both, deliberately: this
       one gives the operator an immediate refusal, that one is the gate. */
    parsePublicUrl(args.imageUrl)

    const apiKey = requireEnv("OPENAI_API_KEY")

    // Step 1: Process image (Sharp: resize, WebP, sharpen, optional upscale)
    const processed = await processImage(args.imageUrl)

    // Step 2: Analyze with Vision AI (bytes inlined — see processedDataUrl)
    const visionResult = await analyzeWithVision(processed.processedDataUrl, args.mode, apiKey)

    // Step 3: Enrich missing fields (conditional — skip if all complete)
    const { enriched, usage: enrichmentUsage } = await enrichMissingSuggestions(
      visionResult.products,
      apiKey
    )

    // Step 4: Load store categories and map
    const categories = (await ctx.runQuery(api.categories.listAll, {
      storeId: args.storeId,
    }).catch(() => [])) as CategoryDoc[]

    const categoryMappings = mapCategories(enriched, categories as CategoryDoc[])

    // Step 5: Generate individual product images (menu mode = DALL-E, single = use uploaded photo)
    let productImages = new Map<number, string>()
    if (args.mode === "menu") {
      productImages = await generateAllProductImages(enriched, apiKey)
    }

    // Step 6: Post-process and assemble suggestions
    const suggestions: ProductSuggestion[] = enriched.map((product, index) => {
      const processed_ = postProcess(product)
      const mapping = categoryMappings[index]
      const generatedImageUrl = productImages.get(index)

      return {
        tempId: crypto.randomUUID(),
        name: processed_.name as AiField<string>,
        description: processed_.description as AiField<string>,
        price: processed_.price as AiField<number | null>,
        ingredients: processed_.ingredients as AiField<string[]>,
        allergens: processed_.allergens as AiField<string[]>,
        detectedCategoryName: processed_.detectedCategoryName as AiField<string | null>,
        suggestedCategoryName: processed_.suggestedCategoryName as AiField<string>,
        matchedCategoryId: mapping?.matchedCategoryId ?? null,
        imageUrl: generatedImageUrl ?? processed.processedUrl,
        originalImageUrl: processed.originalUrl,
        imageEnhanced: processed.enhanced,
        imageSource: generatedImageUrl ? ("generated" as const) : ("uploaded" as const),
        warnings: processed_.warnings as ParsingWarning[],
      }
    })

    // Calculate cost estimate
    const visionTokens = visionResult.usage?.prompt_tokens ?? 0
    const completionTokens =
      (visionResult.usage?.completion_tokens ?? 0) +
      (enrichmentUsage?.prompt_tokens ?? 0) +
      (enrichmentUsage?.completion_tokens ?? 0)

    // GPT-4o pricing: ~$2.50/1M input, ~$10/1M output
    const textCostUsd =
      (visionTokens * 2.5) / 1_000_000 + (completionTokens * 10) / 1_000_000
    const imageCostUsd = productImages.size * DALLE_COST_PER_IMAGE
    const estimatedCostUsd = textCostUsd + imageCostUsd

    return {
      mode: args.mode,
      suggestions,
      processingCost: {
        visionTokens,
        completionTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
        imageUpscaled: processed.enhanced,
        imagesGenerated: productImages.size,
      },
    }
    } catch (error) {
      // The analysis produced nothing, so it costs the owner no slot.
      await ctx.runMutation(
        internal.authHelpers.releaseImageToProductQuota,
        { ownerId }
      )
      throw error
    }
  },
})
