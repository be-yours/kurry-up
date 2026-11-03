#!/usr/bin/env node
/**
 * Initializes a new client site from the boilerplate.
 *
 * Usage:
 *   pnpm setup                        # interactive
 *   pnpm setup -- --name "Chez Luigi" --yes   # non-interactive
 *
 * Idempotent: the presence of .beindigital-site.json marks a site as already
 * initialized (re-run with --force to execute again).
 *
 * Configuration: web only (default) or web + Expo mobile app
 * (--mobile / --web to force one without being asked).
 * Design template: --template <slug> (pizzeria, fast-food, food-truck,
 * poulet, asiatique, or the name the catalogue sells one under, such as
 * pizzeria-trattoria — `pnpm template:list` for the catalog); the wizard
 * offers it, defaulting to the neutral engine look.
 * From scratch: --blank applies NO catalogue template. The site keeps the
 * engine's neutral base and every package, and its design is composed
 * afterwards. --design-prompt "…" (or --design-prompt-file <path>) records what
 * the client asked for in site/DESIGN_BRIEF.md; given without --template it
 * implies --blank. See scripts/lib/design-brief.mjs.
 *
 * What the script does:
 *   1. Fills in site.config.ts (name, description, locale)
 *   2. Applies the design template (site/theme.css + site/fonts.ts), or none
 *      with --blank, and writes the design brief when there is one
 *   3. Renames the package (site slug)
 *   4. Creates .env.local from .env.example and generates the secrets
 *      (BETTER_AUTH_SECRET, ENCRYPTION_KEY)
 *   5. Adds the `template` git remote (boilerplate updates)
 *   6. Writes the .beindigital-site.json sentinel
 *
 * Maintenance contract: --license-key <clé> --license-api <url> record what the
 * update scripts present to check the contract still covers this site
 * (scripts/lib/maintenance.mjs). Both come from the deployment created in the
 * BeYours console. Omitted, the site simply updates unchecked.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import readline from "node:readline"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { activateMobile } from "./add-mobile.mjs"
import { applyTemplate, listTemplates, resolveTemplateSlug } from "./apply-template.mjs"
import {
  normalizePrompt,
  promptProblem,
  readPromptFile,
  writeBrief,
} from "./lib/design-brief.mjs"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SENTINEL = path.join(ROOT, ".beindigital-site.json")
const TEMPLATE_REPO =
  "https://github.com/be-yours/beyours-boilerplate.git"

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : undefined
}

function slugify(s) {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Prompt that works with both a TTY AND piped stdin: lines are queued as they
// arrive; after EOF, any remaining question resolves to "" (= default).
// (Plain readline.question never resolves a question asked after the pipe has
// closed — the process exited silently, leaving init half done.)
// Same mechanism as scripts/env.mjs.
function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin })
  const queue = []
  let pending = null
  let closed = false
  rl.on("line", (l) => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve(l)
    } else {
      queue.push(l)
    }
  })
  rl.on("close", () => {
    closed = true
    if (pending) {
      const resolve = pending
      pending = null
      resolve("")
    }
  })
  const nextLine = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift())
    if (closed) return Promise.resolve("")
    return new Promise((resolve) => (pending = resolve))
  }
  const ask = async (question, fallback = "") => {
    process.stdout.write(`${question}${fallback ? ` (${fallback})` : ""} : `)
    const a = (await nextLine()).trim()
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`)
    return a || fallback
  }
  return { ask, close: () => rl.close() }
}

function replaceOnce(file, from, to, label) {
  const p = path.join(ROOT, file)
  const src = fs.readFileSync(p, "utf8")
  if (!src.includes(from)) {
    console.warn(`  ! ${file} : valeur par défaut "${label}" introuvable, non modifié`)
    return
  }
  fs.writeFileSync(p, src.split(from).join(to))
  console.log(`  ✓ ${file} : ${label}`)
}

async function main() {
  if (fs.existsSync(SENTINEL) && !flag("force")) {
    const info = JSON.parse(fs.readFileSync(SENTINEL, "utf8"))
    console.log(`Site déjà initialisé : ${info.name} (${info.slug})`)
    console.log("Relancer avec --force pour ré-exécuter.")
    return
  }

  let name = opt("name")
  let description = opt("description")
  let locale = opt("locale")
  let mobile = flag("mobile") ? true : flag("web") ? false : undefined
  let template = opt("template")
  let blank = flag("blank")
  let designPrompt = opt("design-prompt")
  const designPromptFile = opt("design-prompt-file")
  const licenseKey = opt("license-key")
  const licenseApi = opt("license-api")

  /* "From scratch" is the absence of a catalogue template, so naming one next to
     it contradicts itself. Refused up front rather than settled in favour of one
     of the two: either guess hands the operator a site they did not ask for. */
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
  if (designPromptFile !== undefined) {
    try {
      designPrompt = readPromptFile(path.resolve(designPromptFile))
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
    if (normalizePrompt(designPrompt) === "") {
      console.error(`Le fichier de brief est vide : ${designPromptFile}`)
      process.exit(1)
    }
  }
  /* A brief with no template to adapt is a design to compose, which is what
     --blank says. Settled here so the wizard below does not ask a question the
     flags have already answered. */
  if (!blank && template === undefined && normalizePrompt(designPrompt) !== "") blank = true

  const templates = listTemplates(ROOT)
  if (template) {
    /* The sales catalogue sells five templates under a compound name
       (`asiatique-izakaya`) that is not the name of their directory
       (`asiatique`). `template:apply` has always resolved it, and this check
       compared against directory names only: the name a buyer was shown was
       refused here, after the clone and the install had already run. It is
       recorded as the directory, as `applyTemplate` records it. */
    const resolved = resolveTemplateSlug(template, ROOT)
    if (resolved === null) {
      const known = templates.flatMap((t) => [t.slug, ...(t.aliases ?? [])])
      console.error(`Template inconnu : "${template}". Disponibles : ${known.join(", ")}`)
      process.exit(1)
    }
    template = resolved
  }

  if (
    !flag("yes") &&
    (!name ||
      !description ||
      !locale ||
      mobile === undefined ||
      (template === undefined && !blank))
  ) {
    const prompt = createPrompt()
    name = name || (await prompt.ask("Nom du restaurant / site", "Mon Restaurant"))
    description =
      description ||
      (await prompt.ask(
        "Description (SEO)",
        "Commande en ligne, click & collect et livraison.",
      ))
    locale = locale || (await prompt.ask("Locale par défaut", "fr"))
    if (mobile === undefined) {
      const answer = await prompt.ask(
        "Configuration — 1) web seul  2) web + app mobile",
        "1",
      )
      mobile = answer.trim() === "2"
    }
    if (template === undefined && !blank && templates.length > 0) {
      console.log("\nTemplate design :")
      console.log("  0) À partir de zéro (aucun design du catalogue)")
      templates.forEach((t, i) => console.log(`  ${i + 1}) ${t.label}`))
      const answer = (await prompt.ask("Template (numéro, slug, ou 0 pour partir de zéro)", "1")).trim()
      if (answer === "0") {
        blank = true
      } else {
        const named = resolveTemplateSlug(answer, ROOT) ?? answer
        const picked =
          templates[Number(answer) - 1] ||
          templates.find((t) => t.slug === named) ||
          templates[0]
        template = picked.slug
      }
    }
    if (blank && designPrompt === undefined) {
      designPrompt = await prompt.ask("Décrivez le design souhaité (Entrée pour passer)")
    }
    prompt.close()
  }
  mobile = mobile === true
  designPrompt = normalizePrompt(designPrompt)
  const promptError = promptProblem(designPrompt)
  if (promptError) {
    console.error(promptError)
    process.exit(1)
  }
  // `null` is "no catalogue template", and is not the same thing as `default`:
  // that one is a template (the engine's own look) and is recorded as such.
  template = blank ? null : template || "default"
  name = name || "Mon Restaurant"
  description =
    description || "Commande en ligne, click & collect et livraison."
  locale = locale || "fr"
  const slug = slugify(name) || "beindigital-site"

  console.log("\n1. site.config.ts")
  replaceOnce("site.config.ts", 'name: "Mon Restaurant"', `name: ${JSON.stringify(name)}`, "nom")
  replaceOnce(
    "site.config.ts",
    'description: "Commande en ligne, click & collect et livraison."',
    `description: ${JSON.stringify(description)}`,
    "description",
  )
  replaceOnce(
    "site.config.ts",
    'titleTemplate: "%s — Mon Restaurant"',
    `titleTemplate: ${JSON.stringify(`%s — ${name}`)}`,
    "titre",
  )
  replaceOnce(
    "site.config.ts",
    'defaultLocale: "fr"',
    `defaultLocale: ${JSON.stringify(locale)}`,
    "locale",
  )

  console.log("\n2. template design")
  if (blank) {
    // Nothing is copied: site/ keeps what the boilerplate ships, which is the
    // engine's neutral base. On a site that already has a design (`--force`),
    // that design stays; `pnpm template:apply default` is the way back.
    console.log("  = à partir de zéro : aucun design du catalogue (base neutre du moteur)")
  } else {
    const templateMeta = applyTemplate(template, ROOT)
    console.log(
      template === "default"
        ? "  = neutre engine (thème et polices d'origine)"
        : `  ✓ ${templateMeta.label}`,
    )
  }
  const designBrief = designPrompt ? writeBrief(ROOT, { prompt: designPrompt, template }) : undefined
  if (designBrief) console.log(`  ✓ ${designBrief} : brief de design enregistré`)

  console.log("\n3. package.json")
  const pkgPath = path.join(ROOT, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  const templateVersion = pkg.version
  pkg.name = slug
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  console.log(`  ✓ name → ${slug}`)

  console.log("\n4. .env.local")
  const envLocal = path.join(ROOT, ".env.local")
  if (fs.existsSync(envLocal)) {
    console.log("  = .env.local existe déjà, non modifié")
  } else {
    let env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")
    env = env.replace(
      /^BETTER_AUTH_SECRET=.*$/m,
      `BETTER_AUTH_SECRET=${crypto.randomBytes(32).toString("base64")}`,
    )
    env = env.replace(
      /^ENCRYPTION_KEY=.*$/m,
      `ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`,
    )
    fs.writeFileSync(envLocal, env)
    console.log("  ✓ créé (secrets BETTER_AUTH_SECRET / ENCRYPTION_KEY générés)")
  }

  console.log("\n5. remote git `template`")
  try {
    const remotes = execSync("git remote", { cwd: ROOT }).toString().split("\n")
    if (remotes.includes("template")) {
      console.log("  = remote template déjà présent")
    } else {
      execSync(`git remote add template ${TEMPLATE_REPO}`, { cwd: ROOT })
      console.log(`  ✓ template → ${TEMPLATE_REPO}`)
    }
  } catch {
    console.warn("  ! pas de repo git détecté — remote template non ajouté")
  }

  console.log("\n6. sentinel")
  fs.writeFileSync(
    SENTINEL,
    JSON.stringify(
      {
        name,
        slug,
        mobile,
        // `null` when the site was created from scratch.
        template,
        ...(designBrief ? { designBrief } : {}),
        templateRepo: TEMPLATE_REPO,
        templateVersion,
        /* Maintenance contract — read by scripts/lib/maintenance.mjs before an
           update. Absent on a site provisioned outside the console: it then
           updates unchecked rather than being blocked by our bookkeeping. */
        ...(licenseKey ? { licenseKey } : {}),
        ...(licenseApi ? { licenseApi } : {}),
        initializedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  )
  console.log("  ✓ .beindigital-site.json")

  if (mobile) {
    console.log("\n7. app mobile")
    activateMobile({ name, slug })
  }

  const designLabel = blank ? "design : à partir de zéro" : `template design : ${template}`
  const designNextSteps = blank
    ? `Design à composer : site/theme.css, site/fonts.ts et site/layout.ts${designBrief ? `, d'après ${designBrief}` : ""}.
Contrôle : pnpm design:check. Un design du catalogue reste possible : pnpm template:list.`
    : `Couleurs client : site/theme.css (direction :
templates/${template}/DESIGN.md). Changer de template : pnpm template:list.`

  console.log(`
────────────────────────────────────────────────────────
Site "${name}" initialisé (${mobile ? "web + app mobile" : "web"}, ${designLabel}). Prochaines étapes :

  1. pnpx convex dev          # provisionne le deployment Convex
  2. pnpm env:setup           # wizard .env (web + convex + mobile)
  3. pnpm convex:env          # pousse .env.convex côté backend
  4. npx convex env set ADMIN_BOOTSTRAP_TOKEN "$(openssl rand -base64 32)"
                              # sans lui, /setup refuse TOUT LE MONDE et
                              # personne ne peut prendre la main sur l'admin
  5. pnpm dev${mobile ? "\n  6. cd mobile && pnpm install && pnpm start   # app Expo" : ""}

L'étape 4 échoue fermé, exprès : un jeton absent qui laisserait passer
rouvrirait le trou sur exactement les déploiements que personne n'a configurés.
Ce jeton est celui de l'ÉQUIPE, pas du client : /setup n'attribue que le rôle
super_admin, et un restaurateur qui le colle obtiendrait les droits de l'équipe
sur son propre contrat. Un membre de l'équipe crée son compte, ouvre /setup, le
colle, puis retire le jeton (npx convex env remove ADMIN_BOOTSTRAP_TOKEN). Le
siège du restaurateur (client_admin) s'attribue ensuite avec la clé de
déploiement, sans jeton. Procédure complète, avec la restriction de la clé
Google Maps : scripts/wizards/github-e2e-maps-bootstrap.sh dans le monorepo
BeYours — il lit l'état des deux sièges et imprime les commandes.

Avant la mise en prod : créer le projet Sentry DU CLIENT (1 projet par client,
sous SON compte), coller le DSN dans NEXT_PUBLIC_SENTRY_DSN, et le déclarer
aussi sur l'hébergeur — c'est une variable NEXT_PUBLIC_, donc figée au build.
Procédure : docs/SENTRY.md

Personnalisation : site.config.ts, site/ (thème, polices, composants),
public/ (logos). ${designNextSteps}
Voir docs/CUSTOMIZATION.md.
Mises à jour : pnpm update:engine / pnpm update:template. Voir docs/UPDATES.md.
────────────────────────────────────────────────────────`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
