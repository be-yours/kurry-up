#!/usr/bin/env node
/**
 * Site environment variable management — all 3 files at once:
 *
 *   .env.local    (Next.js web)      ← source of truth
 *   .env.convex   (Convex backend)   ← shared subset, pushed with
 *                                      `pnpm convex:env`
 *   mobile/.env   (Expo app)         ← EXPO_PUBLIC_CONVEX_URL
 *
 * Usage:
 *   pnpm env:setup    # wizard: required vars + integrations (Stripe, AWS, Uber…)
 *   pnpm env:check    # status: missing required vars, incomplete integrations
 *   pnpm env:sync     # propagates .env.local → .env.convex + mobile/.env
 *
 * The variable lists are NOT restated here. They come from `envManifest` in
 * @be-yours/core/env, which derives them from the Zod schemas the app
 * boots against.
 *
 * They used to be three local arrays under the instruction "keep them in sync
 * when the engine is updated". Nobody can follow that reliably and nobody had:
 * `CONVEX_KEYS` was missing eleven keys that `convex/*.ts` reads from
 * `process.env` — AWS_S3_PUBLIC_BASE_URL, EMAIL_API_SECRET,
 * ADMIN_BOOTSTRAP_TOKEN, the BID_* billing set. A key missing there is not a
 * lint failure: it is a Convex function reading `undefined` in production,
 * visible only when a customer's email does not arrive. See #37.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { envManifest } from "@be-yours/core/env"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const ENV_LOCAL = path.join(ROOT, ".env.local")
const ENV_EXAMPLE = path.join(ROOT, ".env.example")
const ENV_CONVEX = path.join(ROOT, ".env.convex")
const ENV_MOBILE = path.join(ROOT, "mobile", ".env")

/**
 * Required for the site to boot — the same list `instrumentation.ts` enforces,
 * because it is the same list.
 *
 * The hand-written version of this array was wrong in both directions: it
 * carried CONVEX_DEPLOYMENT, BETTER_AUTH_URL and NEXT_PUBLIC_APP_URL, which are
 * optional and which the wizard therefore nagged about forever, and it omitted
 * the five AWS variables and OPENAI_API_KEY, without which the deployment
 * refuses to start. A wizard that reports green on a site that cannot boot is
 * worse than no wizard.
 */
const REQUIRED = envManifest.required

/** Automatic generators used when the value is empty. */
const GENERATORS = {
  BETTER_AUTH_SECRET: () => crypto.randomBytes(32).toString("base64"),
  ENCRYPTION_KEY: () => crypto.randomBytes(32).toString("hex"),
}

/**
 * Optional integrations, enabled one by one in the wizard.
 *
 * `feature` and `vars` come straight from the manifest. `requiredTogether` is
 * the subset the schema refuses to see half-configured, and it replaces the
 * local guess this script used to make: it filtered out a hard-coded set of
 * "keys with defaults" to decide whether a group was on. That guess and the
 * schema's rule disagreed about STRIPE_PUBLISHABLE_KEY, so a correctly
 * configured Stripe reported as INCOMPLET.
 */
const GROUPS = envManifest.groups.map((group) => ({
  name: group.feature,
  keys: [...group.vars],
  requiredTogether: [...group.requiredTogether],
}))

/**
 * Keys to replicate on the Convex side (backend functions).
 *
 * Convex functions run in their own isolate with their own environment: a value
 * in `.env.local` is invisible to them. This is the measured set of what
 * `convex/*.ts` and the packages it imports read from `process.env`.
 */
const CONVEX_KEYS = envManifest.convexKeys

// ---------------------------------------------------------------------------

function parse(file) {
  if (!fs.existsSync(file)) return {}
  const vars = {}
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m) vars[m[1]] = m[2].trim()
  }
  return vars
}

