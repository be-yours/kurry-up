import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The missing-token guard speaks BEFORE pnpm reaches for the network.
 *
 * WHAT WENT WRONG. `scripts/check-node-auth-token.mjs` exists to turn the opaque
 * « ERR_PNPM_FETCH_401 » of a missing `NODE_AUTH_TOKEN` into a message that says
 * what to do. It was wired as the root `preinstall`, and pnpm resolves and
 * fetches before it runs the root `preinstall`: on a clone with no token the
 * operator read « ERR_PNPM_FETCH_401 GET https://npm.pkg.github.com/@be-yours%2F… »
 * (or a 404 from the public registry, when `.npmrc` could not expand the token)
 * and the guard never printed. Found by running the install of a freshly
 * created site, which is the first thing an operator does after `create-site`.
 *
 * `.pnpmfile.cjs` is loaded when an install starts, ahead of resolution. These
 * cases run the real pnpm in a sandbox shaped like a clone — the script, the
 * pnpmfile, a package.json that depends on a private package — with no token and
 * no way to reach a registry that would answer.
 *
 * The second half matters as much as the first: pnpm loads the pnpmfile for
 * EVERY command, and a guard that stopped `pnpm dev` on a machine whose
 * dependencies are already installed would be worse than the 401.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.join(HERE, '..')

let sandbox

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
  sandbox = undefined
})

function clone({ overrides } = {}) {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-'))
  fs.mkdirSync(path.join(sandbox, 'scripts'))
  fs.copyFileSync(
    path.join(HERE, 'check-node-auth-token.mjs'),
    path.join(sandbox, 'scripts', 'check-node-auth-token.mjs'),
  )
  fs.copyFileSync(path.join(SITE, '.pnpmfile.cjs'), path.join(sandbox, '.pnpmfile.cjs'))
  fs.writeFileSync(
    path.join(sandbox, 'package.json'),
    JSON.stringify(
      {
        name: 'token-guard-probe',
        version: '1.0.0',
        private: true,
        scripts: {
          preinstall: 'node scripts/check-node-auth-token.mjs',
          noop: 'node -e "console.log(\'noop ran\')"',
        },
        dependencies: { '@be-yours/ui': '^1.2.1' },
        ...(overrides ? { pnpm: { overrides } } : {}),
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(sandbox, '.npmrc'),
    '@be-yours:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n',
  )
}

function pnpm(args, env = {}) {
  const { NODE_AUTH_TOKEN: _drop, SKIP_NODE_AUTH_TOKEN_CHECK: _skip, ...inherited } = process.env
  const result = spawnSync('pnpm', args, {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...inherited, ...env },
    timeout: 60_000,
  })
  return { out: `${result.stdout}${result.stderr}`, status: result.status }
}

describe('an install with no token', () => {
  it('prints the setup message and stops before any download', () => {
    clone()

    const { out, status } = pnpm(['install'])

    expect(out).toMatch(/NODE_AUTH_TOKEN is not set/)
    expect(out).not.toMatch(/ERR_PNPM_FETCH/)
    expect(status).not.toBe(0)
  })

  it('does the same for `pnpm add`, which downloads too', () => {
    clone()

    const { out } = pnpm(['add', 'left-pad'])

    expect(out).toMatch(/NODE_AUTH_TOKEN is not set/)
  })

  it('lets the documented bypass through', () => {
    clone()

    // `--offline`: the guard is all this is asking about, and a test that waited
    // on a registry would be one more thing a flaky network could fail.
    const { out } = pnpm(['install', '--offline'], { SKIP_NODE_AUTH_TOKEN_CHECK: '1' })

    expect(out).not.toMatch(/NODE_AUTH_TOKEN is not set/)
  })

  it('lets a tarball install through, which downloads no private package', () => {
    // How `pnpm check:mirror-build` installs what a client would resolve.
    clone({ overrides: { '@be-yours/ui': 'file:../ui.tgz' } })

    const { out } = pnpm(['install', '--offline'])

    expect(out).not.toMatch(/NODE_AUTH_TOKEN is not set/)
  })
})

describe('the other commands', () => {
  it('does not stop `pnpm run` on a machine with no token', () => {
    clone()

    const { out, status } = pnpm(['run', 'noop'])

    expect(out).toMatch(/noop ran/)
    expect(status).toBe(0)
  })

  it('does not stop `pnpm exec` either', () => {
    clone()

    const { out, status } = pnpm(['exec', 'node', '-e', "console.log('exec ran')"])

    expect(out).toMatch(/exec ran/)
    expect(status).toBe(0)
  })
})
