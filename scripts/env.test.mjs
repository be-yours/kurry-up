import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `pnpm env:check` and `pnpm env:setup` on a site nobody has configured yet.
 *
 * WHAT WENT WRONG. Run on a fresh clone — nothing configured, `.env.local` just
 * copied from `.env.example` — `env:check` ended on « 3 point(s) à corriger »:
 * Uber Eats, Deliveroo and BeYours billing, all « INCOMPLET ». None of the three
 * was configured. `.env.example` ships `UBER_EATS_SANDBOX_MODE=true`,
 * `DELIVEROO_IS_SANDBOX=true` and `BID_APP_URL=http://localhost:3000`, and the
 * wizard took each shipped default for a choice the owner had made, switched the
 * group on, and found its credentials missing. The first report an agency read
 * about a new site was three problems that were not there.
 *
 * Separately, the wizard said `CONVEX_SITE_URL` « sera remplie par `pnpx convex
 * dev` ». It is not: `convex dev` writes `NEXT_PUBLIC_CONVEX_URL` and stops, the
 * `.convex.site` half is just as required, and a site came up with it empty.
 *
 * The suite drives the real script in a sandbox laid out like a site (the
 * script derives its root from its own location), so what it exercises is what
 * an operator runs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.join(HERE, '..')

let sandbox

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
  sandbox = undefined
})

/** A site-shaped directory: the real script and examples, a chosen `.env.local`. */
function site(envLocal) {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'env-wizard-'))
  fs.mkdirSync(path.join(sandbox, 'scripts'))
  fs.copyFileSync(path.join(HERE, 'env.mjs'), path.join(sandbox, 'scripts', 'env.mjs'))
  for (const file of ['.env.example', '.env.convex.example']) {
    fs.copyFileSync(path.join(SITE, file), path.join(sandbox, file))
  }
  // Resolves `@be-yours/core/env` the way the real site does.
  fs.symlinkSync(path.join(SITE, 'node_modules'), path.join(sandbox, 'node_modules'))
  if (envLocal !== undefined) fs.writeFileSync(path.join(sandbox, '.env.local'), envLocal)
  return sandbox
}

function run(command) {
  const result = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'env.mjs'), command], {
    cwd: sandbox,
    input: '',
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    timeout: 60_000,
  })
  return { out: `${result.stdout}${result.stderr}`, status: result.status }
}

const example = () => fs.readFileSync(path.join(SITE, '.env.example'), 'utf8')
const local = () => fs.readFileSync(path.join(sandbox, '.env.local'), 'utf8')

describe('env:check on a fresh site', () => {
  it('reports no integration as incomplete when nothing was configured', () => {
    site(example())

    const { out } = run('check')

    expect(out).not.toMatch(/INCOMPLET/)
    expect(out).toMatch(/Uber Eats.*\(inactif\)/)
    expect(out).toMatch(/Deliveroo.*\(inactif\)/)
    expect(out).toMatch(/BeYours billing.*\(inactif\)/)
  })

  it('still calls an integration incomplete once its credentials are chosen', () => {
    // Credentials set, the sandbox flag deleted: the engine wants it DECLARED,
    // so this is half-configured and has to say so.
    const withoutFlag = example()
      .split('\n')
      .filter((line) => !line.startsWith('UBER_EATS_SANDBOX_MODE='))
      .map((line) =>
        line
          .replace(/^UBER_EATS_CLIENT_ID=.*/, 'UBER_EATS_CLIENT_ID=client-id')
          .replace(/^UBER_EATS_CLIENT_SECRET=.*/, 'UBER_EATS_CLIENT_SECRET=client-secret')
          .replace(/^UBER_EATS_WEBHOOK_SECRET=.*/, 'UBER_EATS_WEBHOOK_SECRET=hook-secret'),
      )
      .join('\n')
    site(withoutFlag)

    const { out } = run('check')

    expect(out).toMatch(/Uber Eats.*INCOMPLET : UBER_EATS_SANDBOX_MODE/)
  })

  it('calls an integration configured when credentials and flag are all there', () => {
    const complete = example()
      .replace(/^UBER_EATS_CLIENT_ID=.*/m, 'UBER_EATS_CLIENT_ID=client-id')
      .replace(/^UBER_EATS_CLIENT_SECRET=.*/m, 'UBER_EATS_CLIENT_SECRET=client-secret')
      .replace(/^UBER_EATS_WEBHOOK_SECRET=.*/m, 'UBER_EATS_WEBHOOK_SECRET=hook-secret')
    site(complete)

    const { out } = run('check')

    expect(out).toMatch(/✓ Uber Eats/)
  })
})

describe('env:setup and CONVEX_SITE_URL', () => {
  it('derives it from NEXT_PUBLIC_CONVEX_URL, which `convex dev` does write', () => {
    site(
      example().replace(
        /^NEXT_PUBLIC_CONVEX_URL=.*/m,
        'NEXT_PUBLIC_CONVEX_URL=https://happy-otter-123.convex.cloud',
      ),
    )

    const { out } = run('setup')

    expect(local()).toMatch(/^CONVEX_SITE_URL=https:\/\/happy-otter-123\.convex\.site$/m)
    expect(out).toMatch(/CONVEX_SITE_URL : déduite de NEXT_PUBLIC_CONVEX_URL/)
  })

  it('does not claim `convex dev` will write it when it cannot be derived', () => {
    site(example())

    const { out } = run('setup')

    const line = out.split('\n').find((l) => l.includes('CONVEX_SITE_URL')) ?? ''
    expect(line).toMatch(/à renseigner/)
    expect(line).not.toMatch(/sera remplie par/)
  })

  it('leaves a self-hosted address alone rather than guessing', () => {
    site(
      example().replace(
        /^NEXT_PUBLIC_CONVEX_URL=.*/m,
        'NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210',
      ),
    )

    run('setup')

    // Still the example's placeholder: not replaced by a guess.
    expect(local()).toMatch(/^CONVEX_SITE_URL=https:\/\/your-deployment\.convex\.site$/m)
  })
})