/** Writes KEY=VALUE into `file`: replaces the existing line, or appends it. */
function upsert(file, updates, { headerForNew } = {}) {
  let src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const missing = []
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m")
    if (re.test(src)) src = src.replace(re, `${key}=${value}`)
    else missing.push(`${key}=${value}`)
  }
  if (missing.length) {
    if (!src.endsWith("\n") && src !== "") src += "\n"
    if (headerForNew) src += `\n# --- ${headerForNew} ---\n`
    src += missing.join("\n") + "\n"
  }
  fs.writeFileSync(file, src)
}

function ensureFromExample(file, example) {
  if (fs.existsSync(file)) return false
  fs.copyFileSync(path.join(ROOT, example), file)
  return true
}

const isSet = (v) =>
  v !== undefined &&
  v !== "" &&
  !/your-deployment|sk_test_\.\.\.|pk_test_\.\.\.|whsec_\.\.\.|sk-\.\.\./.test(v)

/**
 * The keys that decide whether a group counts as configured.
 *
 * The schema's own all-or-nothing rule when it has one — those are exactly the
 * variables `siteEnvOptionalSchema` refuses to see set by halves, so agreeing
 * with it means `env:check` and the boot check can never disagree. For a group
 * the schema does not constrain (a lone API key, a sandbox flag), every
 * variable in it is a signal.
 *
 * The sandbox flags are deliberately NOT excluded any more. They have their own
 * rule in `env/sandbox.ts`: a flag must be DECLARED, not inherited from a
 * default, so treating one as "pre-filled, ignore it" was the opposite of what
 * the engine asks for.
 */
const signalKeys = (group) =>
  group.requiredTogether.length ? group.requiredTogether : group.keys

function groupStatus(vars, group, shipped = parse(ENV_EXAMPLE)) {
  const sig = signalKeys(group)
  const set = sig.filter((k) => isSet(vars[k]))
  // A value `.env.example` ships already — `UBER_EATS_SANDBOX_MODE=true`,
  // `DELIVEROO_IS_SANDBOX=true`, `BID_APP_URL=http://localhost:3000` — was not
  // chosen by anybody, and it used to switch its whole group on: a fresh site,
  // with nothing configured, reported Uber Eats, Deliveroo and BeYours billing
  // as « INCOMPLET » and « 3 point(s) à corriger ». The first thing a
  // restaurateur's agency read from `env:check` was three problems that were
  // not there. Such a value still COUNTS toward a group that something else
  // switched on — credentials set and the flag deleted is still « partial » —
  // it just cannot be the thing that switches it on.
  const chosen = set.filter((k) => !isSet(shipped[k]))
  if (chosen.length === 0) return "off"
  if (set.length === sig.length) return "ok"
  return "partial"
}

/**
 * The deployment's HTTP address, derived from its API address.
 *
 * `npx convex dev` writes NEXT_PUBLIC_CONVEX_URL (`https://x.convex.cloud`) into
 * `.env.local` and nothing for CONVEX_SITE_URL (`https://x.convex.site`), which
 * is just as required — webhooks, OAuth callbacks and the health check all use
 * it. The wizard said it would be « remplie par \`pnpx convex dev\` », which was
 * not true, so a site came up with the key empty and the first symptom was a
 * webhook that went nowhere. The two names are one deployment's two hosts, so
 * the second is derived from the first. Anything that is not a cloud deployment
 * (a self-hosted backend, a typo) is left for a person to fill in.
 */
function convexSiteUrlFrom(apiUrl) {
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec(apiUrl ?? "")
  return match ? `https://${match[1]}.convex.site` : undefined
}

// ---------------------------------------------------------------------------

