#!/usr/bin/env node
/**
 * Seeds a Be yours deployment with Kurry Up's ordering restaurant, carte, pages and blog. CLIENT ZONE.
 *
 *   node site/seed/run.mjs                 # the deployment named in .env.local (local: Convex API 3300, site 3301)
 *   node site/seed/run.mjs --prod --yes    # the project's production deployment (asks for --yes)
 *   node site/seed/run.mjs --only=catalogue,pages,blog   (steps: settings, languages, ui, catalogue, pages, blog)
 *   node site/seed/run.mjs --store=paris-washington       # one store only (the only store of this site)
 *   node site/seed/run.mjs --reset-ops     # also rewrite what the OWNER edits in the admin (see below)
 *   node site/seed/run.mjs --dry-run       # checks data.mjs and articles.html, prints the plan, writes NOTHING
 *   node site/seed/run.mjs --image-list    # writes site/IMAGES_PRODUITS_LISTE.json (what the imagery agent draws), writes NOTHING else
 *
 * ONE STORE. Categories, products, CMS pages, media records, articles, languages and UI words carry a `storeId`, so every step below runs
 * once per store of `STORES` (here a single one, Kurry Up Paris Washington). Only `globalSettings` is deployment-wide. `stores.create`
 * opens a store as a `draft` that follows the global week: this seed publishes it (`status`) and sets `useGlobalHours: false`.
 * The other restaurants of the network are not stores: they live in `site/components/network.ts`.
 *
 * Idempotent: every step looks the document up first (store by slug, category by slug, product by slug, media by key, article by slug) and
 * updates it when it exists. Run it again after editing `data.mjs` or `articles.html`, and again once the files of `public/brand/` exist.
 * A product or a category this seed no longer lists is switched off, never deleted.
 *
 * WHAT A RE-RUN DOES NOT TOUCH. The establishment's identity (name, address, phone, status), its opening hours and the global settings
 * (VAT, services, payments, seller and legal identity) are the owner's from the first day: they are written when the store is created and
 * left alone afterwards, because `globalSettings:upsert` replaces `seller` and `siteLegal` whole and a re-run would wipe a SIRET typed in
 * the admin. `--reset-ops` is the explicit way to rewrite them. Opening hours are never written with `--prod` (add `--hours` to do it on
 * purpose): the engine REFUSES orders outside the hours it holds.
 *
 * HOW IT TALKS TO CONVEX. It uses the engine's own public mutations, exactly as the dashboard does, so no engine file is touched and no
 * function is added to `convex/`. `npx convex run --identity` lets the deployment admin call a public function as a given identity; the
 * identity is a synthetic super-admin profile (`seed:kurry-up`) created at the start and DOWNGRADED TO `customer` at the end. No real login
 * can ever carry that subject, so nothing is left to abuse.
 *
 * MEDIA. The files live in `public/brand/` and are served by the app itself, so no S3 is needed to render the site. CMS images are
 * `cmsMedia` records pointing at `/brand/<file>`; product and category pictures are plain paths (`/brand/products/<slug>.webp`). A file that
 * is not on disk is SKIPPED (the field stays empty and the engine's own fallback shows) and listed at the end: run the seed again when it
 * exists. The record's S3 key carries a hash of the file, so a regenerated picture gets a record with its real size and dimensions.
 *
 * GUARDS. Before anything is written, `validate()` refuses the run on a duplicate slug, a bad price, a dash (em or en), the word « halal »,
 * a third-party brand name in visitor text, or a trending slug that does not exist.
 */

