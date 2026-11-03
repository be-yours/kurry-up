import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest"

/**
 * `pnpm convex:env:infisical` — the bridge that carries BeYours' shared
 * credentials from Infisical onto one client's Convex deployment.
 *
 * It is the last link of the rotation chain: `tasks/secret-rotation-runbook.md`
 * §A.1 says "change the value once in the store, then run this in each client
 * repo". So a wrong answer here is not a broken script, it is a rotation that
 * everybody believes happened. Two wrong answers were shipped before these
 * tests existed, and the 4 Sep 2026 audit measured both (issue #328):
 *
 *  1. `INFISICAL_PATH` defaulted to `/`, the root folder, which holds ZERO keys
 *     in every environment — every secret lives one level down. The documented
 *     rotation therefore printed a green "0 variables set" per client and
 *     propagated nothing: every restaurant kept the revoked credential.
 *  2. Whatever a folder held was pushed unfiltered. A witness run against
 *     `/themes` answered `would set JWT_PRIVATE_KEY / JWKS / ENCRYPTION_KEY /
 *     BETTER_AUTH_SECRET` — per-deployment secrets, one copy of which on two
 *     deployments means either client's leak decrypts the other's OAuth tokens.
 *
 * The suite drives the real script with a stub `infisical` and a stub `pnpx` on
 * PATH, so it exercises the shell as an operator runs it, with values the test
 * chooses. Every case also asserts that no value reached the output: this
 * script's header promises key names only, and a test harness that prints
 * secrets would be the first place to break that promise.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, "setup-convex-env.sh")
/** The engine's copy of the skip-list. Absent in a client clone — see below. */
const BOOTSTRAP = path.join(HERE, "..", "..", "..", "scripts", "infisical-bootstrap.mjs")

/**
 * Values the stubs hand back. Chosen to be unmistakable in an assertion: if any
 * of these strings appears on stdout or stderr, the script leaked a value.
 */
const VALUES = {
  OPENAI_API_KEY: "sk-witness-openai",
  DELIVEROO_CLIENT_SECRET: "witness-deliveroo-secret",
  STRIPE_BID_PRICE_PRO: "price_witness_pro",
  JWT_PRIVATE_KEY: "witness-jwt-private",
  JWKS: "witness-jwks",
  ENCRYPTION_KEY: "witness-encryption-key",
  BETTER_AUTH_SECRET: "witness-better-auth",
  EMAIL_API_SECRET: "witness-email-api",
  ADMIN_BOOTSTRAP_TOKEN: "witness-bootstrap-token",
  SEED_PASSWORD: "witness-seed-password",
}
const dotenv = (keys) => keys.map((k) => `${k}=${VALUES[k]}\n`).join("")

let stubDir
let workDir

beforeAll(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-env-stub-"))

  // A stub `infisical` that replays one canned export. FAKE_EXPORT is the whole
  // dotenv body; FAKE_EXPORT_PATH records the --path it was asked for, so a
  // test can assert which folder the script actually read.
  fs.writeFileSync(
    path.join(stubDir, "infisical"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "export" ]; then',
      '  for arg in "$@"; do',
      '    case "$arg" in --path=*) echo "${arg#--path=}" > "$FAKE_PATH_LOG" ;; esac',
      "  done",
      '  printf \'%s\' "${FAKE_EXPORT:-}"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )

  // A stub `pnpx` that records every `convex env set` as one KEY line. It never
  // records the value: the log is read by assertions, and a log holding secrets
  // is a secret in a temp file.
  fs.writeFileSync(
    path.join(stubDir, "pnpx"),
    [
      "#!/usr/bin/env bash",
      '# pnpx convex env set <KEY> <VALUE> [--prod]',
      'if [ "$1" = "convex" ] && [ "$2" = "env" ] && [ "$3" = "set" ]; then',
      '  echo "$4" >> "$FAKE_SET_LOG"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
})

afterAll(() => {
  fs.rmSync(stubDir, { recursive: true, force: true })
})

afterEach(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  workDir = undefined
})

/**
 * Runs the script in a throwaway cwd, with the stubs first on PATH.
 *
 * `env.INFISICAL_PATH` is only set when a test passes it, so "unset" can be
 * tested — which is the case that used to mean `/`.
 */
function run({ args = ["--infisical", "--dry-run"], exported = [], envConvex, env = {} } = {}) {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-env-work-"))
  const setLog = path.join(workDir, "set.log")
  const pathLog = path.join(workDir, "path.log")
  fs.writeFileSync(setLog, "")
  fs.writeFileSync(pathLog, "")
  if (envConvex !== undefined) fs.writeFileSync(path.join(workDir, ".env.convex"), envConvex)

  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: workDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      INFISICAL_PROJECT_ID: "witness-project",
      INFISICAL_ENV: "prod",
      FAKE_EXPORT: dotenv(exported),
      FAKE_SET_LOG: setLog,
      FAKE_PATH_LOG: pathLog,
      ...env,
    },
  })

  const output = `${result.stdout}${result.stderr}`
  return {
    status: result.status,
    output,
    /** Folder the stub CLI was actually asked to export. */
    readPath: fs.readFileSync(pathLog, "utf8").trim(),
    /** Keys really handed to `convex env set`. Empty on a dry run. */
    setKeys: fs.readFileSync(setLog, "utf8").split("\n").filter(Boolean),
    /** Keys the dry run said it would set. */
    wouldSet: [...output.matchAll(/^ {2}would set ([A-Z_][A-Z0-9_]*)$/gm)].map((m) => m[1]),
  }
}

