#!/usr/bin/env node
/**
 * Development mode: consume the @be-yours/* packages from a local clone
 * of beyours (pnpm symlinks) instead of the GitHub Packages registry.
 * Useful to:
 *   - develop the engine and a site side by side without publishing;
 *   - validate the boilerplate without a NODE_AUTH_TOKEN.
 *
 * Usage:
 *   node scripts/engine-link.js link [path-to-engine-clone]
 *   node scripts/engine-link.js unlink
 *
 * The default path comes from BID_ENGINE_PATH, falling back to ../beyours.
 * WARNING: never commit package.json/pnpm-lock.yaml while in link mode
 * (they carry `link:` overrides). `unlink` cleans up both.
 */

import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const PKG_PATH = path.join(ROOT, "package.json")

const cmd = process.argv[2]
const engineArg = process.argv[3]

function run(command, opts = {}) {
  execSync(command, { stdio: "inherit", cwd: ROOT, ...opts })
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_PATH, "utf8"))
}

function writePkg(pkg) {
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n")
}

function link() {
  const enginePath = path.resolve(
    engineArg || process.env.BID_ENGINE_PATH || path.join(ROOT, "..", "beyours"),
  )
  const packagesDir = path.join(enginePath, "packages")
  if (!fs.existsSync(path.join(packagesDir, "core", "package.json"))) {
    console.error(`Clone engine introuvable : ${packagesDir}`)
    console.error(
      "git clone https://github.com/be-yours/beyours puis relancer avec le chemin en argument ou BID_ENGINE_PATH.",
    )
    process.exit(1)
  }

  // The engine packages import each other (workspace:*). In link mode their
  // imports resolve inside the clone, so the clone has to be installed.
  if (!fs.existsSync(path.join(enginePath, "node_modules"))) {
    console.log(`Installation du clone engine (${enginePath})…`)
    run("pnpm install", { cwd: enginePath })
  }

  // Some packages ship built (exports → dist/): on the registry dist is
  // produced at publish time, but a raw clone has none. So build every
  // package that declares a build script and has no dist yet.
  const needBuild = fs.readdirSync(packagesDir).some((dir) => {
    const pkgJson = path.join(packagesDir, dir, "package.json")
    if (!fs.existsSync(pkgJson)) return false
    const j = JSON.parse(fs.readFileSync(pkgJson, "utf8"))
    return (
      j.scripts &&
      j.scripts.build &&
      !fs.existsSync(path.join(packagesDir, dir, "dist"))
    )
  })
  if (needBuild) {
    console.log("Build des packages engine (dist/ manquants)…")
    run('pnpm -r --filter "./packages/**" run build', { cwd: enginePath })
  }

  const pkg = readPkg()
  pkg.pnpm = pkg.pnpm || {}
  pkg.pnpm.overrides = pkg.pnpm.overrides || {}
  const linked = []
  for (const dir of fs.readdirSync(packagesDir)) {
    const pkgJson = path.join(packagesDir, dir, "package.json")
    if (!fs.existsSync(pkgJson)) continue
    const { name } = JSON.parse(fs.readFileSync(pkgJson, "utf8"))
    if (!name || !name.startsWith("@be-yours/")) continue
    pkg.pnpm.overrides[name] = `link:${path.join(packagesDir, dir)}`
    linked.push(name)
  }
  writePkg(pkg)
  console.log(`Overrides link: posés pour ${linked.length} packages.`)

  run("pnpm install", {
    env: {
      ...process.env,
      SKIP_NODE_AUTH_TOKEN_CHECK: "1",
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN || "link-mode-placeholder",
    },
  })

  // React type alignment: the TS sources of the linked packages (and the
  // .d.ts of their peer deps such as radix) resolve @types/react inside the
  // engine clone → two copies that tsc considers nominally incompatible (a
  // non-issue in registry mode, where everything lives in the site's
  // node_modules). So replace the REAL copy in the clone's .pnpm store with a
  // symlink to the site's copy: every link chain then converges on it.
  const pnpmStore = path.join(enginePath, "node_modules", ".pnpm")
  for (const typesPkg of ["react", "react-dom"]) {
    const target = path.join(ROOT, "node_modules", "@types", typesPkg)
    if (!fs.existsSync(target) || !fs.existsSync(pnpmStore)) continue
    const realTarget = fs.realpathSync(target)
    for (const entry of fs.readdirSync(pnpmStore)) {
      if (!entry.startsWith(`@types+${typesPkg}@`)) continue
      const real = path.join(pnpmStore, entry, "node_modules", "@types", typesPkg)
      if (!fs.existsSync(real) || fs.lstatSync(real).isSymbolicLink()) continue
      fs.rmSync(real, { recursive: true, force: true })
      fs.symlinkSync(realTarget, real)
    }
  }

  // Marker for next.config.ts: in link mode Turbopack needs a root that
  // encloses the engine clone (otherwise "Module not found" on TS sources
  // outside the project). Compute the common ancestor; next.config applies it
  // through outputFileTracingRoot for as long as the marker exists.
  let commonRoot = path.dirname(ROOT)
  while (!path.resolve(enginePath).startsWith(commonRoot + path.sep)) {
    const parent = path.dirname(commonRoot)
    if (parent === commonRoot) break
    commonRoot = parent
  }
  fs.writeFileSync(
    path.join(ROOT, ".engine-link.json"),
    JSON.stringify({ enginePath, tracingRoot: commonRoot }, null, 2) + "\n",
  )

  console.log(`
Mode link ACTIF (engine : ${enginePath}, tracing root : ${commonRoot}).
⚠ Ne pas commiter package.json / pnpm-lock.yaml dans cet état.
Retour au registre : pnpm engine:unlink`)
}

function unlink() {
  const pkg = readPkg()
  if (pkg.pnpm && pkg.pnpm.overrides) {
    for (const key of Object.keys(pkg.pnpm.overrides)) {
      if (key.startsWith("@be-yours/")) delete pkg.pnpm.overrides[key]
    }
    if (Object.keys(pkg.pnpm.overrides).length === 0) delete pkg.pnpm.overrides
    if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm
  }
  // onlyBuiltDependencies also lives under pnpm: restore it if it got dropped
  pkg.pnpm = pkg.pnpm || {}
  pkg.pnpm.onlyBuiltDependencies = pkg.pnpm.onlyBuiltDependencies || [
    "esbuild",
    "sharp",
    "unrs-resolver",
  ]
  writePkg(pkg)

  const lock = path.join(ROOT, "pnpm-lock.yaml")
  if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8").includes("link:")) {
    fs.rmSync(lock)
    console.log("pnpm-lock.yaml (mode link) supprimé.")
  }
  const marker = path.join(ROOT, ".engine-link.json")
  if (fs.existsSync(marker)) fs.rmSync(marker)
  console.log(
    "Overrides retirés. Relancer `pnpm install` avec NODE_AUTH_TOKEN pour revenir au registre.",
  )
}

if (cmd === "link") link()
else if (cmd === "unlink") unlink()
else {
  console.error("Usage : engine-link.js <link [chemin]|unlink>")
  process.exit(1)
}