async function check({ quiet } = {}) {
  const web = parse(ENV_LOCAL)
  const convex = parse(ENV_CONVEX)
  const hasMobile = fs.existsSync(path.join(ROOT, "mobile"))
  let problems = 0

  if (!fs.existsSync(ENV_LOCAL)) {
    console.log("✗ .env.local absent — lancer `pnpm env:setup`")
    return 1
  }

  console.log("Requis (web) :")
  for (const key of REQUIRED) {
    const ok = isSet(web[key])
    if (!ok) problems++
    console.log(`  ${ok ? "✓" : "✗"} ${key}`)
  }

  console.log("\nIntégrations :")
  for (const group of GROUPS) {
    const st = groupStatus(web, group)
    if (st === "partial") {
      problems++
      const missing = signalKeys(group).filter((k) => !isSet(web[k]))
      console.log(`  ◐ ${group.name} — INCOMPLET : ${missing.join(", ")}`)
    } else {
      console.log(`  ${st === "ok" ? "✓" : "·"} ${group.name}${st === "off" ? " (inactif)" : ""}`)
    }
  }

  console.log("\nPropagation :")
  const convexDrift = CONVEX_KEYS.filter(
    (k) => isSet(web[k]) && convex[k] !== web[k],
  )
  if (!fs.existsSync(ENV_CONVEX)) {
    console.log("  ✗ .env.convex absent — `pnpm env:sync` puis `pnpm convex:env`")
    problems++
  } else if (convexDrift.length) {
    console.log(`  ✗ .env.convex désynchronisé (${convexDrift.length} clés : ${convexDrift.slice(0, 4).join(", ")}${convexDrift.length > 4 ? "…" : ""}) — \`pnpm env:sync\``)
    problems++
  } else {
    console.log("  ✓ .env.convex aligné (penser à `pnpm convex:env` après modif)")
  }

  if (hasMobile) {
    const mobile = parse(ENV_MOBILE)
    if (isSet(web.NEXT_PUBLIC_CONVEX_URL) && mobile.EXPO_PUBLIC_CONVEX_URL !== web.NEXT_PUBLIC_CONVEX_URL) {
      console.log("  ✗ mobile/.env : EXPO_PUBLIC_CONVEX_URL ≠ NEXT_PUBLIC_CONVEX_URL — `pnpm env:sync`")
      problems++
    } else {
      console.log("  ✓ mobile/.env aligné")
    }
  }

  // Official engine validation (Zod schemas from @be-yours/core) — the
  // authoritative layer when node_modules is installed; silent otherwise.
  try {
    for (const [k, v] of Object.entries(web)) {
      if (process.env[k] === undefined) process.env[k] = v
    }
    const { validateAllEnv, formatEnvReport } = await import(
      "@be-yours/core/env"
    )
    const { ok, missing } = validateAllEnv()
    if (ok) {
      console.log("\nValidation @be-yours/core : ✓")
    } else {
      problems += 1
      console.log("\nValidation @be-yours/core :")
      console.log(formatEnvReport(missing))
    }
  } catch {
    console.log(
      "\n(validation @be-yours/core indisponible — lancer pnpm install)",
    )
  }

  if (!quiet) {
    console.log(
      problems === 0
        ? "\nEnvironnement complet."
        : `\n${problems} point(s) à corriger.`,
    )
  }
  return problems === 0 ? 0 : 1
}

function sync() {
  if (!fs.existsSync(ENV_LOCAL)) {
    console.error(".env.local absent — lancer `pnpm env:setup` d'abord.")
    process.exit(1)
  }
  const web = parse(ENV_LOCAL)

  ensureFromExample(ENV_CONVEX, ".env.convex.example")
  const convexUpdates = {}
  for (const key of CONVEX_KEYS) {
    if (isSet(web[key])) convexUpdates[key] = web[key]
  }
  upsert(ENV_CONVEX, convexUpdates, { headerForNew: "Synchronisé depuis .env.local" })
  console.log(`✓ .env.convex : ${Object.keys(convexUpdates).length} clés propagées`)

  if (fs.existsSync(path.join(ROOT, "mobile"))) {
    if (isSet(web.NEXT_PUBLIC_CONVEX_URL)) {
      upsert(ENV_MOBILE, { EXPO_PUBLIC_CONVEX_URL: web.NEXT_PUBLIC_CONVEX_URL })
      console.log("✓ mobile/.env : EXPO_PUBLIC_CONVEX_URL alignée")
    } else {
      console.log("· mobile/.env : NEXT_PUBLIC_CONVEX_URL pas encore définie (lancer `pnpx convex dev`)")
    }
  }

  console.log("\nPousser côté backend : pnpm convex:env   (applique .env.convex via convex env set)")
}