/** No test may pass while a value is on the output. Asserted everywhere. */
function expectNoValueLeaked(output) {
  for (const [key, value] of Object.entries(VALUES)) {
    expect(output, `${key}'s value reached the output`).not.toContain(value)
  }
}

describe("the Infisical path", () => {
  it("defaults to /platform, not to the empty root folder", () => {
    const r = run({ exported: ["OPENAI_API_KEY"] })
    expect(r.status).toBe(0)
    expect(r.readPath).toBe("/platform")
    expectNoValueLeaked(r.output)
  })

  it("refuses an explicit root path instead of exporting nothing", () => {
    // The exact configuration of the audit: INFISICAL_PATH=/ and a store that
    // answers with nothing. It used to exit 0 having pushed nothing.
    const r = run({ exported: [], env: { INFISICAL_PATH: "/" } })
    expect(r.status).not.toBe(0)
    expect(r.output).toContain("refusing to read the Infisical ROOT folder")
    expect(r.readPath).toBe("") // the CLI was never called
    expect(r.setKeys).toEqual([])
    expectNoValueLeaked(r.output)
  })

  it("refuses --path=/ as well as INFISICAL_PATH=/", () => {
    const r = run({ args: ["--infisical", "--dry-run", "--path=/"] })
    expect(r.status).not.toBe(0)
    expect(r.output).toContain("refusing to read the Infisical ROOT folder")
    expectNoValueLeaked(r.output)
  })

  it("takes --path over INFISICAL_PATH, and adds the leading slash", () => {
    const r = run({
      args: ["--infisical", "--dry-run", "--path=demo"],
      exported: ["OPENAI_API_KEY"],
      env: { INFISICAL_PATH: "/platform" },
    })
    expect(r.status).toBe(0)
    expect(r.readPath).toBe("/demo")
    expectNoValueLeaked(r.output)
  })
})

describe("a zero-key export", () => {
  it("is a hard error, not a green run", () => {
    const r = run({ exported: [] })
    expect(r.status).not.toBe(0)
    expect(r.output).toContain("holds no keys")
    expect(r.setKeys).toEqual([])
    expectNoValueLeaked(r.output)
  })

  it("stops before the per-client half, so nothing is half-pushed", () => {
    // Without the guard this run would push the local file and report success,
    // hiding the fact that the shared half — the half being rotated — was empty.
    const r = run({ exported: [], envConvex: "AWS_S3_BUCKET_NAME=client-bucket\n" })
    expect(r.status).not.toBe(0)
    expect(r.output).not.toContain("AWS_S3_BUCKET_NAME")
    expectNoValueLeaked(r.output)
  })

  it("is judged on what the store held, not on what survived the filters", () => {
    // A folder holding only deployment-owned keys pushes nothing, and that is a
    // different problem from a folder holding nothing: the store DID answer.
    const r = run({ exported: ["JWT_PRIVATE_KEY", "JWKS"] })
    expect(r.status).toBe(0)
    expect(r.output).not.toContain("holds no keys")
    expect(r.wouldSet).toEqual([])
    expectNoValueLeaked(r.output)
  })
})

