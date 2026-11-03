/**
 * Run the token guard BEFORE pnpm reaches for the network.
 *
 * `preinstall` in package.json cannot do this job. pnpm resolves and fetches
 * first and runs the root `preinstall` after, so a missing `NODE_AUTH_TOKEN`
 * surfaced as « ERR_PNPM_FETCH_401 GET https://npm.pkg.github.com/@be-yours%2F… »
 * — or a 404 from the public registry when `.npmrc` could not expand the token —
 * and the friendly message in `scripts/check-node-auth-token.mjs` never printed.
 * This file is loaded when pnpm starts an install, ahead of both.
 *
 * ONLY for the commands that download packages. pnpm loads this file for every
 * command, `run` and `exec` included, and a guard that stopped `pnpm dev` or
 * `pnpm test` on a machine whose dependencies are already installed — and whose
 * shell has no token, which is the normal state of a developer's terminal —
 * would be worse than the 401 it replaces.
 *
 * The decision stays in the script: the `link:` and `workspace:` modes that need
 * no token, `SKIP_NODE_AUTH_TOKEN_CHECK=1`. This only asks it, early.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- pnpm loads this file as CommonJS; there is no import form */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const FETCHING = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'fetch', 'dedupe'])

const argv = process.argv.slice(2)
const end = argv.indexOf('--')
const args = end === -1 ? argv : argv.slice(0, end)

if (args.some((arg) => FETCHING.has(arg))) {
  const guard = path.join(__dirname, 'scripts', 'check-node-auth-token.mjs')
  const result = spawnSync(process.execPath, [guard], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

module.exports = {}