import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import * as D from "./data.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const CONVEX = path.join(ROOT, "node_modules", ".bin", "convex")
const argv = process.argv.slice(2)
const PROD = argv.includes("--prod")
const RESET_OPS = argv.includes("--reset-ops")
const DRY_RUN = argv.includes("--dry-run")
const IMAGE_LIST = argv.includes("--image-list")
// `--status=temporarily_unavailable` publishes the carte without taking orders; the default opens
// the establishment. Needs --reset-ops on an existing establishment, like every identity field.
// `--hours` writes the hours of data.mjs to production too.
const STATUS = (argv.find((a) => a.startsWith("--status=")) ?? "--status=open").slice(9)
if (PROD && !argv.includes("--yes")) {
  console.error(
    "--prod writes to the PRODUCTION deployment and overwrites its catalogue, CMS pages and articles.\n" +
      "Once the owner has edited those in the admin, a re-run erases their edits. Add --yes if you mean it.",
  )
  process.exit(1)
}
const ONLY = (argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean)
const wants = (step) => ONLY.length === 0 || ONLY.includes(step)
const ONLY_STORE = (argv.find((a) => a.startsWith("--store=")) ?? "").slice(8)
const STEPS = ["settings", "languages", "ui", "catalogue", "pages", "blog"]
for (const s of ONLY) {
  if (!STEPS.includes(s)) {
    console.error(`--only=${s} : étape inconnue (${STEPS.join(", ")})`)
    process.exit(1)
  }
}
if (ONLY_STORE && !D.STORES.some((s) => s.slug === ONLY_STORE)) {
  console.error(`--store=${ONLY_STORE} : boutique inconnue (${D.STORES.map((s) => s.slug).join(", ")})`)
  process.exit(1)
}

const KNOWN_FLAGS = ["--prod", "--yes", "--reset-ops", "--hours", "--dry-run", "--image-list"]
for (const a of argv) {
  if (!KNOWN_FLAGS.includes(a) && !/^--(only|store|status)=/.test(a)) {
    console.error(`${a} : option inconnue (${KNOWN_FLAGS.join(", ")}, --only=, --store=, --status=)`)
    process.exit(1)
  }
}

const USER_ID = `seed:${D.BRAND_SLUG}`
const IDENTITY = JSON.stringify({ subject: USER_ID, issuer: "seed", name: "Seed Kurry Up" })

/* ── plumbing ──────────────────────────────────────────────────────────── */

function parseOutput(out) {
  const text = out.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // function logs may precede the result: take the longest JSON suffix
    const lines = text.split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines.slice(i).join("\n"))
      } catch {
        /* keep walking up */
      }
    }
    return text
  }
}

/**
 * Runs one Convex function. Public functions run as the seed identity; internal
 * ones (`internal: true`) run as the deployment itself, which is the only way to
 * reach them and cannot be combined with an identity.
 */
function cx(fn, args = {}, { internal = false } = {}) {
  const a = ["run"]
  if (PROD) a.push("--prod")
  if (!internal) a.push("--identity", IDENTITY)
  a.push(fn, JSON.stringify(args))
  try {
    return parseOutput(execFileSync(CONVEX, a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }))
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-12).join("\n")
    throw new Error(`convex run ${fn} failed:\n${msg}`)
  }
}

/** Read-only inline query, for lookups no public function offers. */
function inlineQuery(source) {
  const a = ["run"]
  if (PROD) a.push("--prod")
  a.push("--inline-query", source)
  return parseOutput(execFileSync(CONVEX, a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }))
}

const log = (...a) => console.log(...a)
const step = (name) => log(`\n▸ ${name}`)

/**
 * French typography on text nodes only: non-breaking space before : ; ? ! € » and after «,
 * between a number and `h` (« 11 h »), after `h` before minutes (« 3 h 45 »), inside « 4,1 / 5 »
 * and inside a French phone number (« 09 80 95 46 84 »).
 */
