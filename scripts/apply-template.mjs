#!/usr/bin/env node
/**
 * Design templates — catalog and application.
 *
 * Usage:
 *   pnpm template:list                # catalog of available templates
 *   pnpm template:apply <slug>        # applies a template to the site
 *   pnpm template:apply default       # restores the original theme
 *
 * Applying a template copies templates/<slug>/theme.css, fonts.ts and layout.ts
 * into site/ (client zone) and records the choice in .beindigital-site.json if
 * the site is initialized. All three are OVERWRITTEN: review `git diff site/`
 * before committing if the site already had customizations.
 *
 * Art direction details: templates/<slug>/DESIGN.md and templates/README.md.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Available templates: directories under templates/ that carry a template.json. */
export function listTemplates(root = DEFAULT_ROOT) {
  const dir = path.join(root, "templates")
  if (!fs.existsSync(dir)) return []
  const templates = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metaPath = path.join(dir, entry.name, "template.json")
    if (!fs.existsSync(metaPath)) continue
    try {
      templates.push(JSON.parse(fs.readFileSync(metaPath, "utf8")))
    } catch {
      console.warn(`  ! templates/${entry.name}/template.json illisible, ignoré`)
    }
  }
  // Neutral first, then alphabetical order
  return templates.sort((a, b) =>
    a.slug === "default" ? -1 : b.slug === "default" ? 1 : a.slug.localeCompare(b.slug),
  )
}

/**
 * Resolves a slug to the directory that actually holds the template.
 *
 * The sales catalogue (`apps/site/lib/templates-data.ts`) sells all fifty
 * themes under a compound `<vertical>-<theme>` slug. Five of them are their
 * vertical's *base* template, whose directory kept the bare vertical name:
 * `templates/asiatique/` is the theme sold as `asiatique-izakaya`, and its own
 * template.json has always called it themeName "Izakaya". So the five slugs a
 * buyer was shown — izakaya, trattoria, smash, convoi, braise — were the five
 * that answered "Template inconnu" when someone tried to apply them.
 *
 * A real directory always wins over an alias, so creating
 * `templates/asiatique-izakaya/` later supersedes the alias with no code change.
 *
 * Returns the directory slug, or null when nothing claims this name.
 */
export function resolveTemplateSlug(slug, root = DEFAULT_ROOT) {
  if (fs.existsSync(path.join(root, "templates", slug, "template.json"))) return slug
  const owner = listTemplates(root).find((t) => t.aliases?.includes(slug))
  return owner ? owner.slug : null
}

/** Every name `apply` accepts: directory slugs plus the aliases sold beside them. */
function applicableNames(root) {
  return listTemplates(root).flatMap((t) => [t.slug, ...(t.aliases ?? [])])
}

/**
 * Applies a template: copies theme.css + fonts.ts into site/ and updates the
 * .beindigital-site.json sentinel if it exists. Returns the metadata.
 *
 * Accepts an alias, but everything downstream — the files copied, the sentinel
 * written, the DESIGN.md path printed — uses the resolved directory slug.
 */
export function applyTemplate(requestedSlug, root = DEFAULT_ROOT) {
  const slug = resolveTemplateSlug(requestedSlug, root)
  if (slug === null) {
    const known = applicableNames(root).join(", ")
    throw new Error(`Template inconnu : "${requestedSlug}". Disponibles : ${known}`)
  }
  const dir = path.join(root, "templates", slug)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "template.json"), "utf8"))

  const sources = [
    ["theme.css", path.join("site", "theme.css")],
    ["fonts.ts", path.join("site", "fonts.ts")],
    // The layout half of the identity (#507). Copied like the other two, and
    // like them OVERWRITTEN. The refusal below is the reason it is listed here
    // rather than copied when present: a template with no `layout.ts` fails
    // loudly at apply time instead of quietly leaving the previous template's
    // layout over the new one's colours.
    ["layout.ts", path.join("site", "layout.ts")],
  ]

  /*
   * EVERY SOURCE CHECKED BEFORE ANY IS COPIED (#532).
   *
   * The check used to sit inside the copy loop, one file at a time, and that
   * defeated the refusal it was written for: a template missing its LAST source
   * had already had `theme.css` and `fonts.ts` written over it before the throw.
   * The result is precisely the half-applied site the refusal exists to prevent
   * — the new template's colours and type over the old one's layout — reached
   * through an error message telling the operator to fix something else.
   *
   * Measured: `apply-template.test.mjs` « writes nothing when it refuses » fails
   * on the loop form and passes on this one.
   */
  for (const [from] of sources) {
    const src = path.join(dir, from)
    if (!fs.existsSync(src)) throw new Error(`Fichier manquant : templates/${slug}/${from}`)
  }

  for (const [from, to] of sources) {
    fs.copyFileSync(path.join(dir, from), path.join(root, to))
    console.log(`  ✓ ${to} ← templates/${slug}/${from}`)
  }

  const sentinelPath = path.join(root, ".beindigital-site.json")
  if (fs.existsSync(sentinelPath)) {
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8"))
    sentinel.template = slug
    fs.writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + "\n")
    console.log(`  ✓ .beindigital-site.json : template → ${slug}`)
  }

  return meta
}

function printList(root) {
  const templates = listTemplates(root)
  if (templates.length === 0) {
    console.log("Aucun template trouvé dans templates/.")
    return
  }
  console.log("Templates design disponibles :\n")
  for (const t of templates) {
    const cat = t.category ? `[${t.category}] ` : ""
    console.log(`  ${t.slug.padEnd(12)} ${cat}${t.label}`)
    if (t.aliases?.length)
      console.log(`  ${"".padEnd(12)} vendu sous : ${t.aliases.join(", ")}`)
    console.log(`  ${"".padEnd(12)} ${t.description}`)
    if (t.fonts)
      console.log(
        `  ${"".padEnd(12)} titres ${t.fonts.heading} · texte ${t.fonts.body} · signature ${t.primary}\n`,
      )
  }
  console.log("Appliquer : pnpm template:apply <slug>")
  console.log("Aperçu    : ouvrir templates/preview.html · détail : templates/<slug>/DESIGN.md")
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const [command, slug] = process.argv.slice(2)
  try {
    if (command === "list" || command === undefined) {
      printList(DEFAULT_ROOT)
    } else if (command === "apply") {
      if (!slug) {
        console.error("Usage : pnpm template:apply <slug>  (pnpm template:list pour le catalogue)")
        process.exit(1)
      }
      const meta = applyTemplate(slug, DEFAULT_ROOT)
      console.log(`\nTemplate « ${meta.label} » appliqué.`)
      console.log("Relire : git diff site/ — puis ajuster les couleurs du client dans site/theme.css")
      // meta.slug, not the argument: an alias has no directory of its own.
      console.log(`Direction artistique : templates/${meta.slug}/DESIGN.md`)
    } else {
      console.error(`Commande inconnue : ${command}. Utiliser "list" ou "apply <slug>".`)
      process.exit(1)
    }
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
