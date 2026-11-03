#!/usr/bin/env node
/**
 * TEMPLATE update (git channel) — pulls the boilerplate's structural changes
 * (routes, convex/ wrappers, scripts, configs) through a git merge from the
 * `template` remote.
 *
 * Usage:
 *   pnpm update:template              # fetch + merge template/main
 *   pnpm update:template -- --dry-run # lists the commits without merging
 *   pnpm update:template -- --first   # first sync of a repo created with
 *                                     # "Use this template" (unrelated
 *                                     # histories)
 *
 * Client zones (site/, site.config.ts, .env*, modified public/) only conflict
 * if the template touched them — which, by contract, it never does
 * (docs/CUSTOMIZATION.md). A client file the template adds after a site exists
 * (site/routes.ts, site/components/SiteEffects.tsx) arrives once, empty, with
 * the first update that carries it, and is never edited again (docs/UPDATES.md).
 */

import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { assertMaintenanceCurrent } from "./lib/maintenance.mjs"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_REPO =
  "https://github.com/be-yours/beyours-boilerplate.git"

const args = process.argv.slice(2)
const DRY = args.includes("--dry-run")
const FIRST = args.includes("--first")
const BRANCH = "main"

function sh(command, opts = {}) {
  return execSync(command, { cwd: ROOT, encoding: "utf8", ...opts })
}

function shInherit(command) {
  execSync(command, { cwd: ROOT, stdio: "inherit" })
}

// 1. A clean tree is mandatory (merging into a dirty tree is unrecoverable)
if (sh("git status --porcelain").trim() !== "") {
  console.error(
    "Arbre de travail non propre. Commiter ou stasher avant update:template.",
  )
  process.exit(1)
}

// 2. Remote template
const remotes = sh("git remote").trim().split("\n")
if (!remotes.includes("template")) {
  let url = DEFAULT_REPO
  const sentinel = path.join(ROOT, ".beindigital-site.json")
  if (fs.existsSync(sentinel)) {
    const info = JSON.parse(fs.readFileSync(sentinel, "utf8"))
    if (info.templateRepo) url = info.templateRepo
  }
  shInherit(`git remote add template ${url}`)
  console.log(`Remote template ajouté : ${url}`)
}

console.log("Fetch du template…")
shInherit("git fetch template")

// 3. What's new?
let range = `HEAD..template/${BRANCH}`
let unrelated = false
try {
  sh(`git merge-base HEAD template/${BRANCH}`, {
    stdio: ["pipe", "pipe", "ignore"],
  })
} catch {
  unrelated = true
  range = `template/${BRANCH}`
}

const log = sh(`git log --oneline ${range} | head -50`).trim()
if (!unrelated && log === "") {
  console.log("Déjà à jour avec le template.")
  process.exit(0)
}
console.log(`\nCommits template à intégrer${unrelated ? " (premier sync)" : ""} :`)
console.log(log || "  (historique complet — premier sync)")

if (DRY) process.exit(0)

/* Gate placed AFTER the dry run on purpose: a client whose maintenance has
   lapsed can still see what they are missing — that list is the argument for
   renewing. What stops is the merge. */
await assertMaintenanceCurrent({ root: ROOT, channel: "template" })

if (unrelated && !FIRST) {
  console.error(`
Ce repo n'a pas d'ancêtre commun avec le template (créé via "Use this
template" ?). Le premier merge doit être fait explicitement :

  pnpm update:template -- --first

Il fusionnera les deux historiques (--allow-unrelated-histories). Les merges
suivants seront incrémentaux. Alternative recommandée pour les prochains
sites : cloner le boilerplate (git clone) au lieu du bouton template, pour
garder l'historique commun.`)
  process.exit(1)
}

// 4. Merge
try {
  shInherit(
    `git merge template/${BRANCH} --no-edit${unrelated ? " --allow-unrelated-histories" : ""}`,
  )
} catch {
  console.error(`
────────────────────────────────────────────────────────
CONFLITS DE MERGE — guide de résolution :

  Zones ENGINE (app/, components/, lib/, hooks/, cms/, convex/, configs) :
    → prendre la version du template, sauf si vous avez patché sciemment :
      git checkout --theirs <fichier> && git add <fichier>

  Zones CLIENT (site/, site.config.ts, public/, .env*) :
    → garder votre version :
      git checkout --ours <fichier> && git add <fichier>

  Puis : git commit
  Abandonner : git merge --abort
────────────────────────────────────────────────────────`)
  process.exit(1)
}

console.log(`
Merge OK. Étapes suivantes :
  1. pnpm install         # si package.json a changé
  2. pnpm convex:codegen  # si convex/ ou le schéma ont changé
  3. pnpm typecheck && pnpm test
  4. Déployer : pnpm convex:deploy puis déploiement Vercel`)