async function setup() {
  const created = ensureFromExample(ENV_LOCAL, ".env.example")
  if (created) console.log("✓ .env.local créé depuis .env.example")
  const web = parse(ENV_LOCAL)

  // 1. Auto-generated secrets
  const generated = {}
  for (const [key, gen] of Object.entries(GENERATORS)) {
    if (!isSet(web[key])) {
      generated[key] = gen()
      web[key] = generated[key]
    }
  }
  if (Object.keys(generated).length) {
    upsert(ENV_LOCAL, generated)
    console.log(`✓ secrets générés : ${Object.keys(generated).join(", ")}`)
  }

  // Prompt that works with both a TTY AND piped stdin: lines are queued as
  // they arrive; after EOF, any remaining question resolves to "" (= default).
  // (Plain readline.question never resolves a question asked after the pipe
  // has closed.)
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
  const ask = async (q, fallback = "") => {
    process.stdout.write(`${q}${fallback ? ` (${fallback})` : ""} : `)
    const a = (await nextLine()).trim()
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`)
    return a || fallback
  }

  // 2. Missing required vars
  console.log("\n— Variables requises (Entrée = laisser vide / garder) —")
  const updates = {}
  for (const key of REQUIRED) {
    if (isSet(web[key])) continue
    if (key === "CONVEX_SITE_URL") {
      // From a real value only: the example ships `https://your-deployment.convex.cloud`,
      // which matches the pattern and would be « derived » into another placeholder.
      const derived = convexSiteUrlFrom(
        isSet(web.NEXT_PUBLIC_CONVEX_URL) ? web.NEXT_PUBLIC_CONVEX_URL : undefined
      )
      if (derived) {
        updates[key] = derived
        web[key] = derived
        console.log(`  ✓ ${key} : déduite de NEXT_PUBLIC_CONVEX_URL (${derived})`)
      } else {
        console.log(
          `  · ${key} : à renseigner — l'adresse en \`.convex.site\` du même déploiement. ` +
            "`pnpx convex dev` ne l'écrit pas ; relancer `pnpm env:setup` une fois " +
            "NEXT_PUBLIC_CONVEX_URL connue, elle sera déduite."
        )
      }
      continue
    }
    if (key.startsWith("NEXT_PUBLIC_CONVEX") || key.startsWith("CONVEX")) {
      console.log(`  · ${key} : sera remplie par \`pnpx convex dev\``)
      continue
    }
    const def =
      key === "BETTER_AUTH_URL" || key === "SITE_URL" || key === "NEXT_PUBLIC_APP_URL"
        ? "http://localhost:3000"
        : ""
    const v = await ask(`  ${key}`, def)
    if (v) {
      updates[key] = v
      web[key] = v
    }
  }

  // 3. Integrations
  console.log("\n— Intégrations (activer ? y/N ; Entrée = garder la valeur) —")
  for (const group of GROUPS) {
    const st = groupStatus(web, group)
    const on = await ask(`${group.name}${st !== "off" ? " [déjà partiellement configurée]" : ""} — activer ?`, st === "off" ? "N" : "y")
    if (!/^y(es)?$/i.test(on)) continue
    for (const key of group.keys) {
      const v = await ask(`    ${key}`, web[key] || "")
      if (v && v !== web[key]) {
        updates[key] = v
        web[key] = v
      }
    }
  }
  rl.close()

  if (Object.keys(updates).length) upsert(ENV_LOCAL, updates)
  console.log(`\n✓ .env.local à jour (${Object.keys(updates).length} clés modifiées)`)

  // 4. Propagate to convex + mobile, then report the final state
  sync()
  console.log("")
  await check({ quiet: true })
}

// ---------------------------------------------------------------------------

const cmd = process.argv[2]
if (cmd === "check") process.exit(await check())
else if (cmd === "sync") sync()
else if (cmd === "setup") await setup()
else {
  console.error("Usage : env.mjs <setup|check|sync>")
  process.exit(1)
}
