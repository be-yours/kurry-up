#!/usr/bin/env node
/**
 * One-shot command: creates a complete client site (clone + config) in a
 * single call. Self-contained — it can run from a clone of the boilerplate OR
 * be piped in without cloning anything first:
 *
 *   gh api repos/be-yours/beyours-boilerplate/contents/scripts/create-site.mjs \
 *     -H "Accept: application/vnd.github.raw" | node --input-type=module - \
 *     client-luigi --name "Chez Luigi" --mobile
 *
 * Usage:
 *   node scripts/create-site.mjs <directory> [options]
 *
 * Options:
 *   --name "X"            restaurant name (default: derived from the directory)
 *   --description "…"     SEO description
 *   --locale fr           default locale
 *   --mobile | --web      web + Expo app, or web only (default)
 *   --template <slug>     design template: pizzeria, fast-food, food-truck,
 *                         poulet, asiatique, or the name the catalogue sells
 *                         one under, e.g. pizzeria-trattoria (default: neutral
 *                         engine look)
 *   --blank               from scratch: NO catalogue template. The site keeps
 *                         the engine's neutral base and every package; its
 *                         design is composed afterwards
 *   --design-prompt "…"   what the client asked for, recorded in
 *                         site/DESIGN_BRIEF.md. Without --template it implies
 *                         --blank
 *   --design-prompt-file F  the same, read from a file (relative to where this
 *                         command is run)
 *   --repo owner/name     creates the private GitHub repo (via gh) and pushes
 *   --template-url URL    source boilerplate (default: the BeYours repo)
 *   --license-key bys_…   maintenance licence key, from the deployment's page
 *                         in the BeYours console (Licence panel)
 *   --license-api URL     the licence API that key answers on
 *                         (https://<deployment>.convex.site)
 *   --skip-install        skip pnpm install (no NODE_AUTH_TOKEN)
 *
 * The two licence options are what `pnpm update:engine` and
 * `pnpm update:template` present before pulling anything
 * (scripts/lib/maintenance.mjs). They were accepted by init.mjs and dropped
 * here, so a site created in one shot — the documented path — was delivered
 * without its key, and `pnpm setup -- --license-key …` afterwards answered
 * « Site déjà initialisé ». Both are forwarded now; omitted, the site updates
 * unchecked, as before.
 *
 * Steps: clone the template → `template` remote → (GitHub repo) →
 * pnpm install → pnpm setup --yes → initial commit → (push).
 */

import fs from "node:fs"
import path from "node:path"
import { execSync, spawnSync } from "node:child_process"

const DEFAULT_TEMPLATE =
  "https://github.com/be-yours/beyours-boilerplate.git"

const args = process.argv.slice(2)
const positional = args.filter((a, i) => {
  if (a.startsWith("--")) return false
  const prev = args[i - 1]
  return !(
    prev &&
    prev.startsWith("--") &&
    !["--mobile", "--web", "--skip-install", "--blank"].includes(prev)
  )
})
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : undefined
}

const targetArg = positional[0]
if (!targetArg) {
  console.error(
    "Usage : create-site.mjs <dossier> [--name \"X\"] [--mobile] [--repo owner/nom] …",
  )
  process.exit(1)
}
const target = path.resolve(targetArg)
if (fs.existsSync(target)) {
  console.error(`Le dossier existe déjà : ${target}`)
  process.exit(1)
}

const templateUrl = opt("template-url") || DEFAULT_TEMPLATE
const licenseKey = opt("license-key")
const licenseApi = opt("license-api")
/* The pair is one thing: scripts/lib/maintenance.mjs returns silently — no
   call, no refusal — when EITHER field is missing from the sentinel. A key
   without its API would be written, reported as registered, and check nothing.
   Refused here, before anything is cloned. */
if (Boolean(licenseKey) !== Boolean(licenseApi)) {
  console.error(
    "--license-key et --license-api vont ensemble : les deux, ou aucun. Les deux figurent sur la page du déploiement dans la console (panneau Licence).",
  )
  process.exit(1)
}
const template = opt("template")
const blank = flag("blank")
const designPrompt = opt("design-prompt")
const designPromptFile = opt("design-prompt-file")
/* The same refusals init.mjs makes, made here as well because init.mjs runs
   after the clone and the install — and a contradiction between two flags is
   no reason to spend either. */
if (blank && template !== undefined) {
  console.error(
    "--blank et --template s'excluent : « à partir de zéro » veut dire aucun design du catalogue.",
  )
  process.exit(1)
}
if (designPrompt !== undefined && designPromptFile !== undefined) {
  console.error("--design-prompt et --design-prompt-file s'excluent : un seul brief par site.")
  process.exit(1)
}
/* init.mjs runs INSIDE the clone, so a relative path would be read against the
   new site and not against the directory this command was typed in. */