describe("secrets a deployment owns", () => {
  const OWNED = [
    "JWT_PRIVATE_KEY",
    "JWKS",
    "BETTER_AUTH_SECRET",
    "EMAIL_API_SECRET",
    "ENCRYPTION_KEY",
    "ADMIN_BOOTSTRAP_TOKEN",
    "SEED_PASSWORD",
  ]

  it("never leave the shared store, even on a real push", () => {
    const r = run({
      args: ["--infisical"],
      exported: [...OWNED, "OPENAI_API_KEY", "DELIVEROO_CLIENT_SECRET"],
    })
    expect(r.status).toBe(0)
    expect(r.setKeys).toEqual(["OPENAI_API_KEY", "DELIVEROO_CLIENT_SECRET"])
    for (const key of OWNED) expect(r.setKeys).not.toContain(key)
    expectNoValueLeaked(r.output)
  })

  it("are named in the report, so the operator knows to clean the folder", () => {
    const r = run({ exported: [...OWNED, "OPENAI_API_KEY"] })
    expect(r.output).toContain("NOT PUSHED")
    for (const key of OWNED) expect(r.output).toContain(`  - ${key}`)
    expectNoValueLeaked(r.output)
  })

  it("still come from .env.convex, which IS this deployment's own half", () => {
    // .env.convex.example asks for four of them by name. Filtering the local
    // file too would leave a fresh deployment unable to sign anybody in.
    const r = run({
      args: ["--infisical", "--dry-run"],
      exported: ["OPENAI_API_KEY"],
      envConvex: [
        `BETTER_AUTH_SECRET=${VALUES.BETTER_AUTH_SECRET}`,
        `ENCRYPTION_KEY=${VALUES.ENCRYPTION_KEY}`,
        `EMAIL_API_SECRET=${VALUES.EMAIL_API_SECRET}`,
        `ADMIN_BOOTSTRAP_TOKEN=${VALUES.ADMIN_BOOTSTRAP_TOKEN}`,
        "",
      ].join("\n"),
    })
    expect(r.status).toBe(0)
    expect(r.wouldSet).toContain("BETTER_AUTH_SECRET")
    expect(r.wouldSet).toContain("ENCRYPTION_KEY")
    expect(r.wouldSet).toContain("EMAIL_API_SECRET")
    expect(r.wouldSet).toContain("ADMIN_BOOTSTRAP_TOKEN")
    expectNoValueLeaked(r.output)
  })

  it("excludes the auth pair from the local file too — nothing may carry it", () => {
    const r = run({
      exported: ["OPENAI_API_KEY"],
      envConvex: `JWT_PRIVATE_KEY=${VALUES.JWT_PRIVATE_KEY}\nJWKS=${VALUES.JWKS}\n`,
    })
    expect(r.status).toBe(0)
    expect(r.wouldSet).not.toContain("JWT_PRIVATE_KEY")
    expect(r.wouldSet).not.toContain("JWKS")
    expectNoValueLeaked(r.output)
  })
})

describe("the two halves", () => {
  it("still lets the shared store win over a stale local copy", () => {
    const r = run({
      exported: ["DELIVEROO_CLIENT_SECRET"],
      envConvex: `DELIVEROO_CLIENT_SECRET=stale-local-copy\nAWS_S3_BUCKET_NAME=client-bucket\n`,
    })
    expect(r.status).toBe(0)
    expect(r.wouldSet).toEqual(["DELIVEROO_CLIENT_SECRET", "AWS_S3_BUCKET_NAME"])
    expect(r.output).toContain("the shared store is authoritative")
    expectNoValueLeaked(r.output)
  })

  it("carries the Auto Blog plan prices, which are BeYours' own", () => {
    const r = run({ exported: ["STRIPE_BID_PRICE_PRO"] })
    expect(r.wouldSet).toContain("STRIPE_BID_PRICE_PRO")
    expectNoValueLeaked(r.output)
  })

  it("runs without --infisical exactly as before", () => {
    const r = run({ args: ["--dry-run"], envConvex: "AWS_S3_BUCKET_NAME=client-bucket\n" })
    expect(r.status).toBe(0)
    expect(r.readPath).toBe("") // the CLI is never called
    expect(r.wouldSet).toEqual(["AWS_S3_BUCKET_NAME"])
  })
})

/**
 * This file ships inside every client clone, where `scripts/infisical-bootstrap.mjs`
 * does not exist — `apps/themes` is published on its own. So the skip-list has
 * to be duplicated, and this is what keeps the two copies from drifting: it
 * runs in the monorepo, which is the only place a divergence can be introduced.
 */
describe.skipIf(!fs.existsSync(BOOTSTRAP))("the engine's copy of the skip-list", () => {
  const listOf = (source, marker) => {
    const body = source.slice(source.indexOf(marker))
    return new Set([...body.slice(0, body.indexOf("]") + 1).matchAll(/"([A-Z_][A-Z0-9_]*)"/g)].map((m) => m[1]))
  }

  it("names exactly what setup-convex-env.sh refuses to push", () => {
    const shell = fs.readFileSync(SCRIPT, "utf8")
    const line = shell.match(/^DEPLOYMENT_OWNED="(.*)"$/m)
    expect(line, "DEPLOYMENT_OWNED is no longer a single quoted line").not.toBeNull()
    const fromShell = new Set(line[1].trim().split(/\s+/))
    const fromBootstrap = listOf(fs.readFileSync(BOOTSTRAP, "utf8"), "const DEPLOYMENT_OWNED = new Set([")
    expect([...fromShell].sort()).toEqual([...fromBootstrap].sort())
  })
})
