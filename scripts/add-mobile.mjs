#!/usr/bin/env node
/**
 * Enables the mobile (Expo) app on a site: copies `.template/mobile/` to
 * `mobile/`, customizes app.json (name, slug, bundle id), and creates
 * mobile/.env (EXPO_PUBLIC_CONVEX_URL taken from .env.local) and eas.json.
 *
 * Usage:
 *   pnpm add:mobile             # on an already-initialized site
 *   (also called by `pnpm setup` when the "web + app" option is chosen)
 *
 * Refuses to run if mobile/ already exists (never overwrites).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, "..")
const TEMPLATE = path.join(ROOT, ".template", "mobile")
const TARGET = path.join(ROOT, "mobile")

// Snapshot date — bumped on every refresh of .template/mobile.
// Past 6 months, warn: Expo versions move fast.
const SNAPSHOT_DATE = "2026-07-04"

function slugify(s) {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function activateMobile({ name, slug } = {}) {
  if (fs.existsSync(TARGET)) {
    console.log("mobile/ existe déjà — activation ignorée.")
    return false
  }
  if (!fs.existsSync(TEMPLATE)) {
    console.error(
      ".template/mobile/ introuvable — récupérer le template depuis le boilerplate (pnpm update:template).",
    )
    process.exit(1)
  }

  const ageDays = Math.floor(
    (Date.now() - new Date(SNAPSHOT_DATE).getTime()) / 86_400_000,
  )
  if (ageDays > 180) {
    console.warn(
      `! Le snapshot mobile date de ${SNAPSHOT_DATE} (${ageDays} j) — vérifier les versions Expo avant de démarrer un vrai projet.`,
    )
  }

  // Site identity: arguments > sentinel > package.json
  const sentinelPath = path.join(ROOT, ".beindigital-site.json")
  if (!name && fs.existsSync(sentinelPath)) {
    const info = JSON.parse(fs.readFileSync(sentinelPath, "utf8"))
    name = info.name
    slug = slug || info.slug
  }
  if (!name) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    )
    name = pkg.name
  }
  slug = slug || slugify(name) || "beindigital-site"
  const slugCompact = slug.replace(/-/g, "")

  console.log(`Activation de l'app mobile pour « ${name} »…`)
  fs.cpSync(TEMPLATE, TARGET, { recursive: true })

  // app.json: template in the name / slug / bundle id
  const appJsonPath = path.join(TARGET, "app.json")
  fs.writeFileSync(
    appJsonPath,
    fs
      .readFileSync(appJsonPath, "utf8")
      .replaceAll("__SITE_NAME__", name)
      .replaceAll("__SITE_SLUG__", slug)
      .replaceAll("__SITE_SLUG_COMPACT__", slugCompact),
  )

  // package.json: name of the mobile package
  const pkgPath = path.join(TARGET, "package.json")
  const mobilePkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  mobilePkg.name = `${slug}-mobile`
  fs.writeFileSync(pkgPath, JSON.stringify(mobilePkg, null, 2) + "\n")

  // eas.json from the template
  const easTemplate = path.join(TARGET, "eas.json.template")
  if (fs.existsSync(easTemplate)) {
    fs.renameSync(easTemplate, path.join(TARGET, "eas.json"))
  }

  // mobile/.env: reuse the web Convex URL if it is already provisioned
  let convexUrl = ""
  const envLocal = path.join(ROOT, ".env.local")
  if (fs.existsSync(envLocal)) {
    const m = fs
      .readFileSync(envLocal, "utf8")
      .match(/^NEXT_PUBLIC_CONVEX_URL=(.+)$/m)
    if (m && m[1] && !m[1].includes("your-deployment")) convexUrl = m[1].trim()
  }
  fs.writeFileSync(
    path.join(TARGET, ".env"),
    `# Backend Convex partagé avec le web (gitignoré)\nEXPO_PUBLIC_CONVEX_URL=${convexUrl}\n`,
  )

  // Sentinel: record the activation
  if (fs.existsSync(sentinelPath)) {
    const info = JSON.parse(fs.readFileSync(sentinelPath, "utf8"))
    info.mobile = true
    fs.writeFileSync(sentinelPath, JSON.stringify(info, null, 2) + "\n")
  }

  console.log(`  ✓ mobile/ créé (app.json, eas.json, .env${convexUrl ? " — Convex repris de .env.local" : ""})

App mobile prête :
  cd mobile && pnpm install && pnpm start
Voir mobile/README.md (backend, auth bearer, builds EAS).`)
  return true
}

// Direct execution (pnpm add:mobile)
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  activateMobile()
}