const promptFile = designPromptFile === undefined ? undefined : path.resolve(designPromptFile)
if (promptFile !== undefined && !(fs.existsSync(promptFile) && fs.statSync(promptFile).isFile())) {
  console.error(`Fichier de brief introuvable : ${promptFile}`)
  process.exit(1)
}
/* A brief with no template to adapt is a design to compose — init.mjs reads it
   the same way, and the summary below has to agree with what it did. */
const fromScratch = blank || (template === undefined && (designPrompt !== undefined || promptFile !== undefined))
const name =
  opt("name") ||
  path
    .basename(target)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
const repo = opt("repo")

function run(command, opts = {}) {
  execSync(command, { stdio: "inherit", ...opts })
}
function has(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}

console.log(`\n① Clone du template → ${target}`)
run(`git clone ${templateUrl} ${JSON.stringify(target)}`)
run("git remote rename origin template", { cwd: target })

let originReady = false
if (repo) {
  console.log(`\n② Repo GitHub ${repo}`)
  if (!has("gh")) {
    console.warn("  ! gh absent — repo non créé. Ajouter origin manuellement.")
  } else {
    const r = spawnSync(
      "gh",
      ["repo", "create", repo, "--private", "--source", target, "--remote", "origin"],
      { stdio: "inherit" },
    )
    originReady = r.status === 0
    if (!originReady)
      console.warn("  ! création du repo échouée — continuer sans origin.")
  }
} else {
  console.log("\n② Pas de --repo : ajouter origin plus tard :")
  console.log("     git remote add origin git@github.com:be-yours/<client>.git")
}

console.log("\n③ Installation")
if (flag("skip-install")) {
  console.log("  = sautée (--skip-install)")
} else if (!process.env.NODE_AUTH_TOKEN) {
  console.warn(
    "  ! NODE_AUTH_TOKEN absent — install sautée. Exporter le PAT (read:packages) puis `pnpm install`.",
  )
} else {
  run("pnpm install", { cwd: target })
}

console.log("\n④ Configuration du site")
const setupArgs = ["scripts/init.mjs", "--yes", "--name", name]
const description = opt("description")
const locale = opt("locale")
if (description) setupArgs.push("--description", description)
if (locale) setupArgs.push("--locale", locale)
if (template) setupArgs.push("--template", template)
if (blank) setupArgs.push("--blank")
if (designPrompt) setupArgs.push("--design-prompt", designPrompt)
if (promptFile) setupArgs.push("--design-prompt-file", promptFile)
if (licenseKey) setupArgs.push("--license-key", licenseKey)
if (licenseApi) setupArgs.push("--license-api", licenseApi)
setupArgs.push(flag("mobile") ? "--mobile" : "--web")
const setup = spawnSync("node", setupArgs, { cwd: target, stdio: "inherit" })
if (setup.status !== 0) process.exit(setup.status || 1)

console.log("\n⑤ Commit initial")
run("git add -A", { cwd: target })
run(
  `git commit -q -m ${JSON.stringify(`chore: init site ${name}`)} --no-verify`,
  { cwd: target },
)
if (originReady) {
  run("git push -q -u origin HEAD", { cwd: target })
  console.log("  ✓ poussé sur origin")
}

const hasBrief = designPrompt !== undefined || promptFile !== undefined
const designHint = fromScratch
  ? `Design à composer : ${hasBrief ? "site/DESIGN_BRIEF.md, " : ""}site/theme.css, site/fonts.ts, site/layout.ts — puis pnpm design:check`
  : "Template design  : pnpm template:list / pnpm template:apply <slug>"

console.log(`
────────────────────────────────────────────────────────
Site « ${name} » prêt dans ${target} (${flag("mobile") ? "web + app mobile" : "web"}${fromScratch ? ", à partir de zéro" : template ? `, template ${template}` : ""}${licenseKey ? ", licence enregistrée" : ", SANS clé de licence — pnpm setup -- --force --license-key … --license-api …"}).

  cd ${targetArg}
  pnpx convex dev            # provisionne le backend
  pnpm env:setup             # wizard .env (requis + intégrations), puis pnpm convex:env
  pnpm dev                   # storefront + admin${flag("mobile") ? "\n  cd mobile && pnpm install && pnpm start   # app Expo" : ""}

Avant la mise en prod : créer le projet Sentry DU CLIENT (1 projet par client,
sous SON compte) et coller le DSN dans NEXT_PUBLIC_SENTRY_DSN — sinon aucune
erreur de production n'est remontée. Procédure : docs/SENTRY.md

Personnalisation : site.config.ts, site/, public/ (docs/CUSTOMIZATION.md)
${designHint}
Mises à jour     : pnpm update:engine / pnpm update:template (docs/UPDATES.md)
────────────────────────────────────────────────────────`)