const NB = "\u00a0" // no-break space: before : € % » and after «, inside numbers, hours and phone numbers
const NNB = "\u202f" // narrow no-break space: before ; ? !
function typo(s) {
  if (s === undefined || s === null) return s
  return s
    .split(/(<[^>]+>)/g)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part
            .replace(/[ \u00a0](?=[;?!](?:\s|$|[»)"'.,<]))/g, NNB)
            .replace(/ (?=[:€»](?:\s|$|[)"'.,<\u00a0\u202f]))/g, NB)
            .replace(/« /g, `«${NB}`)
            .replace(/(\d) (?=h(?![\p{L}]))/gu, `$1${NB}`)
            .replace(/(\dh|\d h|\d\u00a0h) (?=\d)/g, (m) => m.slice(0, -1) + NB)
            .replace(/(\d) \/ (\d)/g, `$1${NB}/${NB}$2`)
            .replace(/(\d) (?=(?:g|cm|cl|j)\b)/g, `$1${NB}`)
            .replace(/(\d) %/g, `$1${NB}%`)
            .replace(/\b(\d\d) (\d\d) (\d\d) (\d\d) (\d\d)\b/g, `$1${NB}$2${NB}$3${NB}$4${NB}$5`),
    )
    .join("")
}

const warnLen = (what, text, max) => {
  if (text && text.length > max) log(`  ! ${what}: ${text.length} caractères (max ${max})`)
}

/** Media files a step wanted but could not find on disk (reported at the end). */
const MISSING = new Set()

/**
 * Same, for the category and product pictures: there are ~100 of them and the imagery phase may produce only some. A file that is
 * not there is NOT listed one by one (the field stays empty and the engine's fallback shows); the end of the run only counts them.
 */
const OPTIONAL_MISSING = new Set()
function optionalBrandUrl(file) {
  if (!file) return null
  if (fs.existsSync(path.join(ROOT, "public", "brand", file))) return `/brand/${file}`
  OPTIONAL_MISSING.add(file)
  return null
}

/* ── guards ────────────────────────────────────────────────────────────── */

const BANNED_WORDS = /halal|ben\s*&\s*jerry|coca[- ]?cola|nutella|evian|badoit|sprite|seven\s?up|oasis|minute\s?maid|lipton|arizona|shezan|cobra|kingfisher|\bmaya\b/i

/** Every visitor text of the seed, as plain strings (keys and ids are not visitor text). */
function visitorTexts(articles) {
  const out = []
  const walk = (v) => {
    if (typeof v === "string") out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => (k === "id" || k === "slug" || k === "imageFile" || k === "$media" || k === "file" || k === "fichier" ? null : walk(x)))
  }
  for (const def of D.STORES) {
    walk(def.description)
    walk(D.carteFor(def.slug))
    walk(D.pagesFor(def.slug))
    walk(D.uiWordsFor(def.slug))
  }
  walk(D.BLOG_CATEGORIES)
  articles.forEach((a) => walk([a.title, a.excerpt, a.metaTitle, a.metaDescription, a.html, a.coverAlt]))
  return out
}

function validate(articles) {
  const problems = []
  const dup = (what, list) => {
    const seen = new Set()
    for (const x of list) {
      if (seen.has(x)) problems.push(`${what} en double : ${x}`)
      seen.add(x)
    }
  }
  dup("boutique", D.STORES.map((s) => s.slug))
  dup("catégorie", D.CATEGORY_SLUGS)
  for (const def of D.STORES) {
    const carte = D.carteFor(def.slug)
    if (carte.map((c) => c.slug).join() !== D.CATEGORY_SLUGS.join()) problems.push(`${def.slug} : la carte ne suit pas CATEGORY_SLUGS`)
    const all = carte.flatMap((c) => c.products)
    dup("produit", all.map((x) => x.slug))
    for (const x of all) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.slug)) problems.push(`slug non kebab-case : ${x.slug}`)
      if (!Number.isInteger(x.price) || x.price <= 0) problems.push(`${x.slug} : prix invalide (${x.price})`)
      dup(`${x.slug}, groupe d'options`, (x.options ?? []).map((o) => o.id))
      for (const g of x.options ?? []) dup(`${x.slug}.${g.id}, choix`, g.choices.map((c) => c.id))
    }
    for (const slug of D.trendingFor(def.slug)) if (!all.some((x) => x.slug === slug && x.active !== false)) problems.push(`à la une : produit actif inconnu ${slug}`)
    for (const key of Object.keys(D.MEDIA)) if (!D.MEDIA[key].file) problems.push(`média sans fichier : ${key}`)
  }
  for (const a of articles) if (!D.BLOG_CATEGORIES.some((c) => c.name === a.category)) problems.push(`${a.slug} : rubrique inconnue ${a.category}`)
  dup("article", articles.map((a) => a.slug))
  for (const a of articles) if (!D.MEDIA[a.cover]) problems.push(`${a.slug} : couverture inconnue ${a.cover}`)
  for (const text of visitorTexts(articles)) {
    if (/[\u2013\u2014]/.test(text)) problems.push(`tiret cadratin ou demi-cadratin : « ${text.slice(0, 60)} »`)
    const m = text.match(BANNED_WORDS)
    if (m) problems.push(`mot interdit « ${m[0]} » : « ${text.slice(0, 60)} »`)
  }
  if (problems.length) {
    console.error("Garde-fous :\n  - " + problems.join("\n  - "))
    process.exit(1)
  }
}

/** Dry run: the plan, no network call at all. */
function printPlan(articles) {
  log(`Kurry Up, plan du semis (--dry-run, rien n'est écrit)`)
  log(`  boutiques : ${D.STORES.map((s) => `${s.slug} (${s.name})`).join(", ")}`)
  log(`  catégories : ${D.CATEGORY_SLUGS.join(", ")}`)
  log(`  produits : ${D.COUNTS.products} dont ${D.COUNTS.active} actifs`)
  for (const def of D.STORES) {
    for (const c of D.carteFor(def.slug)) {
      log(`    ${c.slug.padEnd(14)} ${c.products.map((x) => `${x.slug}${x.active === false ? "(off)" : ""} ${euros(x.price)}`).join(" · ")}`)
    }
    log(`  pages du CMS : ${Object.keys(D.pagesFor(def.slug)).join(", ")}`)
    // run the CMS texts through the same length checks as a real run
    for (const blocks of Object.values(D.pagesFor(def.slug))) resolveBlocks(blocks, {})
  }
  for (const a of articles) {
    warnLen(`${a.slug}.title`, a.title, 120)
    warnLen(`${a.slug}.metaTitle`, a.metaTitle, 70)
    warnLen(`${a.slug}.metaDescription`, a.metaDescription, 160)
    warnLen(`${a.slug}.excerpt`, a.excerpt, 300)
  }
  log(`  articles : ${articles.map((a) => a.slug).join(", ")}`)
  const missing = new Set()
  for (const m of Object.values(D.MEDIA)) if (!fs.existsSync(path.join(ROOT, "public", "brand", m.file))) missing.add(m.file)
  log(`  médias CMS absents de public/brand pour l'instant : ${missing.size} sur ${Object.keys(D.MEDIA).length}`)
}

function writeImageList() {
  const file = path.join(ROOT, "site", "IMAGES_PRODUITS_LISTE.json")
  const list = D.imageList()
  fs.writeFileSync(file, JSON.stringify({ marque: "Kurry Up", dossier: "public/brand/products/", format: "<slug>.webp et <slug>-sm.webp", produits: list }, null, 2) + "\n")
  log(`✓ ${list.length} produits écrits dans ${path.relative(ROOT, file)}`)
}

/* ── steps ─────────────────────────────────────────────────────────────── */

function ensureAdminProfile() {
  cx("userProfiles:internalUpsert", { userId: USER_ID, role: "super_admin", storeIds: [], permissions: [], language: "fr" }, { internal: true })
}

function dropAdminProfile() {
  // No delete exists in the engine: downgrade to a powerless customer profile.
  cx("userProfiles:internalUpsert", { userId: USER_ID, role: "customer", storeIds: [], permissions: [], language: "fr" }, { internal: true })
}

/** No store of Kurry Up has an external booking link: the engine's default (off) stays. */
const RESERVATION = (def) => (def.reservationUrl ? { reservationMode: def.reservationMode, reservationUrl: def.reservationUrl } : {})

function ensureStore(def) {
  step(`établissement : ${def.name}`)
  const store = cx("stores:getBySlug", { slug: def.slug })
  const existed = Boolean(store)
  let id = store?._id
  if (!id) {
    id = cx("stores:create", {
      name: def.name,
      slug: def.slug,
      description: typo(def.description),
      address: def.address,
      ...(def.phone ? { phone: def.phone } : {}),
      ...RESERVATION(def),
    })
    log("  + créé", id)
  }
  warnLen("description établissement", def.description, 1000)
  if (existed && !RESET_OPS) {
    log("  = établissement existant conservé (identité, adresse, horaires : --reset-ops pour réécrire)", id)
    return id
  }
  // `useGlobalHours: false`: each restaurant keeps its own week (`stores.create` writes `true`).
  cx("stores:update", {
    id,
    name: def.name,
    slug: def.slug,
    description: typo(def.description),
    ...(def.phone ? { phone: def.phone } : {}),
    status: STATUS,
    useGlobalHours: false,
    ...RESERVATION(def),
  })
  cx("stores:updateAddress", { id, address: def.address })
  if (PROD && !argv.includes("--hours")) {
    log("  ! horaires NON écrits en production : à saisir dans l'admin (Paramètres → Horaires).")
  } else {
    cx("stores:updateHours", { id, hours: def.hours })
  }
  log("  ✓", def.name, id)
  return id
}

function ensureSettings() {
  step("réglages (communs aux restaurants)")
  if (cx("globalSettings:get", {}) && !RESET_OPS) {
    log("  = réglages existants conservés (TVA, services, paiements, identité légale : --reset-ops pour réécrire)")
    return
  }
  const { hours, ...withoutHours } = D.GLOBAL_SETTINGS
  const skipHours = PROD && !argv.includes("--hours")
  cx("globalSettings:upsert", skipHours ? withoutHours : { ...withoutHours, hours })
  log(skipHours ? "  ✓ devise, TVA, services, paiements (sans horaires)" : "  ✓ devise, TVA, services, horaires, paiements")
}

function ensureLanguages(storeId) {
  step("langues")
  const existing = cx("languages:list", { storeId }) ?? []
  for (const l of D.LANGUAGES) {
    if (existing.some((e) => e.code === l.code)) continue
    cx("languages:create", { storeId, code: l.code, name: l.name, nativeName: l.nativeName, flagEmoji: l.flagEmoji, isDefault: l.isDefault, isActive: true, isRtl: false })
    log("  +", l.code)
  }
  log("  ✓", D.LANGUAGES.map((l) => l.code).join(", "))
}

/** The shop's own words: the restaurateur's UI overrides, which beat the engine's catalogue. */
function ensureUiWords(storeId, storeSlug) {
  step("mots de la boutique")
  let count = 0
  for (const [languageCode, words] of Object.entries(D.uiWordsFor(storeSlug))) {
    for (const [field, value] of Object.entries(words)) {
      cx("translations:upsert", { storeId, entityType: "ui", entityId: "static", field, languageCode, value: typo(value), isAutoTranslated: false })
      count++
    }
  }
  log("  ✓", count, "libellés")
}

const euros = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`

function ensureCatalogue(storeId, storeSlug) {
  const carte = D.carteFor(storeSlug)

  step("catégories")
  const cats = new Map((cx("categories:list", { storeId }) ?? []).map((c) => [c.slug, c]))
  const catId = {}
  carte.forEach((c, rank) => {
    const imageUrl = optionalBrandUrl(c.imageFile)
    const fields = { name: c.name, slug: c.slug, description: typo(c.description), ...(imageUrl ? { imageUrl } : {}), sortOrder: rank, isActive: true }
    const found = cats.get(c.slug)
    if (found) {
      cx("categories:update", { id: found._id, ...fields })
      catId[c.slug] = found._id
    } else {
      catId[c.slug] = cx("categories:create", { storeId, ...fields })
    }
    log("  ✓", c.name)
  })
  for (const [slug, row] of cats) {
    if (catId[slug]) continue
    cx("categories:update", { id: row._id, isActive: false })
    log("  - catégorie désactivée", slug)
  }

  step("produits")
  // `listAll`, not `list`: a product switched off (`active: false`) must be found again, not recreated.
  const prods = new Map((cx("products:listAll", { storeId }) ?? []).map((p) => [p.slug, p]))
  const prodId = {}
  let count = 0
  carte.forEach((c, rank) => {
    c.products.forEach((p, i) => {
      warnLen(`${p.slug}.description`, p.description, 2000)
      // `imageFile: null` is a dish with no honest photo: no file is expected for it.
      const imageFile = p.imageFile === undefined ? D.productImageFile(p.slug) : p.imageFile
      const imageUrl = imageFile ? optionalBrandUrl(imageFile) : null
      const fields = {
        categoryId: catId[c.slug],
        name: p.name,
        slug: p.slug,
        ...(p.description ? { description: typo(p.description) } : {}),
        price: p.price,
        taxRate: D.GLOBAL_SETTINGS.taxRate,
        images: imageUrl ? [imageUrl] : [],
        options: p.options ?? [],
        allergens: [], // TO CONFIRM by the client: mandatory before go-live
        tags: [],
        isActive: p.active !== false,
        isFeatured: D.trendingFor(storeSlug).includes(p.slug),
        // Global order: the « Tout » view of the carte sorts every product by this one number, so a
        // product's rank is its category's rank first, then its own.
        sortOrder: rank * 100 + i,
      }
      const found = prods.get(p.slug)
      if (found) {
        cx("products:update", { id: found._id, ...fields })
        prodId[p.slug] = found._id
      } else {
        prodId[p.slug] = cx("products:create", { storeId, ...fields })
      }
      if (p.active !== false) count++
      log(p.active !== false ? "  ✓" : "  ~ inactif", c.name, "·", p.name, euros(p.price))
    })
  })
  for (const [slug, row] of prods) {
    if (prodId[slug] || !row.isActive) continue
    cx("products:update", { id: row._id, isActive: false })
    log("  - produit désactivé", slug)
  }
  log("  ✓", count, "produits actifs")

  const trending = D.trendingFor(storeSlug)
  cx("products:setTrendingProducts", { storeId, productIds: trending.map((slug) => prodId[slug]) })
  log("  ✓ à la une :", trending.join(" · "))
}

/** key → cmsMedia id, registering every file of `MEDIA` that exists on disk. Media rows are per store. */
async function ensureMedia(storeId, storeSlug) {
  step("médias")
  const rows = inlineQuery(`return await ctx.db.query("cmsMedia").collect()`) ?? []
  const byKey = new Map(rows.filter((r) => r.storeId === storeId).map((r) => [r.s3Key, r._id]))
  const ids = {}
  for (const [key, m] of Object.entries(D.MEDIA)) {
    const file = path.join(ROOT, "public", "brand", m.file)
    if (!fs.existsSync(file)) {
      MISSING.add(m.file)
      continue
    }
    const hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 8)
    const s3Key = `seed/${storeSlug}/${hash}/${m.file}`
    if (byKey.has(s3Key)) {
      ids[key] = byKey.get(s3Key)
      continue
    }
    const isSvg = m.file.endsWith(".svg")
    const meta = isSvg ? { width: 64, height: 64 } : await sharp(file).metadata()
    const mime = isSvg ? "image/svg+xml" : m.file.endsWith(".png") ? "image/png" : m.file.endsWith(".jpg") ? "image/jpeg" : m.file.endsWith(".ico") ? "image/x-icon" : "image/webp"
    ids[key] = cx(
      "cmsSeedData:createMediaRecord",
      {
        storeId,
        filename: m.file,
        mimeType: mime,
        size: fs.statSync(file).size,
        s3Key,
        sourceUrl: `/brand/${m.file}`,
        width: meta.width,
        height: meta.height,
      },
      { internal: true },
    )
    byKey.set(s3Key, ids[key])
    log("  +", m.file)
  }
  log("  ✓", Object.keys(ids).length, "médias enregistrés")
  return ids
}

/** Limits of the CMS fields (cms/pages/*.ts), checked on every text so a too long copy is flagged before the engine refuses it. */
const FIELD_MAX = [
  [/^(badge|ctaLabel|buttonText|viewAllLabel|floatingBadge\d(Title|Subtitle)|stat\dLabel|submitLabel)$/, 50],
  [/^(title|sectionTitle|heading)$/, 120],
  [/^value\dDescription$/, 200],
  [/^(subtitle|description)$/, 300],
  [/^stat\dValue$/, 20],
]

function resolveBlocks(blocks, mediaIds) {
  const out = {}
  for (const [blockKey, fields] of Object.entries(blocks)) {
    out[blockKey] = {}
    for (const [fieldKey, v] of Object.entries(fields)) {
      if (v.type === "image") {
        const id = mediaIds[v.$media]
        if (!id) continue // file not produced yet: the field stays empty, the engine's fallback shows
        out[blockKey][fieldKey] = { type: "image", mediaId: id, altText: v.altText ?? D.MEDIA[v.$media].alt }
      } else if (v.type === "text" || v.type === "richtext") {
        out[blockKey][fieldKey] = { type: v.type, textValue: typo(v.textValue) }
        const max = FIELD_MAX.find(([re]) => re.test(fieldKey))
        if (max && v.type === "text") warnLen(`${blockKey}.${fieldKey}`, v.textValue, max[1])
        if (fieldKey === "metaTitle") warnLen(`${blockKey}.${fieldKey}`, v.textValue, 70)
        if (fieldKey === "metaDescription") warnLen(`${blockKey}.${fieldKey}`, v.textValue, 160)
        if (/^feature\dLabel$/.test(fieldKey)) warnLen(`${blockKey}.${fieldKey}`, v.textValue, 60)
        if (/^link\dLabel$/.test(fieldKey)) warnLen(`${blockKey}.${fieldKey}`, v.textValue, 40)
      } else {
        out[blockKey][fieldKey] = v
      }
    }
    if (Object.keys(out[blockKey]).length === 0) delete out[blockKey]
  }
  return out
}

function seedPages(storeId, storeSlug, mediaIds) {
  step("pages du CMS")
  for (const [pageSlug, blocks] of Object.entries(D.pagesFor(storeSlug))) {
    cx("cmsSeedData:seedAndPublishPage", { storeId, pageSlug, blocks: resolveBlocks(blocks, mediaIds) }, { internal: true })
    log("  ✓", pageSlug)
  }
}

function parseArticles() {
  const src = fs.readFileSync(path.join(ROOT, "site", "seed", "articles.html"), "utf8")
  const re = /<!--\s*article\s*(\{"slug"[\s\S]*?\})\s*-->/g
  const marks = [...src.matchAll(re)]
  return marks.map((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length
    return { ...JSON.parse(m[1]), html: src.slice(start, end).trim() }
  })
}

function seedBlog(storeId, mediaIds) {
  step("blog")
  const cats = new Map((cx("blog:listCategories", { storeId }) ?? []).map((c) => [c.name, c._id]))
  for (const c of D.BLOG_CATEGORIES) {
    if (cats.has(c.name)) continue
    cats.set(c.name, cx("blog:createCategory", { storeId, name: c.name, description: c.description }))
    log("  + rubrique", c.name)
  }
  // The admin list names the slugs `draftSlug` / `publishedSlug` (the content itself stays nested in the row).
  const rows = cx("blog:listAdminArticles", { storeId }) ?? []
  const slugOf = (row) => row.draftSlug ?? row.publishedSlug
  const existing = new Map()
  for (const row of rows) {
    const slug = slugOf(row)
    if (slug && !existing.has(slug)) existing.set(slug, row._id)
  }
  const articles = ARTICLES
  for (const a of articles) {
    warnLen(`${a.slug}.title`, a.title, 120)
    warnLen(`${a.slug}.metaTitle`, a.metaTitle, 70)
    warnLen(`${a.slug}.metaDescription`, a.metaDescription, 160)
    warnLen(`${a.slug}.excerpt`, a.excerpt, 300)
    const categoryId = cats.get(a.category)
    if (!categoryId) throw new Error(`rubrique inconnue : ${a.category}`)
    let articleId = existing.get(a.slug)
    if (!articleId) articleId = cx("blog:createArticle", { storeId, title: typo(a.title), categoryId })
    // The engine refuses to publish an article without a cover. Until its picture exists an article
    // borrows the wall scene, so the blog is never empty; with neither file it stays a draft.
    const coverId = mediaIds[a.cover] ?? mediaIds.fallback
    const coverAlt = mediaIds[a.cover] ? a.coverAlt : D.MEDIA.fallback.alt
    cx("blog:saveDraft", {
      articleId,
      categoryId,
      draftContent: {
        title: typo(a.title),
        slug: a.slug,
        excerpt: typo(a.excerpt),
        coverImageId: coverId,
        coverImageAlt: coverId ? coverAlt : undefined,
        content: typo(a.html),
        metaTitle: typo(a.metaTitle),
        metaDescription: typo(a.metaDescription),
        updatedAt: Date.now(),
      },
    })
    if (coverId) {
      cx("blog:publishArticle", { articleId })
      log("  ✓", a.slug, mediaIds[a.cover] ? "" : `(couverture provisoire : « ${a.cover} » absente)`)
    } else {
      log("  ~", a.slug, `(brouillon : couverture « ${a.cover} » absente, relance le semis quand le fichier existe)`)
    }
  }

  for (const row of rows) {
    const slug = slugOf(row)
    if (!slug || row.authorId !== USER_ID || !D.RETIRED_ARTICLES.includes(slug)) continue
    cx("blog:deleteArticle", { articleId: row._id })
    log("  - article retiré", slug)
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

const started = Date.now()
if (IMAGE_LIST) {
  writeImageList()
  process.exit(0)
}
const ARTICLES = parseArticles()
validate(ARTICLES)
if (DRY_RUN) {
  printPlan(ARTICLES)
  process.exit(0)
}
log(`Kurry Up, semis ${PROD ? "PRODUCTION" : "dev/local"}`)
if (!PROD) {
  // The deployment `convex run` talks to is the one named in .env.local: say which, and warn when it is not this site's (3300 / 3301).
  const env = fs.existsSync(path.join(ROOT, ".env.local")) ? fs.readFileSync(path.join(ROOT, ".env.local"), "utf8") : ""
  const url = env.match(/^NEXT_PUBLIC_CONVEX_URL=(.*)$/m)?.[1]?.trim()
  log(`  Convex : ${url ?? "NEXT_PUBLIC_CONVEX_URL absent de .env.local"}`)
  if (!url || !/:3300\b/.test(url)) log("  ! l'API Convex de Kurry Up est attendue sur le port 3300 (site 3301) : vérifie .env.local avant de continuer.")
}
ensureAdminProfile()
try {
  if (wants("settings")) ensureSettings()
  // Every store first, in order: the engine's automatic selection falls back on the first one created.
  const stores = D.STORES.map((def) => ({ def, id: ensureStore(def) }))
  for (const { def, id } of stores) {
    if (ONLY_STORE && ONLY_STORE !== def.slug) continue
    log(`\n═══ ${def.name} ═══`)
    if (wants("languages")) ensureLanguages(id)
    if (wants("ui")) ensureUiWords(id, def.slug)
    if (wants("catalogue")) ensureCatalogue(id, def.slug)
    const needMedia = wants("pages") || wants("blog")
    const mediaIds = needMedia ? await ensureMedia(id, def.slug) : {}
    if (wants("pages")) seedPages(id, def.slug, mediaIds)
    if (wants("blog")) seedBlog(id, mediaIds)
  }
  if (MISSING.size) {
    log(`\n! ${MISSING.size} fichier(s) absents de public/brand, champs image laissés vides : relance le semis quand ils existent.`)
    for (const f of [...MISSING].sort()) log("    -", f)
  }
  if (OPTIONAL_MISSING.size) {
    log(`\n~ ${OPTIONAL_MISSING.size} image(s) de catégorie ou de produit absentes de public/brand (champ vide, rien de bloquant) : relance le semis quand elles existent.`)
  }
  log(`\n✔ terminé en ${((Date.now() - started) / 1000).toFixed(0)} s : ${stores.map((s) => `${s.def.slug} ${s.id}`).join(", ")}`)
} finally {
  dropAdminProfile()
}
